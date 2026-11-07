import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const handlers = new Map();
const cached = new Map([['/',new Response('<html>offline shell</html>')],['/app.js',new Response('cached javascript')]]);
const context = vm.createContext({
  URL, Response, location:{origin:'https://orbital-test.example'},
  self:{addEventListener:(name,fn)=>handlers.set(name,fn),skipWaiting:async()=>{},clients:{claim:async()=>{}}},
  caches:{match:async request=>cached.get(typeof request==='string'?request:new URL(request.url).pathname)?.clone(),open:async()=>({put:async()=>{},addAll:async()=>{}}),keys:async()=>[],delete:async()=>true},
  fetch:async()=>{throw new Error('Offline test — no network permitted');},
});
vm.runInContext(await readFile(new URL('../public/sw.js', import.meta.url),'utf8'),context);
const request = (path, mode='cors') => {
  let result;
  handlers.get('fetch')({request:{url:'https://orbital-test.example'+path,method:'GET',mode},respondWith:promise=>{result=promise;},waitUntil(){}});
  return result;
};
assert.equal(await (await request('/new-view','navigate')).text(),'<html>offline shell</html>');
assert.equal(await (await request('/app.js')).text(),'cached javascript');
assert.equal((await request('/missing.js')).type,'error','Missing JS must not receive cached HTML');
await assert.rejects(request('/api/market/ticker?instId=BTC-USDT'),/Offline test/,'API network errors are never replayed as cached shell');
console.log('pwa-cache: OK — navigation shell, exact assets, no HTML substitution for JS, no API replay.');
