(() => {
  let hidden = true;            // whole panel (hotkey); until storage answers, show nothing
  let reveal = false;           // eye: answer opens only when clicked; every new answer starts folded
  let shownKey = '';            // question signature the output belongs to
  let job = null;               // {key, port, timer}
  const results = new Map();    // signature -> {answer, work, note, error}
  const life = new AbortController();

  const EYE = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

  const host = document.createElement('div');
  const shadow = host.attachShadow({mode: 'closed'});
  // Styled like the Yandex ad tiles OnlineTestPad shows around the test.
  shadow.innerHTML = `<style>
:host{all:initial;position:fixed!important;z-index:2147483000!important;display:block}
.card{box-sizing:border-box;width:max-content;max-width:var(--w,360px);background:#fff;border-radius:8px;box-shadow:0 1px 3px #0000001f;font:13px/1.35 -apple-system,"YS Text","Segoe UI",Arial,sans-serif;color:#1f1f1f;text-align:left;overflow:hidden}
header{display:flex;align-items:center;gap:6px;padding:5px 7px 4px 9px;position:relative}
.lbl{font-size:9.5px;letter-spacing:.06em;color:#999;text-transform:uppercase;margin-right:4px}
.card{display:flex;flex-direction:column}
.card.br{flex-direction:column-reverse}.card.br header{justify-content:flex-end}.card.br output{padding:8px 10px 0}
button{all:unset;cursor:pointer;color:#9a9a9a;font-size:10px;line-height:14px;padding:0 3px;border-radius:3px;position:relative}
button:hover{color:#555;background:#f2f2f2}
button.eye{display:flex;align-items:center;height:14px}
button.go{font-size:11px;font-weight:600;padding:0 5px}
button:disabled{cursor:default;opacity:.3;background:none!important;color:#9a9a9a!important}
button.eye.dot::after{content:"";position:absolute;top:-1px;right:0;width:4px;height:4px;border-radius:50%;background:#5fae7a}
button.eye.err::after{background:#d07a7a}
output{display:block;overflow:auto;max-height:var(--h,34vh);padding:0 10px 8px}
output:empty,output[hidden]{display:none}
.a{font-weight:600;white-space:pre-wrap}.w{white-space:pre-wrap;color:#444;margin-top:3px;font-size:12px}.n{color:#8a6a2a;margin-top:3px;font-size:11px}.e{color:#a33;white-space:pre-wrap;font-size:12px}
</style><div class="card"><header><span class="lbl">Реклама</span><button class="eye" type="button" title=""></button><button class="go" type="button">?</button></header><output></output></div>`;
  const $ = s => shadow.querySelector(s);
  const card = $('.card'), eye = $('.eye'), go = $('.go'), output = $('output');

  function line(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }

  function render() {
    go.disabled = !!job && job.key === shownKey;   // "?" fades and can't be pressed while sent
    const r = results.get(shownKey);
    eye.innerHTML = EYE;   // same icon either way, so nothing shifts
    eye.classList.toggle('dot', !!r);                // green = answer ready, red = error
    eye.classList.toggle('err', !!r?.error);
    output.hidden = !reveal;
    output.replaceChildren();
    if (!r || !reveal) return;
    if (r.error) return output.append(line('e', r.error));
    if (r.answer) output.append(line('a', 'Ответ: ' + r.answer));
    if (r.work) output.append(line('w', r.work));
    if (r.note) output.append(line('n', r.note));
  }

  const AD_SPOTS = ['.otp-ad-content', '.adleft', '.adright', '[id^="yandex_rtb_"]', '[id^="adfox_"]'];
  function adRect() {
    for (const sel of AD_SPOTS) for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const visible = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (r.width >= 180 && visible >= 70 && r.left >= -1 && r.right <= innerWidth + 1) return r;
    }
    return null;
  }

  function place() {
    if (!chrome.runtime?.id) return teardown();
    const root = otp.current();
    if (hidden || !root) { if (host.isConnected) host.remove(); return; }
    if (root !== lastRoot || dirty) {
      lastRoot = root; dirty = false;
      const key = otp.read(root).key;
      if (key !== shownKey) { shownKey = key; reveal = false; render(); }
    }
    if (!host.isConnected) document.documentElement.append(host);
    const r = adRect(), s = host.style;
    if (r) { // sit on top of the ad, top-left corner
      const top = Math.max(r.top, 0) + 6;
      const room = Math.min(r.bottom, innerHeight) - top - 6;
      s.setProperty('left', Math.round(r.left + 6) + 'px', 'important');
      s.setProperty('top', Math.round(top) + 'px', 'important');
      s.removeProperty('right'); s.removeProperty('bottom'); card.classList.remove('br');
      card.style.setProperty('--w', Math.round(Math.min(r.width - 12, 380)) + 'px');
      card.style.setProperty('--h', Math.max(110, room - 28) + 'px');
    } else {   // no ads on screen: bottom-right corner
      s.setProperty('right', '8px', 'important'); s.setProperty('bottom', '6px', 'important');
      s.removeProperty('left'); s.removeProperty('top'); card.classList.add('br');
      card.style.setProperty('--w', 'min(380px,84vw)'); card.style.setProperty('--h', '34vh');
    }
  }

  function finish(key, value) {
    results.set(key, value);
    if (key === shownKey) reveal = false;   // never pop open by itself
    if (job?.key === key) { clearTimeout(job.timer); job = null; }
    render();
  }

  async function solve() {
    const root = otp.current();
    if (!root) return;
    const snap = otp.read(root);
    if (job) { if (job.key === snap.key) return; job.port?.disconnect(); clearTimeout(job.timer); job = null; }
    const me = job = {key: snap.key, port: null,
      timer: setTimeout(() => { if (job === me) { me.port?.disconnect(); finish(snap.key, {error: 'Нет ответа. Нажмите ? ещё раз.'}); } }, 100000)};
    results.delete(snap.key);
    render();
    const {images, skipped} = await otp.pictures(snap.visual);
    if (job !== me) return;
    let port;
    try { port = me.port = chrome.runtime.connect({name: 'solve'}); }
    catch { return finish(snap.key, {error: 'Расширение обновилось — обновите страницу (F5).'}); }
    port.onMessage.addListener(msg => {
      if (job !== me) return;
      if (msg.stage) return;
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
  const onStorage = (changes, area) => {
    if (area !== 'local') return;
    if (changes.hidden) { hidden = changes.hidden.newValue === true; place(); }
  };
  const onCommand = msg => {
    if (msg.command === 'toggle-panel') once('toggle', toggle);
    if (msg.command === 'solve') once('solve', solve);
  };

  chrome.storage.local.get('hidden').then(s => { hidden = s.hidden === true; render(); place(); });
  chrome.runtime.sendMessage({warm: true}).catch(() => {}); // pick the 302.ai address before the first "?"
  chrome.storage.onChanged.addListener(onStorage);
  chrome.runtime.onMessage.addListener(onCommand);
  // Fallback when the browser shortcut is taken or unassigned on this PC.
  addEventListener('keydown', e => {
    if (!e.isTrusted || e.repeat || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if (!chrome.runtime?.id) return teardown();
    if (e.code === 'Digit8') { e.preventDefault(); e.stopPropagation(); once('toggle', toggle); }
    if (e.code === 'Digit9') { e.preventDefault(); e.stopPropagation(); once('solve', solve); }
  }, {capture: true, signal: life.signal});
  go.addEventListener('click', e => { if (e.isTrusted) solve(); });
  eye.addEventListener('click', e => { if (e.isTrusted) { reveal = !reveal; render(); } });

  let scheduled = false;
  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; place(); }); } };
  let lastRoot = null, dirty = true;
  const observer = new MutationObserver(records => {
    let relevant = false;
    for (const r of records) {
      if (r.target === host) continue;
      relevant = true;
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (el?.closest('.otp-item-view-question')) dirty = true;   // ads changing don't count
    }
    if (relevant) schedule();
  });
  observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'src', 'style']});
  addEventListener('scroll', schedule, {passive: true, capture: true, signal: life.signal});
  addEventListener('resize', schedule, {signal: life.signal});
  const watchdog = setInterval(() => { if (!chrome.runtime?.id) teardown(); }, 2000);

  // After the extension updates itself, this copy loses its connection; the new copy takes over.
  function teardown() {
    life.abort(); observer.disconnect(); clearInterval(watchdog);
    if (job) clearTimeout(job.timer);
    host.remove();
  }
})();
