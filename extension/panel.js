(() => {
  let hidden = true;            // whole panel (hotkey); until storage answers, show nothing
  let reveal = true;            // eye: answer text shown or folded away
  let shownKey = '';            // question signature the output belongs to
  let job = null;               // {key, started, stage, chars, port, timer}
  const results = new Map();    // signature -> {answer, work, note, error}
  const life = new AbortController();

  const EYE = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  const host = document.createElement('div');
  const shadow = host.attachShadow({mode: 'closed'});
  // Styled like the Yandex ad tiles OnlineTestPad shows around the test.
  shadow.innerHTML = `<style>
:host{all:initial;position:fixed!important;z-index:2147483000!important;display:block}
.card{box-sizing:border-box;width:max-content;max-width:var(--w,360px);background:#fff;border-radius:8px;box-shadow:0 1px 3px #0000001f;font:13px/1.35 -apple-system,"YS Text","Segoe UI",Arial,sans-serif;color:#1f1f1f;text-align:left;overflow:hidden}
header{display:flex;align-items:center;gap:6px;padding:5px 7px 4px 9px;position:relative}
.lbl{font-size:9.5px;letter-spacing:.06em;color:#999;text-transform:uppercase;margin-right:auto}
button{all:unset;cursor:pointer;color:#9a9a9a;font-size:10px;line-height:14px;padding:0 3px;border-radius:3px;position:relative}
button:hover{color:#555;background:#f2f2f2}
button.eye{display:flex;align-items:center;height:14px}
button.go{font-size:11px;font-weight:600;padding:0 5px}
button.eye.dot::after{content:"";position:absolute;top:-1px;right:0;width:4px;height:4px;border-radius:50%;background:#7fb08f}
button.eye.err::after{background:#d48a8a}
.card{position:relative}
.bar{display:none;height:2px;background:#e8ebe9;min-width:150px}
.bar.on{display:block}
.bar i{display:block;height:100%;width:0;background:#7d9486;transition:width .6s ease}
button:disabled{cursor:default;opacity:.3;background:none!important;color:#9a9a9a!important}
output{display:block;overflow:auto;max-height:var(--h,34vh);padding:0 10px 8px}
output:empty,output[hidden]{display:none}
.a{font-weight:600;white-space:pre-wrap}.w{white-space:pre-wrap;color:#444;margin-top:3px;font-size:12px}.n{color:#8a6a2a;margin-top:3px;font-size:11px}.e{color:#a33;white-space:pre-wrap;font-size:12px}
</style><div class="card"><header><span class="lbl">Реклама</span><button class="eye" type="button" title=""></button><button class="go" type="button">?</button></header><output></output><div class="bar"><i></i></div></div>`;
  const $ = s => shadow.querySelector(s);
  const card = $('.card'), eye = $('.eye'), go = $('.go'), bar = $('.bar'), fillBar = $('.bar i'), output = $('output');

  function line(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }

  function progress() {
    if (!job) return 0;
    const t = (performance.now() - job.started) / 1000;
    if (job.stage === 'read') return 6;
    if (job.stage === 'think') return 12 + 60 * (1 - Math.exp(-t / 12));
    return Math.min(97, 70 + 27 * Math.min(1, job.chars / 500));
  }

  function render() {
    const busy = !!job && job.key === shownKey;
    bar.classList.toggle('on', busy);
    go.disabled = busy;
    fillBar.style.width = busy ? progress().toFixed(1) + '%' : '0';
    const r = results.get(shownKey);
    eye.innerHTML = reveal ? EYE : EYE_OFF;
    eye.classList.toggle('dot', !!r && !reveal);
    eye.classList.toggle('err', !!r?.error && !reveal);
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
    const key = otp.read(root).key;
    if (key !== shownKey) { shownKey = key; render(); }
    if (!host.isConnected) document.documentElement.append(host);
    const r = adRect(), s = host.style;
    if (r) { // sit on top of the ad, top-left corner
      const top = Math.max(r.top, 0) + 6;
      const room = Math.min(r.bottom, innerHeight) - top - 6;
      s.setProperty('left', Math.round(r.left + 6) + 'px', 'important');
      s.setProperty('top', Math.round(top) + 'px', 'important');
      s.removeProperty('right'); s.removeProperty('bottom');
      card.style.setProperty('--w', Math.round(Math.min(r.width - 12, 380)) + 'px');
      card.style.setProperty('--h', Math.max(110, room - 28) + 'px');
    } else {   // no ads on screen: bottom-right corner
      s.setProperty('right', '8px', 'important'); s.setProperty('bottom', '6px', 'important');
      s.removeProperty('left'); s.removeProperty('top');
      card.style.setProperty('--w', 'min(380px,84vw)'); card.style.setProperty('--h', '34vh');
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
    const me = job = {key: snap.key, started: performance.now(), stage: 'read', chars: 0, port: null,
      timer: setInterval(() => { if (!hidden) render(); }, 700)};
    results.delete(snap.key);
    render();
    const {images, skipped} = await otp.pictures(snap.visual);
    if (job !== me) return;
    let port;
    try { port = me.port = chrome.runtime.connect({name: 'solve'}); }
    catch { return finish(snap.key, {error: 'Расширение обновилось — обновите страницу (F5).'}); }
    me.stage = 'think'; render();
    port.onMessage.addListener(msg => {
      if (job !== me) return;
      if (msg.stage) { if (msg.stage === 'пишет') { me.stage = 'write'; me.chars = msg.chars || 0; } return; }
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
    if (changes.reveal) { reveal = changes.reveal.newValue !== false; render(); }
  };
  const onCommand = msg => {
    if (msg.command === 'toggle-panel') once('toggle', toggle);
    if (msg.command === 'solve') once('solve', solve);
  };

  chrome.storage.local.get(['hidden', 'reveal']).then(s => { hidden = s.hidden === true; reveal = s.reveal !== false; render(); place(); });
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
  eye.addEventListener('click', e => { if (e.isTrusted) chrome.storage.local.set({reveal: !reveal}); });

  let scheduled = false;
  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; place(); }); } };
  const observer = new MutationObserver(records => { if (records.some(r => r.target !== host)) schedule(); });
  observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'src', 'style']});
  addEventListener('scroll', schedule, {passive: true, capture: true, signal: life.signal});
  addEventListener('resize', schedule, {signal: life.signal});
  const watchdog = setInterval(() => { if (!chrome.runtime?.id) teardown(); }, 2000);

  // After the extension updates itself, this copy loses its connection; the new copy takes over.
  function teardown() {
    life.abort(); observer.disconnect(); clearInterval(watchdog);
    if (job) clearInterval(job.timer);
    host.remove();
  }
})();
