chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL('settings.html')}));
chrome.commands.onCommand.addListener(async (command, tab)=>{
  if (command !== 'toggle-panel') return;
  const target = tab || (await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0];
  if (target?.id) chrome.tabs.sendMessage(target.id,{toggle:true}).catch(()=>{});
});
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if (msg.binding) {
    chrome.commands.getAll().then(commands=>{
      const key=commands.find(c=>c.name==='toggle-panel')?.shortcut;
      reply(['⌃⇧8','Ctrl+Shift+8','Control+Shift+8'].includes(key));
    }).catch(()=>reply(false));
    return true;
  }
  if (!msg.solve || !sender.tab || sender.frameId!==0 || !/^https:\/\/(?:[\w-]+\.)*onlinetestpad\.com\//i.test(sender.url)) return;
  (async()=>{
    const {connection} = await chrome.storage.session.get('connection');
    if (!connection) throw Error('Откройте TestPad Pocket в меню расширений и введите пароль.');
    const res = await fetch(connection.origin+'/solve',{method:'POST',redirect:'error',signal:AbortSignal.timeout(100000),
      headers:{Authorization:'Bearer '+connection.credential,'Content-Type':'application/json'},body:JSON.stringify(msg.solve)});
    const data = await res.json();
    if (!res.ok) throw Error(data.error || 'Ошибка сервера.');
    return data;
  })().then(reply).catch(e=>reply({error:e.message}));
  return true;
});
