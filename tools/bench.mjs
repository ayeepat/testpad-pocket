#!/usr/bin/env node
// Speed check on Polza.ai: the same request the extension sends (system prompt, formula picture,
// answer fields), on several models at once, over a few test-style questions with known answers.
// Each question goes to every model at the same moment, so they race under the same conditions.
// This is billed: a few rubles in all. Every answer line shows what it cost, and the table the
// average per question, per 100 questions, and the total.
//
//   node tools/bench.mjs                                   # the four default models below
//   node tools/bench.mjs google/gemini-4-neon:low ...      # any models, as id:effort
//   node tools/bench.mjs --rounds 2                        # every question twice per model
//
// The Polza.ai key comes from the vault (your password) or POLZA_KEY=...
import {readFileSync} from 'node:fs';
import {ask as askSecret} from './ask.mjs';
import {openAny, buildBody, parseReply, sameAnswer, explainHttp, provider, CHAT_PATH} from '../extension/lib.js';

const DEFAULT = ['openai/gpt-6.2-sol:medium', 'google/gemini-4-hydrogen:medium', 'google/gemini-3.8-flash:high', 'google/gemini-4-neon:medium'];
const args = process.argv.slice(2);
const at = args.indexOf('--rounds');
const rounds = at >= 0 ? Math.max(1, Number(args[at + 1]) || 1) : 1;
const picked = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
const models = (picked.length ? picked : DEFAULT).map(s => { const [id, effort = 'medium'] = s.split(':'); return {id, effort}; });
const base = process.env.POLZA_BASE || provider('polza').hosts[0];

// Typical OnlineTestPad informatics questions, with the values a correct answer fills in.
const QUESTIONS = [
  {name: 'звук', question: 'Производится одноканальная (моно) звукозапись с частотой дискретизации 8 кГц и глубиной кодирования 16 бит. Запись длится 64 секунды. Определите информационный объём полученного файла в Кбайтах.',
    fields: [{kind: 'text', label: 'Кбайт', options: []}], expect: ['1000']},
  {name: 'двоичн.', question: 'Сколько единиц в двоичной записи десятичного числа 113?',
    fields: [{kind: 'radio', label: '', options: ['3', '4', '5', '6']}], expect: ['2']},
  {name: 'ввод', question: 'Выберите все устройства ввода информации.',
    fields: [{kind: 'checkbox', label: '', options: ['Клавиатура', 'Монитор', 'Мышь', 'Принтер', 'Сканер']}], expect: ['1,3,5']},
  {name: 'hex', question: 'Переведите число 2F из шестнадцатеричной системы счисления в десятичную.',
    fields: [{kind: 'text', label: '', options: []}], expect: ['47']},
  {name: 'картинка', question: 'Растровое изображение размером 256×128 пикселей использует палитру из 16 цветов. Каков информационный объём изображения в Кбайтах?',
    fields: [{kind: 'text', label: 'Кбайт', options: []}], expect: ['16']},
];

let key = process.env.POLZA_KEY;
if (!key) {
  const vault = JSON.parse(readFileSync(new URL('../extension/vault.json', import.meta.url), 'utf8'));
  let opened;
  try { opened = await openAny(vault, process.env.VAULT_PASSWORD || await askSecret('Пароль от хранилища: ')); }
  catch { console.error('Неверный пароль.'); process.exit(1); }
  key = [opened, opened.race].find(a => a?.provider === 'polza')?.key;
  if (!key) { console.error('У этого аккаунта нет ключа Polza.ai.'); process.exit(1); }
}

const bytes = readFileSync(new URL('../extension/formula.jpg', import.meta.url));
const formula = 'data:image/jpeg;base64,' + bytes.toString('base64');

// Prices (₽ per million tokens) from Polza.ai's public model list, to turn usage into rubles.
const prices = {};
try {
  const list = await (await fetch(base + '/v1/models', {signal: AbortSignal.timeout(20000)})).json();
  for (const m of list.data || []) prices[m.id] = m.top_provider?.pricing || m.pricing || {};
} catch {}
// Polza.ai's own figure when the reply carries one; otherwise tokens × list price (marked «~»).
const rub = (id, u) => {
  if (u?.cost != null) return {rub: Number(u.cost), exact: true};
  const p = prices[id];
  if (!p || !u) return null;
  return {rub: ((u.prompt_tokens || 0) * Number(p.prompt_per_million || 0) + (u.completion_tokens || 0) * Number(p.completion_per_million || 0)) / 1e6, exact: false};
};
const money = c => c == null ? '—' : (c.exact ? '' : '~') + c.rub.toFixed(2).replace('.', ',') + ' ₽';

/** One request, timed: {ms, firstMs (first answer text), reply, usage} or {ms, error}. */
async function run(model, task) {
  const t0 = performance.now();
  const body = {...buildBody({model: model.id, effort: model.effort, task, formula}), stream_options: {include_usage: true}};
  const signal = AbortSignal.timeout(150000);
  const send = () => fetch(base + CHAT_PATH, {
    method: 'POST', signal,
    headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'text/event-stream'},
    body: JSON.stringify(body),
  });
  try {
    let res = await send();
    // A model that refuses a setting (OpenAI reasoning models and temperature, say) gets one retry without it.
    if (res.status === 400) {
      const text = await res.text();
      const bad = ['stream_options', 'temperature'].filter(p => text.includes(p));
      if (!bad.length) throw Error(explainHttp(400, text, 'Polza.ai'));
      for (const p of bad) delete body[p];
      model.dropped = [...new Set([...(model.dropped || []), ...bad])];
      res = await send();
    }
    if (!res.ok) throw Error(explainHttp(res.status, await res.text(), 'Polza.ai'));
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buffer = '', text = '', firstMs = null, usage = null;
    read: for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break read;
        let json; try { json = JSON.parse(data); } catch { continue; }
        if (json.error) throw Error(json.error.message || 'ошибка во время ответа');
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) { firstMs ??= performance.now() - t0; text += delta; }
      }
    }
    if (!text.trim()) throw Error('пустой ответ');
    return {ms: performance.now() - t0, firstMs, reply: parseReply(text), usage};
  } catch (err) {
    return {ms: performance.now() - t0, error: err.name === 'TimeoutError' ? 'нет ответа за 150 с' : err.message};
  }
}

const s = ms => ms == null ? '—' : (ms / 1000).toFixed(1).replace('.', ',') + ' с';
const short = id => id.replace(/^(google|openai)\//, '');
const results = new Map(models.map(m => [m, []]));
console.log(`Polza.ai: ${models.map(m => `${short(m.id)} (${m.effort})`).join(', ')}`);
console.log(`${QUESTIONS.length} вопросов × ${rounds} — каждый вопрос всем моделям одновременно.\n`);

for (let r = 0; r < rounds; r++) {
  for (const q of QUESTIONS) {
    const task = {question: q.question, fields: q.fields, images: []};
    const label = `${q.name}${rounds > 1 ? ' #' + (r + 1) : ''}`;
    await Promise.all(models.map(async m => {
      const out = await run(m, task);
      out.ok = !out.error && sameAnswer(q.fields, out.reply, {answer: '', values: q.expect}) === true;
      out.cost = out.error ? null : rub(m.id, out.usage);
      results.get(m).push(out);
      console.log(`  ${label.padEnd(10)} ${short(m.id).padEnd(18)} ${s(out.ms).padStart(7)}  ${(out.error ? '' : money(out.cost)).padStart(8)}  ` + (out.error ? `ошибка: ${out.error}`
        : `${out.ok ? '✓' : '✗'} ${JSON.stringify(out.reply.values)}${out.ok ? '' : ' (нужно ' + JSON.stringify(q.expect) + ')'}`));
    }));
  }
}

const median = xs => { const v = xs.filter(x => x != null).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
const rows = models.map(m => {
  const rs = results.get(m), good = rs.filter(x => !x.error), costs = good.map(x => x.cost).filter(Boolean);
  return {m, med: median(good.map(x => x.ms)), best: good.length ? Math.min(...good.map(x => x.ms)) : null,
    worst: good.length ? Math.max(...good.map(x => x.ms)) : null, first: median(good.map(x => x.firstMs)),
    ok: rs.filter(x => x.ok).length, n: rs.length, errors: rs.length - good.length,
    cost: costs.length ? {rub: costs.reduce((a, c) => a + c.rub, 0) / costs.length, exact: costs.every(c => c.exact)} : null,
    spent: costs.reduce((a, c) => a + c.rub, 0)};
}).sort((a, b) => (a.med ?? 1e9) - (b.med ?? 1e9));

console.log('\nМодель (усилие)                 медиана  лучшее  худшее  до текста  верно   ₽/вопрос   ₽/100 вопросов');
for (const r of rows) {
  console.log(`${`${short(r.m.id)} (${r.m.effort})`.padEnd(31)} ${s(r.med).padStart(7)} ${s(r.best).padStart(7)} ${s(r.worst).padStart(7)} ${s(r.first).padStart(10)}  ${`${r.ok}/${r.n}`.padStart(5)}   ${money(r.cost).padStart(8)}   ${(r.cost ? money({...r.cost, rub: r.cost.rub * 100}) : '—').padStart(14)}${r.errors ? `   ошибок: ${r.errors}` : ''}`);
}
const spent = rows.reduce((a, r) => a + r.spent, 0), exact = rows.every(r => !r.cost || r.cost.exact);
console.log(`\nПотрачено за проверку: ${exact ? '' : '~'}${spent.toFixed(2).replace('.', ',')} ₽ (запросы с ошибкой не считаны).`);
if (!exact) console.log('«~» — оценка по прайсу Polza.ai (токены × цена); без «~» — сумма, которую вернул сам Polza.ai.');
for (const m of models) if (m.dropped) console.log(`${short(m.id)} не принимает ${m.dropped.join(', ')} — повторено без этого. В расширении эта модель сейчас получила бы ошибку.`);
console.log('\nмедиана/лучшее/худшее — от отправки до полного ответа (столько ждёт панель); «до текста» — до первых букв ответа, остальное время модель думает.');
