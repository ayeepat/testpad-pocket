import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync} from 'node:fs';
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
