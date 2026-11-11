#!/usr/bin/env node
// Encrypts your 302.ai key with a password into extension/vault.json.
// The vault is safe to commit to a public repo: without the password it is useless.
//
//   node tools/seal.mjs
//
// Non-interactive: API_302_KEY=... VAULT_PASSWORD=... node tools/seal.mjs [--no-check] [--out path]
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {sealVault, openVault, DEFAULT_MODEL} from '../extension/lib.js';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : fileURLToPath(new URL('../extension/vault.json', import.meta.url));

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(text); }; // hide typing
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

const apiKey = process.env.API_302_KEY || await ask('Ключ 302.ai (sk-…): ');
if (!apiKey) { console.error('Ключ пустой.'); process.exit(1); }
let password = process.env.VAULT_PASSWORD;
if (!password) {
  password = await ask('Новый пароль (от 12 символов): ');
  if (password !== await ask('Повторите пароль: ')) { console.error('Пароли не совпадают.'); process.exit(1); }
}
if (password.length < 12) { console.error('Пароль короче 12 символов: его можно подобрать. Возьмите длиннее.'); process.exit(1); }

if (!args.includes('--no-check')) {
  process.stdout.write('Проверяю ключ на 302.ai… ');
  try {
    const res = await fetch('https://api.302.ai/v1/models', {headers: {Authorization: 'Bearer ' + apiKey}, signal: AbortSignal.timeout(20000)});
    if (res.status === 401) { console.error('ключ не принят (HTTP 401).'); process.exit(1); }
    const ids = res.ok ? ((await res.json()).data || []).map(m => m.id) : [];
    if (!res.ok) console.log(`HTTP ${res.status}, продолжаю.`);
    else if (ids.includes(DEFAULT_MODEL)) console.log(`ок, модель ${DEFAULT_MODEL} доступна.`);
    else console.log(`ключ принят, но ${DEFAULT_MODEL} нет в списке. Похожие: ${ids.filter(id => /gemini.*flash/i.test(id)).slice(-8).join(', ') || '—'}.\n  Модель можно сменить в меню расширения → Дополнительно.`);
  } catch (err) { console.log('не удалось проверить (' + err.message + '), продолжаю.'); }
}

const vault = await sealVault(apiKey, password);
if (await openVault(vault, password) !== apiKey.trim()) throw Error('self-check failed');
writeFileSync(out, JSON.stringify(vault, null, 2) + '\n');
console.log(`Готово: ${out}\nДальше: закоммитьте и запушьте extension/vault.json, затем обновите расширение и введите этот пароль в его меню.`);
