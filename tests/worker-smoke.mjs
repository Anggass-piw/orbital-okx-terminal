import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { default: worker, OrderGuard } = await import(moduleUrl);
const env = { ASSETS: { fetch: async () => new Response('asset') } };
const request = (path, init) => new Request(`https://orbital-test.example${path}`, init);

const statusResponse = await worker.fetch(request('/api/status'), env);
assert.equal(statusResponse.status, 200);
const status = await statusResponse.json();
assert.equal(status.marketProxy, true);
assert.equal(status.tradingAvailable, false);
assert.equal(status.tradingMode, 'disabled');

const quoteResponse = await worker.fetch(request('/api/live/quote', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instId: 'BTC-USDT', side: 'buy', sz: '0.001', px: '50000' }),
}), env);
assert.equal(quoteResponse.status, 503, 'Order quotes stay disabled without the private backend and guard');

const orderResponse = await worker.fetch(request('/api/live/order', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instId: 'BTC-USDT', side: 'buy', sz: '0.001', px: '50000', confirmText: 'KIRIM ORDER LIVE' }),
}), env);
assert.equal(orderResponse.status, 503, 'Order submission stays disabled without the private backend and guard');

const crossOriginResponse = await worker.fetch(request('/api/status', {
  headers: { origin: 'https://attacker.example' },
}), env);
assert.equal(crossOriginResponse.status, 403);

const invalidInstrumentResponse = await worker.fetch(request('/api/market/ticker?instId=BTC-USDT-SWAP'), env);
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
globalThis.fetch = async input => {
  const url = new URL(String(input));
  upstreamCalls.push(url.pathname);
  if (url.pathname === '/api/v5/market/tickers') return new Response(JSON.stringify({ code:'0', data:[{instId:'BTC-USDT',last:'100',ts:'1'},{instId:'XRP-USDT',last:'2',ts:'1'}] }));
  if (url.pathname === '/api/v5/market/history-candles') return new Response(JSON.stringify({ code:'0', data:[['1','100','101','99','100','1','100','100','1']] }));
  return new Response(JSON.stringify({ code:'50011', msg:'Too Many Requests' }), { status:429 });
};
try {
  const tickerFallback = await worker.fetch(request('/api/market/ticker?instId=BTC-USDT'), env);
  assert.equal(tickerFallback.status, 200);
  assert.deepEqual((await tickerFallback.json()).data.map(row => row.instId), ['BTC-USDT']);
  const candlesFallback = await worker.fetch(request('/api/market/candles?instId=BTC-USDT&bar=1H'), env);
  assert.equal(candlesFallback.status, 200);
  assert.equal((await candlesFallback.json()).data.length, 1);
  assert.equal(upstreamCalls.length, 4, 'At most one official fallback is requested for each public market request');
} finally {
  globalThis.fetch = originalFetch;
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
  ORBITAL_ADMIN_TOKEN:'mock-owner-token-not-a-secret-123456789', ORBITAL_CHALLENGE_SECRET:'mock-challenge-not-a-secret-123456789',
  OKX_API_KEY:'MOCK_ONLY', OKX_API_SECRET:'MOCK_ONLY', OKX_API_PASSPHRASE:'MOCK_ONLY',
};
const authHeaders = { 'content-type':'application/json', authorization:`Bearer ${fakeEnv.ORBITAL_ADMIN_TOKEN}` };
const mockOrder = { instId:'BTC-USDT', side:'buy', sz:'0.1', px:'100' };
let simulatedOrderCalls = 0;
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path === '/api/v5/market/ticker') return new Response(JSON.stringify({code:'0',data:[{last:'100'}]}));
  if (path === '/api/v5/public/instruments') return new Response(JSON.stringify({code:'0',data:[{state:'live',minSz:'0.01',lotSz:'0.01',tickSz:'0.1'}]}));
  if (path === '/api/v5/trade/order') {
    simulatedOrderCalls++;
    assert.equal(new Headers(init.headers).get('x-simulated-trading'), '1');
    assert.ok(new Headers(init.headers).get('OK-ACCESS-SIGN'));
    return new Response(JSON.stringify({code:'0',data:[{sCode:'0',ordId:'MOCK_ORDER_NOT_REAL'}]}));
  }
  throw new Error('Unexpected mocked network request');
};
try {
  const quote = await worker.fetch(request('/api/live/quote', {method:'POST',headers:authHeaders,body:JSON.stringify(mockOrder)}), fakeEnv);
  assert.equal(quote.status, 200);
  const { challenge } = await quote.json();
  const submission = {...mockOrder,challenge,confirmText:'KIRIM ORDER LIVE'};
  const sendMock = body => worker.fetch(request('/api/live/order', {method:'POST',headers:authHeaders,body:JSON.stringify(body)}), fakeEnv);
  assert.equal((await sendMock(submission)).status, 200);
  assert.equal((await sendMock(submission)).status, 200);
  assert.equal(simulatedOrderCalls, 1, 'A retry returns the previous result without another exchange request');
  assert.equal((await sendMock({...submission,px:'101'})).status, 400);
  const liveWithoutAck = await worker.fetch(request('/api/live/quote', {method:'POST',headers:authHeaders,body:JSON.stringify(mockOrder)}), {...fakeEnv,ORBITAL_TRADING_MODE:'live'});
  assert.equal(liveWithoutAck.status, 503);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('worker-smoke: OK — disabled public trading, request guards, official market fallback, and mocked signed demo flow with once-only order submission. No real network or exchange orders.');
