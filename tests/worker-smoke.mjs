import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { default: worker, OrderGuard, AutoTrader } = await import(moduleUrl);
const env = { ASSETS: { fetch: async () => new Response('asset') } };
const request = (path, init) => new Request(`https://orbital-test.example${path}`, init);

const statusResponse = await worker.fetch(request('/api/status'), env);
assert.equal(statusResponse.status, 200);
const status = await statusResponse.json();
assert.equal(status.marketProxy, true);
assert.equal(status.accountReadAvailable, false);
assert.equal(status.accountMode, 'disabled');
assert.equal(status.tradingAvailable, false);
assert.equal(status.tradingMode, 'disabled');

const adminToken = 'test-admin-token-' + 'x'.repeat(32);
let autoTraderCalls = 0;
const configuredAutoEnv = {
  ...env,
  ORBITAL_ADMIN_TOKEN: adminToken,
  OKX_API_KEY: 'test-key',
  OKX_API_SECRET: 'test-secret',
  OKX_API_PASSPHRASE: 'test-passphrase',
  ORBITAL_TRADING_ENABLED: 'true',
  ORBITAL_ORDER_GUARD: {},
  ORBITAL_CHALLENGE_SECRET: 'c'.repeat(32),
  ORBITAL_AUTO_TRADING_ENABLED: 'true',
  ORBITAL_AUTO_TRADING_ACK: 'I_ACCEPT_AUTO_TRADING_RISK',
  ORBITAL_AUTO_TRADER: { get() { autoTraderCalls++; throw new Error('Oversized body must not reach storage'); } },
};
const oversizedBody = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(`{"value":"${'x'.repeat(5000)}"}`));
    controller.close();
  },
});
const oversizedRequest = request('/api/auto/start', {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: oversizedBody,
  duplex: 'half',
});
assert.equal(oversizedRequest.headers.get('content-length'), null, 'Streaming request fixture has no Content-Length header');
const oversizedResponse = await worker.fetch(oversizedRequest, configuredAutoEnv);
assert.equal(oversizedResponse.status, 400, 'Actual streamed bytes above the JSON limit are rejected without Content-Length');
assert.equal(autoTraderCalls, 0, 'Rejected request must not reach Durable Object storage');

const quoteResponse = await worker.fetch(request('/api/live/quote', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instId: 'BTC-USDT-SWAP', side: 'buy', sz: '0.001', px: '50000' }),
}), env);
assert.equal(quoteResponse.status, 503, 'Order quotes stay disabled without the private backend and guard');

const orderResponse = await worker.fetch(request('/api/live/order', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instId: 'BTC-USDT-SWAP', side: 'buy', sz: '0.001', px: '50000', confirmText: 'KIRIM ORDER LIVE' }),
}), env);
assert.equal(orderResponse.status, 503, 'Order submission stays disabled without the private backend and guard');

const crossOriginResponse = await worker.fetch(request('/api/status', {
  headers: { origin: 'https://attacker.example' },
}), env);
assert.equal(crossOriginResponse.status, 403);

const invalidInstrumentResponse = await worker.fetch(request('/api/market/ticker?instId=BTC-USDT'), env);
assert.equal(invalidInstrumentResponse.status, 400);

const assetResponse = await worker.fetch(request('/'), env);
assert.equal(await assetResponse.text(), 'asset');

const data = new Map();
const ctx = {
  storage: {
    transaction: async callback => callback({
      get: async key => data.get(key),
      put: async (key, value) => { data.set(key, value); },
    }),
    setAlarm: async () => {},
    delete: async key => { data.delete(key); },
  },
};
const guard = new OrderGuard(ctx);
const clOrdId = 'orb' + 'a'.repeat(29);
const guardRequest = path => new Request(`https://order-guard${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clOrdId }),
});
const firstReservation = await guard.fetch(guardRequest('/reserve'));
assert.equal(firstReservation.status, 201, 'A fresh signed order may be reserved once');
const replayReservation = await guard.fetch(guardRequest('/reserve'));
assert.equal(replayReservation.status, 409, 'A pending reservation must not be sent again');

const completeRequest = new Request('https://order-guard/complete', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clOrdId, outcome: { ok: true, order: { orderId: 'paper-test-id' } } }),
});
assert.equal((await guard.fetch(completeRequest)).status, 200);
const idempotentRetry = await guard.fetch(guardRequest('/reserve'));
assert.equal(idempotentRetry.status, 200, 'A completed retry returns the saved outcome instead of sending a new order');
assert.equal((await idempotentRetry.json()).outcome.order.orderId, 'paper-test-id');

const originalFetch = globalThis.fetch;
const upstreamCalls = [];
const cacheEntries = new Map();
const cacheTtls = new Map();
const originalCaches = globalThis.caches;
globalThis.caches = { default: {
  match: async key => cacheEntries.get(String(key.url))?.clone(),
  put: async (key, value) => { cacheEntries.set(String(key.url), value.clone()); cacheTtls.set(String(key.url), value.headers.get('cache-control')); },
  delete: async key => cacheEntries.delete(String(key.url)),
} };
const candleRows = Array.from({ length: 15 }, (_, i) => [String(1000 + i), '100', '101', '99', '100', '1', '100', '100', '1']);
const instrumentRows = [
  {instId:'BTC-USDT-SWAP',instType:'SWAP',state:'live',settleCcy:'USDT',ctType:'linear',baseCcy:'',ctVal:'0.01',ctValCcy:'BTC',minSz:'0.01',lotSz:'0.01',tickSz:'0.1',lever:'50'},
  {instId:'ETH-USDT-SWAP',instType:'SWAP',state:'live',settleCcy:'USDT',ctType:'linear',baseCcy:'ETH',ctVal:'0.1',ctValCcy:'ETH',minSz:'0.1',lotSz:'0.1',tickSz:'0.01',lever:'50'},
  {instId:'BTC-USD-SWAP',instType:'SWAP',state:'live',settleCcy:'BTC',ctType:'inverse',baseCcy:'BTC',ctVal:'100',ctValCcy:'USD',minSz:'1',lotSz:'1',tickSz:'0.1',lever:'50'},
  {instId:'DOGE-USDT-SWAP',instType:'SWAP',state:'suspend',settleCcy:'USDT',ctType:'linear',baseCcy:'DOGE',ctVal:'10',ctValCcy:'DOGE',minSz:'1',lotSz:'1',tickSz:'0.0001',lever:'20'},
  {instId:'XSS-USDT-SWAP',instType:'SWAP',state:'live',settleCcy:'USDT',ctType:'linear',baseCcy:'XSS"><img',ctVal:'1',ctValCcy:'XSS',minSz:'1',lotSz:'1',tickSz:'0.01',lever:'10'},
];
let marketMock = async url => {
  upstreamCalls.push(url.pathname);
  if (url.pathname === '/api/v5/public/instruments') return new Response(JSON.stringify({code:'0',data:instrumentRows}));
  if (url.pathname === '/api/v5/market/tickers') return new Response(JSON.stringify({ code:'0', data:[{instId:'BTC-USDT-SWAP',last:'100',ts:'1000'},{instId:'XRP-USDT-SWAP',last:'2',ts:'1'}] }));
  if (url.pathname === '/api/v5/market/history-candles') {
    const data = url.searchParams.get('instId') === 'ETH-USDT-SWAP' ? candleRows.slice(0, 1) : candleRows;
    return new Response(JSON.stringify({ code:'0', data }));
  }
  if (url.pathname === '/api/v5/market/books') return new Response(JSON.stringify({ code:'0', data:[{asks:[['101','2']],bids:[['100','3']],ts:'1000'}] }));
  if (url.pathname === '/api/v5/market/trades') return new Response(JSON.stringify({ code:'0', data:[{instId:'BTC-USDT-SWAP',px:'100',sz:'0.2',side:'buy',ts:'1000'}] }));
  return new Response(JSON.stringify({ code:'50011', msg:'Too Many Requests' }), { status:429 });
};
globalThis.fetch = async input => marketMock(new URL(String(input)));
try {
  const catalogResponse = await worker.fetch(request('/api/market/instruments'), env);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.deepEqual(catalog.data.map(row => row.instId), ['BTC-USDT-SWAP','ETH-USDT-SWAP'], 'Only live linear USDT-settled swaps are listed');
  assert.equal(catalog.data[0].baseCcy, 'BTC', 'Derivative metadata with empty baseCcy is safely derived from the validated swap ID');
  assert.equal(catalog.data[0].ctVal, '0.01');
  assert.equal(catalog.data[0].maxLever, '50');
  const tickerFallback = await worker.fetch(request('/api/market/ticker?instId=BTC-USDT-SWAP'), env);
  assert.equal(tickerFallback.status, 200);
  assert.deepEqual((await tickerFallback.json()).data.map(row => row.instId), ['BTC-USDT-SWAP']);
  const candlesFallback = await worker.fetch(request('/api/market/candles?instId=BTC-USDT-SWAP&bar=1H'), env);
  assert.equal(candlesFallback.status, 200);
  assert.equal((await candlesFallback.json()).data.length, 15);
  assert.equal(upstreamCalls.length, 5, 'Catalog plus at most one fallback request are expected');

  const partialFallback = await worker.fetch(request('/api/market/candles?instId=ETH-USDT-SWAP&bar=4H'), env);
  assert.equal(partialFallback.status, 502, 'A one-row code-0 candle fallback is rejected');
  assert.equal((await partialFallback.json()).error, 'Invalid response from OKX market data');

  const mismatchedFallback = await worker.fetch(request('/api/market/ticker?instId=ETH-USDT-SWAP'), env);
  assert.equal(mismatchedFallback.status, 502, 'A fallback without a matching instrument is rejected');

  marketMock = async url => {
    upstreamCalls.push(url.pathname);
    if (url.pathname.endsWith('/ticker')) return new Response(JSON.stringify({ code:'50011',msg:'Too Many Requests' }), { status:429 });
    return new Response(JSON.stringify({ code:'51001',msg:'Fallback rejected' }), { status:503 });
  };
  const failedFallback = await worker.fetch(request('/api/market/ticker?instId=SOL-USDT-SWAP'), env);
  assert.equal(failedFallback.status, 503, 'A failed fallback keeps its relevant upstream HTTP status');
  assert.equal((await failedFallback.json()).code, '51001', 'A nonzero OKX fallback code is preserved');

  marketMock = async url => {
    upstreamCalls.push(url.pathname);
    return new Response('<html>bad gateway</html>', { status:200, headers:{ 'content-type':'text/html' } });
  };
  const htmlPayload = await worker.fetch(request('/api/market/books?instId=ETH-USDT-SWAP'), env);
  assert.equal(htmlPayload.status, 502, 'HTML from the upstream is rejected with a safe JSON error');
  assert.match(htmlPayload.headers.get('content-type'), /application\/json/);

  marketMock = async url => {
    upstreamCalls.push(url.pathname);
    if (url.pathname.endsWith('/books')) {
      assert.equal(url.searchParams.get('sz'), '8', 'Order book depth is fixed server-side');
      return new Response(JSON.stringify({ code:'0', data:[{asks:[['101','2']],bids:[['100','3']],ts:'1000'}] }));
    }
    if (url.pathname.endsWith('/funding-rate')) {
      assert.equal(url.searchParams.get('instId'), 'BTC-USDT-SWAP');
      return new Response(JSON.stringify({code:'0',data:[{instType:'SWAP',instId:'BTC-USDT-SWAP',fundingRate:'0.0001',settFundingRate:'0.00008',fundingTime:'2000',nextFundingTime:'3000',settState:'settled',ts:'1000'}]}));
    }
    if (url.pathname.endsWith('/open-interest')) {
      assert.equal(url.searchParams.get('instType'), 'SWAP', 'Open interest request is constrained to Swap');
      assert.equal(url.searchParams.get('instId'), 'BTC-USDT-SWAP');
      return new Response(JSON.stringify({code:'0',data:[{instType:'SWAP',instId:'BTC-USDT-SWAP',oi:'5000',oiCcy:'555.55',oiUsd:'50000',ts:'1000'}]}));
    }
    if (url.pathname.endsWith('/trades')) {
      assert.equal(url.searchParams.get('limit'), '20', 'Recent trade count is fixed server-side');
      return new Response(JSON.stringify({ code:'0', data:[{instId:'BTC-USDT-SWAP',px:'100',sz:'0.2',side:'buy',ts:'1000'}] }));
    }
    if (url.pathname.endsWith('/ticker')) return new Response(JSON.stringify({ code:'0', data:[{instId:'ETH-USDT-SWAP',last:'20',ts:'1000'}] }));
    throw new Error(`Unexpected market request ${url.pathname}`);
  };
  const booksResponse = await worker.fetch(request('/api/market/books?instId=BTC-USDT-SWAP&sz=999'), env);
  assert.equal(booksResponse.status, 200);
  assert.equal((await booksResponse.json()).data[0].bids.length, 1);
  const tradesResponse = await worker.fetch(request('/api/market/trades?instId=BTC-USDT-SWAP&limit=999'), env);
  assert.equal(tradesResponse.status, 200);
  assert.equal((await tradesResponse.json()).data[0].side, 'buy');
  const fundingResponse = await worker.fetch(request('/api/market/funding-rate?instId=BTC-USDT-SWAP'), env);
  assert.equal(fundingResponse.status, 200);
  assert.equal((await fundingResponse.json()).data[0].fundingRate, '0.0001');
  const interestResponse = await worker.fetch(request('/api/market/open-interest?instId=BTC-USDT-SWAP'), env);
  assert.equal(interestResponse.status, 200);
  assert.equal((await interestResponse.json()).data[0].oiUsd, '50000');
  assert.equal(cacheTtls.get('https://orbital-test.example/__orbital_market_cache/books?instId=BTC-USDT-SWAP&sz=8'), 'public, max-age=3');
  assert.equal(cacheTtls.get('https://orbital-test.example/__orbital_market_cache/trades?instId=BTC-USDT-SWAP&limit=20'), 'public, max-age=5');
  assert.equal(cacheTtls.get('https://orbital-test.example/__orbital_market_cache/funding-rate?instId=BTC-USDT-SWAP'), 'public, max-age=30');
  assert.equal(cacheTtls.get('https://orbital-test.example/__orbital_market_cache/open-interest?instType=SWAP&instId=BTC-USDT-SWAP'), 'public, max-age=30');

  marketMock = async url => {
    upstreamCalls.push(url.pathname);
    if (url.pathname.endsWith('/ticker')) return new Response(JSON.stringify({ code:'0', data:[{instId:'BTC-USDT-SWAP',last:'100',ts:'1000'}] }));
    throw new Error(`Unexpected market request ${url.pathname}`);
  };
  const tickerCacheKey = 'https://orbital-test.example/__orbital_market_cache/ticker?instId=BTC-USDT-SWAP';
  cacheEntries.set(tickerCacheKey, new Response(JSON.stringify({ code:'0',data:[{instId:'BTC-USDT-SWAP',last:'0',ts:'1'}] }), { status:200 }));
  const repairedCache = await worker.fetch(request('/api/market/ticker?instId=BTC-USDT-SWAP'), env);
  assert.equal(repairedCache.status, 200);
  assert.equal(repairedCache.headers.get('x-orbital-edge-cache'), 'MISS', 'Malformed cached data is evicted rather than served');
  assert.equal((await repairedCache.json()).data[0].last, '100');

  marketMock = async url => {
    upstreamCalls.push(url.pathname);
    if (url.pathname.endsWith('/ticker')) return new Response(JSON.stringify({ code:'0', data:[{instId:'XRP-USDT-SWAP',last:'2',ts:'1000'}] }));
    throw new Error(`Unexpected market request ${url.pathname}`);
  };
  const malformedTicker = await worker.fetch(request('/api/market/ticker?instId=SOL-USDT-SWAP'), env);
  assert.equal(malformedTicker.status, 502, 'Code-0 data for another instrument is rejected');
  assert.match(malformedTicker.headers.get('content-type'), /application\/json/);
} finally {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
}

const guardActors = new Map();
const guardNamespace = {
  idFromName: value => value,
  get: id => {
    if (!guardActors.has(id)) {
      const entries = new Map();
      guardActors.set(id, new OrderGuard({ storage: {
        transaction: async callback => callback({ get:async key => entries.get(key), put:async (key,value) => { entries.set(key,value); } }),
        setAlarm:async () => {}, delete:async key => { entries.delete(key); },
      } }));
    }
    return { fetch: (url, init) => guardActors.get(id).fetch(new Request(url, init)) };
  },
};
const fakeEnv = {
  ...env, ORBITAL_ORDER_GUARD:guardNamespace, ORBITAL_TRADING_ENABLED:'true', ORBITAL_TRADING_MODE:'demo',
  ORBITAL_AUTO_TRADING_ENABLED:'true', ORBITAL_AUTO_TRADING_ACK:'I_ACCEPT_AUTO_TRADING_RISK',
  ORBITAL_ADMIN_TOKEN:'mock-owner-token-not-a-secret-123456789', ORBITAL_CHALLENGE_SECRET:'mock-challenge-not-a-secret-123456789',
  OKX_API_KEY:'MOCK_ONLY', OKX_API_SECRET:'MOCK_ONLY', OKX_API_PASSPHRASE:'MOCK_ONLY',
};
const authHeaders = { 'content-type':'application/json', authorization:`Bearer ${fakeEnv.ORBITAL_ADMIN_TOKEN}` };
const mockOrder = { instId:'BTC-USDT-SWAP', side:'buy', tdMode:'isolated', sz:'0.1', px:'100' };
let simulatedOrderCalls = 0;
let autoOrderCalls = 0;
const privateReadCalls = [];
let autoMode = false;
let autoPositionRows = [];
let autoPendingRows = [];
let lastAutoOrder = null;
const risingThenOversold = [...Array.from({length:15}, (_, i) => 100 + i), 80];
const autoCandleStart = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 16 * 3_600_000;
const autoCandleRows = risingThenOversold.map((close, i) => {
  const previous = i ? risingThenOversold[i - 1] : close;
  return [String(autoCandleStart + i * 3_600_000), String(previous), String(Math.max(previous, close) + 2), String(Math.min(previous, close) - 2), String(close), '1', '1', '1', '1'];
}).reverse();
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.startsWith('/api/v5/account/')) privateReadCalls.push(path);
  if (path === '/api/v5/market/ticker') return new Response(JSON.stringify({code:'0',data:[{instId:'BTC-USDT-SWAP',last:autoMode?'80':'100',ts:String(Date.now())}]}));
  if (path === '/api/v5/market/candles') return new Response(JSON.stringify({code:'0',data:autoCandleRows}));
  if (path === '/api/v5/public/instruments') return new Response(JSON.stringify({code:'0',data:[{instId:'BTC-USDT-SWAP',instType:'SWAP',state:'live',settleCcy:'USDT',ctType:'linear',baseCcy:'BTC',ctVal:'0.01',ctValCcy:'BTC',minSz:'0.01',lotSz:'0.01',tickSz:'0.1',lever:'50'}]}));
  if (path === '/api/v5/account/balance') return new Response(JSON.stringify({code:'0',data:[{totalEq:'1000',details:[{ccy:'USDT',availBal:'1000'}]}]}));
  if (path === '/api/v5/account/config') return new Response(JSON.stringify({code:'0',data:[{posMode:'net_mode'}]}));
  if (path === '/api/v5/account/positions') return new Response(JSON.stringify({code:'0',data:autoPositionRows}));
  if (path === '/api/v5/trade/orders-pending') return new Response(JSON.stringify({code:'0',data:autoPendingRows}));
  if (path === '/api/v5/trade/order') {
    simulatedOrderCalls++;
    assert.equal(new Headers(init.headers).get('x-simulated-trading'), '1');
    assert.ok(new Headers(init.headers).get('OK-ACCESS-SIGN'));
    const order = JSON.parse(init.body);
    assert.equal(order.instId, 'BTC-USDT-SWAP');
    assert.equal(order.tdMode, 'isolated');
    if (order.tag === 'orbital-auto') {
      autoOrderCalls++;
      lastAutoOrder = order;
      assert.equal(order.ordType, 'market');
      assert.ok(order.attachAlgoOrds?.[0]?.slTriggerPx && order.attachAlgoOrds?.[0]?.tpTriggerPx);
      assert.equal(order.attachAlgoOrds[0].slOrdPx, '-1');
      assert.equal(order.attachAlgoOrds[0].tpOrdPx, '-1');
    } else assert.equal(order.sz, '0.1', 'SWAP sz is a number of contracts');
    return new Response(JSON.stringify({code:'0',data:[{sCode:'0',ordId:'MOCK_ORDER_NOT_REAL'}]}));
  }
  throw new Error('Unexpected mocked network request');
};
try {
  const missingAdminToken = await worker.fetch(request('/api/auto/status'), {...fakeEnv, ORBITAL_ADMIN_TOKEN:undefined});
  assert.equal(missingAdminToken.status, 401, 'Auto status rejects requests when the admin token is missing');
  const shortAdminTokenValue = 'short-admin-token-value-123456';
  assert.ok(shortAdminTokenValue.length < 32);
  const shortAdminToken = await worker.fetch(request('/api/auto/status', {
    headers:{authorization:`Bearer ${shortAdminTokenValue}`},
  }), {...fakeEnv, ORBITAL_ADMIN_TOKEN:shortAdminTokenValue});
  assert.equal(shortAdminToken.status, 401, 'Auto status rejects a matching admin token shorter than 32 characters');

  const readOnlyEnv = {
    ...fakeEnv,
    ORBITAL_ORDER_GUARD:undefined,
    ORBITAL_CHALLENGE_SECRET:undefined,
    ORBITAL_TRADING_ENABLED:'false',
    ORBITAL_AUTO_TRADING_ENABLED:'false',
  };
  const readOnlyStatusResponse = await worker.fetch(request('/api/status'), readOnlyEnv);
  const readOnlyStatus = await readOnlyStatusResponse.json();
  assert.equal(readOnlyStatus.accountReadAvailable, true, 'Private account reads are separately configured');
  assert.equal(readOnlyStatus.accountMode, 'demo');
  assert.equal(readOnlyStatus.tradingAvailable, false, 'Manual execution remains disabled');
  assert.equal(readOnlyStatus.autoTradingAvailable, false, 'Auto execution remains disabled');
  const readOnlyAccount = await worker.fetch(request('/api/private/account', {headers:authHeaders}), readOnlyEnv);
  assert.equal(readOnlyAccount.status, 200, 'Authenticated private account reads work without execution flags');
  const readOnlyPayload = await readOnlyAccount.json();
  assert.equal(readOnlyPayload.account.mode, 'demo');
  assert.equal(readOnlyPayload.account.availableUsdt, 1000);
  const lockedQuote = await worker.fetch(request('/api/live/quote', {
    method:'POST',headers:authHeaders,body:JSON.stringify(mockOrder),
  }), readOnlyEnv);
  assert.equal(lockedQuote.status, 503, 'Quote preparation stays locked when execution is disabled');
  const lockedOrder = await worker.fetch(request('/api/live/order', {
    method:'POST',headers:authHeaders,body:JSON.stringify({...mockOrder,confirmText:'KIRIM ORDER LIVE'}),
  }), readOnlyEnv);
  assert.equal(lockedOrder.status, 503, 'Order submission stays locked when execution is disabled');
  assert.equal(simulatedOrderCalls, 0, 'Read-only regression never sends any exchange order request');
  assert.deepEqual(privateReadCalls.slice().sort(), ['/api/v5/account/balance','/api/v5/account/config','/api/v5/account/positions'].sort(),
    'Read-only account check performs only GET account reads');

  const dormantEntries = new Map([['autoState',{running:true,mode:'demo',instId:'BTC-USDT-SWAP'}]]);
  const dormantStorage = {get:async key=>dormantEntries.get(key),put:async(key,value)=>{dormantEntries.set(key,value);},setAlarm:async()=>{},deleteAlarm:async()=>{}};
  const dormantTrader = new AutoTrader({storage:dormantStorage}, readOnlyEnv);
  await dormantTrader.alarm();
  assert.equal((await dormantStorage.get('autoState')).running, false,
    'A previously scheduled alarm fails closed and stops when auto execution is disabled');
  assert.equal(simulatedOrderCalls, 0, 'Disabled alarm does not submit an order');

  const quote = await worker.fetch(request('/api/live/quote', {method:'POST',headers:authHeaders,body:JSON.stringify(mockOrder)}), fakeEnv);
  assert.equal(quote.status, 200);
  const quoteBody = await quote.json();
  assert.equal(quoteBody.preview.notionalUsdt, '0.1000', 'Notional uses contracts × contract value × price');
  assert.equal(quoteBody.preview.sizeContracts, '0.1');
  const { challenge } = quoteBody;
  const submission = {...mockOrder,challenge,confirmText:'KIRIM ORDER LIVE'};
  const sendMock = body => worker.fetch(request('/api/live/order', {method:'POST',headers:authHeaders,body:JSON.stringify(body)}), fakeEnv);
  assert.equal((await sendMock(submission)).status, 200);
  assert.equal((await sendMock(submission)).status, 200);
  assert.equal(simulatedOrderCalls, 1, 'A retry returns the previous result without another exchange request');
  assert.equal((await sendMock({...submission,px:'101'})).status, 400);
  const liveWithoutAck = await worker.fetch(request('/api/live/quote', {method:'POST',headers:authHeaders,body:JSON.stringify(mockOrder)}), {...fakeEnv,ORBITAL_TRADING_MODE:'live'});
  assert.equal(liveWithoutAck.status, 503);

  const configuredStatus = await worker.fetch(request('/api/status'), fakeEnv);
  assert.equal((await configuredStatus.json()).autoTradingAvailable, true);
  const privateAccountResponse = await worker.fetch(request('/api/private/account', {headers:authHeaders}), fakeEnv);
  assert.equal(privateAccountResponse.status, 200);
  const privateAccount = await privateAccountResponse.json();
  assert.equal(privateAccount.account.availableUsdt, 1000);
  assert.equal(privateAccount.account.positionMode, 'net_mode');
  assert.equal(JSON.stringify(privateAccount).includes('MOCK_ONLY'), false, 'Private responses never expose API credentials');

  const autoEntries = new Map();
  const autoStorage = {
    get: async key => autoEntries.get(key),
    put: async (key, value) => { autoEntries.set(key, value); },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  const autoTrader = new AutoTrader({storage:autoStorage}, fakeEnv);
  fakeEnv.ORBITAL_AUTO_TRADER = {
    idFromName: () => 'single-owner',
    get: () => ({fetch: request => autoTrader.fetch(request)}),
  };
  const autoStart = body => worker.fetch(request('/api/auto/start', {
    method:'POST',headers:authHeaders,body:JSON.stringify(body),
  }), fakeEnv);
  assert.equal((await autoStart({instId:'BTC-USDT-SWAP',riskPct:0.5,confirmText:'MULAI AUTO TRADE LIVE'})).status, 400,
    'Demo mode rejects a live-mode start phrase');
  const started = await autoStart({instId:'BTC-USDT-SWAP',riskPct:0.5,confirmText:'MULAI AUTO TRADE DEMO'});
  assert.equal(started.status, 201);
  assert.equal((await started.json()).running, true);
  assert.equal(autoOrderCalls, 0, 'Starting the scheduler does not submit an immediate order');

  autoMode = true;
  await autoTrader.alarm();
  const runningState = await autoStorage.get('autoState');
  assert.equal(runningState.running, true);
  assert.equal(runningState.lastSignal, 'BUY', 'Closed-candle RSI crossing triggers a long entry signal');
  assert.equal(autoOrderCalls, 1, 'A valid new closed candle can produce one mocked demo order');
  assert.equal(lastAutoOrder.posSide, undefined, 'Net mode omits posSide');
  assert.ok(Number(lastAutoOrder.sz) > 0 && Number(lastAutoOrder.sz) * 80 * 0.01 <= 25.000001,
    'Auto size remains within the server-side notional cap');
  await autoTrader.alarm();
  assert.equal(autoOrderCalls, 1, 'Polling the same closed candle does not repeat an order');
  autoPositionRows = [{instId:'BTC-USDT-SWAP',pos:'0.1',posSide:'net',avgPx:'80',upl:'0',mgnMode:'isolated'}];
  const blockedEntries = new Map();
  const blockedStorage = {get:async key=>blockedEntries.get(key),put:async(key,value)=>{blockedEntries.set(key,value);},setAlarm:async()=>{},deleteAlarm:async()=>{}};
  const blockedTrader = new AutoTrader({storage:blockedStorage}, fakeEnv);
  const blockedStart = await blockedTrader.fetch(new Request('https://auto-trader/start', {
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({instId:'BTC-USDT-SWAP',riskPct:0.5,confirmText:'MULAI AUTO TRADE DEMO'}),
  }));
  assert.equal(blockedStart.status, 201);
  await blockedTrader.alarm();
  assert.match((await blockedStorage.get('autoState')).lastMessage, /Ada posisi Swap/);
  assert.equal(autoOrderCalls, 1, 'An existing account position is never added to, reversed, or closed by the bot');
  autoPositionRows = [];
  const stopResponse = await worker.fetch(request('/api/auto/stop', {method:'POST',headers:authHeaders,body:'{}'}), fakeEnv);
  assert.equal(stopResponse.status, 200);
  assert.equal((await stopResponse.json()).running, false, 'The authenticated stop action disables future alarms');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('worker-smoke: OK — read-only account regression with execution flags false, locked quote/order and alarm, filtered USDT Swap catalog, signed mocked reads, demo-only auto start, capped RSI/ATR order with attached exits, existing-position guard, idempotent polling and stop. No real network or exchange orders.');
