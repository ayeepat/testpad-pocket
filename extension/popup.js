import {provider, modelFor} from './lib.js';

const $ = id => document.getElementById(id);
const msg = (text, ok = false) => { $('msg').textContent = text; $('msg').className = ok ? 'ok' : ''; };

function pretty(shortcut) {
  if (!shortcut) return '<small>не назначено</small>';
  const parts = shortcut.includes('+') ? shortcut.split('+') : [...shortcut]; // Mac reports "⌃⇧8"
  return parts.map(k => `<kbd>${k.replace('MacCtrl', 'Control')}</kbd>`).join(' ');
}

async function refresh() {
  const KEYS = ['apiKey', 'provider', 'raceProvider', 'prefs'];
  const [local, temp] = await Promise.all([
    chrome.storage.local.get([...KEYS, 'model', 'effort', 'raceOff']), chrome.storage.session.get(KEYS)]);
  const {apiKey: saved, model, effort} = local, keys = temp.apiKey ? temp : local;
  const unlocked = !!(saved || temp.apiKey);
  const prov = provider(keys.provider);
  // The account's own model (if it has one) is what an empty field means.
  const own = modelFor(keys.provider, {prefs: keys.prefs});
  // An account with a second key: both providers answer every question, unless turned off here.
  $('race-row').hidden = $('race-help').hidden = !keys.raceProvider;
  if (keys.raceProvider) {
    const other = modelFor(keys.raceProvider, {prefs: keys.prefs, main: false});
    $('race-label').textContent = `Сразу два: ${prov.name} и ${provider(keys.raceProvider).name}`;
    $('race-models').textContent = `${provider(keys.raceProvider).name}: ${other.model}`;
    $('race').checked = !local.raceOff;
  }
  $('model-label').textContent = 'Модель ' + prov.name;
  $('model').placeholder = own.model;
  $('title').className = unlocked ? 'on' : '';
  $('state').textContent = unlocked ? (saved ? 'Готово' : 'Готово до закрытия браузера') : 'Заблокировано';
  $('unlock').hidden = unlocked;
  $('ready').hidden = !unlocked;
  $('model').value = model && model !== own.model ? model : '';
  $('effort').value = effort || own.effort;
  const commands = await chrome.commands.getAll();
  const key = name => commands.find(c => c.name === name)?.shortcut;
  $('k-solve').innerHTML = pretty(key('solve'));
  $('k-toggle').innerHTML = pretty(key('toggle-panel'));
  if (!unlocked) $('pass').focus();
}

$('unlock').addEventListener('submit', async e => {
  e.preventDefault();
  $('go').disabled = true; msg('Проверяю…', true);
  // The worker does the work, so closing this popup mid-way is harmless.
  const res = await chrome.runtime.sendMessage({unlock: {password: $('pass').value, remember: $('remember').checked}}).catch(() => null);
  $('go').disabled = false;
  if (!res?.ok) return msg(res?.error || 'Не удалось открыть.');
  $('pass').value = '';
  msg('Открыто. Окно можно закрыть.', true);
  refresh();
  showRoute();
});

$('lock').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({lock: true});
  msg('Ключ удалён с этого компьютера.', true);
  refresh();
});

$('model').addEventListener('change', () => {
  const value = $('model').value.trim();
  value ? chrome.storage.local.set({model: value}) : chrome.storage.local.remove('model');
  msg('Сохранено.', true);
});
$('race').addEventListener('change', () => {
  $('race').checked ? chrome.storage.local.remove('raceOff') : chrome.storage.local.set({raceOff: true});
  msg('Сохранено.', true);
  showRoute();
});
$('effort').addEventListener('change', () => { chrome.storage.local.set({effort: $('effort').value}); msg('Сохранено.', true); });

async function showRoute(fresh = false) {
  $('route').textContent = fresh ? 'проверяю…' : '…';
  const r = await chrome.runtime.sendMessage({route: {fresh}}).catch(() => null);
  $('route').textContent = !r ? '—' : !r.host ? 'нет связи ни с одним' :
    new URL(r.host).host + (r.ms != null ? ` · ${(r.ms / 1000).toFixed(1).replace('.', ',')} с` : '') +
    (r.also ? ' + ' + new URL(r.also).host : '');
}
$('reroute').addEventListener('click', e => { e.preventDefault(); showRoute(true); });

refresh();
showRoute();

// Also makes the extension pick up an update.cmd run right away.
chrome.runtime.sendMessage({checkUpdate: true}).then(info => {
  if (!info || info.reloading) return;
  const mac = navigator.platform.startsWith('Mac');
  $('ver').innerHTML = info.updatedTo ? `<b>Обновлено до ${info.updatedTo}.</b>`
    : info.latest ? `<b>Есть версия ${info.latest}.</b> Запустите ${mac ? 'update.command' : 'update.cmd'} в папке расширения.`
    : 'Версия ' + info.current;
}).catch(() => {});
