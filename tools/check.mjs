#!/usr/bin/env node
// Checks the provider your password opens from this computer: can it reach each address
// (for 302.ai, with a real-sized request), and does your key work there. Nothing is billed.
// An account with a second key gets both providers checked.
//
//   node tools/check.mjs          # free: addresses and keys
//   node tools/check.mjs --live   # also one tiny real question to every provider at once, the way
//                                 # the extension races them (a fraction of a cent each)
//
// Non-interactive: VAULT_PASSWORD=... node tools/check.mjs   (or API_302_KEY=... to skip the vault)
import {readFileSync} from 'node:fs';
import {ask as askSecret} from './ask.mjs';
import {openAny, probeHost, provider, fastestHost, ask, race, sameAnswer, modelFor} from '../extension/lib.js';


let accounts = [{key: process.env.API_302_KEY, provider: '302', ...modelFor('302')}];
if (!accounts[0].key) {
  const vault = JSON.parse(readFileSync(new URL('../extension/vault.json', import.meta.url), 'utf8'));
  try {
    const opened = await openAny(vault, process.env.VAULT_PASSWORD || await askSecret('Пароль от хранилища: '));
    // Each provider with the model and depth the extension would use for this account.
    accounts = [opened, opened.race].filter(Boolean).map((a, i) => ({...a, ...modelFor(a.provider, {prefs: opened.prefs, main: i === 0})}));
  } catch { console.error('Неверный пароль.'); process.exit(1); }
}

/** One provider's addresses: reachable (302.ai: with a real-sized request), key accepted, model listed. */
async function checkProvider({key, provider: id, model, effort}) {
  const prov = provider(id);
  console.log(`Провайдер: ${prov.name} — ${model} (${effort === 'medium' ? 'средняя' : effort === 'high' ? 'высокая' : effort})`);
  let usable = 0;
  for (const host of prov.hosts) {
    let line = new URL(host).host.padEnd(14) + ' ';
    if (id === '302') {
      try { line += `связь ок (${(await probeHost(host, AbortSignal.timeout(15000)) / 1000).toFixed(1)} с), `; }
      catch (err) { line += `связи нет (${err.name === 'TimeoutError' ? 'завис — похоже на блокировку' : err.message}), `; }
    }
    try {
      const get = path => fetch(host + path, {headers: {Authorization: 'Bearer ' + key}, signal: AbortSignal.timeout(20000)});
      const auth = await get(prov.authPath);
      if (auth.status === 401) line += 'ключ НЕ принят';
      else if (!auth.ok) line += `ключ: HTTP ${auth.status}`;
      else {
        const list = prov.authPath === '/v1/models' ? auth : await get('/v1/models');
        const ids = list.ok ? ((await list.json()).data || []).map(m => m.id) : [];
        // Not listed: show the names that share its words (gpt + sol), in case this provider spells it differently.
        const words = model.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 1);
        const near = ids.filter(m => words.every(w => m.toLowerCase().includes(w))).slice(0, 12);
        if (ids.includes(model)) { line += `ключ принят, ${model} есть`; usable++; }
        else line += `ключ принят, но ${model} НЕТ в списке. Похожие: ${near.join(', ') || '—'}`;
      }
    } catch (err) { line += `ключ не проверить (${err.name === 'TimeoutError' ? 'завис' : err.message})`; }
    console.log(line);
  }
  return usable > 0;
}

let ok = true;
for (const account of accounts) ok = await checkProvider(account) && ok;
if (accounts.length > 1) console.log(`Гонка: каждый вопрос уходит на ${accounts.map(a => provider(a.provider).name).join(' и ')}, первый ответ вписывается.`);

if (ok && process.argv.includes('--live')) {
  // A two-field question with a known answer: radio "2" (3 + 4 = 7) and text "12" (3 · 4).
  const task = {question: 'Сколько будет 3 + 4? Отдельно впишите 3 · 4.',
    fields: [{kind: 'radio', label: '', options: ['6', '7', '8']}, {kind: 'text', label: 'Произведение', options: []}], images: []};
  console.log('\nПробная задача, все провайдеры сразу:');
  const best = accounts.some(a => a.provider === '302') ? (await fastestHost())?.host : null;
  const hostsFor = id => id === '302' && best ? [best, ...provider(id).hosts.filter(h => h !== best)] : provider(id).hosts;
  const signal = AbortSignal.timeout(150000);
  const show = (tag, id, ms, reply) => console.log(`  ${tag} ${provider(id).name.padEnd(9)} ${(ms / 1000).toFixed(1).padStart(5)} с  ответ: ${reply.answer || '—'}  поля: ${JSON.stringify(reply.values)}`);
  await race(accounts.map(a => ({id: a.provider, run: async () =>
    (await ask({key: a.key, id: a.provider, hosts: hostsFor(a.provider), model: a.model, effort: a.effort, task, formula: null, signal})).reply,
  })), e => {
    if (e.first) show('1.', e.first.id, e.first.ms, e.first.reply);
    if (e.other?.reply) {
      show('2.', e.other.id, e.other.ms, e.other.reply);
      console.log(`  Ответы ${e.other.same === true ? 'совпадают ✓' : e.other.same === false ? 'разные ✗' : 'не сравнить'}`);
    }
    if (e.other?.error) { ok = false; console.log(`  ✗ ${provider(e.other.id).name}: ${e.other.error.message}`); }
    if (e.failed) { ok = false; for (const f of e.failed) console.log(`  ✗ ${provider(f.id).name}: ${f.error.message}`); }
  }, (a, b) => sameAnswer(task.fields, a, b));
}

console.log(ok ? 'Всё работает.' : 'Есть проблемы — см. выше. Без связи с 302.ai нужен VPN или другой провайдер.');
process.exit(ok ? 0 : 1);
