import {DEFAULT_MODEL} from './lib.js';

const $ = id => document.getElementById(id);
const msg = (text, ok = false) => { $('msg').textContent = text; $('msg').className = ok ? 'ok' : ''; };

function pretty(shortcut) {
  if (!shortcut) return '<small>не назначено</small>';
  const parts = shortcut.includes('+') ? shortcut.split('+') : [...shortcut]; // Mac reports "⌃⇧8"
  return parts.map(k => `<kbd>${k.replace('MacCtrl', 'Control')}</kbd>`).join(' ');
}

async function refresh() {
  const [{apiKey: saved, model, effort}, {apiKey: temp}] = await Promise.all([
    chrome.storage.local.get(['apiKey', 'model', 'effort']), chrome.storage.session.get('apiKey')]);
  const unlocked = !!(saved || temp);
  $('title').className = unlocked ? 'on' : '';
  $('state').textContent = unlocked ? (saved ? 'Готово' : 'Готово до закрытия браузера') : 'Заблокировано';
  $('unlock').hidden = unlocked;
  $('ready').hidden = !unlocked;
  $('model').value = model && model !== DEFAULT_MODEL ? model : '';
  $('effort').value = effort || 'high';
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
$('effort').addEventListener('change', () => { chrome.storage.local.set({effort: $('effort').value}); msg('Сохранено.', true); });

refresh();

// Also makes the extension pick up an update.cmd run right away.
chrome.runtime.sendMessage({checkUpdate: true}).then(info => {
  if (!info || info.reloading) return;
  const mac = navigator.platform.startsWith('Mac');
  $('ver').innerHTML = info.updatedTo ? `<b>Обновлено до ${info.updatedTo}.</b>`
    : info.latest ? `<b>Есть версия ${info.latest}.</b> Запустите ${mac ? 'update.command' : 'update.cmd'} в папке расширения.`
    : 'Версия ' + info.current;
}).catch(() => {});
