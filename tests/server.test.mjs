import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';

test('password gates upstream requests, with the requested model and formula', async t=>{
  const portProbe=createServer().listen(0,'127.0.0.1');
  await once(portProbe,'listening');
  const port=portProbe.address().port;
  await new Promise(done=>portProbe.close(done));
  const stub=`globalThis.fetch=async(url,opts)=>{
    const body=JSON.parse(opts.body);
    if(url!=='https://api.302.ai/v1/chat/completions' || opts.headers.Authorization!=='Bearer test-only' ||
       body.model!=='gemini-3.8-flash' || body.reasoning_effort!=='high' ||
       !body.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,/9j/')) throw Error();
    return Response.json({choices:[{message:{content:JSON.stringify({answer:'2000',work:'1 × 1000 × 8 × 2 / 8 = 2000 байт.',values:['2000']})}}]});
  }`;
  const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(stub),'server/main.mjs'],{
    env:{...process.env,PORT:String(port),API_302_KEY:'test-only',SOLVER_PASSWORD:'fixture-pass-123'}});
  t.after(()=>child.kill());
  const origin='http://127.0.0.1:'+port;
  for(let i=0;i<100;i++){try{await fetch(origin+'/health');break;}catch{await new Promise(done=>setTimeout(done,20));}}
  const headers={authorization:'Bearer '+Buffer.from('fixture-pass-123').toString('base64')};
  const post=(path,data,auth=headers)=>fetch(origin+path,{method:'POST',headers:auth,body:JSON.stringify(data)});
  assert.equal((await post('/solve',{},{ })).status,401);
  assert.equal((await post('/unlock',{})).status,200);
  assert.equal((await post('/solve',{question:'x',fields:[],images:['bad']})).status,400);
  const result=await (await post('/solve',{question:'Объём звука в байтах?',fields:[{kind:'text'}],images:[]})).json();
  assert.deepEqual(result.values,['2000']);
});
