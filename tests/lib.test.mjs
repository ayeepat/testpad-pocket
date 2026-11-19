import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {sealVault, openVault, openAny, provider, parseReply, buildBody, describeTask, explainHttp, isParamError, DEFAULT_MODEL, probeHost, fastestHost, sameAnswer, race, ask} from '../extension/lib.js';

test('vault round-trips and rejects a wrong password', async () => {
  const vault = await sealVault('  sk-test-123  ', 'correct horse battery');
  assert.equal(vault.v, 1);
  assert.ok(!JSON.stringify(vault).includes('sk-test'));
  assert.equal(await openVault(vault, 'correct horse battery'), 'sk-test-123');
  await assert.rejects(openVault(vault, 'correct horse batterY'), /wrong-password/);
  const other = await sealVault('sk-test-123', 'correct horse battery');
  assert.notEqual(other.data, vault.data, 'fresh salt and IV each time');
});

test('each password opens its own provider; a pre-2.3 single vault still opens as 302.ai', async () => {
  const a = await sealVault('sk-302', 'first password long', '302');
  const b = await sealVault('pz-key', 'second password long', 'polza');
  assert.deepEqual(await openAny([a, b], 'second password long'), {key: 'pz-key', provider: 'polza'});
  assert.deepEqual(await openAny([a, b], 'first password long'), {key: 'sk-302', provider: '302'});
  await assert.rejects(openAny([a, b], 'nope nope nope'), /wrong-password/);
  const {provider: _, ...old} = a;
  assert.deepEqual(await openAny(old, 'first password long'), {key: 'sk-302', provider: '302'});
  assert.equal(provider('polza').hosts[0], 'https://api.polza.ai/api');
  assert.equal(provider(undefined).name, '302.ai');
  assert.match(explainHttp(401, '', 'Polza.ai'), /Ключ Polza\.ai/);
});

test('parseReply tolerates fences, prose, numbers and raw newlines', () => {
  assert.deepEqual(parseReply('```json\n{"work":"I = 2·44100·16·10","answer":"1 722,7 Кбайт","values":[2]}\n```'),
    {work: 'I = 2·44100·16·10', answer: '1 722,7 Кбайт', values: ['2']});
  assert.deepEqual(parseReply('Вот ответ: {"work":"строка 1\nстрока 2","answer":"3","values":["1, 3"]} конец').values, ['1, 3']);
  assert.equal(parseReply('{"work":"строка 1\nстрока 2","answer":"3","values":[]}').work, 'строка 1\nстрока 2');
  assert.deepEqual(parseReply('Просто текст без JSON'), {work: 'Просто текст без JSON', answer: '', values: []});
});

test('request carries the model, effort, prompt, formula and fields', () => {
  const task = {question: 'Сколько байт?', fields: [{kind: 'radio', label: '', options: ['10', '20']}, {kind: 'text', label: 'Кбайт', options: []}], images: ['data:image/jpeg;base64,BBB']};
  const body = buildBody({model: DEFAULT_MODEL, effort: 'high', task, formula: 'data:image/jpeg;base64,AAA'});
  assert.equal(body.model, 'gemini-3.8-flash');
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.stream, true);
  assert.match(body.messages[0].content, /по-русски/);
  assert.match(body.messages[0].content, /перепроверь/);
  assert.match(body.messages[0].content, /только шаги/);
  const [text, formula, image] = body.messages[1].content;
  assert.match(text.text, /1\. один вариант: 1\) 10; 2\) 20\n2\. поле ввода \(подпись: Кбайт\)/);
  assert.equal(formula.image_url.url, 'data:image/jpeg;base64,AAA');
  assert.equal(image.image_url.url, 'data:image/jpeg;base64,BBB');
  assert.equal(buildBody({model: 'm', effort: '', task, formula: null}).reasoning_effort, undefined);
  assert.match(describeTask({question: 'q', fields: []}), /нет полей/);
});

test('302.ai errors become readable', () => {
  assert.match(explainHttp(401, ''), /Ключ/);
  assert.match(explainHttp(402, '{"error":{"message":"insufficient balance"}}'), /баланс/);
  assert.match(explainHttp(400, '{"error":{"message":"model gemini-x does not exist"}}'), /Модель/);
  assert.ok(isParamError(400, '{"error":{"err_code":-10003,"message":"Parameter error"}}'));
  assert.ok(!isParamError(500, 'Parameter error'));
});

// The route probe against real local servers that behave like the cases we see in Russia.

function server(kind) {
  const s = http.createServer((req, res) => {
    let got = 0;
    req.on('data', c => { got += c.length; });
    req.on('end', () => {
      if (kind === 'freeze') return; // a throttled cloud: the connection just stops
      if (kind === 'reset') return req.socket.destroy();
      if (kind === 'portal') return res.end('<html>Войдите в Wi-Fi</html>'.padEnd(20000));
      if (req.method === 'GET') return res.end('<html>' + 'x'.repeat(24000));
      if (got < 90000) { res.statusCode = 400; return res.end('small body'); }
      res.statusCode = 401; res.end('{"error":{"message":"Missing 302 Apikey"}}');
    });
  });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({url: `http://127.0.0.1:${s.address().port}`, close: () => s.closeAllConnections() || s.close()})));
}

test('probe passes only a host that moves real-sized data both ways', async () => {
  const [good, freeze, reset, portal] = await Promise.all(['good', 'freeze', 'reset', 'portal'].map(server));
  try {
    assert.ok(await probeHost(good.url, AbortSignal.timeout(3000)) >= 0);
    await assert.rejects(probeHost(freeze.url, AbortSignal.timeout(500)));
    await assert.rejects(probeHost(reset.url, AbortSignal.timeout(3000)));
    await assert.rejects(probeHost(portal.url, AbortSignal.timeout(3000)), /gateway|short/);
    // The working host wins even when listed after a frozen one; nothing passes -> null, within the timeout.
    assert.equal((await fastestHost([freeze.url, reset.url, good.url], 3000)).host, good.url);
    const t0 = Date.now();
    assert.equal(await fastestHost([freeze.url, portal.url], 600), null);
    assert.ok(Date.now() - t0 < 1500, 'gives up at the timeout');
  } finally { [good, freeze, reset, portal].forEach(s => s.close()); }
});

// ---------- two providers on one account ----------

test('an entry can carry a second key on another provider, behind the same password', async () => {
  const dual = await sealVault('sk-302', 'my own long password', '302', {provider: 'polza', key: ' pz-key '});
  const plain = await sealVault('pz-other', 'someone else password', 'polza');
  assert.ok(!JSON.stringify(dual).includes('pz-key'));
  assert.equal(dual.race.provider, 'polza');
  assert.notEqual(dual.race.iv, dual.iv, 'own IV for the second key');
  assert.deepEqual(await openAny([plain, dual], 'my own long password'),
    {key: 'sk-302', provider: '302', race: {key: 'pz-key', provider: 'polza'}});
  assert.deepEqual(await openAny([plain, dual], 'someone else password'), {key: 'pz-other', provider: 'polza'});
  assert.equal(await openVault(dual, 'my own long password'), 'sk-302', 'older code still opens the main key');
  await assert.rejects(openAny([plain, dual], 'nope nope nope'), /wrong-password/);
});

test('answers agree when the fill values do, read the way each field reads them', () => {
  const f = [{kind: 'checkbox'}, {kind: 'text'}, {kind: 'radio'}];
  const r = (...values) => ({answer: 'x', values});
  assert.equal(sameAnswer(f, r('1,3', '1 722,7', '2'), r('3, 1', '1722.7', ' 2 ')), true);
  assert.equal(sameAnswer(f, r('1,3', '1722,7', '2'), r('1', '1722,7', '2')), false);
  assert.equal(sameAnswer(f, r('1,3', '1722,7', '2'), r('1,3', '1722,8', '2')), false);
  assert.equal(sameAnswer(f, r('1,3', '', '2'), r('1,3', '5', '2')), false, 'one left a field empty');
  assert.equal(sameAnswer([{kind: 'text'}], r('Ёлка.'), r('елка')), true);
  // No fields (or no values): the answer lines decide; nothing to compare -> null.
  assert.equal(sameAnswer([], {answer: '42 Кбайт', values: []}, {answer: '42  кбайт', values: []}), true);
  assert.equal(sameAnswer([], {answer: '42', values: []}, {answer: '43', values: []}), false);
  assert.equal(sameAnswer([], {answer: '', values: []}, {answer: '43', values: []}), null);
});

test('race: the first success leads, the other follows; failures wait for a success', async () => {
  const after = (ms, value, fail) => () => new Promise((ok, no) => setTimeout(() => fail ? no(Error(value)) : ok({answer: value, values: []}), ms));
  const run = async jobs => { const seen = []; await race(jobs, e => seen.push(e), (a, b) => a.answer === b.answer); return seen; };
  const brief = seen => seen.map(e => e.first ? `first ${e.first.id} ${e.first.reply.answer}`
    : e.other ? `other ${e.other.id} ${e.other.error ? 'error ' + e.other.error.message : e.other.reply.answer + ' ' + e.other.same}`
    : `failed ${e.failed.map(f => f.id + ':' + f.error.message).join(',')}`);

  assert.deepEqual(brief(await run([{id: '302', run: after(40, '7')}, {id: 'polza', run: after(5, '7')}])),
    ['first polza 7', 'other 302 7 true']);
  assert.deepEqual(brief(await run([{id: '302', run: after(5, '7')}, {id: 'polza', run: after(40, '8')}])),
    ['first 302 7', 'other polza 8 false']);
  // The faster one fails: the slower success still leads, and the failure is reported right after it.
  assert.deepEqual(brief(await run([{id: '302', run: after(5, 'down', true)}, {id: 'polza', run: after(30, '7')}])),
    ['first polza 7', 'other 302 error down']);
  assert.deepEqual(brief(await run([{id: '302', run: after(30, 'slow', true)}, {id: 'polza', run: after(5, '7')}])),
    ['first polza 7', 'other 302 error slow']);
  assert.deepEqual(brief(await run([{id: '302', run: after(5, 'a', true)}, {id: 'polza', run: after(10, 'b', true)}])),
    ['failed 302:a,polza:b']);
  assert.deepEqual(brief(await run([{id: '302', run: after(1, '7')}])), ['first 302 7'], 'one provider: just the answer');
});

test('ask streams the answer, passes over a host that rejects the key, retries without effort', async () => {
  const hits = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body);
      hits.push({path: req.url, auth: req.headers.authorization, effort: json.reasoning_effort ?? null, model: json.model});
      if (req.url.startsWith('/nokey')) { res.statusCode = 401; return res.end('{"error":{"message":"bad key"}}'); }
      if (json.reasoning_effort) { res.statusCode = 400; return res.end('{"error":{"message":"unknown parameter reasoning_effort"}}'); }
      res.setHeader('content-type', 'text/event-stream');
      const reply = JSON.stringify({work: '3+4', answer: '7', values: ['2']});
      for (const part of [reply.slice(0, 10), reply.slice(10)]) res.write(`data: ${JSON.stringify({choices: [{delta: {content: part}}]})}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(ok => s.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const out = await ask({key: 'pz', id: 'polza', hosts: [base + '/nokey', base + '/ok'], model: 'm', effort: 'high',
      task: {question: 'q', fields: [], images: []}, formula: null});
    assert.deepEqual(out, {reply: {work: '3+4', answer: '7', values: ['2']}, host: base + '/ok', skipped: true});
    assert.deepEqual(hits.map(h => [h.path, h.effort]), [['/nokey/v1/chat/completions', 'high'], ['/ok/v1/chat/completions', 'high'], ['/ok/v1/chat/completions', null]]);
    assert.ok(hits.every(h => h.auth === 'Bearer pz' && h.model === 'm'));
    await assert.rejects(ask({key: 'pz', id: 'polza', hosts: [base + '/nokey'], model: 'm', effort: '', task: {question: 'q', fields: [], images: []}}), /Ключ Polza\.ai не принят/);
  } finally { s.closeAllConnections(); s.close(); }
});
