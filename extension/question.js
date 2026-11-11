// OnlineTestPad scopes answer controls to one question; site menus and ads also contain inputs.
const otp = (() => {
  const visible = el => el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const clean = value => (value || '').replace(/\s+/g,' ').trim();
  function current() {
    const roots = [...document.querySelectorAll('.otp-item-view-question')].filter(visible);
    const inView = roots.filter(el=>{const r=el.getBoundingClientRect();return r.bottom>0 && r.top<innerHeight;});
    return inView.find(el=>el.contains(document.activeElement)) || inView[0] || (roots.length===1 ? roots[0] : null);
  }
  function read(root) {
    const body = root.querySelector('.qcontainer') || root;
    const stem = body.querySelector('.qtext') || body;
    const area = body.querySelector('[id="d-q-ans-container"]') || body;
    const fields = [], groups = [], visual = [];
    let previousChoice = null;
    for (const el of area.querySelectorAll('input,select,textarea')) {
      const choice = ['radio','checkbox'].includes(el.type);
      const label = el.labels?.[0];
      if (el.disabled || el.readOnly || !visible(choice && label ? label : el)) continue;
      if (!choice && !['select-one','text','textarea','number','search'].includes(el.type)) continue;
      const kind = choice ? el.type : el.type === 'select-one' ? 'select' : 'text';
      const same = choice && previousChoice && previousChoice.type===el.type &&
        (kind==='checkbox' || previousChoice.name===el.name);
      if (!same) {
        fields.push({kind,label:choice ? '' : clean(label?.innerText || el.placeholder || el.getAttribute('aria-label')),options:[]});
        groups.push([]);
      }
      previousChoice = choice ? el : null;
      groups.at(-1).push(el);
      if (choice) fields.at(-1).options.push(clean(label?.innerText || el.parentElement.innerText));
      if (kind==='select') fields.at(-1).options = [...el.options].map(o=>clean(o.text));
    }
    for (const el of body.querySelectorAll('img,canvas,svg')) {
      if (!visible(el) || el.closest('.indicator,button,.qnumber')) continue;
      const num = visual.push(el);
      const i = groups.findIndex(g=>g.some(c=>c.labels?.[0]?.contains(el)));
      if (i>=0 && ['radio','checkbox'].includes(fields[i].kind)) {
        const j = groups[i].findIndex(c=>c.labels?.[0]?.contains(el));
        fields[i].options[j]+=' [рис. '+num+']';
      }
    }
    const question = (stem.innerText || '').trim();
    // Include surrounding text for inline gaps, units, captions, and multiple answer fields.
    const context = (body.innerText || '').trim();
    const key = JSON.stringify([root.id,question,context,fields,visual.map(el=>el.currentSrc || el.outerHTML.slice(0,3000))]);
    return {root,fields,groups,visual,question:context || question,key};
  }
  async function pictures(elements) {
    if (elements.length>8) throw Error('В задании больше восьми рисунков.');
    const images = [];
    for (let el of elements) {
      if (el instanceof SVGElement) {
        const svg = new Image();
        svg.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(el));
        await svg.decode(); el=svg;
      }
      if (el instanceof HTMLImageElement) await el.decode();
      const w=el.naturalWidth || el.width, h=el.naturalHeight || el.height;
      const scale=Math.min(1,1400/Math.max(w,h));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(w*scale)); canvas.height=Math.max(1,Math.round(h*scale));
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='white'; ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(el,0,0,canvas.width,canvas.height);
      try { images.push(canvas.toDataURL('image/jpeg',0.88)); }
      catch {
        if (!(el instanceof HTMLImageElement)) throw Error('Не удалось прочитать рисунок.');
        const copy=new Image(); copy.crossOrigin='anonymous'; copy.src=el.currentSrc;
        try {
          await copy.decode(); canvas.width=canvas.width;
          ctx.fillStyle='white'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(copy,0,0,canvas.width,canvas.height);
          images.push(canvas.toDataURL('image/jpeg',0.88));
        } catch {throw Error('Сайт закрыл доступ к рисунку. Решение без него может быть неверным.');}
      }
    }
    return images;
  }
  function fill(snapshot, values) {
    if (!Array.isArray(values) || !values.length || values.length!==snapshot.groups.length) return false;
    const actions=[];
    for (const [i,group] of snapshot.groups.entries()) {
      const value=values[i], el=group[0], kind=snapshot.fields[i].kind;
      if (typeof value!=='string' || !value.trim()) return false;
      if (kind==='text') {
        const probe=el.cloneNode(); probe.value=value;
        if (!probe.value || !probe.checkValidity() || (el.maxLength>=0 && value.length>el.maxLength)) return false;
        actions.push(()=>{el.value=value; notify(el);return el.value===value;});
      } else {
        if (!/^\d+(?:\s*,\s*\d+)*$/.test(value)) return false;
        const picks=value.split(',').map(n=>Number(n)-1);
        if ((kind!=='checkbox' && picks.length!==1) || picks.some(n=>n<0 || n>=snapshot.fields[i].options.length)) return false;
        if (kind==='select') {
          if (el.options[picks[0]].disabled) return false;
          actions.push(()=>{el.selectedIndex=picks[0];notify(el);return el.selectedIndex===picks[0];});
        } else actions.push(()=>{
          for (const [j,c] of group.entries()) if (c.checked!==picks.includes(j) && (kind==='checkbox' || picks.includes(j))) c.click();
          return group.every((c,j)=>c.checked===picks.includes(j));
        });
      }
    }
    return actions.every(action=>action());
  }
  function notify(el) {for (const type of ['input','change']) el.dispatchEvent(new Event(type,{bubbles:true}));}
  return {current,read,pictures,fill};
})();
