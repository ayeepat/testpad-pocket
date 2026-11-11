const url = document.querySelector('#url');
const pass = document.querySelector('#pass');
const status = document.querySelector('output');
chrome.storage.local.get('origin').then(s => {url.value = s.origin || '';});
chrome.commands.getAll().then(commands => {
  const key = commands.find(c=>c.name==='toggle-panel')?.shortcut;
  document.querySelector('#shortcut').textContent = key ? 'Показать / скрыть: '+key : 'Назначьте сочетание в настройках горячих клавиш расширений.';
});
document.querySelector('form').onsubmit = async e => {
  e.preventDefault();
  try {
    const target = new URL(url.value);
    if (target.protocol !== 'https:' || !/^[a-z0-9-]+\.onrender\.com$/.test(target.hostname) || target.port || target.username || target.password) throw Error('Укажите HTTPS-адрес сервиса Render.');
    if (!await chrome.permissions.request({origins:[target.origin+'/*']})) throw Error('Нужен доступ к указанному серверу.');
    status.textContent = 'Подключение…';
    const credential = btoa(Array.from(new TextEncoder().encode(pass.value),c=>String.fromCharCode(c)).join(''));
    const response = await fetch(target.origin+'/unlock',{method:'POST',headers:{Authorization:'Bearer '+credential},redirect:'error',signal:AbortSignal.timeout(100000)});
    const data = await response.json();
    if (!response.ok || !data.ok) throw Error(data.error || 'Сервер недоступен.');
    await chrome.storage.session.set({connection:{origin:target.origin,credential}});
    await chrome.storage.local.set({origin:target.origin});
    pass.value = '';
    status.textContent = 'Подключено. Откройте задание OnlineTestPad.';
  } catch (err) {status.textContent = err.message;}
};
