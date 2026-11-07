import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const boundary = source.indexOf('instrumentSearchController = createInstrumentSearch({');
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
const mixedCloses = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46.00,46.03,46.41];
assert.ok(Math.abs(rsi(mixedCloses, 14) - 69.34685316290866) < 1e-10, 'Mixed gains/losses use Wilder smoothing after the seed');
const gapCandles = [{high:10,low:8,close:9},{high:13,low:12,close:12},{high:14,low:11,close:13},{high:13,low:12,close:12.5}];
assert.equal(atr(gapCandles, 2), 2.25, 'ATR includes previous-close gaps and smooths ranges 4, 3, 1');
state.instruments = [
  {instId:'BTC-USDT-SWAP',baseCcy:'BTC'},
  {instId:'ETH-USDT-SWAP',baseCcy:'ETH'},
  {instId:'1000PEPE-USDT-SWAP',baseCcy:'1000PEPE'},
];
assert.equal(filterInstruments('btc').map(item => item.instId).join(','), 'BTC-USDT-SWAP', 'Search is case-insensitive and matches the base currency');
assert.equal(filterInstruments(' ETH-USDT ').map(item => item.instId).join(','), 'ETH-USDT-SWAP', 'Search accepts spaces and pair separators');
assert.equal(filterInstruments('1000pepeusdt').map(item => item.instId).join(','), '1000PEPE-USDT-SWAP', 'Compact pair searches match contracts with numeric prefixes');
assert.equal(filterInstruments('USDT SWAP').length, 3, 'Multiple query terms must all match active USDT swaps');
assert.equal(filterInstruments('DOGE').length, 0, 'Unmatched symbols produce an empty result set');
state.price = null; state.taScore = 0.5; state.taWeight = 0.7;
setSentiment(-0.25);
assert.ok(Math.abs(state.score - 0.275) < 1e-12, 'Actual sentiment path computes the weighted composite');
state.taWeight = 0; setSentiment(-1); assert.equal(state.score, -1);
state.taWeight = 1; setSentiment(-1); assert.equal(state.score, 0.5);
for (const [score, action] of [[0.65,'HOLD'],[-0.65,'HOLD'],[0.650001,'BUY'],[-0.650001,'SELL']]) {
  state.score = score; assert.equal(scoreAction(), action);
}
state.price = 100; state.atr = 10; state.riskPct = 1; state.connected = true; state.loading = false;
state.asset = 'BTC-USDT-SWAP';
state.instrument = {instId:'BTC-USDT-SWAP',baseCcy:'BTC',settleCcy:'USDT',ctVal:'0.01',ctValCcy:'BTC',minSz:'0.01',lotSz:'0.01',tickSz:'0.1',maxLever:'10'};
state.leverage = 1;
state.portfolio = { cash:10000, position:null, trades:[] };
const size = calcPosition('long');
assert.ok(Math.abs(size.risk - 99.999) < 1e-8, 'Rounded contract size does not exceed the risk budget');
assert.equal(size.sl, 85); assert.equal(size.tp, 125);
assert.equal(size.qty, 666.66, 'Risk sizing uses risk / (stop distance × contract value)');
assert.equal(size.notional, 666.66); assert.equal(size.margin, 666.66);
const shortSize = calcPosition('short');
assert.equal(shortSize.sl, 115); assert.equal(shortSize.tp, 75, 'Short stop and take-profit are direction-aware');
state.price = 100; state.atr = 0.1; state.riskPct = 1;
state.portfolio = { cash:50, position:null, trades:[] };
const cashLimitedSize = calcPosition();
assert.equal(cashLimitedSize.qty, 50, 'Collateral caps contract quantity using contract value and leverage');
assert.ok(Math.abs(cashLimitedSize.risk - 0.075) < 1e-12, 'Reported nominal risk reflects the stop loss on the cash-limited quantity');
state.portfolio = { cash:0, position:{instId:'BTC-USDT-SWAP', side:'long', qty:2, entry:90, ctVal:0.01, margin:0.2, sl:80, tp:120}, trades:[] };
state.asset = 'BTC-USDT-SWAP'; state.price = 100; state.connected = true;
state.score = -1;
paperTrade();
assert.equal(state.portfolio.position, null, 'A SELL signal closes an open paper long even with zero free cash');
assert.ok(Math.abs(state.portfolio.cash - 0.4) < 1e-12, 'Closing returns margin plus contract-value P&L');
assert.equal(state.portfolio.trades.length, 1);
assert.ok(Math.abs(state.portfolio.trades[0].pnl - 0.2) < 1e-12);
state.portfolio = { cash:1, position:{instId:'BTC-USDT-SWAP', side:'short', qty:2, entry:100, ctVal:0.01, margin:0.2, sl:120, tp:80}, trades:[] };
state.price = 90; state.score = 1;
paperTrade();
assert.equal(state.portfolio.position, null, 'A BUY signal closes an open paper short');
assert.ok(Math.abs(state.portfolio.trades[0].pnl - 0.2) < 1e-12, 'Short P&L reverses the price move');
state.asset = 'SOL-USDT-SWAP'; state.candles = [{close:2225}];
$('#priceValue').textContent = '2225';
clearMarketDisplay('Memuat data OKX…');
assert.equal(state.price, null);
assert.equal(state.candles.length, 0);
assert.equal($('#priceValue').textContent, '—');
assert.equal($('#chartAsset').textContent, 'SOL-USDT-SWAP');
assert.equal($('#paperTradeBtn').disabled, true);
`, context);
console.log('app-logic: OK — Wilder RSI/ATR, composite-score thresholds, contract-value long/short sizing, margin caps, exits and stale-market guards pass without network or exchange orders.');
