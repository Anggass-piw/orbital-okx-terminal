import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const boundary = source.indexOf('instrumentSearchController = createInstrumentSearch({');
assert.ok(boundary > 0, 'App function boundary found');
const elements = new Map();
let storedPortfolio = null;
const element = selector => {
  if (!elements.has(selector)) elements.set(selector, {
    textContent: '', innerHTML: '', className: '', disabled: false, hidden: false,
    style: {}, classList: { toggle() {}, add() {}, remove() {} }, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  });
  return elements.get(selector);
};
const context = vm.createContext({
  assert,
  console,
  document: { querySelector: element },
  window: { devicePixelRatio: 1 },
  localStorage: { getItem: key => key === 'orbital-paper-v2' ? storedPortfolio : null, setItem(key,value) { if (key === 'orbital-paper-v2') storedPortfolio = value; } },
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
assert.equal(ema([1,2,3],3)[2],2, 'EMA seeds from a simple moving average');
assert.equal(bollinger(Array.from({length:20},(_,i)=>i+1),20,2)[19].middle,10.5);
const risingCandles=Array.from({length:60},(_,i)=>{const close=100+i+i*i*0.02;return {open:close-0.2,high:close+1,low:close-1,close};});
const fallingCandles=Array.from({length:60},(_,i)=>{const close=160-i-i*i*0.02;return {open:close+0.2,high:close+1,low:close-1,close};});
assert.equal(trendDirection(risingCandles),'BUY','The 4H filter needs both EMA and positive MACD histogram');
assert.equal(trendDirection(fallingCandles),'SELL');
assert.equal(trendDirection(risingCandles.slice(0,20)),null,'Insufficient higher-timeframe history fails closed');
state.taWeight=0.7; state.taScore=0.5; state.faScore=-0.25; state.fundingWeight=0; state.oiWeight=0;
state.fundingScore=null; state.oiScore=null;
assert.ok(Math.abs(recomputeCompositeScore()-0.275)<1e-12,'Default derivative weights preserve the prior TA/manual composite');
state.fundingWeight=0.2; state.oiWeight=0.2; state.fundingScore=-1; state.oiScore=1;
assert.ok(Math.abs(recomputeCompositeScore()-0.165)<1e-12,'Optional derivative factors are normalized against the configured weights');
state.trendFilterEnabled=true; state.trendConfirmed='SELL'; state.score=0.9;
assert.equal(scoreAction(),'HOLD','A conflicting 4H trend blocks a directional signal');
state.trendConfirmed='BUY'; assert.equal(scoreAction(),'BUY');
state.trendFilterEnabled=false; state.fundingWeight=0; state.oiWeight=0;
const volumeCandles=Array.from({length:21},(_,i)=>({vol:i===20?120:100}));
assert.equal(volumeExpansion(volumeCandles),true,'Volume confirmation accepts a closed candle at 1.2x the 20-candle average');
volumeCandles[20].vol=119; assert.equal(volumeExpansion(volumeCandles),false);
assert.equal(volumeExpansion(volumeCandles.slice(0,20)),null,'Volume confirmation fails closed without 21 candles');
state.taConfirmEnabled=true; state.taTrendConfirmed='BUY'; state.volumeConfirmed=false; state.score=0.9;
assert.equal(scoreAction(),'HOLD','Technical confirmation blocks a signal without volume expansion');
state.volumeConfirmed=true; assert.equal(scoreAction(),'BUY');
state.taTrendConfirmed='SELL'; assert.equal(scoreAction(),'HOLD','Opposing EMA/MACD confirmation blocks the directional signal');
state.taConfirmEnabled=false;
assert.equal(priceCrossed('above',99,100,100),true);
assert.equal(priceCrossed('above',100,101,100),false,'Alert fires on a crossing, not if already beyond the level');
assert.equal(priceCrossed('below','101','99','100'),true,'Alert input values are numerically normalized');
assert.equal(priceCrossed('above',null,101,100),false);
state.priceAlerts=[{instId:'BTC-USDT-SWAP',direction:'above',price:100,lastPrice:null,triggeredAt:null}];
evaluatePriceAlerts('BTC-USDT-SWAP',101);
assert.equal(state.priceAlerts[0].triggeredAt,null,'The first quote initializes the alert baseline without a false crossing');
assert.equal(state.priceAlerts[0].lastPrice,101);
state.priceAlerts[0].price=102; evaluatePriceAlerts('BTC-USDT-SWAP',103);
assert.ok(state.priceAlerts[0].triggeredAt,'A later actual crossing triggers the alert');
state.priceAlerts=[];
assert.equal(simulateBacktest(risingCandles).error,undefined,'Closed-candle backtest returns metrics for sufficient data');
assert.ok(Number.isFinite(simulateBacktest(risingCandles).netReturn));
assert.equal(simulateBacktest(risingCandles.slice(0,20)).error,'Butuh minimal 35 candle tertutup.');
assert.ok(csvCell('=1+1').includes("'=1+1"),'CSV exports neutralize spreadsheet formula prefixes');
assert.equal(validatePaperBackup({schema:'orbital-paper-backup',version:1,portfolio:{cash:100,trades:[],position:null}}).cash,100);
assert.equal(validatePaperBackup({schema:'orbital-paper-backup',version:1,portfolio:{cash:100,trades:[{asset:'BTC-USDT-SWAP',side:'HACK',time:1,price:1,qty:1}],position:null}}),null,'Import rejects malformed or unsafe trade records');
assert.equal(validatePaperBackup({schema:'orbital-paper-backup',version:1,portfolio:{cash:100,trades:[{asset:'BTC-USDT-SWAP',side:'LONG',time:1,price:1,qty:1,fee:0.05}],position:null}}).trades[0].entryFee,0.05,'Backup preserves opening fill fee');
assert.equal(validatePaperBackup({schema:'orbital-paper-backup',version:1,portfolio:{cash:100,trades:[{asset:'BTC-USDT-SWAP',side:'LONG',time:1,price:1,qty:1,fee:-0.05}],position:null}}),null,'Backup rejects negative transaction fees');
localStorage.setItem('orbital-paper-v2',JSON.stringify({cash:900,position:{instId:'BTC-USDT-SWAP',side:'long',qty:1,entry:100,ctVal:0.01,margin:100,entryFee:0.05,fundingAccrued:-0.01,fundingRateAtEntry:0.0002,nextFundingTime:123456789,autoExit:true},trades:[]}));
const reloadedPortfolio=loadPortfolio();
assert.equal(reloadedPortfolio.position.autoExit,true,'New paper auto-exit intent survives a browser reload');
assert.equal(reloadedPortfolio.position.entryFee,0.05);
assert.equal(reloadedPortfolio.position.fundingAccrued,-0.01);
assert.equal(reloadedPortfolio.position.nextFundingTime,123456789);
localStorage.setItem('orbital-paper-v2',JSON.stringify({cash:900,position:{instId:'BTC-USDT-SWAP',side:'long',qty:1,entry:100,ctVal:0.01,margin:100},trades:[]}));
assert.equal(loadPortfolio().position.autoExit,false,'Older stored positions do not get retroactive auto-exit behavior');
localStorage.setItem('orbital-paper-v2','{}');
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
state.candles = [{ts:1000,open:100,high:102,low:98,close:100,vol:1}];
state.analysisCandles = state.candles;
let chartMarkers = [];
tvChart = { timeScale:()=>({fitContent(){}}) };
tvCandleSeries = {setData(){},removePriceLine(){},createPriceLine:line=>line};
tvMarkers = {setMarkers:markers=>{chartMarkers=markers;}};
for (const [side,score,sl,tp] of [['long',1,85,125],['short',-1,115,75]]) {
  state.price=100; state.atr=10; state.score=score;
  state.portfolio={cash:10000,position:null,trades:[]};
  updateUI();
  assert.equal($('#signalText').textContent,side.toUpperCase());
  assert.equal($('#riskSL').textContent,fmt(sl,6));
  assert.equal($('#riskTP').textContent,fmt(tp,6));
  assert.equal(tvPriceLines[1].price,sl); assert.equal(tvPriceLines[2].price,tp);
  assert.ok(chartMarkers[0].text.startsWith(side.toUpperCase()));
  assert.match($('#longScenario').textContent,/Entry .*TP .*SL /);
  assert.match($('#shortScenario').textContent,/Entry .*TP .*SL /);
  paperTrade();
  assert.equal(state.portfolio.position.side,side);
  const expectedFill=100*(side==='long'?1+0.0002:1-0.0002);
  const expectedSign=side==='long'?1:-1;
  const storedSl=expectedFill-expectedSign*10*1.5;
  const storedTp=expectedFill+expectedSign*10*2.5;
  assert.equal(state.portfolio.position.entry,expectedFill);
  assert.equal(state.portfolio.position.sl,storedSl); assert.equal(state.portfolio.position.tp,storedTp);
  assert.equal(state.portfolio.position.autoExit,true);
  assert.ok(state.portfolio.position.entryFee>0,'Paper entry charges the assumed taker fee');
  assert.equal(state.portfolio.trades[0].side,side.toUpperCase());
  state.score=-score; updateUI();
  const opposite=side==='long'?'SHORT':'LONG';
  assert.match($('#riskDirection').textContent,new RegExp('Referensi '+opposite));
  assert.match($('#riskDirection').textContent,/bukan level posisi aktif/);
  assert.ok(tvPriceLines.every(line=>line.title.startsWith('REF '+opposite)));
  assert.equal($('#riskSL').textContent,fmt(tvPriceLines[1].price,6));
  assert.equal($('#paperTradeBtn').textContent,'Tutup posisi '+side.toUpperCase()+' paper');
  assert.equal(state.portfolio.position.sl,storedSl, 'Signal references never overwrite stored position levels');
  state.score=0; state.price=side==='long'?130:70; updateUI();
  assert.equal($('#riskSL').textContent,'—'); assert.equal($('#riskTP').textContent,'—');
  assert.equal(tvPriceLines.length,0, 'WAIT has no directional signal overlay');
  assert.equal(state.portfolio.position.side,side, 'Rendering a signal alone does not trigger an exit; valid ticker evaluation does');
}
tvChart=null; tvCandleSeries=null; tvMarkers=null;
state.price=100; state.atr=10;
assert.equal(state.live.available,false); assert.equal(state.live.autoAvailable,false);
state.instruments = [{instId:'1000PEPE-USDT-SWAP',baseCcy:'1000PEPE',lotSz:'0.0001'}];
state.portfolio = {
  cash:99,
  position:{instId:'1000PEPE-USDT-SWAP',side:'long',qty:0.0001,entry:100,ctVal:0.01,margin:1,lotSz:'0.0001'},
  trades:[{asset:'1000PEPE-USDT-SWAP',side:'LONG',price:100,qty:0.0001,lotSz:'0.0001',time:Date.now(),pnl:null}],
};
renderPortfolio();
assert.equal($('#openPosition').textContent,'LONG 0.0001 kontrak 1000PEPE', 'Open positions preserve the instrument lot precision');
assert.match($('#activityBody').innerHTML,/0\.0001 kontrak/, 'Trade history preserves small valid contract quantities');
state.price = 100; state.atr = 0.1; state.riskPct = 1;
state.portfolio = { cash:50, position:null, trades:[] };
const cashLimitedSize = calcPosition();
assert.equal(cashLimitedSize.qty, 49.97, 'Collateral sizing reserves the assumed taker fee');
assert.ok(Math.abs(cashLimitedSize.risk - 49.97*0.01*0.1*1.5) < 1e-12, 'Reported nominal risk reflects the stop loss on the fee-limited quantity');
state.portfolio = { cash:0, position:{instId:'BTC-USDT-SWAP', side:'long', qty:2, entry:90, ctVal:0.01, margin:0.2, sl:80, tp:120}, trades:[] };
state.asset = 'BTC-USDT-SWAP'; state.price = 100; state.connected = true;
state.score = -1;
paperTrade();
assert.equal(state.portfolio.position, null, 'A SELL signal closes an open paper long even with zero free cash');
const longExitFill=100*(1-0.0002), longGross=(longExitFill-90)*2*0.01, longFee=longExitFill*2*0.01*0.0005;
assert.ok(Math.abs(state.portfolio.cash - (0.2+longGross-longFee)) < 1e-12, 'Closing returns margin plus gross P&L less exit cost');
assert.equal(state.portfolio.trades.length, 1);
assert.ok(Math.abs(state.portfolio.trades[0].pnl - (longGross-longFee)) < 1e-12);
state.portfolio = { cash:1, position:{instId:'BTC-USDT-SWAP', side:'short', qty:2, entry:100, ctVal:0.01, margin:0.2, sl:120, tp:80}, trades:[] };
state.price = 90; state.score = 1;
paperTrade();
assert.equal(state.portfolio.position, null, 'A BUY signal closes an open paper short');
const shortExitFill=90*(1+0.0002), shortGross=(shortExitFill-100)*2*0.01*-1, shortFee=shortExitFill*2*0.01*0.0005;
assert.ok(Math.abs(state.portfolio.trades[0].pnl - (shortGross-shortFee)) < 1e-12, 'Short P&L reverses the price move and includes costs');
state.fundamentals={fundingRate:0.001,nextFundingTime:null};
const fundingLong={side:'long',qty:10,ctVal:0.01,nextFundingTime:Date.now()-1,fundingRateAtEntry:0.0001,fundingAccrued:0};
state.portfolio={cash:100,position:fundingLong,trades:[]};
applyEstimatedFunding(fundingLong,100,Date.now());
assert.ok(Math.abs(state.portfolio.cash-99.99)<1e-12,'Positive estimated funding debits a long paper position');
assert.ok(Math.abs(fundingLong.fundingAccrued+0.01)<1e-12);
const fundingShort={side:'short',qty:10,ctVal:0.01,nextFundingTime:Date.now()-1,fundingRateAtEntry:0.001,fundingAccrued:0};
state.portfolio.cash=100; applyEstimatedFunding(fundingShort,100,Date.now());
assert.ok(Math.abs(state.portfolio.cash-100.01)<1e-12,'Positive estimated funding credits a short paper position');
const fallbackNow=Date.now();
const fallbackPosition={side:'long',qty:10,ctVal:0.01,openedAt:fallbackNow-8*60*60*1000-1000,nextFundingTime:null,fundingRateAtEntry:0.001,fundingAccrued:0};
state.portfolio.cash=100; applyEstimatedFunding(fallbackPosition,100,fallbackNow);
assert.ok(Math.abs(state.portfolio.cash-99.99)<1e-12,'Missing OKX schedule falls back to one estimated 8-hour interval');
assert.ok(fallbackPosition.nextFundingTime>fallbackNow,'Fallback advances its next deadline');
const missedNow=Date.now();
const missedPosition={side:'long',qty:10,ctVal:0.01,openedAt:missedNow-48*60*60*1000,nextFundingTime:missedNow-25*60*60*1000,fundingRateAtEntry:0.001,fundingAccrued:0};
state.portfolio.cash=100; applyEstimatedFunding(missedPosition,100,missedNow);
assert.ok(Math.abs(state.portfolio.cash-99.97)<1e-12,'At most three missed funding estimates are charged per refresh');
assert.ok(missedPosition.nextFundingTime>missedNow,'Excess missed intervals are skipped until the next estimated deadline');
state.fundamentals=null; state.price=89; state.connected=true; state.atr=10;
state.portfolio={cash:1000,position:{instId:'BTC-USDT-SWAP',side:'long',qty:1,entry:100,ctVal:0.01,margin:100,sl:90,tp:125,openedAt:Date.now(),entryFee:0.01,fundingAccrued:0,nextFundingTime:null,autoExit:true},trades:[]};
assert.equal(evaluatePaperExit('BTC-USDT-SWAP',89),true,'A valid ticker at/beyond the stored long stop auto-closes a new paper position');
assert.equal(state.portfolio.trades[0].exitReason,'SL');
assert.equal(state.portfolio.position,null);
state.portfolio={cash:1000,position:{instId:'BTC-USDT-SWAP',side:'long',qty:1,entry:100,ctVal:0.01,margin:100,sl:90,tp:110},trades:[]};
assert.equal(evaluatePaperExit('BTC-USDT-SWAP',89),false,'Legacy paper positions without the new explicit flag are not auto-closed');
assert.ok(state.portfolio.position,'Legacy position remains intact');
state.asset = 'SOL-USDT-SWAP'; state.candles = [{close:2225}];
$('#priceValue').textContent = '2225';
clearMarketDisplay('Memuat data OKX…');
assert.equal(state.price, null);
assert.equal(state.candles.length, 0);
assert.equal($('#priceValue').textContent, '—');
assert.equal($('#chartAsset').textContent, 'SOL-USDT-SWAP');
assert.equal($('#paperTradeBtn').disabled, true);
assert.equal($('#longScenario').textContent,'Menunggu data pasar');
assert.equal($('#shortScenario').textContent,'Menunggu data pasar');
`, context);
console.log('app-logic: OK — Wilder RSI/ATR, composite-score thresholds, contract-value long/short sizing, margin caps, exits and stale-market guards pass without network or exchange orders.');
