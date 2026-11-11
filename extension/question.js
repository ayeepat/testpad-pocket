// Reads and fills one OnlineTestPad question. Site menus and ads also contain
// inputs, so everything is scoped to .otp-item-view-question > .qcontainer.
const otp = (() => {
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const TEXT_TYPES = ['text', 'textarea', 'number', 'search', 'tel', ''];

  function current() {
    const roots = [...document.querySelectorAll('.otp-item-view-question')].filter(visible);
    if (roots.length <= 1) return roots[0] || null;
    const inView = roots.filter(el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
    return roots.find(el => el.contains(document.activeElement)) ||
      inView.find(el => el.getBoundingClientRect().top >= -40) || inView[0] || roots[0];
  }

  function read(root) {
    const body = root.querySelector('.qcontainer') || root;
    const fields = [], groups = [], visual = [], stemFigures = [];
    let previous = null;
    for (const el of body.querySelectorAll('input,select,textarea')) {
      const choice = el.type === 'radio' || el.type === 'checkbox';
      const label = el.labels?.[0] || el.closest('label');
      if (el.disabled || el.readOnly || !visible(choice && label ? label : el)) continue;
      if (!choice && el.type !== 'select-one' && !TEXT_TYPES.includes(el.type)) continue;
      const kind = choice ? el.type : el.type === 'select-one' ? 'select' : 'text';
      const same = choice && previous?.type === el.type && (kind === 'checkbox' || previous.name === el.name);
      if (!same) {
        fields.push({kind, label: choice ? '' : clean(label?.innerText || el.placeholder || el.getAttribute('aria-label') || el.title), options: []});
        groups.push([]);
      }
      previous = choice ? el : null;
      groups.at(-1).push(el);
      if (choice) fields.at(-1).options.push(clean(label?.innerText || el.parentElement.innerText) || '(без текста)');
      if (kind === 'select') fields.at(-1).options = [...el.options].map(o => clean(o.text) || '(пусто)');
    }
    for (const el of body.querySelectorAll('img,canvas,svg')) {
      if (!visible(el) || el.closest('.indicator,button,.qnumber,svg svg') || (el.ownerSVGElement)) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 12 || box.height < 12) continue; // icons, bullets
      const num = visual.push(el);
      const i = groups.findIndex(g => g.some(c => (c.labels?.[0] || c.closest('label'))?.contains(el)));
      if (i >= 0 && (fields[i].kind === 'radio' || fields[i].kind === 'checkbox')) {
        const j = groups[i].findIndex(c => (c.labels?.[0] || c.closest('label'))?.contains(el));
        fields[i].options[j] += ' [рис. ' + num + ']';
      } else stemFigures.push(num);
    }
    let question = (body.innerText || '').trim();
    if (stemFigures.length) question += `\n[В условии рисунки: ${stemFigures.map(n => 'рис. ' + n).join(', ')} — по порядку сверху вниз]`;
    const key = JSON.stringify([root.id, question, fields, visual.map(el => el.currentSrc || el.outerHTML.slice(0, 2000))]);
    return {root, fields, groups, visual, question, key};
  }

  async function rasterize(el) {
    if (el instanceof SVGElement) {
      const svg = new Image();
      const box = el.getBoundingClientRect();
      const copy = el.cloneNode(true);
      copy.setAttribute('width', box.width); copy.setAttribute('height', box.height);
      if (!copy.getAttribute('xmlns')) copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
      await svg.decode(); el = svg;
    } else if (el instanceof HTMLImageElement && !el.complete) await el.decode();
    const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
    if (!w || !h) throw Error('empty');
    // 302.ai rejects tiny images; cap large ones to keep the request small.
    const scale = Math.min(1400 / Math.max(w, h), Math.max(1, 96 / Math.min(w, h)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
    const draw = source => {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.9);
    };
    try { return draw(el); }
    catch {
      if (!(el instanceof HTMLImageElement)) throw Error('tainted');
      const copy = new Image(); copy.crossOrigin = 'anonymous'; copy.src = el.currentSrc || el.src;
      try { await copy.decode(); return draw(copy); }
      catch { return /^https:\/\//.test(el.currentSrc || el.src) ? (el.currentSrc || el.src) : null; } // let the model fetch it
    }
  }

  /** Returns {images, skipped}. Unreadable pictures are skipped, not fatal. */
  async function pictures(elements) {
    const images = []; let skipped = 0;
    for (const el of elements.slice(0, 10)) {
      try { const url = await rasterize(el); if (url) images.push(url); else skipped++; }
      catch { skipped++; }
    }
    return {images, skipped: skipped + Math.max(0, elements.length - 10)};
  }

  function notify(el) {
    for (const type of ['input', 'keyup', 'change']) el.dispatchEvent(new Event(type, {bubbles: true}));
  }
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    notify(el);
  }

  /** Fills what it can. Returns {filled, total}. Never presses Next/Finish. */
  function fill(snapshot, values) {
    let filled = 0;
    const total = snapshot.groups.length;
    if (!Array.isArray(values)) return {filled, total};
    for (const [i, group] of snapshot.groups.entries()) {
      let value = typeof values[i] === 'string' ? values[i].trim() : '';
      const el = group[0], field = snapshot.fields[i];
      if (!value || !el.isConnected) continue;
      try {
        if (field.kind === 'text') {
          if (el.type === 'number') value = value.replace(',', '.').replace(/[^\d.eE+-]/g, '');
          if (el.maxLength > 0 && value.length > el.maxLength) continue;
          setValue(el, value);
          if (el.value === value) filled++;
        } else {
          const picks = [...new Set((value.match(/\d+/g) || []).map(n => Number(n) - 1))];
          if (!picks.length || picks.some(n => n < 0 || n >= field.options.length)) continue;
          if (field.kind !== 'checkbox' && picks.length !== 1) continue;
          if (field.kind === 'select') {
            if (el.options[picks[0]]?.disabled) continue;
            el.selectedIndex = picks[0]; notify(el);
            if (el.selectedIndex === picks[0]) filled++;
          } else {
            for (const [j, c] of group.entries()) {
              const want = picks.includes(j);
              if (c.checked !== want && (field.kind === 'checkbox' || want)) c.click();
            }
            if (group.every((c, j) => c.checked === picks.includes(j))) filled++;
          }
        }
      } catch {}
    }
    return {filled, total};
  }

  return {current, read, pictures, fill};
})();
