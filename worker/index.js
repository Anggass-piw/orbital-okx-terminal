const OKX = 'https://openapi.okx.com';
const SWAP_INST_ID = /^[A-Z0-9]{2,20}-USDT-SWAP$/;
const ALLOWED_BARS = new Set(['15m', '1H', '4H', '1D']);
const REAL_TRADING_ACK = 'I_ACCEPT_REAL_TRADING_RISK';
const OWNER_CONFIRMATION = 'KIRIM ORDER LIVE';
const AUTO_TRADING_ACK = 'I_ACCEPT_AUTO_TRADING_RISK';
const AUTO_TRADER_NAME = 'orbital-auto-trader-owner';
const DEFAULT_MAX_NOTIONAL = 25;
const ABSOLUTE_MAX_NOTIONAL = 100;
const MAX_PRICE_DEVIATION = 0.10;
const CHALLENGE_TTL_MS = 90_000;
const ORDER_GUARD_TTL_MS = 24 * 60 * 60 * 1000;
const AUTO_POLL_INTERVAL_MS = 60_000;
const AUTO_RSI_PERIOD = 14;
const MAX_JSON_BODY_BYTES = 4096;

function isUsdtSwapInstrument(value) {
  return typeof value === 'string' && SWAP_INST_ID.test(value);
}
function mappedUsdtSwap(item) {
  // OKX leaves baseCcy empty for derivatives; derive it from the validated linear USDT swap ID.
  const baseCcy = item?.baseCcy || (isUsdtSwapInstrument(item?.instId) ? item.instId.replace(/-USDT-SWAP$/, '') : '');
  if (!item || item.instType !== 'SWAP' || item.state !== 'live'
      || !isUsdtSwapInstrument(item.instId) || item.settleCcy !== 'USDT'
      || item.ctType !== 'linear' || !/^[A-Z0-9]{2,20}$/.test(baseCcy)
      || item.instId !== `${baseCcy}-USDT-SWAP`
      || !positiveFinite(item.ctVal) || !positiveFinite(item.minSz)
      || !positiveFinite(item.lotSz) || !positiveFinite(item.tickSz)) return null;
  return {
    instId: String(item.instId),
    instType: 'SWAP',
    state: 'live',
    ctType: 'linear',
    baseCcy: String(baseCcy),
    settleCcy: 'USDT',
    ctVal: String(item.ctVal),
    ctValCcy: String(item.ctValCcy || baseCcy),
    minSz: String(item.minSz),
    lotSz: String(item.lotSz),
    tickSz: String(item.tickSz),
    maxMktSz: String(item.maxMktSz || ''),
    maxLever: positiveFinite(item.lever) ? String(item.lever) : '1',
  };
}
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

function accountReadConfiguration(env) {
  const mode = env.ORBITAL_TRADING_MODE === 'live' ? 'live' : 'demo';
  const configured = typeof env.ORBITAL_ADMIN_TOKEN === 'string' && env.ORBITAL_ADMIN_TOKEN.length >= 32
    && typeof env.OKX_API_KEY === 'string' && env.OKX_API_KEY.length > 0
    && typeof env.OKX_API_SECRET === 'string' && env.OKX_API_SECRET.length > 0
    && typeof env.OKX_API_PASSPHRASE === 'string' && env.OKX_API_PASSPHRASE.length > 0;
  return { configured, mode: configured ? mode : 'disabled' };
}

function tradingConfiguration(env) {
  const mode = env.ORBITAL_TRADING_MODE === 'live' ? 'live' : 'demo';
  const read = accountReadConfiguration(env);
  const configured = read.configured
    && env.ORBITAL_TRADING_ENABLED === 'true'
    && Boolean(env.ORBITAL_ORDER_GUARD)
    && typeof env.ORBITAL_CHALLENGE_SECRET === 'string' && env.ORBITAL_CHALLENGE_SECRET.length >= 32
    && (mode !== 'live' || env.ORBITAL_LIVE_ACK === REAL_TRADING_ACK);
  return { configured, mode: configured ? mode : 'disabled' };
}

function autoTradingConfiguration(env) {
  const trading = tradingConfiguration(env);
  const enabled = trading.configured
    && env.ORBITAL_AUTO_TRADING_ENABLED === 'true'
    && env.ORBITAL_AUTO_TRADING_ACK === AUTO_TRADING_ACK;
  return { enabled, mode: enabled ? trading.mode : 'disabled' };
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
  const token = env.ORBITAL_ADMIN_TOKEN;
  if (typeof token !== 'string' || token.length < 32) return false;
  const supplied = request.headers.get('authorization') || '';
  const expected = `Bearer ${token}`;
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
  if (!isUsdtSwapInstrument(instId)) throw new Error('Unsupported instrument');
  const url = new URL('/api/v5/public/instruments', OKX);
  url.searchParams.set('instType', 'SWAP');
  url.searchParams.set('instId', instId);
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Instrument rules unavailable');
  const result = await response.json();
  const instrument = result?.data?.[0];
  const mapped = result?.code === '0' ? mappedUsdtSwap(instrument) : null;
  if (!mapped || mapped.instId !== instId) throw new Error('Instrument rules unavailable');
  return mapped;
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
    throw new Error(`Permintaan privat OKX ditolak (kode ${code})`);
  }
  return result;
}

async function privateAccountSnapshot(env) {
  const [balance, accountConfig, positions] = await Promise.all([
    okxPrivateRequest(env, 'GET', '/api/v5/account/balance'),
    okxPrivateRequest(env, 'GET', '/api/v5/account/config'),
    okxPrivateRequest(env, 'GET', '/api/v5/account/positions?instType=SWAP'),
  ]);
  const account = balance.data?.[0] || {};
  const usdt = account.details?.find(item => item.ccy === 'USDT') || {};
  const availableUsdt = Number(usdt.availBal || usdt.availEq || 0);
  return {
    mode: accountReadConfiguration(env).mode,
    positionMode: String(accountConfig.data?.[0]?.posMode || 'unknown'),
    totalEquityUsdt: Number(account.totalEq) || 0,
    availableUsdt: Number.isFinite(availableUsdt) ? Math.max(0, availableUsdt) : 0,
    openPositions: (Array.isArray(positions.data) ? positions.data : [])
      .filter(item => isUsdtSwapInstrument(item.instId) && positiveFinite(Math.abs(Number(item.pos))))
      .map(item => ({
        instId: String(item.instId),
        side: String(item.posSide || (Number(item.pos) > 0 ? 'long' : 'short')),
        sizeContracts: String(Math.abs(Number(item.pos))),
        averagePrice: String(item.avgPx || ''),
        unrealizedPnl: String(item.upl || '0'),
        marginMode: String(item.mgnMode || ''),
      })),
  };
}

async function privateAccountRoute(request, env) {
  if (!accountReadConfiguration(env).configured) return responseJson({ error: 'Private OKX read backend not configured' }, 503);
  if (!authorized(request, env)) return responseJson({ error: 'Unauthorized' }, 401);
  try {
    return responseJson({ account: await privateAccountSnapshot(env) });
  } catch (error) {
    return responseJson({ error: error instanceof Error ? error.message : 'Could not verify the private OKX connection' }, 502);
  }
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* Stop reading once the hard limit is crossed. */ }
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    try { await reader.cancel(); } catch { /* The body may already be closed. */ }
    return null;
  }
}

function validateOrder(input) {
  if (!input || !isUsdtSwapInstrument(input.instId) || !['buy', 'sell'].includes(input.side)) return null;
  const tdMode = input.tdMode === undefined ? 'isolated' : input.tdMode;
  if (!['isolated', 'cross'].includes(tdMode)) return null;
  const sz = normalizedDecimal(input.sz);
  const px = normalizedDecimal(input.px);
  if (!sz || !px) return null;
  return { instId: input.instId, side: input.side, tdMode, sz, px };
}
function orderNotional(order, rules) {
  return Number(order.sz) * Number(order.px) * Number(rules.ctVal);
}
function validByInstrumentRules(order, rules) {
  const size = Number(order.sz);
  const price = Number(order.px);
  return size >= Number(rules.minSz)
    && alignsToStep(order.sz, rules.lotSz)
    && alignsToStep(order.px, rules.tickSz)
    && Number.isFinite(price) && price > 0
    && positiveFinite(rules.ctVal);
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

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}
function nonNegativeFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0;
}
function optionalFinite(value) {
  return value === undefined || value === null || value === '' || Number.isFinite(Number(value));
}

function validMarketPayload(route, payload, instId) {
  if (!payload || payload.code !== '0' || !Array.isArray(payload.data)) return false;
  if (route === 'instruments') {
    return payload.data.length > 0 && payload.data.every(item => mappedUsdtSwap(item)
      && mappedUsdtSwap(item).instId === item.instId);
  }
  if (route === 'ticker') {
    return payload.data.length > 0 && payload.data.every(row => row?.instId === instId
      && positiveFinite(row.last) && positiveFinite(row.ts));
  }
  if (route === 'candles') {
    return payload.data.length >= 15 && payload.data.every(row => {
      if (!Array.isArray(row) || row.length < 5) return false;
      const [timestamp, open, high, low, close] = row.slice(0, 5).map(Number);
      return [timestamp, open, high, low, close].every(Number.isFinite)
        && timestamp > 0 && open > 0 && high > 0 && low > 0 && close > 0
        && high >= low && high >= open && high >= close && low <= open && low <= close;
    });
  }
  if (route === 'books') {
    return payload.data.length > 0 && payload.data.every(book => positiveFinite(book?.ts)
      && Array.isArray(book.bids) && book.bids.length > 0
      && Array.isArray(book.asks) && book.asks.length > 0
      && [...book.bids, ...book.asks].every(level => Array.isArray(level)
        && positiveFinite(level[0]) && positiveFinite(level[1])));
  }
  if (route === 'trades') {
    return payload.data.length > 0 && payload.data.every(trade => trade?.instId === instId
      && positiveFinite(trade.px) && positiveFinite(trade.sz)
      && ['buy', 'sell'].includes(trade.side) && positiveFinite(trade.ts));
  }
  if (route === 'funding-rate') {
    return payload.data.length > 0 && payload.data.every(row => row?.instId === instId
      && row.instType === 'SWAP' && positiveFinite(row.ts)
      && optionalFinite(row.fundingRate) && optionalFinite(row.settFundingRate)
      && optionalFinite(row.fundingTime) && optionalFinite(row.nextFundingTime));
  }
  if (route === 'open-interest') {
    return payload.data.length > 0 && payload.data.every(row => row?.instId === instId
      && row.instType === 'SWAP' && positiveFinite(row.ts)
      && nonNegativeFinite(row.oi) && optionalFinite(row.oiCcy) && optionalFinite(row.oiUsd));
  }
  return false;
}
function invalidMarketResponse(cacheState = 'MISS') {
  return marketDataResponse(JSON.stringify({ error: 'Invalid response from OKX market data' }), 502, cacheState);
}

async function marketProxy(request, url) {
  if (request.method !== 'GET') return responseJson({ error: 'Method not allowed' }, 405);
  const route = url.pathname.slice('/api/market/'.length);
  if (!['instruments', 'ticker', 'candles', 'books', 'trades', 'funding-rate', 'open-interest'].includes(route)) return responseJson({ error: 'Not found' }, 404);
  const instId = url.searchParams.get('instId') || '';
  if (route !== 'instruments' && !isUsdtSwapInstrument(instId)) return responseJson({ error: 'Unsupported instrument' }, 400);
  const upstream = route === 'instruments'
    ? new URL('/api/v5/public/instruments', OKX)
    : route === 'funding-rate' || route === 'open-interest'
      ? new URL(`/api/v5/public/${route}`, OKX)
      : new URL(`/api/v5/market/${route}`, OKX);
  if (route === 'instruments') {
    upstream.searchParams.set('instType', 'SWAP');
  } else {
    if (route === 'open-interest') upstream.searchParams.set('instType', 'SWAP');
    upstream.searchParams.set('instId', instId);
    if (route === 'candles') {
      const bar = url.searchParams.get('bar') || '1H';
      if (!ALLOWED_BARS.has(bar)) return responseJson({ error: 'Unsupported interval' }, 400);
      upstream.searchParams.set('bar', bar);
      upstream.searchParams.set('limit', '100');
    } else if (route === 'books') {
      upstream.searchParams.set('sz', '8');
    } else if (route === 'trades') {
      upstream.searchParams.set('limit', '20');
    }
  }
  const cacheUrl = new URL(`/__orbital_market_cache/${route}`, url.origin);
  cacheUrl.search = upstream.search;
  const cacheKey = new Request(cacheUrl.toString());
  const edgeCache = typeof caches !== 'undefined' ? caches.default : null;
  try {
    if (edgeCache) {
      const cached = await edgeCache.match(cacheKey);
      if (cached) {
        const cachedBody = await cached.text();
        let cachedPayload;
        try { cachedPayload = JSON.parse(cachedBody); } catch { cachedPayload = null; }
        if (cached.status === 200 && validMarketPayload(route, cachedPayload, instId)) {
          return marketDataResponse(cachedBody, cached.status, 'HIT');
        }
        try { await edgeCache.delete(cacheKey); } catch { /* Invalid cache data is never served. */ }
      }
    }
    const result = await fetch(upstream, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    let status = result.status;
    let body = await result.text();
    let payload;
    try { payload = JSON.parse(body); } catch { payload = null; }
    if ((status === 429 || payload?.code === '50011') && ['ticker', 'candles'].includes(route)) {
      const fallback = new URL(route === 'candles' ? '/api/v5/market/history-candles' : '/api/v5/market/tickers', OKX);
      if (route === 'candles') fallback.search = upstream.search;
      else fallback.searchParams.set('instType', 'SWAP');
      try {
        const fallbackResponse = await fetch(fallback, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        const fallbackBody = await fallbackResponse.text();
        let fallbackPayload;
        try { fallbackPayload = JSON.parse(fallbackBody); } catch { fallbackPayload = null; }
        if (!fallbackPayload || typeof fallbackPayload !== 'object' || fallbackPayload.code === undefined) {
          return invalidMarketResponse();
        }
        if (fallbackPayload?.code !== '0') {
          return marketDataResponse(fallbackBody, fallbackResponse.ok ? status : fallbackResponse.status, 'MISS');
        }
        const fallbackData = route === 'ticker' && Array.isArray(fallbackPayload.data)
          ? fallbackPayload.data.filter(row => row?.instId === instId)
          : fallbackPayload.data;
        const validatedFallback = { ...fallbackPayload, data: fallbackData };
        if (fallbackResponse.ok && validMarketPayload(route, validatedFallback, instId)) {
          payload = validatedFallback;
          body = JSON.stringify(payload);
          status = 200;
        } else {
          return invalidMarketResponse();
        }
      } catch { /* Preserve the original rate-limit response rather than inventing market data. */ }
    }
    if (!payload || typeof payload !== 'object' || payload.code === undefined) return invalidMarketResponse();
    if (payload.code === '0') {
      if (route === 'instruments') {
        const instruments = Array.isArray(payload.data) ? payload.data.map(mappedUsdtSwap).filter(Boolean) : [];
        if (!instruments.length) return invalidMarketResponse();
        instruments.sort((a, b) => a.baseCcy.localeCompare(b.baseCcy) || a.instId.localeCompare(b.instId));
        payload = { code: '0', data: instruments };
        body = JSON.stringify(payload);
      }
      if (status !== 200 || !validMarketPayload(route, payload, instId)) return invalidMarketResponse();
    }
    if (status === 200 && payload.code === '0' && edgeCache) {
      const ttl = ({ instruments: 900, ticker: 30, candles: 60, books: 3, trades: 5, 'funding-rate': 30, 'open-interest': 30 })[route];
      const internal = new Response(body, {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
      });
      try { await edgeCache.put(cacheKey, internal); } catch { /* Cache failures do not hide valid data. */ }
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
  const order = validateOrder(input);
  if (!order) return responseJson({ error: 'Invalid USDT perpetual order' }, 400);
  let marketPrice;
  let rules;
  try {
    [marketPrice, rules] = await Promise.all([okxTicker(order.instId), okxInstrumentRules(order.instId)]);
  } catch {
    return responseJson({ error: 'Could not verify current OKX price and USDT perpetual rules' }, 502);
  }
  if (!validByInstrumentRules(order, rules)) {
    return responseJson({ error: `Input must satisfy OKX minimum contract size ${rules.minSz}, lot step ${rules.lotSz}, and price tick ${rules.tickSz}` }, 400);
  }
  const notional = orderNotional(order, rules);
  if (!Number.isFinite(notional) || notional > maxNotional(env) + 1e-8) {
    return responseJson({ error: `Order notional exceeds ${maxNotional(env)} USDT limit` }, 400);
  }
  if (Math.abs(Number(order.px) / marketPrice - 1) > MAX_PRICE_DEVIATION) {
    return responseJson({ error: 'Limit price is more than 10% away from the current OKX price' }, 400);
  }
  const now = Date.now();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const claims = { ...order, ctVal: rules.ctVal, clOrdId: `orb${nonce.slice(0, 29)}`, issuedAt: now, expiresAt: now + CHALLENGE_TTL_MS };
  const challenge = await makeChallenge(env, claims);
  return responseJson({
    preview: {
      instId: order.instId,
      side: order.side.toUpperCase(),
      tdMode: order.tdMode,
      sizeContracts: order.sz,
      contractValue: rules.ctVal,
      notionalUsdt: notional.toFixed(4),
      limitPrice: order.px,
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
  const order = validateOrder(input);
  if (!order || input.confirmText !== OWNER_CONFIRMATION) return responseJson({ error: 'Invalid order or explicit confirmation missing' }, 400);
  const claims = await readChallenge(env, input.challenge);
  if (!claims || claims.expiresAt < Date.now() || claims.issuedAt > Date.now() + 5000) {
    return responseJson({ error: 'Order preview expired or invalid; request a new preview' }, 400);
  }
  if (claims.instId !== order.instId || claims.side !== order.side || claims.tdMode !== order.tdMode
      || claims.sz !== order.sz || claims.px !== order.px) {
    return responseJson({ error: 'Submitted order differs from the confirmed preview' }, 400);
  }
  let marketPrice;
  let rules;
  try {
    [marketPrice, rules] = await Promise.all([okxTicker(order.instId), okxInstrumentRules(order.instId)]);
  } catch {
    return responseJson({ error: 'Could not re-verify the current OKX price and contract rules; no order was sent' }, 502);
  }
  if (!validByInstrumentRules(order, rules) || String(rules.ctVal) !== String(claims.ctVal)
      || orderNotional(order, rules) > maxNotional(env) + 1e-8
      || Math.abs(Number(order.px) / marketPrice - 1) > MAX_PRICE_DEVIATION) {
    return responseJson({ error: 'Market price, contract rules, or order limits changed; request a fresh preview' }, 409);
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
    tdMode: order.tdMode,
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
        sizeContracts: order.sz,
        notionalUsdt: orderNotional(order, rules).toFixed(4),
        limitPrice: order.px,
        orderId: String(result.data[0].ordId || ''),
        clientOrderId: claims.clOrdId,
        state: String(result.data[0].sMsg || 'accepted'),
      },
    };
    try { await completeOrderGuard(env, claims.clOrdId, outcome); } catch { /* Keep reservation pending to block duplicate submission. */ }
    return responseJson(outcome);
  } catch (error) {
    const outcome = { ok: false, message: 'Order request outcome is uncertain; check OKX history before any new attempt' };
    try { await completeOrderGuard(env, claims.clOrdId, outcome); } catch { /* Pending reservation blocks replay. */ }
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

function closedAutoCandles(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => Array.isArray(row) && row.length >= 9 && row[8] === '1')
    .map(row => ({ ts: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }))
    .filter(row => Number.isFinite(row.ts) && row.ts > 0 && positiveFinite(row.open) && positiveFinite(row.high)
      && positiveFinite(row.low) && positiveFinite(row.close) && row.high >= Math.max(row.open, row.close)
      && row.low <= Math.min(row.open, row.close))
    .sort((a, b) => a.ts - b.ts);
}

function autoRsi(values, period = AUTO_RSI_PERIOD) {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(0, change);
    loss += Math.max(0, -change);
  }
  let averageGain = gain / period, averageLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function autoAtr(candles, period = AUTO_RSI_PERIOD) {
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i], previous = candles[i - 1];
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  if (!ranges.length) return 0;
  const count = Math.min(period, ranges.length);
  let result = ranges.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
  for (let i = count; i < ranges.length; i++) result = (result * (period - 1) + ranges[i]) / period;
  return result;
}

function floorContracts(value, step) {
  const digits = Math.min(8, (String(step).split('.')[1] || '').length);
  if (!Number.isFinite(value) || value <= 0 || value >= 1e12) return '0';
  const units = decimalUnits(value.toFixed(8), 8);
  const stepUnits = decimalUnits(String(step), 8);
  if (units === null || stepUnits === null || stepUnits <= 0n) return '0';
  const rounded = units / stepUnits * stepUnits;
  const whole = (rounded / 100_000_000n).toString();
  const fraction = (rounded % 100_000_000n).toString().padStart(8, '0').slice(0, digits).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function priceToTick(value, tick, roundUp) {
  const digits = Math.min(8, (String(tick).split('.')[1] || '').length);
  const step = Number(tick);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(step) || step <= 0) return null;
  const count = roundUp ? Math.ceil(value / step - 1e-10) : Math.floor(value / step + 1e-10);
  const rounded = count * step;
  return Number.isFinite(rounded) && rounded > 0 ? rounded.toFixed(digits) : null;
}

async function fetchAutoCandles(instId) {
  const url = new URL('/api/v5/market/candles', OKX);
  url.searchParams.set('instId', instId);
  url.searchParams.set('bar', '1H');
  url.searchParams.set('limit', '100');
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.code !== '0') throw new Error('Candles unavailable');
  const candles = closedAutoCandles(result.data);
  if (candles.length < AUTO_RSI_PERIOD + 2) throw new Error('Not enough closed candles');
  return candles;
}

export class AutoTrader {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
  }

  async fetch(request) {
    return this.enqueue(() => this.handleFetch(request));
  }

  enqueue(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async handleFetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status' && request.method === 'GET') return responseJson(await this.currentState());
    if (path === '/start' && request.method === 'POST') return this.start(request);
    if (path === '/stop' && request.method === 'POST') return this.stop();
    return responseJson({ error: 'Not found' }, 404);
  }

  async currentState() {
    return (await this.ctx.storage.get('autoState')) || { running: false, mode: 'disabled', lastMessage: 'Bot belum dimulai' };
  }

  async start(request) {
    const config = autoTradingConfiguration(this.env);
    if (!config.enabled) return responseJson({ error: 'Auto-trading backend is not enabled' }, 503);
    const input = await readJson(request);
    const expectedConfirmation = config.mode === 'live' ? 'MULAI AUTO TRADE LIVE' : 'MULAI AUTO TRADE DEMO';
    const riskPct = Number(input?.riskPct);
    if (!input || input.confirmText !== expectedConfirmation || !isUsdtSwapInstrument(input.instId)
        || !Number.isFinite(riskPct) || riskPct < 0.25 || riskPct > 1) {
      return responseJson({ error: 'Invalid configuration or explicit mode-specific confirmation missing' }, 400);
    }
    const existing = await this.currentState();
    if (existing.running) return responseJson({ error: 'Auto-trading is already running' }, 409);
    try {
      const [rules] = await Promise.all([okxInstrumentRules(input.instId), privateAccountSnapshot(this.env)]);
      if (!rules || rules.instId !== input.instId) return responseJson({ error: 'Unsupported instrument' }, 400);
    } catch {
      return responseJson({ error: 'Connection preflight failed; auto-trading was not started' }, 502);
    }
    const state = {
      running: true,
      mode: config.mode,
      instId: input.instId,
      bar: '1H',
      riskPct,
      maxNotionalUsdt: maxNotional(this.env),
      startedAt: Date.now(),
      lastEvaluatedAt: 0,
      lastCycleAt: 0,
      lastSignal: 'WAIT',
      lastMessage: 'Aktif; memeriksa sinyal pada penutupan candle 1H berikutnya',
      lastOrder: null,
    };
    await this.ctx.storage.put('autoState', state);
    await this.ctx.storage.setAlarm(Date.now() + AUTO_POLL_INTERVAL_MS);
    return responseJson(state, 201);
  }

  async stop() {
    const state = await this.currentState();
    const wasRunning = state.running;
    state.running = false;
    state.stoppedAt = Date.now();
    if (wasRunning) state.lastMessage = 'Bot dihentikan; tidak ada order baru yang akan dibuat';
    await this.ctx.storage.put('autoState', state);
    if (typeof this.ctx.storage.deleteAlarm === 'function') await this.ctx.storage.deleteAlarm();
    return responseJson(state);
  }

  async alarm() {
    return this.enqueue(() => this.runAlarm());
  }

  async runAlarm() {
    let state = await this.currentState();
    if (!state.running) return;
    state.lastCycleAt = Date.now();
    try {
      if (!autoTradingConfiguration(this.env).enabled || state.mode !== tradingConfiguration(this.env).mode) {
        state.running = false;
        state.lastMessage = 'Konfigurasi server berubah; bot dihentikan secara aman';
      } else {
        state = await this.evaluateAndMaybeTrade(state);
      }
    } catch {
      state.running = false;
      state.lastMessage = 'Koneksi atau hasil order tidak pasti; bot dihentikan. Periksa akun dan riwayat OKX sebelum melanjutkan.';
    }
    await this.ctx.storage.put('autoState', state);
    if (state.running) await this.ctx.storage.setAlarm(Date.now() + AUTO_POLL_INTERVAL_MS);
  }

  async evaluateAndMaybeTrade(state) {
    const [candles, ticker, rules, account, pending] = await Promise.all([
      fetchAutoCandles(state.instId),
      okxTicker(state.instId),
      okxInstrumentRules(state.instId),
      privateAccountSnapshot(this.env),
      okxPrivateRequest(this.env, 'GET', `/api/v5/trade/orders-pending?instId=${encodeURIComponent(state.instId)}`),
    ]);
    const latest = candles.at(-1);
    state.lastCycleAt = Date.now();
    if (Date.now() - latest.ts > 2 * 60 * 60 * 1000) {
      state.lastMessage = 'Data candle 1H terlalu lama; order dilewati sampai data segar tersedia';
      return state;
    }
    if (latest.ts <= state.lastEvaluatedAt) {
      state.lastMessage = 'Menunggu candle 1H tertutup berikutnya';
      return state;
    }
    state.lastEvaluatedAt = latest.ts;
    const closes = candles.map(item => item.close);
    const previousRsi = autoRsi(closes.slice(0, -1));
    const currentRsi = autoRsi(closes);
    state.lastSignal = previousRsi > 30 && currentRsi <= 30 ? 'BUY'
      : previousRsi < 70 && currentRsi >= 70 ? 'SELL' : 'WAIT';
    if (state.lastSignal === 'WAIT') {
      state.lastMessage = `Tidak ada crossing RSI pada candle tertutup; RSI ${currentRsi.toFixed(1)}`;
      return state;
    }
    if (account.openPositions.some(item => item.instId === state.instId)) {
      state.lastMessage = 'Ada posisi Swap pada instrumen ini; bot tidak akan menambah, membalik, atau menutup posisi yang sudah ada';
      return state;
    }
    if ((Array.isArray(pending.data) ? pending.data : []).some(item => item.instId === state.instId)) {
      state.lastMessage = 'Ada order terbuka pada instrumen ini; bot menunggu tanpa membuat order ganda';
      return state;
    }
    if (!['net_mode', 'long_short_mode'].includes(account.positionMode)) {
      state.lastMessage = 'Mode posisi akun tidak dapat diverifikasi; order dilewati';
      return state;
    }
    const price = Number(ticker);
    if (!Number.isFinite(price) || Math.abs(price / latest.close - 1) > 0.05) {
      state.lastMessage = 'Harga bergerak lebih dari 5% dari candle sinyal; order dilewati untuk menghindari data usang';
      return state;
    }
    const atr = autoAtr(candles);
    const stopDistance = atr * 1.5;
    if (!Number.isFinite(stopDistance) || stopDistance <= 0 || account.availableUsdt <= 0) {
      state.lastMessage = 'Saldo USDT tersedia atau ATR tidak cukup; tidak ada order yang dikirim';
      return state;
    }
    const side = state.lastSignal === 'BUY' ? 'buy' : 'sell';
    const riskBudget = account.availableUsdt * state.riskPct / 100;
    const contractValue = Number(rules.ctVal);
    const maxExposure = Math.min(maxNotional(this.env), account.availableUsdt * 0.5);
    const rawSize = Math.min(
      riskBudget / (stopDistance * contractValue),
      maxExposure / (price * contractValue),
      positiveFinite(rules.maxMktSz) ? Number(rules.maxMktSz) : Infinity,
    );
    const size = floorContracts(rawSize, rules.lotSz);
    const notional = Number(size) * price * contractValue;
    if (Number(size) < Number(rules.minSz) || !Number.isFinite(notional) || notional > maxExposure + 1e-8) {
      state.lastMessage = `Sinyal ${state.lastSignal}, tetapi ukuran minimum atau batas eksposur ${maxExposure.toFixed(2)} USDT tidak terpenuhi`;
      return state;
    }
    const stopLoss = priceToTick(side === 'buy' ? price - stopDistance : price + stopDistance, rules.tickSz, side === 'sell');
    const takeProfit = priceToTick(side === 'buy' ? price + atr * 2.5 : price - atr * 2.5, rules.tickSz, side === 'buy');
    if (!stopLoss || !takeProfit || Number(stopLoss) <= 0 || Number(takeProfit) <= 0) {
      state.lastMessage = 'Harga SL/TP tidak valid; tidak ada order yang dikirim';
      return state;
    }
    const clientOrderId = `orb${crypto.randomUUID().replace(/-/g, '').slice(0, 29)}`;
    const order = {
      instId: state.instId,
      tdMode: 'isolated',
      side,
      ordType: 'market',
      sz: size,
      clOrdId: clientOrderId,
      tag: 'orbital-auto',
      attachAlgoOrds: [{
        tpTriggerPx: takeProfit,
        tpOrdPx: '-1',
        tpTriggerPxType: 'mark',
        slTriggerPx: stopLoss,
        slOrdPx: '-1',
        slTriggerPxType: 'mark',
      }],
    };
    if (account.positionMode === 'long_short_mode') order.posSide = side === 'buy' ? 'long' : 'short';
    state.lastMessage = `Mengirim sinyal ${state.lastSignal}; menunggu jawaban OKX`;
    await this.ctx.storage.put('autoState', state);
    const reservation = await reserveOrderOnce(this.env, clientOrderId);
    if (reservation.status !== 201) throw new Error('Auto order idempotency guard unavailable');
    const result = await okxPrivateRequest(this.env, 'POST', '/api/v5/trade/order', JSON.stringify(order));
    const orderResult = result.data?.[0] || {};
    if (String(orderResult.sCode) !== '0' || !orderResult.ordId) throw new Error('OKX order result was not confirmed');
    const outcome = {
      ok: true,
      order: {
        instrument: state.instId,
        side: side.toUpperCase(),
        sizeContracts: size,
        notionalUsdt: notional.toFixed(4),
        stopLoss,
        takeProfit,
        orderId: String(orderResult.ordId || ''),
        clientOrderId,
      },
    };
    if (!await completeOrderGuard(this.env, clientOrderId, outcome)) throw new Error('Auto order outcome could not be persisted');
    state.lastOrder = outcome.order;
    state.lastMessage = `OKX menerima order ${side.toUpperCase()} ${size} kontrak; SL ${stopLoss}, TP ${takeProfit}. Status diterima bukan jaminan order terisi.`;
    return state;
  }
}

async function autoTraderRoute(request, env, action) {
  if (!authorized(request, env)) return responseJson({ error: 'Unauthorized' }, 401);
  if (!['status', 'start', 'stop'].includes(action)) return responseJson({ error: 'Not found' }, 404);
  if (action === 'start' && !autoTradingConfiguration(env).enabled) {
    return responseJson({ error: 'Auto-trading backend not enabled' }, 503);
  }
  if ((action === 'status' && request.method !== 'GET') || (action !== 'status' && request.method !== 'POST')) {
    return responseJson({ error: 'Method not allowed' }, 405);
  }
  let body;
  if (action === 'start') {
    body = await readJson(request);
    if (!body) return responseJson({ error: 'Invalid request body' }, 400);
  }
  try {
    const stub = env.ORBITAL_AUTO_TRADER.get(env.ORBITAL_AUTO_TRADER.idFromName(AUTO_TRADER_NAME));
    const internal = new Request(`https://auto-trader/${action}`, {
      method: action === 'status' ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await stub.fetch(internal);
  } catch {
    return responseJson({ error: 'Auto-trader storage is unavailable' }, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (!sameOrigin(request)) return responseJson({ error: 'Cross-origin request blocked' }, 403);
      if (url.pathname === '/api/status' && request.method === 'GET') {
        const accountConfig = accountReadConfiguration(env);
        const config = tradingConfiguration(env);
        const autoConfig = autoTradingConfiguration(env);
        return responseJson({ marketProxy: true, accountReadAvailable: accountConfig.configured, accountMode: accountConfig.mode,
          tradingAvailable: config.configured, tradingMode: config.mode,
          autoTradingAvailable: autoConfig.enabled, maxNotionalUsdt: maxNotional(env) });
      }
      if (url.pathname.startsWith('/api/market/')) return marketProxy(request, url);
      if (url.pathname === '/api/private/account' && request.method === 'GET') return privateAccountRoute(request, env);
      if (url.pathname.startsWith('/api/auto/')) return autoTraderRoute(request, env, url.pathname.slice('/api/auto/'.length));
      if (url.pathname === '/api/live/quote' && request.method === 'POST') return createOrderQuote(request, env);
      if (url.pathname === '/api/live/order' && request.method === 'POST') return submitOrder(request, env);
      return responseJson({ error: 'Not found' }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
