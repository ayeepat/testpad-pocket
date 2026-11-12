#!/usr/bin/env node
// Checks both 302.ai addresses from this computer: can it reach each one with a
// real-sized request, and does your key work there. Nothing is billed.
//
//   node tools/check.mjs
//
// Non-interactive: VAULT_PASSWORD=... node tools/check.mjs   (or API_302_KEY=... to skip the vault)
import {readFileSync} from 'node:fs';
import readline from 'node:readline';
import {openVault, probeHost, API_HOSTS, DEFAULT_MODEL} from '../extension/lib.js';

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(text); }; // hide typing
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

let key = process.env.API_302_KEY;
if (!key) {
  const vault = JSON.parse(readFileSync(new URL('../extension/vault.json', import.meta.url), 'utf8'));
  try { key = await openVault(vault, process.env.VAULT_PASSWORD || await ask('Пароль от хранилища: ')); }
  catch { console.error('Неверный пароль.'); process.exit(1); }
}

let usable = 0;
for (const host of API_HOSTS) {
  const name = host.replace('https://', '');
  let line = name.padEnd(14) + ' ';
  try { line += `связь ок (${(await probeHost(host, AbortSignal.timeout(15000)) / 1000).toFixed(1)} с)`; }
  catch (err) { line += `связи нет (${err.name === 'TimeoutError' ? 'завис — похоже на блокировку' : err.message})`; }
  try {
    const res = await fetch(host + '/v1/models', {headers: {Authorization: 'Bearer ' + key}, signal: AbortSignal.timeout(20000)});
    if (res.status === 401) line += ', ключ НЕ принят';
    else if (!res.ok) line += `, ключ: HTTP ${res.status}`;
    else {
      const ids = ((await res.json()).data || []).map(m => m.id);
      line += ', ключ принят' + (ids.includes(DEFAULT_MODEL) ? `, ${DEFAULT_MODEL} есть` : `, ${DEFAULT_MODEL} НЕТ в списке`);
      usable++;
    }
  } catch (err) { line += `, ключ не проверить (${err.name === 'TimeoutError' ? 'завис' : err.message})`; }
  console.log(line);
}
console.log(usable ? 'Расширение возьмёт самый быстрый рабочий адрес.' : 'Ни один адрес не подходит — нужен VPN или другой провайдер.');
process.exit(usable ? 0 : 1);
