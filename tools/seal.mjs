#!/usr/bin/env node
// Encrypts an API key with a password and adds it to extension/vault.json.
// The vault holds one key per provider, each behind its own password; the password
// someone types decides which provider their extension uses.
// The vault is safe to commit to a public repo: without a password it is useless.
//
//   node tools/seal.mjs                    # 302.ai key
//   node tools/seal.mjs --provider polza   # Polza.ai key
//
// Non-interactive: API_KEY=... VAULT_PASSWORD=... node tools/seal.mjs [--provider polza] [--no-check] [--out path]
// (API_302_KEY is accepted too.) Sealing a provider again replaces only that provider's entry.
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {sealVault, openVault, vaultEntries, PROVIDERS} from '../extension/lib.js';

const args = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = opt('--out') || fileURLToPath(new URL('../extension/vault.json', import.meta.url));
const id = opt('--provider') || '302';
const prov = PROVIDERS[id];
if (!prov) { console.error(`Неизвестный провайдер «${id}». Есть: ${Object.keys(PROVIDERS).join(', ')}.`); process.exit(1); }

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(text); }; // hide typing
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

let existing = [];
try { existing = vaultEntries(JSON.parse(readFileSync(out, 'utf8'))); } catch {}
const others = existing.filter(e => (e.provider || '302') !== id);

const apiKey = process.env.API_KEY || process.env.API_302_KEY || await ask(`Ключ ${prov.name}: `);
if (!apiKey) { console.error('Ключ пустой.'); process.exit(1); }
let password = process.env.VAULT_PASSWORD;
if (!password) {
  password = await ask('Новый пароль (от 12 символов): ');
  if (password !== await ask('Повторите пароль: ')) { console.error('Пароли не совпадают.'); process.exit(1); }
}
if (password.length < 12) { console.error('Пароль короче 12 символов: его можно подобрать. Возьмите длиннее.'); process.exit(1); }
for (const other of others) {
  const opens = await openVault(other, password).then(() => true, () => false);
  if (opens) { console.error(`Этот пароль уже открывает ключ ${PROVIDERS[other.provider || '302'].name}. Возьмите другой.`); process.exit(1); }
}

if (!args.includes('--no-check')) {
  process.stdout.write(`Проверяю ключ на ${prov.name}… `);
  try {
    let res, lastErr;
    for (const host of prov.hosts) {
      try { res = await fetch(host + '/v1/models', {headers: {Authorization: 'Bearer ' + apiKey}, signal: AbortSignal.timeout(20000)}); }
      catch (err) { lastErr = err; continue; }
      if (res.status !== 401) break;
    }
    if (!res) throw lastErr;
    if (res.status === 401) { console.error('ключ не принят (HTTP 401).'); process.exit(1); }
    const ids = res.ok ? ((await res.json()).data || []).map(m => m.id) : [];
    if (!res.ok) console.log(`HTTP ${res.status}, продолжаю.`);
    else if (ids.includes(prov.model)) console.log(`ок, модель ${prov.model} доступна.`);
    else console.log(`ключ принят, но ${prov.model} нет в списке. Похожие: ${ids.filter(m => /gemini.*flash/i.test(m)).slice(-8).join(', ') || '—'}.\n  Модель можно сменить в меню расширения → Дополнительно.`);
  } catch (err) { console.log('не удалось проверить (' + err.message + '), продолжаю.'); }
}

const vault = await sealVault(apiKey, password, id);
if (await openVault(vault, password) !== apiKey.trim()) throw Error('self-check failed');
writeFileSync(out, JSON.stringify([...others, vault], null, 2) + '\n');
console.log(`Готово: ${out} (${prov.name}; всего ключей: ${others.length + 1}).\nДальше: закоммитьте и запушьте extension/vault.json, затем обновите расширение и введите этот пароль в его меню.`);
