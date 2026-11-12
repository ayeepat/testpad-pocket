import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {sealVault, openVault, parseReply, buildBody, describeTask, explainHttp, isParamError, DEFAULT_MODEL, probeHost, fastestHost} from '../extension/lib.js';

test('vault round-trips and rejects a wrong password', async () => {
  const vault = await sealVault('  sk-test-123  ', 'correct horse battery');
  assert.equal(vault.v, 1);
  assert.ok(!JSON.stringify(vault).includes('sk-test'));
  assert.equal(await openVault(vault, 'correct horse battery'), 'sk-test-123');
  await assert.rejects(openVault(vault, 'correct horse batterY'), /wrong-password/);
  const other = await sealVault('sk-test-123', 'correct horse battery');
  assert.notEqual(other.data, vault.data, 'fresh salt and IV each time');
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
