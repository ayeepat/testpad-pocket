import {API_HOSTS, provider, fastestHost, openAny, ask, race, sameAnswer, modelFor} from './lib.js';

let active = 0; // solves in flight; never self-reload during one
const OTP_URL = /^https:\/\/(?:[\w-]+\.)*onlinetestpad\.com\//i;
const KEYS = ['apiKey', 'provider', 'raceKey', 'raceProvider', 'prefs'];

/** The unlocked key and its provider id ('302' or 'polza'), or null.
 *  race: {key, provider} when the account has a second key and this computer hasn't turned it off.
 *  prefs: the account's own model and depth per provider, if it has them. */
async function creds() {
  const temp = await chrome.storage.session.get(KEYS);
  const s = temp.apiKey ? temp : await chrome.storage.local.get(KEYS);
  if (!s.apiKey) return null;
  const {raceOff} = await chrome.storage.local.get('raceOff');
  const c = {key: s.apiKey, provider: s.provider || '302', prefs: s.prefs};
  if (s.raceKey && !raceOff) c.race = {key: s.raceKey, provider: s.raceProvider};
  return c;
}
const providerId = async () => (await creds())?.provider || '302';
const uses302 = c => c?.provider === '302' || c?.race?.provider === '302';


/* ---------- which 302.ai address ----------
 * Probed when a test page opens and kept 10 minutes, so a solve rarely waits for it.
 * Any network failure or stall forgets it, and the next solve probes again. */
const ROUTE_TTL = 10 * 60 * 1000;
let probing = null;
async function route(fresh = false) {
  const {route: saved} = await chrome.storage.session.get('route');
  if (!fresh && saved && Date.now() - saved.at < ROUTE_TTL) return saved;
  probing ??= fastestHost().then(async best => {
    if (!best) return {host: null, ms: null, at: Date.now()}; // not cached: try again next time
    const next = {...best, at: Date.now()};
    await chrome.storage.session.set({route: next});
    return next;
  }).finally(() => { probing = null; });
  return probing;
}
// Forget the host and probe again in the background, so the next solve doesn't wait for it.
const forgetRoute = () => chrome.storage.session.remove('route').then(() => route(true)).catch(() => {});
async function hostOrder() {
  const {host} = await route();
  return host ? [host, ...API_HOSTS.filter(h => h !== host)] : API_HOSTS;
}

let formulaCache = null;
async function formula() {
  if (formulaCache) return formulaCache;
  const blob = await (await fetch(chrome.runtime.getURL('extension/formula.jpg'))).blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return (formulaCache = 'data:image/jpeg;base64,' + btoa(bin));
}

/** One provider's solve. 302.ai goes to its fastest working address first, and remembers
 *  a dead or key-less address it had to skip until the route expires. */
async function solveOn({key, provider: id}, task, image, signal, main, prefs) {
  const {model, effort} = modelFor(id, {prefs, main, local: await chrome.storage.local.get(['model', 'effort'])});
  const is302 = id === '302';
  const hosts = is302 ? await hostOrder() : provider(id).hosts;
  const {reply, host, skipped} = await ask({key, id, hosts, model, effort, task, formula: image, signal});
  if (is302 && skipped) chrome.storage.session.set({route: {host, ms: null, at: Date.now()}});
  return reply;
}

/* The page's port: the first answer comes as {result, by, rival?}. With a second provider
 * (rival = its name) the port stays open and its answer follows as {twin: {by, ms, result, same} | {by, ms, error}}.
 * {error} when nothing answered. */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'solve') return;
  const sender = port.sender;
  if (!sender?.tab || sender.frameId !== 0 || !OTP_URL.test(sender.url || '')) return port.disconnect();
  const abort = new AbortController();
  let open = true;
  active++;
  let released = false, waiting302 = false;
  const started = Date.now();
  const stalled = () => Date.now() - started > 60000; // not just a switch to the next question
  const done = () => { clearInterval(keepAlive); clearTimeout(timeout); if (!released) { released = true; active--; } };
  const post = msg => { if (open) port.postMessage(msg); };
  // An awaited fetch is not an extension event; touching an API keeps the worker alive.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const timeout = setTimeout(() => abort.abort(), 150000);
  port.onDisconnect.addListener(() => { open = false; if (waiting302 && stalled()) forgetRoute(); abort.abort(); done(); });

  const failure = (err, id) => {
    const offline = /failed to fetch|network/i.test(err.message);
    if (id === '302' && (abort.signal.aborted ? stalled() : offline)) forgetRoute();
    return abort.signal.aborted ? 'Нет ответа за 2,5 минуты. Повторите.'
      : !offline ? err.message
      : id === '302' ? 'Нет связи с 302.ai (оба адреса). Проверьте интернет.' : `Нет связи с ${provider(id).name}. Проверьте интернет.`;
  };

  port.onMessage.addListener(async msg => {
    if (!msg.solve) return;
    try {
      const task = msg.solve, c = await creds();
      if (!c) return post({error: 'Расширение заблокировано. Нажмите на значок TestPad Pocket и введите пароль.'});
      const image = task.useFormula === false ? null : await formula();
      const runs = c.race ? [{...c, main: true}, c.race] : [{...c, main: true}];
      const name = id => provider(id).name;
      waiting302 = uses302(c);
      await race(runs.map(r => ({id: r.provider, run: () =>
        solveOn(r, task, image, abort.signal, r.main, c.prefs)
          .catch(err => { throw Error(failure(err, r.provider)); })
          .finally(() => { if (r.provider === '302') waiting302 = false; }),
      })), e => {
        if (e.first) post({result: e.first.reply, by: name(e.first.id), ms: e.first.ms,
          rival: runs.length > 1 ? name(runs.find(r => r.provider !== e.first.id).provider) : undefined});
        if (e.other) post({twin: {by: name(e.other.id), ms: e.other.ms,
          ...(e.other.error ? {error: e.other.error.message} : {result: e.other.reply, same: e.other.same})}});
        if (e.failed) post({error: e.failed.length === 1 ? e.failed[0].error.message
          : e.failed.map(f => `${name(f.id)}: ${f.error.message}`).join('\n')});
      }, (a, b) => sameAnswer(task.fields, a, b));
    } catch (err) { post({error: err.message}); }
    finally { done(); }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.warm && sender.tab && sender.frameId === 0 && OTP_URL.test(sender.url || '')) {
    creds().then(c => uses302(c) && route()).catch(() => {});
    return;
  }
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return; // extension pages only
  if (msg.unlock) {
    (async () => {
      const vault = await fetch(chrome.runtime.getURL('extension/vault.json')).then(r => r.ok ? r.json() : null).catch(() => null);
      if (!vault) return {error: 'В папке расширения нет extension/vault.json. Запустите node tools/seal.mjs и обновите расширение.'};
      try {
        const {key, provider: id, race, prefs} = await openAny(vault, msg.unlock.password);
        // A model name typed for one provider means nothing on the other; an account with its own
        // settings brings them along, so this computer's earlier choices give way.
        if (id !== await providerId()) await chrome.storage.local.remove('model');
        if (prefs) await chrome.storage.local.remove(['model', 'effort']);
        await chrome.storage.local.remove(KEYS);
        await chrome.storage.session.remove(KEYS);
        await (msg.unlock.remember ? chrome.storage.local : chrome.storage.session)
          .set({apiKey: key, provider: id, ...(race && {raceKey: race.key, raceProvider: race.provider}), ...(prefs && {prefs})});
        return {ok: true};
      } catch (err) { return {error: err.message === 'wrong-password' ? 'Неверный пароль.' : 'Хранилище повреждено.'}; }
    })().then(reply);
    return true;
  }
  if (msg.route) {
    (async () => {
      const c = await creds(), id = c?.provider || '302';
      const main = id === '302' ? {...await route(msg.route.fresh), hosts: API_HOSTS} : {host: provider(id).hosts[0], ms: null, hosts: provider(id).hosts};
      if (!c?.race) return main;
      const other = c.race.provider === '302' ? (await route(msg.route.fresh)).host : provider(c.race.provider).hosts[0];
      return {...main, also: other};
    })().then(reply);
    return true;
  }
  if (msg.checkUpdate) { checkUpdate().then(reply); return true; }
  if (msg.lock) {
    Promise.all([chrome.storage.local.remove(KEYS), chrome.storage.session.remove(KEYS)]).then(() => reply({ok: true}));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const target = tab?.id ? tab : (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0];
  if (target?.id) chrome.tabs.sendMessage(target.id, {command}).catch(() => {});
});

/* ---------- updating in place ----------
 * update.cmd / update.command overwrite the files in this folder. An unpacked
 * extension serves its files straight from disk, so a changed manifest version
 * there means new code: reload, then put the new panel into open test tabs. */
const OTP_TABS = ['https://onlinetestpad.com/*', 'https://*.onlinetestpad.com/*'];
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false; };

async function diskVersion() {
  try { return (await (await fetch(chrome.runtime.getURL('manifest.json'), {cache: 'no-store'})).json()).version; }
  catch { return null; }
}
async function reloadIfChanged() {
  const onDisk = await diskVersion();
  if (onDisk && onDisk !== chrome.runtime.getManifest().version && active === 0) { chrome.runtime.reload(); return true; }
  return false;
}
async function checkUpdate() {
  const current = chrome.runtime.getManifest().version;
  if (await reloadIfChanged()) return {reloading: true};
  let latest = null;
  try {
    const res = await fetch('https://raw.githubusercontent.com/ayeepat/testpad-pocket/main/manifest.json', {cache: 'no-store', signal: AbortSignal.timeout(8000)});
    if (res.ok) latest = (await res.json()).version;
  } catch {}
  const {updatedTo} = await chrome.storage.local.get('updatedTo');
  if (updatedTo) chrome.storage.local.remove('updatedTo');
  return {current, latest: latest && newer(latest, current) ? latest : null, updatedTo: updatedTo || null};
}

chrome.alarms.get('disk-check').then(a => { if (!a) chrome.alarms.create('disk-check', {periodInMinutes: 0.5}); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'disk-check') reloadIfChanged(); });

chrome.runtime.onInstalled.addListener(async ({reason}) => {
  if (reason === 'update') chrome.storage.local.set({updatedTo: chrome.runtime.getManifest().version});
  if (reason !== 'update' && reason !== 'install') return;
  for (const tab of await chrome.tabs.query({url: OTP_TABS})) {
    chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['extension/question.js', 'extension/panel.js']}).catch(() => {});
  }
});
