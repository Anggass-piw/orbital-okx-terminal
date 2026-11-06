const API = '/api/market';
const $ = selector => document.querySelector(selector);
const SUPPORTED_ASSETS = new Set(['BTC-USDT', 'ETH-USDT', 'SOL-USDT']);
const LIVE_CONFIRMATION = 'KIRIM ORDER LIVE';

const state = {
  asset: 'BTC-USDT',
  bar: '1H',
  candles: [],
  price: null,
  open24h: null,
  volume: null,
  rsi: null,
  atr: null,
  taScore: 0,
  faScore: 0,
  score: 0,
  taWeight: 0.7,
  riskPct: 1,
  loading: false,
  pendingMarketReload: false,
  connected: false,
  live: { available: false, mode: 'disabled', maxNotionalUsdt: 25, quote: null },
  portfolio: loadPortfolio(),
  installPrompt: null,
};

function loadPortfolio() {
  try {
    const value = JSON.parse(localStorage.getItem('orbital-paper-v1') || '{}');
    const cash = Number(value.cash);
    const position = value.position && SUPPORTED_ASSETS.has(value.position.asset)
      && Number.isFinite(Number(value.position.qty)) && Number(value.position.qty) > 0
      && Number.isFinite(Number(value.position.entry)) && Number(value.position.entry) > 0
      ? {
          asset: value.position.asset,
          qty: Number(value.position.qty),
          entry: Number(value.position.entry),
          sl: Number(value.position.sl) || 0,
          tp: Number(value.position.tp) || 0,
          openedAt: Number(value.position.openedAt) || Date.now(),
        }
      : null;
    return {
      cash: Number.isFinite(cash) && cash >= 0 ? cash : 10_000,
      position,
      trades: Array.isArray(value.trades) ? value.trades.slice(-200).filter(trade => trade && typeof trade === 'object') : [],
    };
  } catch {
    return { cash: 10_000, position: null, trades: [] };
  }
}

function savePortfolio() {
  try {
    localStorage.setItem('orbital-paper-v1', JSON.stringify(state.portfolio));
  } catch {
    $('#paperFootnote').textContent = 'Penyimpanan lokal penuh atau diblokir; perubahan mungkin tidak tersimpan.';
  }
  renderPortfolio();
}

const fmt = (value, digits = 2) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : '—';
const money = value => '$' + fmt(value, 2);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function setConnection(online, label) {
  $('#connectionDot').parentElement.classList.toggle('offline', !online);
  $('#connectionText').textContent = label;
}

function setToday() {
  $('#todayLabel').textContent = new Date().toLocaleDateString('id-ID', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  }).toUpperCase();
}

async function getJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Respons server tidak valid (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(response.status === 429 ? 'RATE_LIMIT' : result?.error || result?.msg || `HTTP ${response.status}`);
  if (typeof result?.code === 'string' && result.code !== '0') throw new Error(result.code === '50011' ? 'RATE_LIMIT' : result.msg || 'OKX API error');
  return result;
}

async function loadLiveStatus() {
  try {
    const status = await getJson('/api/status');
    state.live.available = status.tradingAvailable === true;
    state.live.mode = status.tradingMode || 'disabled';
    state.live.maxNotionalUsdt = Number(status.maxNotionalUsdt) || 25;
  } catch {
    state.live.available = false;
    state.live.mode = 'disabled';
  }
  renderLiveStatus();
}

function renderLiveStatus() {
  const available = state.live.available;
  $('#liveUnavailable').hidden = available;
  $('#liveForm').hidden = !available;
  const badge = $('#liveModeBadge');
  badge.textContent = available ? `BACKEND ${state.live.mode.toUpperCase()}` : 'NONAKTIF';
  badge.className = available ? `live-mode-badge ${state.live.mode}` : 'live-mode-badge disabled';
  if (!available) {
    $('#liveUnavailable').textContent = 'Backend trading privat belum dikonfigurasi pada deployment ini. Halaman publik ini tidak dapat mengirim order; gunakan paper trading saja.';
  } else {
    $('#liveLimitNote').textContent = `Order spot limit saja · batas notional server ${money(state.live.maxNotionalUsdt)} · preview kedaluwarsa dalam 90 detik.`;
    $('#liveOrderPrice').value = state.price ? fmt(state.price, state.price > 100 ? 2 : 6).replace(/,/g, '') : '';
  }
}

function rsi(values, period) {
  if (values.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const difference = values[i] - values[i - 1];
    gain += Math.max(0, difference);
    loss += Math.max(0, -difference);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const difference = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, difference)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -difference)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function atr(candles, period) {
  if (candles.length < 2) return 0;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  const count = Math.min(period, ranges.length);
  if (!count) return 0;
  let result = ranges.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
  for (let i = count; i < ranges.length; i++) result = (result * (period - 1) + ranges[i]) / period;
  return result;
}

function scoreAction() {
  return state.score > 0.65 ? 'BUY' : state.score < -0.65 ? 'SELL' : 'HOLD';
}

function getEquity() {
  return state.portfolio.cash + (state.portfolio.position
    ? state.portfolio.position.qty * (state.price || state.portfolio.position.entry)
    : 0);
}

function calcPosition() {
  if (!state.price || !state.atr) return { qty: 0, risk: 0, sl: 0, tp: 0 };
  const stopDistance = state.atr * 1.5;
  const equity = getEquity();
  const risk = equity * state.riskPct / 100;
  const quantityByRisk = stopDistance > 0 ? risk / stopDistance : 0;
  const qty = Math.min(quantityByRisk, state.portfolio.cash / state.price);
  return { qty: Math.max(0, qty), risk, sl: state.price - stopDistance, tp: state.price + state.atr * 2.5 };
}

async function loadMarket() {
  if (state.loading) { state.pendingMarketReload = true; return; }
  const requestedAsset = state.asset;
  const requestedBar = state.bar;
  state.loading = true;
  state.connected = false;
  $('#paperTradeBtn').disabled = true;
  $('#refreshBtn').disabled = true;
  $('#refreshBtn').textContent = 'Memuat…';
  $('#chartEmpty').hidden = true;
  setConnection(false, 'Mengambil data');
  try {
    const instrument = encodeURIComponent(requestedAsset);
    const [tickerResult, candleResult] = await Promise.all([
      getJson(`${API}/ticker?instId=${instrument}`),
      getJson(`${API}/candles?instId=${instrument}&bar=${encodeURIComponent(requestedBar)}&limit=100`),
    ]);
    const ticker = tickerResult?.data?.[0];
    const candles = candleResult?.data;
    if (state.asset !== requestedAsset || state.bar !== requestedBar) { state.pendingMarketReload = true; return; }
    if (!ticker || !Array.isArray(candles) || candles.length < 15) throw new Error('Data pasar OKX kosong atau tidak lengkap');
    const price = Number(ticker.last);
    const open24h = Number(ticker.open24h);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Harga OKX tidak valid');
    const parsed = candles.map(row => ({
      ts: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
      close: Number(row[4]), vol: Number(row[5]),
    })).filter(candle => [candle.ts, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)).reverse();
    if (parsed.length < 15) throw new Error('Candlestick OKX tidak lengkap');
    state.price = price;
    state.open24h = Number.isFinite(open24h) && open24h > 0 ? open24h : null;
    state.volume = Number(ticker.vol24h);
    state.candles = parsed;
    state.rsi = rsi(parsed.map(candle => candle.close), 14);
    state.atr = atr(parsed, 14);
    state.taScore = clamp((50 - state.rsi) / 50, -1, 1);
    state.score = clamp(state.taWeight * state.taScore + (1 - state.taWeight) * state.faScore, -1, 1);
    state.connected = true;
    state.loading = false;
    updateUI();
    setConnection(true, 'Data live');
    $('#updatedAt').textContent = new Date(Number(ticker.ts) || Date.now()).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#chartEmpty').hidden = true;
    renderPortfolio();
    if (state.live.available && !state.live.quote) {
      $('#liveOrderPrice').value = fmt(state.price, state.price > 100 ? 2 : 6).replace(/,/g, '');
    }
  } catch (error) {
    setConnection(false, 'Data tidak tersedia');
    $('#chartEmpty').hidden = false;
    $('#chartEmpty').textContent = error.message === 'RATE_LIMIT'
      ? 'Batas permintaan OKX tercapai. Coba perbarui lagi setelah satu menit.'
      : 'Gagal mengambil data OKX. Periksa koneksi lalu coba lagi.';
    $('#paperFootnote').textContent = 'Koneksi gagal—simulasi order sementara nonaktif.';
    $('#paperTradeBtn').disabled = true;
    console.warn('OKX market fetch failed:', error.message);
  } finally {
    state.loading = false;
    $('#refreshBtn').disabled = false;
    $('#refreshBtn').innerHTML = '<span class="refresh-glyph">↻</span> Perbarui data';
    if (state.pendingMarketReload) { state.pendingMarketReload = false; loadMarket(); }
  }
}

function updateUI() {
  if (!state.price) return;
  $('#priceValue').textContent = fmt(state.price, state.price > 100 ? 2 : 6);
  $('#chartAsset').textContent = state.asset;
  const change = state.open24h ? (state.price / state.open24h - 1) * 100 : 0;
  const changeElement = $('#changeValue');
  changeElement.textContent = (change >= 0 ? '+' : '') + fmt(change, 2) + '%';
  changeElement.className = 'change-pill ' + (change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral');
  $('#rsiValue').textContent = fmt(state.rsi, 1);
  $('#rsiBar').style.width = clamp(state.rsi, 0, 100) + '%';
  $('#rsiBar').style.background = state.rsi < 30 ? 'var(--green)' : state.rsi > 70 ? 'var(--red)' : 'var(--yellow)';
  $('#rsiState').textContent = state.rsi < 30 ? 'Oversold' : state.rsi > 70 ? 'Overbought' : 'Netral';
  $('#scoreValue').textContent = (state.score >= 0 ? '+' : '') + fmt(state.score, 2);
  $('#gaugeScore').textContent = (state.score >= 0 ? '+' : '') + fmt(state.score, 2);
  const action = scoreAction();
  const signal = $('#signalText');
  signal.textContent = action;
  signal.className = action === 'BUY' ? 'signal-buy' : action === 'SELL' ? 'signal-sell' : 'signal-hold';
  $('#signalHint').textContent = action === 'BUY' ? 'Skor di atas ambang beli' : action === 'SELL' ? 'Skor di bawah ambang jual' : 'Belum melewati ambang sinyal';
  $('#scoreState').textContent = action === 'HOLD' ? 'WAIT · sinyal netral' : `SIGNAL · ${action}`;
  $('#scoreState').style.color = action === 'BUY' ? 'var(--green)' : action === 'SELL' ? 'var(--red)' : 'var(--yellow)';
  $('#taScore').textContent = (state.taScore >= 0 ? '+' : '') + fmt(state.taScore, 2);
  $('#faScoreDisplay').textContent = (state.faScore >= 0 ? '+' : '') + fmt(state.faScore, 2);
  $('#thresholdMarker').style.left = (50 + clamp(state.score, -1, 1) * 46) + '%';
  const degrees = state.score >= 0 ? Math.min(180, state.score * 180) : Math.max(-180, state.score * 180);
  $('#signalGauge').style.background = `conic-gradient(${state.score >= 0 ? 'var(--green)' : 'var(--red)'} ${Math.abs(degrees)}deg,#26313b ${Math.abs(degrees)}deg 360deg)`;
  $('#atrValue').textContent = fmt(state.atr, state.price > 100 ? 2 : 6);
  const position = calcPosition();
  $('#stopValue').textContent = fmt(position.sl, state.price > 100 ? 2 : 6);
  $('#positionSize').textContent = fmt(position.qty, 6) + ' ' + state.asset.split('-')[0];
  $('#riskAmount').textContent = 'Risiko nominal: ' + money(position.risk);
  $('#riskSL').textContent = fmt(position.sl, state.price > 100 ? 2 : 6);
  $('#riskTP').textContent = fmt(position.tp, state.price > 100 ? 2 : 6);
  $('#volumeValue').textContent = fmt(state.volume, 2);
  $('#paperTradeBtn').disabled = !state.connected || state.loading || action === 'HOLD'
    || (action === 'BUY' && !!state.portfolio.position)
    || (action === 'SELL' && !state.portfolio.position);
  $('#paperTradeBtn').textContent = action === 'BUY' ? 'Simulasikan BUY'
    : action === 'SELL' ? (state.portfolio.position ? 'Tutup posisi paper' : 'SELL — tidak ada posisi')
      : 'Tunggu sinyal valid';
  $('#paperFootnote').textContent = action === 'BUY' && state.portfolio.position
    ? 'Tutup posisi paper sebelum membuka posisi baru.'
    : action === 'SELL' && !state.portfolio.position
      ? 'Sinyal SELL muncul, tetapi tidak ada posisi long untuk ditutup.'
      : 'Paper trade tidak mengirim order ke bursa.';
  drawChart();
}

function drawChart() {
  const canvas = $('#priceChart');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);
  const candles = state.candles;
  if (!candles.length) return;
  const padding = { left: 7, right: 49, top: 8, bottom: 17 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const low = Math.min(...candles.map(candle => candle.low));
  const high = Math.max(...candles.map(candle => candle.high));
  const range = high - low || 1;
  const y = value => padding.top + (high - value) / range * chartHeight;
  context.strokeStyle = '#202a35';
  context.lineWidth = 1;
  context.font = '8px monospace';
  context.fillStyle = '#6e7c8a';
  context.textAlign = 'left';
  for (let i = 0; i < 5; i++) {
    const lineY = padding.top + i * chartHeight / 4;
    context.beginPath();
    context.moveTo(padding.left, lineY);
    context.lineTo(width - padding.right + 3, lineY);
    context.stroke();
    const value = high - i * range / 4;
    context.fillText(value >= 1000 ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : value.toFixed(2), width - padding.right + 7, lineY + 3);
  }
  const step = chartWidth / candles.length;
  const candleWidth = Math.max(2, step * 0.57);
  candles.forEach((candle, index) => {
    const x = padding.left + index * step + step / 2;
    const up = candle.close >= candle.open;
    const color = up ? '#35d6a1' : '#ff6d78';
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, y(candle.high));
    context.lineTo(x, y(candle.low));
    context.stroke();
    const top = y(Math.max(candle.open, candle.close));
    const bottom = y(Math.min(candle.open, candle.close));
    context.fillRect(x - candleWidth / 2, top, candleWidth, Math.max(1, bottom - top));
  });
  const last = candles.at(-1);
  context.setLineDash([3, 3]);
  context.strokeStyle = '#6d8b84';
  context.beginPath();
  context.moveTo(padding.left, y(last.close));
  context.lineTo(width - padding.right + 3, y(last.close));
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = '#142a25';
  context.fillRect(width - padding.right + 4, y(last.close) - 8, 43, 16);
  context.fillStyle = '#72d7ae';
  context.fillText(fmt(last.close, last.close > 100 ? 1 : 3), width - padding.right + 7, y(last.close) + 3);
  context.fillStyle = '#677483';
  context.textAlign = 'left';
  context.fillText(new Date(candles[0].ts).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }), padding.left, height - 3);
  context.textAlign = 'right';
  context.fillText(new Date(last.ts).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }), width - padding.right, height - 3);
}

function renderPortfolio() {
  const position = state.portfolio.position;
  const equity = getEquity();
  const pnl = position && state.price ? (state.price - position.entry) * position.qty : 0;
  $('#equityValue').textContent = money(equity);
  $('#cashValue').textContent = money(state.portfolio.cash);
  $('#pnlValue').textContent = (pnl >= 0 ? '+' : '') + money(pnl);
  $('#pnlValue').className = pnl > 0 ? 'positive-text' : pnl < 0 ? 'negative-text' : '';
  $('#openPosition').textContent = position ? `${fmt(position.qty, 6)} ${position.asset.split('-')[0]}` : 'Tidak ada';
  renderTrades();
}

function renderTrades() {
  const body = $('#activityBody');
  if (!state.portfolio.trades.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="7">Belum ada aktivitas. Tunggu data pasar lalu jalankan simulasi.</td></tr>';
    return;
  }
  body.innerHTML = state.portfolio.trades.slice().reverse().slice(0, 20).map(trade => `<tr>
    <td>${new Date(Number(trade.time) || Date.now()).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
    <td>${escapeHtml(trade.asset || '')}</td>
    <td><span class="side-badge ${trade.side === 'BUY' ? 'buy' : 'sell'}">${trade.side === 'BUY' ? 'BUY' : 'SELL'}</span></td>
    <td>${money(Number(trade.price))}</td><td>${fmt(trade.qty, 6)}</td>
    <td class="${trade.pnl > 0 ? 'positive-text' : trade.pnl < 0 ? 'negative-text' : ''}">${trade.pnl == null ? '—' : (trade.pnl >= 0 ? '+' : '') + money(trade.pnl)}</td>
    <td>SIMULASI</td>
  </tr>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function paperTrade() {
  const side = scoreAction();
  const sizing = calcPosition();
  if (!state.price || !state.connected || (side === 'BUY' && !sizing.qty)) return;
  const now = Date.now();
  if (side === 'BUY' && !state.portfolio.position) {
    const quantity = sizing.qty;
    state.portfolio.cash -= quantity * state.price;
    state.portfolio.position = { asset: state.asset, qty: quantity, entry: state.price, sl: sizing.sl, tp: sizing.tp, openedAt: now };
    state.portfolio.trades.push({ time: now, asset: state.asset, side: 'BUY', price: state.price, qty: quantity, pnl: null });
  } else if (side === 'SELL' && state.portfolio.position) {
    const position = state.portfolio.position;
    state.portfolio.cash += position.qty * state.price;
    const pnl = (state.price - position.entry) * position.qty;
    state.portfolio.trades.push({ time: now, asset: position.asset, side: 'SELL', price: state.price, qty: position.qty, pnl });
    state.portfolio.position = null;
  }
  savePortfolio();
  updateUI();
}

function setSentiment(value) {
  state.faScore = Number(value);
  $('#faValue').textContent = (state.faScore >= 0 ? '+' : '') + fmt(state.faScore, 2);
  state.score = clamp(state.taWeight * state.taScore + (1 - state.taWeight) * state.faScore, -1, 1);
  updateUI();
}

function liveAuthorizationHeaders() {
  return { 'content-type': 'application/json', authorization: `Bearer ${$('#liveToken').value.trim()}` };
}

async function previewLiveOrder() {
  $('#livePreviewButton').disabled = true;
  $('#liveResult').textContent = 'Meminta preview aman…';
  $('#livePreview').hidden = true;
  try {
    const payload = {
      instId: state.asset,
      side: $('#liveOrderSide').value,
      sz: $('#liveOrderSize').value,
      px: $('#liveOrderPrice').value,
    };
    const result = await getJson('/api/live/quote', {
      method: 'POST', headers: liveAuthorizationHeaders(), body: JSON.stringify(payload),
    });
    state.live.quote = { ...payload, challenge: result.challenge, preview: result.preview };
    const preview = result.preview;
    $('#livePreviewSummary').textContent = `${preview.side} ${preview.size} ${preview.instId} · limit ${preview.limitPrice} USDT · notional ${preview.notionalUsdt} USDT · harga pasar ${preview.marketPrice} USDT · mode ${preview.mode.toUpperCase()} · min-size ${preview.minSize} · lot-step ${preview.sizeStep} · price-tick ${preview.priceTick}`;
    $('#livePreviewExpiry').textContent = 'Preview berlaku sampai ' + new Date(preview.expiresAt).toLocaleTimeString('id-ID');
    $('#liveConfirmInput').value = '';
    $('#liveSubmitButton').disabled = true;
    $('#livePreview').hidden = false;
    $('#liveResult').textContent = 'Belum ada order yang dikirim. Periksa rincian di atas.';
  } catch (error) {
    state.live.quote = null;
    $('#liveResult').textContent = 'Preview gagal: ' + error.message;
  } finally {
    $('#livePreviewButton').disabled = false;
  }
}

async function submitLiveOrder() {
  const quote = state.live.quote;
  if (!quote || $('#liveConfirmInput').value.trim() !== LIVE_CONFIRMATION) return;
  const button = $('#liveSubmitButton');
  button.disabled = true;
  button.textContent = 'Mengirim order…';
  $('#liveResult').textContent = 'Permintaan dikirim ke backend privat; jangan refresh dulu.';
  try {
    const result = await getJson('/api/live/order', {
      method: 'POST',
      headers: liveAuthorizationHeaders(),
      body: JSON.stringify({ ...quote, confirmText: LIVE_CONFIRMATION }),
    });
    state.live.quote = null;
    $('#livePreview').hidden = true;
    $('#liveToken').value = '';
    $('#liveConfirmInput').value = '';
    $('#liveResult').textContent = `OKX menerima order limit ${result.order.side} ${result.order.size} ${result.order.instrument} @ ${result.order.limitPrice} USDT. ID: ${result.order.orderId || 'tersedia di riwayat OKX'}. Status diterima tidak berarti order sudah terisi.`;
  } catch (error) {
    $('#liveResult').textContent = 'Order tidak terkonfirmasi berhasil: ' + error.message + '. Periksa riwayat OKX sebelum mencoba lagi.';
  } finally {
    button.textContent = 'Konfirmasi & kirim order nyata';
    button.disabled = !state.live.quote || $('#liveConfirmInput').value.trim() !== LIVE_CONFIRMATION;
  }
}

$('#faInput').addEventListener('input', event => setSentiment(event.target.value));
$('#riskInput').addEventListener('input', event => {
  state.riskPct = Number(event.target.value);
  $('#riskValueLabel').textContent = fmt(state.riskPct, 2) + '%';
  if (state.price) updateUI();
});
$('#weightInput').addEventListener('input', event => {
  state.taWeight = Number(event.target.value) / 100;
  $('#taWeightLabel').textContent = event.target.value + '%';
  state.score = clamp(state.taWeight * state.taScore + (1 - state.taWeight) * state.faScore, -1, 1);
  updateUI();
});
$('#assetSelect').addEventListener('change', event => {
  if (state.portfolio.position) {
    event.target.value = state.asset;
    $('#paperFootnote').textContent = 'Tutup posisi paper sebelum mengganti aset.';
    return;
  }
  state.asset = event.target.value;
  state.live.quote = null;
  $('#livePreview').hidden = true;
  loadMarket();
});
document.querySelectorAll('.timeframe').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.timeframe').forEach(item => item.classList.remove('selected'));
  button.classList.add('selected');
  state.bar = button.dataset.bar;
  loadMarket();
}));
$('#refreshBtn').addEventListener('click', loadMarket);
$('#paperTradeBtn').addEventListener('click', paperTrade);
$('#clearHistoryBtn').addEventListener('click', () => {
  state.portfolio.trades = [];
  savePortfolio();
});
$('#livePreviewButton').addEventListener('click', previewLiveOrder);
$('#liveSubmitButton').addEventListener('click', submitLiveOrder);
$('#liveConfirmInput').addEventListener('input', event => {
  $('#liveSubmitButton').disabled = !state.live.quote || event.target.value.trim() !== LIVE_CONFIRMATION;
});
$('#liveCancelButton').addEventListener('click', () => {
  state.live.quote = null;
  $('#livePreview').hidden = true;
  $('#liveConfirmInput').value = '';
  $('#liveResult').textContent = 'Preview dibatalkan. Tidak ada order yang dikirim.';
});
$('#installBtn').addEventListener('click', async () => {
  if (!state.installPrompt) {
    $('#installHelp').showModal();
    return;
  }
  state.installPrompt.prompt();
  const choice = await state.installPrompt.userChoice;
  state.installPrompt = null;
  $('#installBtn').hidden = choice.outcome === 'accepted';
});
$('#closeInstallHelp').addEventListener('click', () => $('#installHelp').close());
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });
window.addEventListener('resize', drawChart);
window.addEventListener('online', loadMarket);
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  state.installPrompt = event;
  $('#installBtn').hidden = false;
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(error => console.warn('PWA offline cache unavailable', error)));
}
if (state.portfolio.position?.asset) {
  state.asset = state.portfolio.position.asset;
  $('#assetSelect').value = state.asset;
}
if (window.matchMedia('(display-mode: standalone)').matches) $('#installBtn').hidden = true;
setToday();
renderTrades();
renderPortfolio();
renderLiveStatus();
loadLiveStatus();
loadMarket();
setInterval(() => { if (!document.hidden) loadMarket(); }, 60_000);
