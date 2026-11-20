import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openAny} from '../extension/lib.js';

const SEAL = fileURLToPath(new URL('../tools/seal.mjs', import.meta.url));

// Runs the seal tool against a scratch vault; resolves {code, stdout, stderr}.
function seal(out, args, env = {}) {
  return new Promise(resolve => execFile(process.execPath, [SEAL, '--no-check', '--out', out, ...args],
    {env: {PATH: process.env.PATH, ...env}},
    (err, stdout, stderr) => resolve({code: err ? err.code : 0, stdout, stderr})));
}
const read = out => JSON.parse(readFileSync(out, 'utf8'));
const shape = out => read(out).map(e => [e.name || null, e.provider]);

test('named accounts sit next to the unnamed ones and replace only themselves', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'tpp-seal-')), 'vault.json');
  const ok = async (args, key, password) => {
    const r = await seal(out, args, {API_KEY: key, VAULT_PASSWORD: password});
    assert.equal(r.code, 0, r.stderr);
    return r;
  };
  await ok([], 'sk-302', 'password for 302');
  await ok(['--provider', 'polza'], 'pz-main', 'password for polza');
  await ok(['--provider', 'polza', '--name', 'Liza'], 'pz-liza', 'password for liza');
  assert.deepEqual(shape(out), [[null, '302'], [null, 'polza'], ['Liza', 'polza']]);

  // Same name again: only Liza changes, in place. No name: only the unnamed Polza entry changes.
  const before = read(out);
  await ok(['--provider', 'polza', '--name', 'Liza'], 'pz-liza-2', 'new password for liza');
  await ok(['--provider', 'polza'], 'pz-main-2', 'password for polza');
  const after = read(out);
  assert.deepEqual(after[0], before[0]);
  assert.deepEqual(shape(out), [[null, '302'], [null, 'polza'], ['Liza', 'polza']]);
  assert.deepEqual(await openAny(after, 'new password for liza'), {key: 'pz-liza-2', provider: 'polza'});
  assert.deepEqual(await openAny(after, 'password for polza'), {key: 'pz-main-2', provider: 'polza'});
  await assert.rejects(openAny(after, 'password for liza'), /wrong-password/);

  // A password that opens any other entry, or a short one, is refused and the vault is left alone.
  const taken = await seal(out, ['--provider', 'polza', '--name', 'Masha'], {API_KEY: 'pz-m', VAULT_PASSWORD: 'new password for liza'});
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, /уже открывает ключ «Liza — Polza\.ai»/);
  const short = await seal(out, ['--provider', 'polza', '--name', 'Masha'], {API_KEY: 'pz-m', VAULT_PASSWORD: 'Short6767'});
  assert.equal(short.code, 1);
  assert.match(short.stderr, /короче 12/);
  assert.deepEqual(read(out), after);

  const list = await seal(out, ['--list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /Ключей в хранилище: 3\n {2}\(без имени\) — 302\.ai\n {2}\(без имени\) — Polza\.ai\n {2}Liza — Polza\.ai/);

  const missing = await seal(out, ['--remove', 'Masha']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Нет ключа с именем «Masha»/);
  const removed = await seal(out, ['--remove', 'Liza']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /Ключей в хранилище: 2/);
  assert.deepEqual(read(out), after.slice(0, 2));
});

test('--race adds a second key to the account its password opens, and --race off takes it away', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'tpp-race-')), 'vault.json');
  const run = (args, env) => seal(out, args, env);
  for (const [args, key, password] of [[[], 'sk-302', 'password for 302'], [['--provider', 'polza'], 'pz-main', 'password for polza'],
    [['--provider', 'polza', '--name', 'Liza'], 'pz-liza', 'password for liza']]) {
    assert.equal((await run(args, {API_KEY: key, VAULT_PASSWORD: password})).code, 0);
  }
  const before = read(out);

  const added = await run(['--race', 'polza'], {VAULT_PASSWORD: 'password for 302', RACE_KEY: 'pz-race'});
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /\(без имени\) — 302\.ai \+ Polza\.ai \(гонка\)\n {2}\(без имени\) — Polza\.ai\n {2}Liza — Polza\.ai/);
  let after = read(out);
  assert.deepEqual(after.slice(1), before.slice(1), 'other accounts untouched');
  assert.deepEqual(await openAny(after, 'password for 302'), {key: 'sk-302', provider: '302', race: {key: 'pz-race', provider: 'polza'}});
  assert.deepEqual(await openAny(after, 'password for liza'), {key: 'pz-liza', provider: 'polza'});

  // The account's own settings stay through every re-seal below.
  const prefs = {'302': {model: 'gpt-6.2-sol', effort: 'medium'}};
  writeFileSync(out, JSON.stringify(read(out).map((e, i) => (i === 0 ? {...e, prefs} : e))));
  assert.equal((await run(['--race', 'polza'], {VAULT_PASSWORD: 'password for 302', RACE_KEY: 'pz-race'})).code, 0);
  assert.deepEqual(read(out)[0].prefs, prefs, 'kept by --race');
  after = read(out);

  // Wrong password, or a second key on the account's own provider: refused, vault unchanged.
  const wrong = await run(['--race', 'polza'], {VAULT_PASSWORD: 'not a password here', RACE_KEY: 'x'});
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /не открывает ни один ключ/);
  const same = await run(['--race', 'polza'], {VAULT_PASSWORD: 'password for liza', RACE_KEY: 'x'});
  assert.equal(same.code, 1);
  assert.match(same.stderr, /Второй должен быть на другом провайдере/);
  assert.deepEqual(read(out), after);

  // A new 302.ai key with the same password keeps the second key; a new password drops it, with a note.
  assert.equal((await run([], {API_KEY: 'sk-302-new', VAULT_PASSWORD: 'password for 302'})).code, 0);
  assert.deepEqual(await openAny(read(out), 'password for 302'), {key: 'sk-302-new', provider: '302', race: {key: 'pz-race', provider: 'polza'}, prefs});
  const moved = await run([], {API_KEY: 'sk-302-new', VAULT_PASSWORD: 'brand new password'});
  assert.match(moved.stdout, /не перенесён: пароль новый/);
  assert.deepEqual(await openAny(read(out), 'brand new password'), {key: 'sk-302-new', provider: '302', prefs});

  assert.equal((await run(['--race', 'polza'], {VAULT_PASSWORD: 'brand new password', RACE_KEY: 'pz-race'})).code, 0);
  const off = await run(['--race', 'off'], {VAULT_PASSWORD: 'brand new password'});
  assert.equal(off.code, 0, off.stderr);
  assert.deepEqual(await openAny(read(out), 'brand new password'), {key: 'sk-302-new', provider: '302', prefs});
  assert.equal((await run(['--race', 'off'], {VAULT_PASSWORD: 'brand new password'})).code, 1, 'nothing to take away');
});
