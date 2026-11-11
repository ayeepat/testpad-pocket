(() => {
  let hidden = sessionStorage.getItem('testpad-pocket-hidden') === '1';
  let ticket=0, bound=null, signature='', pending=false;
  const host=document.createElement('div');
  const shadow=host.attachShadow({mode:'closed'});
  shadow.innerHTML='<style>:host{all:initial;display:block;position:relative;z-index:2;height:0}section{position:absolute;bottom:3px;right:4px;font:12px/1.4 Inter,system-ui,sans-serif;color:#2f3733;text-align:left}button{display:block;margin-left:auto;border:1px solid #c3c9c5;border-radius:4px;background:#fafbf9;color:#414b44;font:11px/16px system-ui;padding:0 5px;cursor:pointer}output:not(:empty){display:block;white-space:pre-wrap;overflow:auto;max-height:32vh;width:max-content;max-width:min(360px,82vw);box-sizing:border-box;background:#fffffc;border-left:2px solid #769384;padding:5px 8px;margin:0 0 3px;box-shadow:0 1px 4px #0002}</style><section><output aria-live="polite"></output><button type="button">Решить</button></section>';
  const button=shadow.querySelector('button'), output=shadow.querySelector('output');
  function clear() {ticket++; pending=false; output.textContent='';button.disabled=false;button.textContent='Решить';signature='';}
  function place() {
    const root=otp.current();
    if (hidden || !root) { if (host.isConnected) host.remove(); if (bound) clear(); bound=null;return; }
    if (bound!==root || (signature && otp.read(root).key!==signature)) clear();
    bound=root;
    const ad=document.querySelector('#testform .otp-ad-content,.otp-ad-content');
    if (ad && ad.getBoundingClientRect().top>40 && ad.getBoundingClientRect().top<innerHeight) {
      if (host.nextSibling!==ad) ad.before(host);
      host.style.removeProperty('position');host.style.removeProperty('right');host.style.removeProperty('bottom');
    } else {
      if (host.parentNode!==document.documentElement) document.documentElement.append(host);
      if(host.style.position==='fixed') return;
      host.style.setProperty('position','fixed','important');host.style.setProperty('right','8px','important');host.style.setProperty('bottom','6px','important');
    }
  }
  let lastToggle=-Infinity;
  function toggle(){
    if(performance.now()-lastToggle<180) return;
    lastToggle=performance.now();
    hidden=!hidden;
    sessionStorage.setItem('testpad-pocket-hidden',hidden?'1':'0');
    clear();place();
  }
  chrome.runtime.onMessage.addListener(msg=>{if(msg.toggle) toggle();});
  // Some Chromium builds deliver the key to the page instead of dispatching the command.
  // Respect an unassigned or remapped browser shortcut.
  let defaultBinding=false;
  function checkBinding(){chrome.runtime.sendMessage({binding:true}).then(value=>{defaultBinding=value===true;}).catch(()=>{});}
  checkBinding();addEventListener('focus',checkBinding);
  addEventListener('keydown',event=>{
    if(defaultBinding && event.isTrusted && !event.repeat && event.code==='Digit8' &&
       event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();toggle();
    }
  },true);
  button.onclick=async e=>{
    if (!e.isTrusted || pending || !bound) return;
    const start=otp.read(bound), id=++ticket;
    signature=start.key; pending=true; button.disabled=true; button.textContent='Решаю…'; output.textContent='';
    try {
      const images=await otp.pictures(start.visual);
      if(id!==ticket) return;
      const result=await chrome.runtime.sendMessage({solve:{question:start.question,fields:start.fields,images}});
      if (id!==ticket || hidden || otp.current()!==start.root) return;
      const fresh=otp.read(start.root);
      if (fresh.key!==start.key) {clear();return;}
      if (!result || result.error) throw Error(result?.error || 'Нет ответа сервера.');
      const ok=otp.fill(fresh,result.values);
      output.textContent=[result.work,'Ответ: '+result.answer,ok?'':'Проверьте и внесите ответ вручную.'].filter(Boolean).join('\n');
    } catch(err) {if(id===ticket) output.textContent=err.message;}
    finally {if(id===ticket){pending=false;button.disabled=false;button.textContent='Решить';}}
  };
  let scheduled=false;
  function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;place();});}}
  new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','class','src','style']});
  addEventListener('scroll',schedule,{passive:true});addEventListener('resize',schedule);place();
})();
