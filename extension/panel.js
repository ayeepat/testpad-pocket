(() => {
  let hidden = true;            // until storage answers, show nothing
  let bound = null;             // question root the panel is attached to
  let shownKey = '';            // question signature the output belongs to
  let job = null;               // {key, root, started, stage, port}
  const results = new Map();    // signature -> {answer, work, note, error}

  const host = document.createElement('div');
  const shadow = host.attachShadow({mode: 'closed'});
  shadow.innerHTML = `<style>
:host{all:initial;display:block;position:relative;z-index:2147483000;height:0}
section{position:absolute;bottom:3px;right:4px;font:12px/1.4 system-ui,"Segoe UI",sans-serif;color:#2b322e;text-align:left}
button{display:block;margin-left:auto;border:1px solid #cfd4d1;border-radius:3px;background:#f7f8f7;color:#59625c;font:10px/14px system-ui,"Segoe UI",sans-serif;padding:0 4px;cursor:pointer;opacity:.75}
button:hover{opacity:1}button:disabled{cursor:default}
output:not(:empty){display:block;overflow:auto;max-height:34vh;width:max-content;max-width:min(380px,84vw);box-sizing:border-box;background:#fffffd;border-left:2px solid #6f8f7e;padding:4px 8px;margin:0 0 3px;box-shadow:0 1px 4px #0002}
.a{font-weight:600;white-space:pre-wrap}.w{white-space:pre-wrap;color:#3d4640;margin-top:2px}.n{color:#8a5a12;margin-top:2px}.e{color:#9b2c2c;white-space:pre-wrap}
</style><section><output aria-live="polite"></output><button type="button">Решить</button></section>`;
  const button = shadow.querySelector('button'), output = shadow.querySelector('output');

  function line(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }

  function render() {
    output.replaceChildren();
    const busy = job && job.key === shownKey;
    button.disabled = !!busy;
    if (busy) {
      button.textContent = `${job.stage}… ${Math.round((performance.now() - job.started) / 1000)} с`;
      return;
    }
    button.textContent = 'Решить';
    const r = results.get(shownKey);
    if (!r) return;
    if (r.error) return output.append(line('e', r.error));
    if (r.answer) output.append(line('a', 'Ответ: ' + r.answer));
    if (r.work) output.append(line('w', r.work));
    if (r.note) output.append(line('n', r.note));
  }

  function place() {
    const root = otp.current();
    if (hidden || !root) { if (host.isConnected) host.remove(); bound = null; return; }
    const key = otp.read(root).key;
    if (root !== bound || key !== shownKey) { bound = root; shownKey = key; render(); }
    const ad = document.querySelector('#testform .otp-ad-content, .otp-ad-content');
    const top = ad?.getBoundingClientRect().top;
    if (ad && top > 40 && top < innerHeight) {
      if (host.nextSibling !== ad) ad.before(host);
      for (const p of ['position', 'right', 'bottom']) host.style.removeProperty(p);
    } else {
      if (host.parentNode !== document.documentElement) document.documentElement.append(host);
      host.style.setProperty('position', 'fixed', 'important');
      host.style.setProperty('right', '8px', 'important');
      host.style.setProperty('bottom', '6px', 'important');
    }
  }

  function finish(key, value) {
    results.set(key, value);
    if (job?.key === key) { clearInterval(job.timer); job = null; }
    render();
  }

  async function solve() {
    const root = otp.current();
    if (!root) return;
    const snap = otp.read(root);
    if (job) { if (job.key === snap.key) return; job.port?.disconnect(); clearInterval(job.timer); job = null; }
    const me = job = {key: snap.key, root, started: performance.now(), stage: 'Читаю', port: null,
      timer: setInterval(() => { if (!hidden) render(); }, 1000)};
    results.delete(snap.key);
    render();
    const {images, skipped} = await otp.pictures(snap.visual);
    if (job !== me) return;
    let port;
    try { port = me.port = chrome.runtime.connect({name: 'solve'}); }
    catch { return finish(snap.key, {error: 'Расширение обновилось — обновите страницу (F5).'}); }
    me.stage = 'Решаю'; render();
    port.onMessage.addListener(msg => {
      if (job !== me) return;
      if (msg.stage) { me.stage = msg.stage === 'пишет' ? 'Пишу' : 'Решаю'; return; }
      port.disconnect();
      if (msg.error) return finish(snap.key, {error: msg.error});
      const r = msg.result;
      const notes = [];
      const fresh = root.isConnected ? otp.read(root) : null;
      if (fresh?.key === snap.key) {
        const {filled, total} = otp.fill(fresh, r.values);
        if (total && filled < total) notes.push(filled ? `Заполнено ${filled} из ${total} — остальное вручную.` : 'Внесите ответ вручную.');
      } else notes.push('Задание сменилось — ответ не вносился.');
      if (skipped) notes.push(`Не удалось прочитать рисунков: ${skipped}.`);
      finish(snap.key, {answer: r.answer, work: r.work, note: notes.join(' ')});
    });
    port.onDisconnect.addListener(() => {
      if (job === me) finish(snap.key, {error: 'Соединение прервано. Нажмите ещё раз.'});
    });
    port.postMessage({solve: {question: snap.question, fields: snap.fields, images}});
  }

  const last = {};
  function once(name, fn) { // the browser command and the page key event can both fire
    const now = performance.now();
    if (now - (last[name] || -1e9) < 250) return;
    last[name] = now; fn();
  }
  const toggle = () => chrome.storage.local.set({hidden: !hidden});

  chrome.storage.local.get('hidden').then(s => { hidden = s.hidden === true; place(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.hidden) { hidden = changes.hidden.newValue === true; place(); }
  });
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.command === 'toggle-panel') once('toggle', toggle);
    if (msg.command === 'solve') once('solve', solve);
  });
  // Fallback when the browser shortcut is taken or unassigned on this PC.
  addEventListener('keydown', e => {
    if (!e.isTrusted || e.repeat || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if (e.code === 'Digit8') { e.preventDefault(); e.stopPropagation(); once('toggle', toggle); }
    if (e.code === 'Digit9') { e.preventDefault(); e.stopPropagation(); once('solve', solve); }
  }, true);
  button.addEventListener('click', e => { if (e.isTrusted) solve(); });

  let scheduled = false;
  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; place(); }); } };
  new MutationObserver(records => { if (records.some(r => !host.contains(r.target) && r.target !== host)) schedule(); })
    .observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'src', 'style']});
  addEventListener('scroll', schedule, {passive: true});
  addEventListener('resize', schedule);
})();
