const OKX = 'https://openapi.okx.com';
const ALLOWED_ASSETS = new Set(['BTC-USDT', 'ETH-USDT', 'SOL-USDT']);
const ALLOWED_BARS = new Set(['15m', '1H', '4H', '1D']);
const REAL_TRADING_ACK = 'I_ACCEPT_REAL_TRADING_RISK';
const OWNER_CONFIRMATION = 'KIRIM ORDER LIVE';
const DEFAULT_MAX_NOTIONAL = 25;
const ABSOLUTE_MAX_NOTIONAL = 100;
const MAX_PRICE_DEVIATION = 0.10;
const CHALLENGE_TTL_MS = 90_000;
const ORDER_GUARD_TTL_MS = 24 * 60 * 60 * 1000;

function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    },
  });
}

function tradingConfiguration(env) {
  const mode = env.ORBITAL_TRADING_MODE === 'live' ? 'live' : 'demo';
  const configured = env.ORBITAL_TRADING_ENABLED === 'true'
    && Boolean(env.ORBITAL_ORDER_GUARD)
    && typeof env.ORBITAL_ADMIN_TOKEN === 'string' && env.ORBITAL_ADMIN_TOKEN.length >= 32
    && typeof env.ORBITAL_CHALLENGE_SECRET === 'string' && env.ORBITAL_CHALLENGE_SECRET.length >= 32
    && typeof env.OKX_API_KEY === 'string' && env.OKX_API_KEY.length > 0
    && typeof env.OKX_API_SECRET === 'string' && env.OKX_API_SECRET.length > 0
    && typeof env.OKX_API_PASSPHRASE === 'string' && env.OKX_API_PASSPHRASE.length > 0
    && (mode !== 'live' || env.ORBITAL_LIVE_ACK === REAL_TRADING_ACK);
  return { configured, mode: configured ? mode : 'disabled' };
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  let diff = left.length ^ right.length;
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

function authorized(request, env) {
  const supplied = request.headers.get('authorization') || '';
  const expected = `Bearer ${env.ORBITAL_ADMIN_TOKEN || ''}`;
  return sameOrigin(request) && timingSafeEqual(supplied, expected);
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function signChallenge(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return encodeBase64Url(new Uint8Array(signature));
}

async function makeChallenge(env, claims) {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${await signChallenge(env.ORBITAL_CHALLENGE_SECRET, payload)}`;
}

async function readChallenge(env, token) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = await signChallenge(env.ORBITAL_CHALLENGE_SECRET, payload);
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
  } catch {
    return null;
  }
}

function normalizedDecimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!/^\d{1,12}(?:\.\d{1,8})?$/.test(raw)) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number.toFixed(8).replace(/\.?0+$/, '');
}

function decimalUnits(value, scale = 12) {
  const raw = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > scale) return null;
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
}

function alignsToStep(value, step) {
  try {
    const valueUnits = decimalUnits(value);
    const stepUnits = decimalUnits(step);
    return valueUnits !== null && stepUnits !== null && stepUnits > 0n && valueUnits % stepUnits === 0n;
  } catch {
    return false;
  }
}

function maxNotional(env) {
  const configured = Number(env.ORBITAL_MAX_NOTIONAL_USDT);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_NOTIONAL;
  return Math.min(configured, ABSOLUTE_MAX_NOTIONAL);
}

async function okxTicker(instId) {
  const url = new URL('/api/v5/market/ticker', OKX);
  url.searchParams.set('instId', instId);
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Market price unavailable');
  const result = await response.json();
  const price = Number(result?.data?.[0]?.last);
  if (result?.code !== '0' || !Number.isFinite(price) || price <= 0) throw new Error('Market price unavailable');
  return price;
}

async function okxInstrumentRules(instId) {
  const url = new URL('/api/v5/public/instruments', OKX);
  url.searchParams.set('instType', 'SPOT');
  url.searchParams.set('instId', instId);
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Instrument rules unavailable');
  const result = await response.json();
  const instrument = result?.data?.[0];
  if (result?.code !== '0' || instrument?.state !== 'live' || !instrument.minSz || !instrument.lotSz || !instrument.tickSz) {
    throw new Error('Instrument rules unavailable');
  }
  return { minSz: String(instrument.minSz), lotSz: String(instrument.lotSz), tickSz: String(instrument.tickSz) };
}

async function hmacBase64(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function okxPrivateRequest(env, method, requestPath, body = '') {
  const timestamp = new Date().toISOString();
  const signature = await hmacBase64(env.OKX_API_SECRET, `${timestamp}${method}${requestPath}${body}`);
  const headers = {
    'content-type': 'application/json',
    'OK-ACCESS-KEY': env.OKX_API_KEY,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': env.OKX_API_PASSPHRASE,
  };
  if (env.ORBITAL_TRADING_MODE !== 'live') headers['x-simulated-trading'] = '1';
  const response = await fetch(`${OKX}${requestPath}`, {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.code !== '0' || (result?.data?.[0]?.sCode && result.data[0].sCode !== '0')) {
    const code = String(result?.data?.[0]?.sCode || result?.code || response.status).slice(0, 32);
    throw new Error(`OKX menolak order (kode ${code})`);
  }
  return result;
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 4096) return null;
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function validateOrder(input, env) {
  if (!input || !ALLOWED_ASSETS.has(input.instId) || !['buy', 'sell'].includes(input.side)) return null;
  const sz = normalizedDecimal(input.sz);
  const px = normalizedDecimal(input.px);
  if (!sz || !px) return null;
  if (Number(sz) * Number(px) > maxNotional(env) + 1e-8) return null;
  return { instId: input.instId, side: input.side, sz, px };
}

function validByInstrumentRules(order, rules) {
  const size = Number(order.sz);
  const price = Number(order.px);
  return size >= Number(rules.minSz)
    && alignsToStep(order.sz, rules.lotSz)
    && alignsToStep(order.px, rules.tickSz)
    && Number.isFinite(price) && price > 0;
}

function marketDataResponse(body, status, cacheState) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-orbital-edge-cache': cacheState,
    },
  });
}

async function marketProxy(request, url) {
  if (request.method !== 'GET') return responseJson({ error: 'Method not allowed' }, 405);
  const route = url.pathname.slice('/api/market/'.length);
  if (!['ticker', 'candles'].includes(route)) return responseJson({ error: 'Not found' }, 404);
  const instId = url.searchParams.get('instId') || '';
  if (!ALLOWED_ASSETS.has(instId)) return responseJson({ error: 'Unsupported instrument' }, 400);
  const upstream = new URL(`/api/v5/market/${route}`, OKX);
  upstream.searchParams.set('instId', instId);
  if (route === 'candles') {
    const bar = url.searchParams.get('bar') || '1H';
    if (!ALLOWED_BARS.has(bar)) return responseJson({ error: 'Unsupported interval' }, 400);
    upstream.searchParams.set('bar', bar);
    upstream.searchParams.set('limit', '100');
  }
  const cacheUrl = new URL(`/__orbital_market_cache/${route}`, url.origin);
  cacheUrl.search = upstream.search;
  const cacheKey = new Request(cacheUrl.toString());
  const edgeCache = typeof caches !== 'undefined' ? caches.default : null;
  try {
    if (edgeCache) {
      const cached = await edgeCache.match(cacheKey);
      if (cached) return marketDataResponse(cached.body, cached.status, 'HIT');
    }
    const result = await fetch(upstream, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    let status = result.status;
    let body = await result.text();
    let payload;
    try { payload = JSON.parse(body); } catch { payload = null; }
    if (status === 429 || payload?.code === '50011') {
      const fallback = new URL(route === 'candles' ? '/api/v5/market/history-candles' : '/api/v5/market/tickers', OKX);
      if (route === 'candles') fallback.search = upstream.search;
      else fallback.searchParams.set('instType', 'SPOT');
      try {
        const fallbackResponse = await fetch(fallback, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        const fallbackPayload = await fallbackResponse.json();
        if (fallbackResponse.ok && fallbackPayload?.code === '0') {
          const data = route === 'ticker' ? fallbackPayload.data.filter(row => row.instId === instId) : fallbackPayload.data;
          if (Array.isArray(data) && data.length) {
            payload = { code: '0', msg: '', data };
            body = JSON.stringify(payload);
            status = 200;
          }
        }
      } catch { /* Preserve the original rate-limit response rather than inventing a market snapshot. */ }
    }
    if (status === 200 && payload?.code === '0' && edgeCache) {
      const internal = new Response(body, {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${route === 'ticker' ? 30 : 60}` },
      });
      try { await edgeCache.put(cacheKey, internal); } catch { /* A cache failure must not hide valid market data. */ }
    }
    return marketDataResponse(body, status, 'MISS');
  } catch {
    return responseJson({ error: 'OKX market data temporarily unavailable' }, 502);
  }
}

async function createOrderQuote(request, env) {
  if (!tradingConfiguration(env).configured) return responseJson({ error: 'Trading backend not configured' }, 503);
  if (!authorized(request, env)) return responseJson({ error: 'Unauthorized' }, 401);
  const input = await readJson(request);
  const order = validateOrder(input, env);
  if (!order) return responseJson({ error: `Order invalid or exceeds ${maxNotional(env)} USDT limit` }, 400);
  let marketPrice;
  let rules;
  try {
    [marketPrice, rules] = await Promise.all([okxTicker(order.instId), okxInstrumentRules(order.instId)]);
  } catch {
    return responseJson({ error: 'Could not verify current OKX price and instrument rules' }, 502);
  }
  if (!validByInstrumentRules(order, rules)) {
    return responseJson({ error: `Input must satisfy OKX minimum size ${rules.minSz}, lot step ${rules.lotSz}, and price tick ${rules.tickSz}` }, 400);
  }
  if (Math.abs(Number(order.px) / marketPrice - 1) > MAX_PRICE_DEVIATION) {
    return responseJson({ error: 'Limit price is more than 10% away from the current OKX price' }, 400);
  }
  const now = Date.now();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const claims = { ...order, clOrdId: `orb${nonce.slice(0, 29)}`, issuedAt: now, expiresAt: now + CHALLENGE_TTL_MS };
  const challenge = await makeChallenge(env, claims);
  return responseJson({
    preview: {
      instId: order.instId,
      side: order.side.toUpperCase(),
      size: order.sz,
      limitPrice: order.px,
      notionalUsdt: (Number(order.sz) * Number(order.px)).toFixed(4),
      marketPrice: marketPrice.toFixed(8),
      mode: tradingConfiguration(env).mode,
      expiresAt: claims.expiresAt,
      minSize: rules.minSz,
      sizeStep: rules.lotSz,
      priceTick: rules.tickSz,
    },
    challenge,
  });
}

async function reserveOrderOnce(env, clOrdId) {
  const id = env.ORBITAL_ORDER_GUARD.idFromName(clOrdId);
  const stub = env.ORBITAL_ORDER_GUARD.get(id);
  const response = await stub.fetch('https://order-guard/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clOrdId }),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function completeOrderGuard(env, clOrdId, outcome) {
  const id = env.ORBITAL_ORDER_GUARD.idFromName(clOrdId);
  const stub = env.ORBITAL_ORDER_GUARD.get(id);
  const response = await stub.fetch('https://order-guard/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clOrdId, outcome }),
  });
  return response.ok;
}

async function submitOrder(request, env) {
  const config = tradingConfiguration(env);
  if (!config.configured) return responseJson({ error: 'Trading backend not configured' }, 503);
  if (!authorized(request, env)) return responseJson({ error: 'Unauthorized' }, 401);
  const input = await readJson(request);
  const order = validateOrder(input, env);
  if (!order || input.confirmText !== OWNER_CONFIRMATION) return responseJson({ error: 'Invalid order or explicit confirmation missing' }, 400);
  const claims = await readChallenge(env, input.challenge);
  if (!claims || claims.expiresAt < Date.now() || claims.issuedAt > Date.now() + 5000) {
    return responseJson({ error: 'Order preview expired or invalid; request a new preview' }, 400);
  }
  if (claims.instId !== order.instId || claims.side !== order.side || claims.sz !== order.sz || claims.px !== order.px) {
    return responseJson({ error: 'Submitted order differs from the confirmed preview' }, 400);
  }
  let reservation;
  try {
    reservation = await reserveOrderOnce(env, claims.clOrdId);
  } catch {
    return responseJson({ error: 'Order idempotency guard unavailable; no order was sent' }, 503);
  }
  if (reservation.status === 200 && reservation.data?.state === 'completed' && reservation.data?.outcome?.ok === true) {
    return responseJson(reservation.data.outcome);
  }
  if (reservation.status !== 201) {
    return responseJson({ error: 'This preview has already been submitted or has an uncertain result; check OKX order history before retrying' }, 409);
  }
  const body = JSON.stringify({
    instId: order.instId,
    tdMode: 'cash',
    side: order.side,
    ordType: 'limit',
    px: order.px,
    sz: order.sz,
    clOrdId: claims.clOrdId,
  });
  try {
    const result = await okxPrivateRequest(env, 'POST', '/api/v5/trade/order', body);
    const outcome = {
      ok: true,
      order: {
        instrument: order.instId,
        side: order.side.toUpperCase(),
        size: order.sz,
        limitPrice: order.px,
        orderId: String(result.data[0].ordId || ''),
        clientOrderId: claims.clOrdId,
        state: String(result.data[0].sMsg || 'accepted'),
      },
    };
    try { await completeOrderGuard(env, claims.clOrdId, outcome); } catch { /* Reservation stays pending: retries will not send a second order. */ }
    return responseJson(outcome);
  } catch (error) {
    const outcome = { ok: false, message: 'Order request outcome is uncertain; check OKX history before any new attempt' };
    try { await completeOrderGuard(env, claims.clOrdId, outcome); } catch { /* Reservation stays pending, blocking replay. */ }
    return responseJson({ error: error instanceof Error ? error.message : outcome.message, checkHistory: true }, 502);
  }
}

export class OrderGuard {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.method !== 'POST') return responseJson({ error: 'Method not allowed' }, 405);
    const path = new URL(request.url).pathname;
    let body;
    try { body = await request.json(); } catch { return responseJson({ error: 'Invalid JSON' }, 400); }
    if (typeof body.clOrdId !== 'string' || !/^orb[a-f0-9]{29}$/.test(body.clOrdId)) return responseJson({ error: 'Invalid order id' }, 400);

    if (path === '/reserve') {
      const result = await this.ctx.storage.transaction(async transaction => {
        const existing = await transaction.get('reservation');
        if (existing) {
          if (existing.state === 'completed' && existing.outcome?.ok === true) return { status: 200, data: { state: existing.state, outcome: existing.outcome } };
          return { status: 409, data: { state: existing.state } };
        }
        await transaction.put('reservation', { state: 'pending', createdAt: Date.now() });
        return { status: 201, data: { state: 'reserved' } };
      });
      if (result.status === 201) await this.ctx.storage.setAlarm(Date.now() + ORDER_GUARD_TTL_MS);
      return responseJson(result.data, result.status);
    }

    if (path === '/complete') {
      if (!body.outcome || typeof body.outcome !== 'object' || JSON.stringify(body.outcome).length > 2048) return responseJson({ error: 'Invalid outcome' }, 400);
      const state = await this.ctx.storage.transaction(async transaction => {
        const existing = await transaction.get('reservation');
        if (!existing) return 'missing';
        if (existing.state !== 'pending') return existing.state;
        const completed = body.outcome.ok === true;
        await transaction.put('reservation', {
          state: completed ? 'completed' : 'indeterminate',
          createdAt: existing.createdAt,
          outcome: body.outcome,
        });
        return completed ? 'completed' : 'indeterminate';
      });
      return state === 'completed' ? responseJson({ state }, 200) : responseJson({ state }, 409);
    }
    return responseJson({ error: 'Not found' }, 404);
  }

  async alarm() {
    await this.ctx.storage.delete('reservation');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (!sameOrigin(request)) return responseJson({ error: 'Cross-origin request blocked' }, 403);
      if (url.pathname === '/api/status' && request.method === 'GET') {
        const config = tradingConfiguration(env);
        return responseJson({ marketProxy: true, tradingAvailable: config.configured, tradingMode: config.mode, maxNotionalUsdt: maxNotional(env) });
      }
      if (url.pathname.startsWith('/api/market/')) return marketProxy(request, url);
      if (url.pathname === '/api/live/quote' && request.method === 'POST') return createOrderQuote(request, env);
      if (url.pathname === '/api/live/order' && request.method === 'POST') return submitOrder(request, env);
      return responseJson({ error: 'Not found' }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
