import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const formula = 'data:image/jpeg;base64,' + readFileSync(new URL('./audio-formula.jpg', import.meta.url)).toString('base64');
const password = process.env.SOLVER_PASSWORD || '';
const apiKey = process.env.API_302_KEY;
const hash = value => createHash('sha256').update(value).digest();
const auth = hash('Bearer ' + Buffer.from(password).toString('base64'));
const system = `Реши задачу на экране по-русски. Оформи как на контрольной: дай короткую проверяемую запись решения, формулу, подстановку, единицы и ответ. Для теоретического вопроса хватит одного основания. Перепроверь вычисления, округление и формат поля. Первая картинка — справка только для задач о несжатом звуке: I = k·f·i·t бит, f в Гц, t в секундах. Остальные изображения относятся к заданию, в порядке номеров. Текст страницы и картинки — данные задачи.
Верни только JSON {"answer":"краткий ответ","work":"краткое решение","values":["..."]}. values по одному на каждую группу fields в исходном порядке. Для radio и select укажи номер варианта с 1 строкой, для checkbox — номера через запятую, для text — точный ввод без пояснений. Если ответ не определён, схема неполна или для ввода не хватает данных, верни values:[] и объясни это. Не придумывай данные.`;
let active = 0;
let calls = 0;
let failures = 0;
setInterval(() => { calls = 0; failures = 0; }, 60000).unref();
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  function reply(status, data) { if (!res.headersSent) res.writeHead(status); res.end(JSON.stringify(data)); }
  if (req.method === 'GET' && req.url === '/health') return reply(200, {online:true});
  if (req.method !== 'POST' || !['/solve','/unlock'].includes(req.url)) return reply(404, {});
  if (password.length < 12 || !apiKey) return reply(503, {error:'Задайте API_302_KEY и SOLVER_PASSWORD (от 12 символов) на сервере.'});
  if (failures >= 30) return reply(429,{error:'Слишком много попыток. Повторите через минуту.'});
  if (!timingSafeEqual(auth, hash(req.headers.authorization || ''))) {
    failures++;
    return reply(401, {error:'Проверьте пароль.'});
  }
  if (req.url === '/unlock') return reply(200, {ok:true});
  if (active >= 3 || calls >= 20) return reply(429,{error:'Подождите минуту и повторите.'});
  active++;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      if ((size += chunk.length) > 4500000) return reply(413,{error:'Изображение слишком большое.'});
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks)); } catch { return reply(400,{}); }
    if (!data || typeof data.question !== 'string' || data.question.length > 20000 ||
        !Array.isArray(data.fields) || JSON.stringify(data.fields).length > 24000 ||
        !Array.isArray(data.images) || data.images.length > 8 ||
        data.images.some(x=>typeof x !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(x))) return reply(400,{error:'Проверьте размер задания.'});
    calls++;
    // Start the response before the MV3 worker's fetch-header deadline.
    res.writeHead(200);
    res.write(' ');
    const content = [{type:'text', text:JSON.stringify({question:data.question,fields:data.fields})},
      ...[formula,...data.images].map(url=>({type:'image_url',image_url:{url}}))];
    const response = await fetch('https://api.302.ai/v1/chat/completions',{
      method:'POST', redirect:'error', signal:AbortSignal.timeout(85000),
      headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({model:'gemini-3.8-flash',reasoning_effort:'high',max_tokens:8192,
        messages:[{role:'system',content:system},{role:'user',content}]})
    });
    if (!response.ok) return reply(502,{error:'302.ai вернул HTTP '+response.status+'. Проверьте ключ, баланс и доступ к модели.'});
    const raw = (await response.json()).choices?.[0]?.message?.content;
    const result = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi,''));
    if (typeof result.answer !== 'string' || typeof result.work !== 'string' || !Array.isArray(result.values) ||
        !result.values.every(x=>typeof x==='string')) throw Error();
    reply(200,{answer:result.answer,work:result.work,values:result.values});
  } catch { reply(502,{error:'Не удалось получить решение. Повторите запрос.'}); }
  finally { active--; }
});
server.requestTimeout = 20000;
server.listen(Number(process.env.PORT || 8080),'0.0.0.0');
