import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = source.slice(0, source.indexOf('instrumentSearchController = createInstrumentSearch({'));
const now = Date.now();
const candles = Array.from({length:30}, (_, i) => [String(now-i*3600000),'100','102','98',String(100+i/100),'2']);
const catalog = [
  {instId:'BTC-USDT-SWAP',instType:'SWAP',state:'live',ctType:'linear',baseCcy:'BTC',settleCcy:'USDT',ctVal:'0.01',ctValCcy:'BTC',minSz:'0.01',lotSz:'0.01',tickSz:'0.1',maxLever:'50'},
  {instId:'ETH-USDT-SWAP',instType:'SWAP',state:'live',ctType:'linear',baseCcy:'ETH',settleCcy:'USDT',ctVal:'0.1',ctValCcy:'ETH',minSz:'0.1',lotSz:'0.1',tickSz:'0.01',maxLever:'50'},
];
const fixture = (url, asset = 'BTC-USDT-SWAP') => {
  if (url.includes('/instruments')) return {code:'0',data:catalog};
  if (url.includes('/ticker?')) return {code:'0',data:[{instId:asset,last:'101',open24h:'100',vol24h:'123',high24h:'105',low24h:'95',ts:String(now)}]};
  if (url.includes('/candles?')) return {code:'0',data:candles};
  if (url.includes('/books?')) return {code:'0',data:[{asks:[['101.1','2']],bids:[['101','3']],ts:String(now)}]};
  if (url.includes('/trades?')) return {code:'0',data:[{instId:asset,px:'101',sz:'1',side:'buy',ts:String(now)}]};
  throw new Error('Unexpected route');
};
const create = fetcher => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent:'',innerHTML:'',value:'',className:'',disabled:false,hidden:false,style:{},classList:{toggle(){},add(){},remove(){}},setAttribute(){},addEventListener(){},append(){},replaceChildren(){},getBoundingClientRect:()=>({width:0,height:0})});
    elements.get(id).parentElement = {classList:{toggle(){}}};
    return elements.get(id);
  };
  const context = vm.createContext({assert,console:{warn(){}},document:{querySelector:element,createElement:()=>({addEventListener(){},remove(){}})},window:{devicePixelRatio:1},localStorage:{getItem:()=>null,setItem(){}},URL,AbortSignal,fetch:fetcher});
  vm.runInContext(functions, context);
  vm.runInContext(`state.instrument = ${JSON.stringify(catalog[0])}; state.instruments = ${JSON.stringify(catalog)};`, context);
  return {context, element, run: code => vm.runInContext(code, context)};
};
const response = value => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});

{
  const app = create(async url => response(fixture(url)));
  assert.equal(await app.run('loadInstruments()'), true);
  app.run("assert.equal(state.instruments.length,2); assert.equal(state.instrument.ctVal,'0.01'); assert.equal(state.asset,'BTC-USDT-SWAP')");
  assert.equal(app.element('#instrumentCount').textContent, '2 PAIR AKTIF');
}
{
  const app = create(async url => response(fixture(url)));
  app.run(`state.instrument = ${JSON.stringify(catalog[0])}; renderOrderBook({asks:[[101,1],[102,2],[103,3]],bids:[[100,1],[99,2],[98,3]],ts:${now}})`);
  const asks = app.element('#bookAsks').innerHTML;
  const bids = app.element('#bookBids').innerHTML;
  assert.ok(asks.indexOf('<span>6.14</span>') < asks.indexOf('<span>3.05</span>'), 'Ask notional accumulates from the best ask before display is reversed');
  assert.ok(asks.includes('<span>1.01</span>'), 'Best ask shows the first level notional');
  assert.ok(bids.includes('<span>5.92</span>'), 'Bid notional accumulates across visible depth');
}
{
  const app = create(async url => response(fixture(url)));
  await app.run('loadMarket()');
  app.run("assert.equal(state.connected,true); assert.equal(state.price,101); assert.equal(state.candles.length,30); assert.equal(state.loading,false)");
  assert.match(app.element('#bookAsks').innerHTML, /book-row ask/);
  assert.match(app.element('#recentTrades').innerHTML, /tape-row buy/);
  assert.notEqual(app.element('#marketHigh').textContent,'—');
}
{
  const app = create(async url => {
    if (url.includes('/books?') || url.includes('/trades?')) throw new Error('No depth');
    return response(fixture(url));
  });
  await app.run('loadMarket()');
  app.run('assert.equal(state.connected,true); assert.equal(state.price,101)');
  assert.match(app.element('#bookAsks').innerHTML,/tidak tersedia/);
}
{
  const app = create(async url => response(url.includes('/candles?') ? {code:'0',data:candles.slice(0,2)} : fixture(url)));
  await app.run('loadMarket()');
  app.run('assert.equal(state.price,null); assert.equal(state.connected,false); assert.equal(state.loading,false)');
  assert.equal(app.element('#paperTradeBtn').disabled,true);
  assert.match(app.element('#signalHint').textContent,/Menunggu data/);
}
{
  const app = create(async () => {throw new TypeError('Failed to fetch');});
  await app.run('loadMarket()');
  assert.equal(app.element('#paperTradeBtn').disabled,true);
  assert.match(app.element('#chartEmpty').textContent,/Backend aplikasi tidak terjangkau/);
  assert.equal(app.element('#refreshBtn').disabled,false);
}
{
  const resolvers = [];
  const app = create(url => {
    if (url.includes('instId=BTC-USDT-SWAP') && (url.includes('/ticker?') || url.includes('/candles?'))) return new Promise(resolve => resolvers.push(() => resolve(response(fixture(url)))));
    return Promise.resolve(response(fixture(url,'ETH-USDT-SWAP')));
  });
  const loading = app.run('loadMarket()');
  app.run("state.asset='ETH-USDT-SWAP'; state.instrument=state.instruments[1]; loadMarket()");
  resolvers.forEach(resolve => resolve());
  await loading;
  await new Promise(resolve => setImmediate(resolve));
  app.run("assert.equal(state.asset,'ETH-USDT-SWAP'); assert.equal(state.connected,true); assert.equal(state.pendingMarketReload,false)");
  assert.equal(app.element('#chartAsset').textContent,'ETH-USDT-SWAP');
}
console.log('market-client: OK — dynamic linear USDT catalog, complete/partial market data, independent depth errors, network failure and Swap asset-switch race; no real network or orders.');
