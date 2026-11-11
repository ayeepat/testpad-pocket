import {API_URL, DEFAULT_MODEL, openVault, buildBody, parseReply, explainHttp, isParamError} from './lib.js';

let active = 0; // solves in flight; never self-reload during one
const OTP_URL = /^https:\/\/(?:[\w-]+\.)*onlinetestpad\.com\//i;

async function apiKey() {
  const {apiKey: temp} = await chrome.storage.session.get('apiKey');
  if (temp) return temp;
  const {apiKey: saved} = await chrome.storage.local.get('apiKey');
  return saved || null;
}

async function settings() {
  const s = await chrome.storage.local.get(['model', 'effort']);
  return {model: (s.model || '').trim() || DEFAULT_MODEL, effort: s.effort ?? 'high'};
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

/** Reads an OpenAI-style SSE stream (or a plain JSON body) and returns the message text. */
async function readCompletion(res, onChunk) { // onChunk(chars so far)
  if (!/event-stream/i.test(res.headers.get('content-type') || '')) {
    const json = await res.json();
    return json.choices?.[0]?.message?.content || '';
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '';
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return text;
      try {
        const json = JSON.parse(data);
        if (json.error) throw Error(json.error.message || 'Ошибка 302.ai во время ответа.');
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) { text += delta; onChunk(text.length); }
      } catch (err) { if (err.message && !(err instanceof SyntaxError)) throw err; }
    }
  }
  return text;
}

async function solve(task, signal, progress) {
  const key = await apiKey();
  if (!key) throw Error('Расширение заблокировано. Нажмите на значок TestPad Pocket и введите пароль.');
  const {model, effort} = await settings();
  const image = task.useFormula === false ? null : await formula();
  const send = withEffort => fetch(API_URL, {
    method: 'POST', signal,
    headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'text/event-stream'},
    body: JSON.stringify(buildBody({model, effort: withEffort ? effort : '', task, formula: image})),
  });
  progress('думает');
  let res = await send(true);
  if (!res.ok) {
    const body = await res.text();
    if (effort && isParamError(res.status, body)) res = await send(false);
    else throw Error(explainHttp(res.status, body));
    if (!res.ok) throw Error(explainHttp(res.status, await res.text()));
  }
  const text = await readCompletion(res, () => n => progress('пишет', n));
  if (!text.trim()) throw Error('Модель вернула пустой ответ. Попробуйте ещё раз.');
  return parseReply(text);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'solve') return;
  const sender = port.sender;
  if (!sender?.tab || sender.frameId !== 0 || !OTP_URL.test(sender.url || '')) return port.disconnect();
  const abort = new AbortController();
  let open = true;
  active++;
  let released = false;
  const release = () => { if (!released) { released = true; active--; } };
  const post = msg => { if (open) port.postMessage(msg); };
  // An awaited fetch is not an extension event; touching an API keeps the worker alive.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const timeout = setTimeout(() => abort.abort(), 150000);
  port.onDisconnect.addListener(() => { open = false; abort.abort(); clearInterval(keepAlive); clearTimeout(timeout); release(); });
  port.onMessage.addListener(msg => {
    if (!msg.solve) return;
    solve(msg.solve, abort.signal, (stage, chars) => post({stage, chars}))
      .then(result => post({result}))
      .catch(err => post({error: abort.signal.aborted ? 'Нет ответа за 2,5 минуты. Повторите.'
        : /failed to fetch|network/i.test(err.message) ? 'Нет связи с 302.ai. Проверьте интернет.' : err.message}))
      .finally(() => { clearInterval(keepAlive); clearTimeout(timeout); release(); });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return; // extension pages only
  if (msg.unlock) {
    (async () => {
      const vault = await fetch(chrome.runtime.getURL('extension/vault.json')).then(r => r.ok ? r.json() : null).catch(() => null);
      if (!vault) return {error: 'В папке расширения нет extension/vault.json. Запустите node tools/seal.mjs и обновите расширение.'};
      try {
        const key = await openVault(vault, msg.unlock.password);
        await chrome.storage.local.remove('apiKey');
        await chrome.storage.session.remove('apiKey');
        await (msg.unlock.remember ? chrome.storage.local : chrome.storage.session).set({apiKey: key});
        return {ok: true};
      } catch (err) { return {error: err.message === 'wrong-password' ? 'Неверный пароль.' : 'Хранилище повреждено.'}; }
    })().then(reply);
    return true;
  }
  if (msg.checkUpdate) { checkUpdate().then(reply); return true; }
  if (msg.lock) {
    Promise.all([chrome.storage.local.remove('apiKey'), chrome.storage.session.remove('apiKey')]).then(() => reply({ok: true}));
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
