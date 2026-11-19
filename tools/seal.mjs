#!/usr/bin/env node
// Encrypts an API key with a password and adds it to extension/vault.json.
// Every entry is one key behind its own password; the password someone types decides
// which key (and so which provider) their extension uses.
// The vault is safe to commit to a public repo: without a password it is useless.
//
//   node tools/seal.mjs                                # 302.ai key
//   node tools/seal.mjs --provider polza               # Polza.ai key
//   node tools/seal.mjs --provider polza --name Liza   # a named account (anyone's own key and password)
//   node tools/seal.mjs --list                         # what is in the vault (no password needed)
//   node tools/seal.mjs --remove Liza                  # delete a named account
//
// Non-interactive: API_KEY=... VAULT_PASSWORD=... node tools/seal.mjs [--provider polza] [--name X] [--no-check] [--out path]
// (API_302_KEY is accepted too.) Sealing with --name replaces only the entry with that name;
// without --name it replaces only the unnamed entry of that provider.
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {sealVault, openVault, vaultEntries, PROVIDERS} from '../extension/lib.js';

const args = process.argv.slice(2);
const fail = message => { console.error(message); process.exit(1); };
const opt = flag => {
  if (!args.includes(flag)) return undefined;
  const value = args[args.indexOf(flag) + 1];
  if (!value || value.startsWith('--')) fail(`После ${flag} нужно значение.`);
  return value.trim();
};
const out = opt('--out') || fileURLToPath(new URL('../extension/vault.json', import.meta.url));

let existing = [];
try { existing = vaultEntries(JSON.parse(readFileSync(out, 'utf8'))); } catch {}

const providerName = entry => (PROVIDERS[entry.provider || '302'] || {name: entry.provider}).name;
const label = entry => `${entry.name || '(без имени)'} — ${providerName(entry)}`;
function printList(entries) {
  if (!entries.length) return console.log('Хранилище пустое.');
  console.log(`Ключей в хранилище: ${entries.length}`);
  for (const entry of entries) console.log('  ' + label(entry));
}
const save = entries => writeFileSync(out, JSON.stringify(entries, null, 2) + '\n');

if (args.includes('--list')) { printList(existing); process.exit(0); }

const removeName = opt('--remove');
if (removeName !== undefined) {
  const left = existing.filter(e => e.name !== removeName);
  if (left.length === existing.length) fail(`Нет ключа с именем «${removeName}».`);
  save(left);
  console.log(`Удалил «${removeName}».`);
  printList(left);
  console.log('Дальше: закоммитьте и запушьте extension/vault.json.');
  process.exit(0);
}

const id = opt('--provider') || '302';
const prov = PROVIDERS[id];
if (!prov) fail(`Неизвестный провайдер «${id}». Есть: ${Object.keys(PROVIDERS).join(', ')}.`);
const name = opt('--name');

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    rl._writeToOutput = text => { if (text.includes(question)) process.stdout.write(text); }; // hide typing
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

// The entry this run replaces: the one with the same name, or (no name) the unnamed one of this provider.
const replaces = name ? e => e.name === name : e => !e.name && (e.provider || '302') === id;
const others = existing.filter(e => !replaces(e));

const apiKey = process.env.API_KEY || process.env.API_302_KEY || await ask(`Ключ ${prov.name}${name ? ` для «${name}»` : ''}: `);
if (!apiKey) fail('Ключ пустой.');
let password = process.env.VAULT_PASSWORD;
if (!password) {
  password = await ask('Новый пароль (от 12 символов): ');
  if (password !== await ask('Повторите пароль: ')) fail('Пароли не совпадают.');
}
if (password.length < 12) fail('Пароль короче 12 символов: его можно подобрать. Возьмите длиннее.');
for (const other of others) {
  const opens = await openVault(other, password).then(() => true, () => false);
  if (opens) fail(`Этот пароль уже открывает ключ «${label(other)}». Возьмите другой.`);
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
    if (res.status === 401) fail('ключ не принят (HTTP 401).');
    const ids = res.ok ? ((await res.json()).data || []).map(m => m.id) : [];
    if (!res.ok) console.log(`HTTP ${res.status}, продолжаю.`);
    else if (ids.includes(prov.model)) console.log(`ок, модель ${prov.model} доступна.`);
    else console.log(`ключ принят, но ${prov.model} нет в списке. Похожие: ${ids.filter(m => /gemini.*flash/i.test(m)).slice(-8).join(', ') || '—'}.\n  Модель можно сменить в меню расширения → Дополнительно.`);
  } catch (err) { console.log('не удалось проверить (' + err.message + '), продолжаю.'); }
}

const sealed = await sealVault(apiKey, password, id);
if (await openVault(sealed, password) !== apiKey.trim()) throw Error('self-check failed');
const entry = name ? {v: sealed.v, provider: id, name, ...sealed} : sealed;
const at = existing.findIndex(replaces); // keep a replaced entry in its place
const entries = at < 0 ? [...existing, entry] : existing.map((e, i) => (i === at ? entry : e)).filter((e, i) => i === at || !replaces(e));
save(entries);
console.log(`Готово: ${out} (${label(entry)}${at < 0 ? '' : ', заменил прежний'}).`);
printList(entries);
console.log('Дальше: закоммитьте и запушьте extension/vault.json, затем обновите расширение и введите этот пароль в его меню.');
