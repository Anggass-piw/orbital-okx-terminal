import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const boundary = source.indexOf("$('#faInput').addEventListener");
assert.ok(boundary > 0, 'App function boundary found');
const elements = new Map();
const element = selector => {
  if (!elements.has(selector)) elements.set(selector, {
    textContent: '', innerHTML: '', className: '', disabled: false, hidden: false,
    style: {}, classList: { toggle() {}, add() {}, remove() {} },
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  });
  return elements.get(selector);
};
const context = vm.createContext({
  assert,
  console,
  document: { querySelector: element },
  window: { devicePixelRatio: 1 },
  localStorage: { getItem: () => null, setItem() {} },
  URL,
  fetch: () => { throw new Error('No network calls are allowed in app-logic tests'); },
});
vm.runInContext(source.slice(0, boundary) + `
assert.equal(rsi(Array.from({length:30}, () => 10), 14), 50);
assert.equal(rsi(Array.from({length:30}, (_, i) => i + 1), 14), 100);
assert.equal(rsi(Array.from({length:30}, (_, i) => 30 - i), 14), 0);
const flatCandles = Array.from({length:30}, (_, i) => ({ ts:i, open:100, high:102, low:98, close:100 }));
assert.equal(atr(flatCandles, 14), 4);
state.price = 100; state.atr = 10; state.riskPct = 1; state.connected = true; state.loading = false;
state.portfolio = { cash:10000, position:null, trades:[] };
const size = calcPosition();
assert.equal(size.risk, 100); assert.equal(size.sl, 85); assert.equal(size.tp, 125);
assert.ok(Math.abs(size.qty - 100/15) < 1e-10);
state.portfolio = { cash:0, position:{asset:'BTC-USDT', qty:2, entry:90, sl:80, tp:120}, trades:[] };
state.score = -1;
paperTrade();
assert.equal(state.portfolio.position, null, 'A SELL can close a paper long even when free cash is zero');
assert.equal(state.portfolio.cash, 200);
assert.equal(state.portfolio.trades.length, 1);
assert.equal(state.portfolio.trades[0].pnl, 20);
state.asset = 'SOL-USDT'; state.candles = [{close:2225}];
$('#priceValue').textContent = '2225';
clearMarketDisplay('Memuat data OKX…');
assert.equal(state.price, null);
assert.equal(state.candles.length, 0);
assert.equal($('#priceValue').textContent, '—');
assert.equal($('#chartAsset').textContent, 'SOL-USDT');
assert.equal($('#paperTradeBtn').disabled, true);
`, context);
console.log('app-logic: OK — RSI/ATR, risk sizing, zero-cash exits and stale cross-asset display guards pass without network or exchange orders.');
