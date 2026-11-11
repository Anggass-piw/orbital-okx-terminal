const API = '/api/market';
const $ = selector => document.querySelector(selector);
const SWAP_ID = /^[A-Z0-9]{2,20}-USDT-SWAP$/;
const LIVE_CONFIRMATION = 'KIRIM ORDER LIVE';

const state = {
  asset: 'BTC-USDT-SWAP',
  loadedAsset: null,
  loadedBar: null,
  instrument: null,
  instruments: [],
  bar: '1H',
  candles: [],
  analysisCandles: [],
  fundamentals: null,
  price: null,
  open24h: null,
  volume: null,
  high24h: null,
  low24h: null,
  microRequest: 0,
  rsi: null,
  atr: null,
  taScore: 0,
  faScore: 0,
  score: 0,
  taWeight: 0.7,
  fundingWeight: 0,
  oiWeight: 0,
  fundingScore: null,
  oiScore: null,
  oiHistory: [],
  taConfirmEnabled: false,
  taTrendConfirmed: null,
  volumeConfirmed: null,
  trendFilterEnabled: false,
  trendConfirmed: null,
  trendCandles4h: [],
  trendStatus: 'nonaktif',
  chartOverlays: { ema: false, bollinger: false, volume: false },
  watchlist: loadPreferenceList('orbital-watchlist-v1'),
  priceAlerts: loadPreferenceList('orbital-alerts-v1'),
  theme: localStorage.getItem('orbital-theme-v1') === 'light' ? 'light' : 'dark',
  riskPct: 1,
  leverage: 1,
  loading: false,
  pendingMarketReload: false,
  connected: false,
  live: { accountAvailable: false, accountMode: 'disabled', available: false, autoAvailable: false, mode: 'disabled', maxNotionalUsdt: 25, quote: null, account: null, autoState: null },
  portfolio: loadPortfolio(),
  installPrompt: null,
  serviceWorkerRegistration: null,
};

let tvChart = null;
let tvCandleSeries = null;
let tvEmaSeries = null;
let tvBbUpperSeries = null;
let tvBbLowerSeries = null;
let tvVolumeSeries = null;
let tvMarkers = null;
let tvResizeObserver = null;
let tvPriceLines = [];
let tvChartIdentity = '';
let instrumentSearchController = null;
let autoInstrumentSearchController = null;

function initTradingViewChart() {
  const library = window.LightweightCharts;
  const container = $('#priceChart');
  if (!container || !library?.createChart || !library?.CandlestickSeries) {
    $('#chartEmpty').hidden = false;
    $('#chartEmpty').textContent = 'Komponen chart TradingView tidak tersedia di aset lokal.';
    return;
  }
  const bounds = container.getBoundingClientRect();
  tvChart = library.createChart(container, {
    width: Math.max(1, bounds.width), height: Math.max(1, bounds.height),
    layout: { background: { type: library.ColorType.Solid, color: state.theme === 'light' ? '#ffffff' : '#0d1011' }, textColor: state.theme === 'light' ? '#4d5d53' : '#89928e', attributionLogo: true },
    grid: { vertLines: { color: '#202526' }, horzLines: { color: '#202526' } },
    rightPriceScale: { borderColor: '#2b3131', scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: '#2b3131', timeVisible: true, secondsVisible: false, rightOffset: 6 },
    crosshair: { vertLine: { color: '#63716b', width: 1, style: 2, labelBackgroundColor: '#334238' }, horzLine: { color: '#63716b', width: 1, style: 2, labelBackgroundColor: '#334238' } },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    localization: { locale: 'id-ID' },
  });
  tvCandleSeries = tvChart.addSeries(library.CandlestickSeries, {
    upColor: state.theme === 'light' ? '#2d6b22' : '#a8e66b', downColor: state.theme === 'light' ? '#a82936' : '#f07171', borderVisible: false,
    wickUpColor: state.theme === 'light' ? '#2d6b22' : '#a8e66b', wickDownColor: state.theme === 'light' ? '#a82936' : '#f07171',
    priceLineVisible: true, lastValueVisible: true,
  });
  tvEmaSeries = tvChart.addSeries(library.LineSeries, { color: '#4a9de8', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  tvBbUpperSeries = tvChart.addSeries(library.LineSeries, { color: '#b188f0', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  tvBbLowerSeries = tvChart.addSeries(library.LineSeries, { color: '#b188f0', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  if (library.HistogramSeries) {
    tvVolumeSeries = tvChart.addSeries(library.HistogramSeries, { priceScaleId: 'volume', priceLineVisible: false, lastValueVisible: false, base: 0 });
    tvChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
  }
  if (library.createSeriesMarkers) tvMarkers = library.createSeriesMarkers(tvCandleSeries, []);
  const tooltip = $('#chartTooltip');
  tvChart.subscribeCrosshairMove(parameter => {
    const bar = parameter?.seriesData?.get(tvCandleSeries);
    if (!bar || parameter.time === undefined || parameter.time === null) {
      tooltip.hidden = true;
      return;
    }
    const digits = bar.close > 100 ? 2 : 6;
    $('#chartOhlc').textContent = `O ${fmt(bar.open, digits)} H ${fmt(bar.high, digits)} L ${fmt(bar.low, digits)} C ${fmt(bar.close, digits)}`;
    tooltip.textContent = `${formatMarketTimestamp(Number(parameter.time) * 1000)} · O ${fmt(bar.open, digits)} H ${fmt(bar.high, digits)} L ${fmt(bar.low, digits)} C ${fmt(bar.close, digits)}`;
    tooltip.hidden = false;
  });
  if (typeof ResizeObserver === 'function') {
    tvResizeObserver = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) tvChart.applyOptions({ width: rect.width, height: rect.height });
    });
    tvResizeObserver.observe(container);
  }
}

function loadPortfolio() {
  try {
    const value = JSON.parse(localStorage.getItem('orbital-paper-v2') || '{}');
    const cash = Number(value.cash);
    const raw = value.position;
    const position = raw && SWAP_ID.test(raw.instId) && ['long', 'short'].includes(raw.side)
      && Number.isFinite(Number(raw.qty)) && Number(raw.qty) > 0
      && Number.isFinite(Number(raw.entry)) && Number(raw.entry) > 0
      && Number.isFinite(Number(raw.ctVal)) && Number(raw.ctVal) > 0
      ? {
          instId: raw.instId, side: raw.side, qty: Number(raw.qty), entry: Number(raw.entry),
          ctVal: Number(raw.ctVal), margin: Math.max(0, Number(raw.margin) || 0),
          lotSz: Number.isFinite(Number(raw.lotSz)) && Number(raw.lotSz) > 0 ? String(raw.lotSz) : null,
          sl: Number(raw.sl) || 0, tp: Number(raw.tp) || 0,
          openedAt: Number(raw.openedAt) || Date.now(),
          entryFee: Number.isFinite(Number(raw.entryFee)) && Number(raw.entryFee) >= 0 ? Number(raw.entryFee) : 0,
          fundingAccrued: Number.isFinite(Number(raw.fundingAccrued)) ? Number(raw.fundingAccrued) : 0,
          fundingRateAtEntry: Number.isFinite(Number(raw.fundingRateAtEntry)) ? Number(raw.fundingRateAtEntry) : 0,
          nextFundingTime: Number.isFinite(Number(raw.nextFundingTime)) && Number(raw.nextFundingTime) > 0 ? Number(raw.nextFundingTime) : null,
          autoExit: raw.autoExit === true,
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
  state.portfolio.trades = Array.isArray(state.portfolio.trades) ? state.portfolio.trades.slice(-500) : [];
  try {
    localStorage.setItem('orbital-paper-v2', JSON.stringify(state.portfolio));
  } catch {
    $('#paperFootnote').textContent = 'Penyimpanan lokal penuh atau diblokir; perubahan mungkin tidak tersimpan.';
  }
  renderPortfolio();
}

function loadPreferenceList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(item => typeof item === 'string' ? SWAP_ID.test(item)
      : item && typeof item === 'object' && SWAP_ID.test(item.instId)
        && ['above', 'below'].includes(item.direction) && Number.isFinite(Number(item.price)) && Number(item.price) > 0)
      .slice(-50);
  } catch { return []; }
}
function savePreferenceList(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value.slice(-50))); }
  catch { $('#marketErrorText').textContent = 'Preferensi lokal tidak tersimpan; penyimpanan browser penuh atau diblokir.'; $('#marketError').hidden = false; }
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
  const label = $('#todayLabel');
  if (label) label.textContent = new Date().toLocaleDateString('id-ID', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  }).toUpperCase();
}

async function getJson(url, options) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000), ...options });
  } catch {
    const error = new Error('Backend aplikasi tidak terjangkau. Periksa koneksi atau URL deployment.');
    error.code = 'NETWORK';
    throw error;
  }
  if (response.status === 429) {
    const error = new Error('RATE_LIMIT');
    error.code = 'RATE_LIMIT';
    throw error;
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Respons server tidak valid (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(result?.error || result?.msg || `HTTP ${response.status}`);
  if (typeof result?.code === 'string' && result.code !== '0') {
    const error = new Error(result.code === '50011' ? 'RATE_LIMIT' : result.msg || 'OKX API error');
    if (result.code === '50011') error.code = 'RATE_LIMIT';
    throw error;
  }
  return result;
}

function validInstrument(item) {
  return item && item.instType === 'SWAP' && item.state === 'live' && item.ctType === 'linear'
    && SWAP_ID.test(item.instId) && item.settleCcy === 'USDT'
    && Number(item.ctVal) > 0 && Number(item.minSz) > 0
    && Number(item.lotSz) > 0 && Number(item.tickSz) > 0
    && typeof item.baseCcy === 'string' && /^[A-Z0-9]{2,20}$/.test(item.baseCcy);
}
function normalizeInstrumentQuery(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}
function filterInstruments(query) {
  const terms = normalizeInstrumentQuery(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return state.instruments.slice();
  return state.instruments.filter(item => {
    const base = item.baseCcy;
    const words = [base, item.instId, `${base} USDT SWAP`, 'USDT', 'SWAP', 'PERPETUAL']
      .map(normalizeInstrumentQuery);
    const compact = [base, item.instId, `${base}USDT`, `${base}USDTSWAP`]
      .map(value => String(value).toUpperCase().replace(/[^A-Z0-9]/g, ''));
    return terms.every(term => words.some(field => field.includes(term))
      || compact.some(field => field.includes(term.replace(/\s/g, ''))));
  });
}
function renderInstrumentOptions() {
  const select = $('#assetSelect');
  if (!select) return;
  const unavailable = state.asset && !state.instruments.some(item => item.instId === state.asset)
    ? `<option value="${escapeHtml(state.asset)}" disabled>${escapeHtml(state.asset)} · TIDAK AKTIF / TIDAK TERSEDIA</option>` : '';
  select.innerHTML = unavailable + state.instruments.map(item => `<option value="${escapeHtml(item.instId)}">${escapeHtml(item.baseCcy)} / USDT · ${escapeHtml(item.instId)}</option>`).join('');
  select.value = state.asset;
  renderAutoInstrumentOptions();
  $('#instrumentCount').textContent = `${state.instruments.length} PAIR AKTIF`;
  instrumentSearchController?.render();
  autoInstrumentSearchController?.render();
}
function renderAutoInstrumentOptions() {
  const select = $('#autoInstrument');
  if (!select || !state.instruments.length) return;
  const previous = select.value || state.asset;
  select.innerHTML = state.instruments.map(item => `<option value="${item.instId}">${item.baseCcy} / USDT · ${item.instId}</option>`).join('');
  select.value = state.instruments.some(item => item.instId === previous) ? previous : state.asset;
}
function createInstrumentSearch({ inputId, resultsId, statusId, selectedId, onSelect }) {
  const input = $('#' + inputId);
  const results = $('#' + resultsId);
  const status = $('#' + statusId);
  if (!input || !results || !status) return null;
  let matches = [];
  let activeIndex = -1;
  const close = () => {
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    const query = input.value.trim();
    if (!query) {
      matches = [];
      activeIndex = -1;
      close();
      status.textContent = '';
      return;
    }
    matches = filterInstruments(query);
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (!state.instruments.length) {
      results.innerHTML = '<div class="instrument-search-empty">Katalog instrumen belum tersedia. Coba perbarui data.</div>';
      status.textContent = 'Katalog instrumen belum tersedia.';
      input.removeAttribute('aria-activedescendant');
      activeIndex = -1;
      return;
    }
    if (!matches.length) {
      results.innerHTML = '<div class="instrument-search-empty">Tidak ada pair cocok. Coba kode koin seperti BTC atau sebagian ID pair.</div>';
      status.textContent = 'Tidak ada instrumen yang cocok.';
      input.removeAttribute('aria-activedescendant');
      activeIndex = -1;
      return;
    }
    activeIndex = clamp(activeIndex, 0, matches.length - 1);
    if (activeIndex < 0) activeIndex = 0;
    const current = selectedId();
    results.innerHTML = matches.map((item, index) => `<button class="instrument-result${item.instId === current ? ' is-current' : ''}" id="${resultsId}-option-${index}" type="button" role="option" aria-selected="${index === activeIndex}" data-inst-id="${item.instId}"><span>${item.baseCcy} / USDT</span><small>${item.instId}${item.instId === current ? ' · AKTIF' : ''}</small></button>`).join('');
    input.setAttribute('aria-activedescendant', `${resultsId}-option-${activeIndex}`);
    status.textContent = `${matches.length} pair cocok. Gunakan panah atas/bawah dan Enter, atau pilih hasil.`;
  };
  const choose = instId => {
    const item = matches.find(candidate => candidate.instId === instId);
    if (!item || !onSelect(item)) return;
    input.value = '';
    activeIndex = -1;
    render();
  };
  input.addEventListener('input', () => { activeIndex = 0; render(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !results.hidden) {
      event.preventDefault();
      close();
      status.textContent = 'Hasil pencarian ditutup.';
      return;
    }
    if (results.hidden || !matches.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + direction + matches.length) % matches.length;
      render();
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      choose(matches[activeIndex].instId);
    }
  });
  results.addEventListener('click', event => {
    const option = event.target.closest('[data-inst-id]');
    if (option) choose(option.dataset.instId);
  });
  document.addEventListener('click', event => {
    if (!input.parentElement.contains(event.target) && !results.hidden) close();
  });
  return { render };
}
function renderAssetMark() {
  const holder = $('#assetGlyph');
  if (!holder || !state.instrument || !document.createElement) return;
  const base = state.instrument.baseCcy;
  holder.replaceChildren();
  const fallback = document.createElement('span');
  fallback.className = 'coin-fallback';
  fallback.textContent = base.slice(0, 3);
  holder.append(fallback);
  const icon = document.createElement('img');
  icon.alt = '';
  icon.loading = 'lazy';
  icon.referrerPolicy = 'no-referrer';
  icon.src = `https://assets.coincap.io/assets/icons/${encodeURIComponent(base.toLowerCase())}@2x.png`;
  icon.addEventListener('load', () => { fallback.hidden = true; });
  icon.addEventListener('error', () => { icon.remove(); fallback.hidden = false; });
  holder.append(icon);
}
function selectMarketInstrument(instId) {
  if (state.portfolio.position && instId !== state.asset) {
    $('#paperFootnote').textContent = 'Tutup posisi paper sebelum mengganti aset.';
    $('#assetSelect').value = state.asset;
    return false;
  }
  const selected = state.instruments.find(item => item.instId === instId);
  if (!selected) return false;
  state.asset = selected.instId;
  state.instrument = selected;
  state.live.quote = null;
  $('#livePreview').hidden = true;
  renderAssetMark();
  $('#chartAsset').textContent = state.asset;
  $('#pairCaption').textContent = `${selected.baseCcy} PERPETUAL · USDT SETTLED`;
  $('#pairType').textContent = 'SWAP';
  $('#contractValue').textContent = `${fmt(Number(selected.ctVal), 8).replace(/0+$/, '').replace(/\.$/, '')} ${selected.ctValCcy} / kontrak`;
  const leverageInput = $('#leverageInput');
  leverageInput.max = String(Math.min(20, Math.max(1, Number(selected.maxLever) || 1)));
  if (Number(leverageInput.value) > Number(leverageInput.max)) leverageInput.value = leverageInput.max;
  state.leverage = Number(leverageInput.value);
  $('#leverageValueLabel').textContent = `${fmt(effectiveLeverage(), 0)}×`;
  renderInstrumentOptions();
  renderWatchlist();
  loadMarket();
  return true;
}
async function loadInstruments() {
  $('#instrumentCount').textContent = 'MEMUAT PAIR…';
  try {
    const result = await getJson(`${API}/instruments`);
    const items = Array.isArray(result?.data) ? result.data.filter(validInstrument) : [];
    if (!items.length) throw new Error('Katalog perpetual USDT kosong');
    items.sort((a, b) => a.baseCcy.localeCompare(b.baseCcy) || a.instId.localeCompare(b.instId));
    const hadCatalog = state.instruments.length > 0;
    const preferredId = state.portfolio.position?.instId || state.asset;
    let chosen = items.find(item => item.instId === preferredId);
    if (!chosen && (hadCatalog || state.portfolio.position)) {
      state.instruments = items;
      state.instrument = null;
      state.asset = preferredId;
      renderInstrumentOptions(); renderWatchlist();
      $('#pairCaption').textContent = 'INSTRUMEN TIDAK AKTIF / TIDAK TERSEDIA';
      $('#contractValue').textContent = 'Nilai kontrak tidak tersedia';
      $('#instrumentCount').textContent = `${items.length} PAIR AKTIF · PILIHAN SAAT INI TIDAK TERSEDIA`;
      clearMarketDisplay('Instrumen ini tidak ada dalam katalog aktif OKX. Pilih pair lain secara manual; posisi paper yang tersimpan tidak dihapus.');
      $('#marketStrip').classList.remove('is-initial-loading');
      $('#marketErrorText').textContent = `Pair ${preferredId} tidak ada dalam katalog aktif OKX. Pilih instrumen lain secara manual; saldo/posisi paper tersimpan tidak dihapus.`;
      $('#marketError').hidden = false;
      $('#chartEmpty').hidden = false;
      $('#chartEmpty').textContent = 'Instrumen tidak aktif. Pilih pair aktif secara manual; posisi paper lama tetap tersimpan.';
      setConnection(false, 'Instrumen tidak aktif');
      return false;
    }
    if (!chosen) chosen = items.find(item => item.instId === 'BTC-USDT-SWAP') || items[0];
    state.instruments = items;
    state.asset = chosen.instId;
    state.instrument = chosen;
    renderInstrumentOptions();
    renderAssetMark();
    $('#chartAsset').textContent = state.asset;
    $('#pairCaption').textContent = `${chosen.baseCcy} PERPETUAL · USDT SETTLED`;
    $('#pairType').textContent = 'SWAP';
    $('#contractValue').textContent = `${fmt(Number(chosen.ctVal), 8).replace(/0+$/, '').replace(/\.$/, '')} ${chosen.ctValCcy} / kontrak`;
    renderWatchlist();
    return true;
  } catch (error) {
    const hasPreviousCatalog = state.instruments.length > 0 && Boolean(state.instrument);
    if (hasPreviousCatalog) {
      $('#instrumentCount').textContent = `${state.instruments.length} PAIR · REFRESH GAGAL`;
    } else {
      state.instruments = [];
      state.instrument = null;
      $('#instrumentCount').textContent = 'KATALOG TIDAK TERSEDIA';
      $('#chartEmpty').hidden = false;
      $('#chartEmpty').textContent = 'Daftar perpetual OKX tidak tersedia. Coba muat ulang untuk mengambil instrumen aktif.';
    }
    setConnection(false, error.code === 'NETWORK' ? 'Backend tidak terjangkau' : 'Katalog tidak tersedia');
    return hasPreviousCatalog;
  }
}

function clearMicrostructure() {
  state.microRequest++;
  for (const id of ['bookAsks', 'bookBids', 'recentTrades']) {
    if ($('#' + id)) $('#' + id).innerHTML = '<div class="data-placeholder">Menunggu snapshot OKX</div>';
  }
  for (const id of ['bookMid', 'bookSpread']) if ($('#' + id)) $('#' + id).textContent = '—';
  if ($('#bookStatus')) $('#bookStatus').textContent = 'Menunggu data';
}

function renderOrderBook(book) {
  const asks = book?.asks?.slice(0, 8).map(row => [Number(row[0]), Number(row[1])]) || [];
  const bids = book?.bids?.slice(0, 8).map(row => [Number(row[0]), Number(row[1])]) || [];
  if (!asks.length || !bids.length || [...asks, ...bids].some(row => row.some(value => !Number.isFinite(value) || value <= 0))) throw new Error('Order book tidak valid');
  const ctVal = Number(state.instrument?.ctVal);
  if (!Number.isFinite(ctVal) || ctVal <= 0) throw new Error('Nilai kontrak tidak valid');
  const notional = ([price, size]) => price * size * ctVal;
  const withCumulativeDepth = levels => {
    let cumulative = 0;
    return levels.map(([price, size]) => {
      cumulative += notional([price, size]);
      return [price, size, cumulative];
    });
  };
  const asksDepth = withCumulativeDepth(asks);
  const bidsDepth = withCumulativeDepth(bids);
  const maxTotal = Math.max(...[...asksDepth, ...bidsDepth].map(([, , total]) => total));
  const rows = (levels, side) => levels.map(([price, size, total]) => `<div class="book-row ${side}" style="--depth:${clamp(total / maxTotal * 100, 0, 100).toFixed(2)}%"><span>${fmt(price, price >= 100 ? 2 : 3)}</span><span>${fmt(size, 5)}</span><span>${fmt(total, 2)}</span></div>`).join('');
  $('#bookAsks').innerHTML = rows(asksDepth.slice().reverse(), 'ask');
  $('#bookBids').innerHTML = rows(bidsDepth, 'bid');
  const mid = (asks[0][0] + bids[0][0]) / 2;
  const spread = Math.max(0, asks[0][0] - bids[0][0]);
  $('#bookMid').textContent = fmt(mid, mid >= 100 ? 2 : 3);
  $('#bookSpread').textContent = `${fmt(spread, 3)} · ${fmt(spread / mid * 100, 3)}%`;
  $('#bookStatus').textContent = 'Snapshot ' + new Date(Number(book.ts)).toLocaleTimeString('id-ID');
}

function renderMarketTrades(trades) {
  if (!Array.isArray(trades) || !trades.length) throw new Error('Transaksi pasar kosong');
  $('#recentTrades').innerHTML = trades.slice(0, 10).map(trade => {
    const price = Number(trade.px), size = Number(trade.sz), ts = Number(trade.ts);
    if (![price, size, ts].every(value => Number.isFinite(value) && value > 0)) throw new Error('Transaksi pasar tidak valid');
    return `<div class="tape-row ${trade.side === 'buy' ? 'buy' : 'sell'}"><span>${fmt(price, price >= 100 ? 2 : 3)}</span><span>${fmt(size, 5)}</span><span>${new Date(ts).toLocaleTimeString('id-ID')}</span></div>`;
  }).join('');
}

async function loadMicrostructure() {
  if (!$('#bookAsks') || !$('#recentTrades')) return;
  const asset = state.asset;
  const request = ++state.microRequest;
  const instrument = encodeURIComponent(asset);
  const results = await Promise.allSettled([
    getJson(`${API}/books?instId=${instrument}`),
    getJson(`${API}/trades?instId=${instrument}`),
  ]);
  if (state.asset !== asset || request !== state.microRequest) return;
  try {
    if (results[0].status !== 'fulfilled') throw new Error('Snapshot unavailable');
    renderOrderBook(results[0].value?.data?.[0]);
  } catch {
    $('#bookStatus').textContent = 'Snapshot tidak tersedia';
    for (const id of ['bookAsks', 'bookBids']) $('#' + id).innerHTML = '<div class="data-placeholder">Data order book tidak tersedia</div>';
    $('#bookMid').textContent = '—';
    $('#bookSpread').textContent = '—';
  }
  try {
    if (results[1].status !== 'fulfilled') throw new Error('Trades unavailable');
    renderMarketTrades(results[1].value?.data);
  } catch {
    $('#recentTrades').innerHTML = '<div class="data-placeholder">Transaksi pasar tidak tersedia</div>';
  }
}

async function loadLiveStatus() {
  try {
    const status = await getJson('/api/status');
    state.live.accountAvailable = status.accountReadAvailable === true;
    state.live.accountMode = status.accountMode || 'disabled';
    state.live.available = status.tradingAvailable === true;
    state.live.mode = status.tradingMode || 'disabled';
    state.live.autoAvailable = status.autoTradingAvailable === true;
    state.live.maxNotionalUsdt = Number(status.maxNotionalUsdt) || 25;
  } catch {
    state.live.accountAvailable = false;
    state.live.accountMode = 'disabled';
    state.live.available = false;
    state.live.autoAvailable = false;
    state.live.mode = 'disabled';
  }
  renderLiveStatus();
}

function renderLiveStatus() {
  const available = state.live.available;
  const accountAvailable = state.live.accountAvailable;
  $('#live').hidden = !accountAvailable;
  $('#liveUnavailable').hidden = accountAvailable;
  $('#liveForm').hidden = !accountAvailable;
  const badge = $('#liveModeBadge');
  badge.textContent = available ? `EKSEKUSI ${state.live.mode.toUpperCase()}`
    : accountAvailable ? `AKUN ${state.live.accountMode.toUpperCase()} · READ` : 'NONAKTIF';
  badge.className = available ? `live-mode-badge ${state.live.mode}`
    : accountAvailable ? `live-mode-badge ${state.live.accountMode}` : 'live-mode-badge disabled';
  $('#terminalModeText').textContent = accountAvailable
    ? `AKUN ${state.live.accountMode.toUpperCase()} · READ ONLY` : 'DATA PUBLIK · PAPER';
  $('#safetyTitle').textContent = accountAvailable
    ? `AKUN ${state.live.accountMode.toUpperCase()} · READ-ONLY · EKSEKUSI TERKUNCI`
    : 'SIMULASI SAJA · TIDAK ADA ORDER NYATA';
  $('#safetyDescription').textContent = accountAvailable
    ? 'Koneksi privat hanya untuk membaca status akun. Order manual dan auto-trading dinonaktifkan oleh konfigurasi server; tidak ada strategi atau risiko yang diaktifkan. Paper portfolio tetap terpisah.'
    : 'Data pasar berasal dari OKX Swap USDT perpetual. Paper portfolio dan analisis tidak terhubung ke akun; jangan masukkan API key di preview publik.';
  if (!accountAvailable) {
    $('#liveUnavailable').textContent = 'Koneksi akun privat belum dikonfigurasi. Preview ini hanya memakai data pasar publik dan tidak tersambung ke akun OKX; paper trading saja.';
  }
  $('#executionLockNote').hidden = available;
  if (!available) {
    $('#executionLockNote').textContent = accountAvailable
      ? 'Mode read-only: backend akun dapat diuji dan dibaca, tetapi quote/order manual serta aktivasi bot tetap terkunci.'
      : 'Eksekusi akun tidak tersedia.';
  } else {
    $('#liveLimitNote').textContent = `Order perpetual USDT limit saja · ukuran dalam kontrak · notional memakai nilai kontrak · batas backend ${money(state.live.maxNotionalUsdt)} · preview berlaku 90 detik.`;
    $('#liveOrderPrice').value = state.price ? fmt(state.price, state.price > 100 ? 2 : 6).replace(/,/g, '') : '';
  }
  $('#manualLiveDetails').hidden = !available;
  $('#autoTraderBox').hidden = !accountAvailable;
  if (!state.live.autoAvailable) {
    $('#autoStatus').textContent = accountAvailable
      ? 'Auto-trading terkunci oleh konfigurasi server. Bot tidak berjalan dan tidak dapat dimulai; frasa konfirmasi tetap diperlukan jika aktivasi kelak disetujui.'
      : 'Auto-trade hanya tersedia jika worker privat mengaktifkannya.';
  }
  renderAutoInstrumentOptions();
  renderAutoState();
}

function expectedAutoConfirmation() {
  return state.live.mode === 'live' ? 'MULAI AUTO TRADE LIVE' : 'MULAI AUTO TRADE DEMO';
}

function updateAutoStartEnabled() {
  const input = $('#autoConfirmInput');
  const token = $('#liveToken');
  const button = $('#autoStartBtn');
  if (!input || !token || !button) return;
  const running = state.live.autoState?.running === true;
  const riskPct = Number($('#autoRiskPct').value);
  const validRisk = Number.isFinite(riskPct) && riskPct >= 0.25 && riskPct <= 1
    && Math.abs((riskPct - 0.25) / 0.25 - Math.round((riskPct - 0.25) / 0.25)) < 1e-8;
  button.disabled = !state.live.autoAvailable || running || !state.live.account
    || !token.value.trim() || input.value.trim() !== expectedAutoConfirmation()
    || !$('#autoInstrument').value || !validRisk;
}

function renderAutoState() {
  const badge = $('#autoStateBadge');
  if (!badge) return;
  const auto = state.live.autoState;
  const running = auto?.running === true;
  badge.textContent = running ? `RUNNING · ${String(auto.mode || state.live.mode).toUpperCase()}` : 'STOPPED';
  badge.className = running ? `live-mode-badge ${auto.mode || state.live.mode}` : 'live-mode-badge disabled';
  const details = auto?.lastMessage || (state.live.autoAvailable
    ? 'Bot belum dimulai. Hubungkan akun dan ketik frasa konfirmasi sebelum mulai.'
    : 'Auto-trade hanya tersedia jika worker privat mengaktifkannya.');
  $('#autoStatus').textContent = running
    ? `${auto.instId} · risiko ${fmt(auto.riskPct, 2)}% · batas notional ${fmt(auto.maxNotionalUsdt, 2)} USDT · ${details}`
    : details;
  $('#autoStopBtn').hidden = !running;
  $('#autoStartBtn').hidden = running;
  $('#autoInstrument').disabled = running;
  $('#autoRiskPct').disabled = running;
  $('#autoConfirmInput').disabled = running;
  updateAutoStartEnabled();
}

async function connectOkxAccount() {
  const button = $('#accountConnectBtn');
  button.disabled = true;
  $('#accountStatus').textContent = 'Memverifikasi private API OKX dari backend…';
  try {
    const result = await getJson('/api/private/account', { headers: liveAuthorizationHeaders() });
    const account = result.account;
    state.live.account = account;
    $('#accountAvailable').textContent = `${fmt(account.availableUsdt, 4)} USDT`;
    $('#accountEquity').textContent = `${fmt(account.totalEquityUsdt, 4)} USDT`;
    $('#accountPositions').textContent = `${account.openPositions.length} terbuka`;
    $('#accountSummary').hidden = false;
    $('#accountStatus').textContent = `Private API OKX tersambung · ${String(account.mode).toUpperCase()} · mode posisi ${account.positionMode}. API key/secret tidak dikirim ke browser.`;
    renderAutoState();
    if (state.live.autoAvailable) await refreshAutoStatus();
    return true;
  } catch (error) {
    state.live.account = null;
    $('#accountSummary').hidden = true;
    $('#accountStatus').textContent = `Koneksi akun gagal: ${error.message}`;
    updateAutoStartEnabled();
    return false;
  } finally {
    button.disabled = false;
  }
}

async function refreshAutoStatus() {
  $('#autoRefreshBtn').disabled = true;
  try {
    state.live.autoState = await getJson('/api/auto/status', { headers: liveAuthorizationHeaders() });
    renderAutoState();
  } catch (error) {
    $('#autoStatus').textContent = `Status bot belum dapat dibaca: ${error.message}`;
  } finally {
    $('#autoRefreshBtn').disabled = false;
  }
}

async function startAutoTrading() {
  if (!state.live.account || $('#autoConfirmInput').value.trim() !== expectedAutoConfirmation()) return;
  const button = $('#autoStartBtn');
  button.disabled = true;
  $('#autoStatus').textContent = 'Memverifikasi akun, batas risiko, instrumen, dan koneksi sebelum mengaktifkan bot…';
  try {
    state.live.autoState = await getJson('/api/auto/start', {
      method: 'POST', headers: liveAuthorizationHeaders(),
      body: JSON.stringify({
        instId: $('#autoInstrument').value,
        riskPct: Number($('#autoRiskPct').value),
        confirmText: expectedAutoConfirmation(),
      }),
    });
    $('#autoConfirmInput').value = '';
    renderAutoState();
  } catch (error) {
    $('#autoStatus').textContent = `Bot tidak dimulai: ${error.message}`;
  } finally {
    updateAutoStartEnabled();
  }
}

async function stopAutoTrading() {
  const button = $('#autoStopBtn');
  button.disabled = true;
  $('#autoStatus').textContent = 'Mengirim perintah stop ke server privat…';
  try {
    state.live.autoState = await getJson('/api/auto/stop', { method: 'POST', headers: liveAuthorizationHeaders(), body: '{}' });
    renderAutoState();
  } catch (error) {
    $('#autoStatus').textContent = `Perintah stop belum terkonfirmasi: ${error.message}. Coba lagi dan periksa status bot.`;
  } finally {
    button.disabled = false;
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

function ema(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1 || values.length < period
      || values.some(value => !Number.isFinite(Number(value)))) return [];
  const result = Array(values.length).fill(null);
  let current = values.slice(0, period).reduce((sum, value) => sum + Number(value), 0) / period;
  result[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    current = (Number(values[i]) - current) * multiplier + current;
    result[i] = current;
  }
  return result;
}
function sma(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1 || values.length < period
      || values.some(value => !Number.isFinite(Number(value)))) return [];
  return values.map((_, index) => index + 1 < period ? null
    : values.slice(index + 1 - period, index + 1).reduce((sum, value) => sum + Number(value), 0) / period);
}
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (fast < 1 || slow <= fast || signalPeriod < 1) return [];
  const fastEma = ema(values, fast), slowEma = ema(values, slow);
  const line = values.map((_, index) => Number.isFinite(fastEma[index]) && Number.isFinite(slowEma[index]) ? fastEma[index] - slowEma[index] : null);
  const validStart = line.findIndex(Number.isFinite);
  if (validStart < 0 || line.length - validStart < signalPeriod) return [];
  const signal = ema(line.slice(validStart), signalPeriod);
  return line.map((value, index) => {
    const sig = index >= validStart ? signal[index - validStart] : null;
    return Number.isFinite(value) && Number.isFinite(sig) ? { line: value, signal: sig, histogram: value - sig } : null;
  });
}
function bollinger(values, period = 20, multiplier = 2) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 2 || values.length < period
      || !Number.isFinite(multiplier) || multiplier <= 0) return [];
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const window = values.slice(index + 1 - period, index + 1).map(Number);
    if (window.some(value => !Number.isFinite(value))) return null;
    const mean = window.reduce((sum, value) => sum + value, 0) / period;
    const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
    return { middle: mean, upper: mean + deviation * multiplier, lower: mean - deviation * multiplier };
  });
}

function scoreAction() {
  const raw = state.score > 0.65 ? 'BUY' : state.score < -0.65 ? 'SELL' : 'HOLD';
  if (raw === 'HOLD') return raw;
  if (state.taConfirmEnabled && (state.taTrendConfirmed !== raw || state.volumeConfirmed !== true)) return 'HOLD';
  if (state.trendFilterEnabled && state.trendConfirmed !== raw) return 'HOLD';
  return raw;
}
function recomputeCompositeScore() {
  const fundingWeight = clamp(Number(state.fundingWeight) || 0, 0, 0.2);
  const oiWeight = clamp(Number(state.oiWeight) || 0, 0, 0.2);
  const derivativeWeight = Math.min(1, fundingWeight + oiWeight);
  const coreWeight = 1 - derivativeWeight;
  const components = [
    { weight: coreWeight * clamp(state.taWeight, 0, 1), value: state.taScore },
    { weight: coreWeight * (1 - clamp(state.taWeight, 0, 1)), value: state.faScore },
    { weight: fundingWeight, value: state.fundingScore },
    { weight: oiWeight, value: state.oiScore },
  ].filter(item => item.weight > 0 && Number.isFinite(item.value));
  const totalWeight = components.reduce((sum, item) => sum + item.weight, 0);
  state.score = totalWeight > 0 ? clamp(components.reduce((sum, item) => sum + item.weight * item.value, 0) / totalWeight, -1, 1) : 0;
  return state.score;
}
function trendDirection(candles) {
  if (!Array.isArray(candles) || candles.length < 35) return null;
  const closes = candles.map(candle => Number(candle.close));
  const average = ema(closes, 20).at(-1);
  const momentum = macd(closes).at(-1);
  if (!Number.isFinite(average) || !momentum) return null;
  if (closes.at(-1) > average && momentum.histogram > 0) return 'BUY';
  if (closes.at(-1) < average && momentum.histogram < 0) return 'SELL';
  return 'HOLD';
}
function volumeExpansion(candles, period = 20, multiplier = 1.2) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const volumes = candles.slice(-(period + 1)).map(candle => Number(candle.vol ?? candle.volume));
  if (volumes.some(value => !Number.isFinite(value) || value < 0)) return null;
  const average = volumes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  if (average <= 0) return null;
  return volumes.at(-1) >= average * multiplier;
}

function getUnrealized(position = state.portfolio.position) {
  if (!position || !state.price || position.instId !== state.asset) return 0;
  const sign = position.side === 'long' ? 1 : -1;
  return (state.price - position.entry) * position.qty * position.ctVal * sign;
}
function getEquity() {
  const position = state.portfolio.position;
  return state.portfolio.cash + (position ? position.margin + getUnrealized(position) : 0);
}
function contractDecimals(step) {
  return Math.min(8, (String(step || '1').split('.')[1] || '').length);
}
function contractDigits(asset, lotSz) {
  const step = lotSz || state.instruments.find(item => item.instId === asset)?.lotSz || '0.01';
  return contractDecimals(step);
}
function formatContracts(quantity, asset, lotSz) {
  return `${fmt(quantity, contractDigits(asset, lotSz))} kontrak`;
}
function floorToStep(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  const factor = 10 ** contractDecimals(step);
  const stepUnits = Math.round(step * factor);
  if (!stepUnits) return 0;
  return Math.floor(Math.floor(value * factor + 1e-8) / stepUnits) * stepUnits / factor;
}
function effectiveLeverage() {
  const max = Math.max(1, Number(state.instrument?.maxLever) || 1);
  return Math.min(clamp(Number(state.leverage) || 1, 1, 20), max);
}
function calcPosition(direction = null) {
  const instrument = state.instrument;
  if (!state.price || !state.atr || !instrument || !Number(instrument.ctVal)) return { qty: 0, risk: 0, sl: 0, tp: 0, notional: 0, margin: 0, leverage: effectiveLeverage() };
  const side = direction || (scoreAction() === 'SELL' ? 'short' : 'long');
  const sign = side === 'short' ? -1 : 1;
  const stopDistance = state.atr * 1.5;
  const riskTarget = Math.max(0, getEquity()) * state.riskPct / 100;
  const ctVal = Number(instrument.ctVal);
  const leverage = effectiveLeverage();
  const byRisk = stopDistance > 0 ? riskTarget / (stopDistance * ctVal) : 0;
  const byCollateral = state.portfolio.cash / (state.price * ctVal * (1 / leverage + PAPER_TAKER_FEE));
  const rounded = floorToStep(Math.min(byRisk, byCollateral), Number(instrument.lotSz));
  const qty = rounded >= Number(instrument.minSz) ? rounded : 0;
  const notional = qty * ctVal * state.price;
  const margin = leverage > 0 ? notional / leverage : notional;
  return {
    qty, risk: qty * ctVal * stopDistance,
    sl: state.price - sign * stopDistance,
    tp: state.price + sign * state.atr * 2.5,
    notional, margin, leverage,
  };
}

function clearMarketDisplay(message = 'Menunggu data pasar') {
  Object.assign(state, { price:null, open24h:null, high24h:null, low24h:null, volume:null, rsi:null, atr:null, taScore:0, score:0, candles:[], analysisCandles:[], fundamentals:null, connected:false });
  $('#marketStrip').classList.add('is-initial-loading');
  clearMicrostructure();
  renderFundamentals();
  for (const id of ['marketHigh', 'marketLow']) if ($('#' + id)) $('#' + id).textContent = '—';
  for (const id of ['priceValue','changeValue','rsiValue','scoreValue','gaugeScore','taScore','atrValue','stopValue','positionSize','riskSL','riskTP','riskNotional','volumeValue','updatedAt']) {
    $('#' + id).textContent = '—';
  }
  $('#chartAsset').textContent = state.asset;
  $('#changeValue').className = 'change-pill neutral';
  $('#rsiBar').style.width = '0%';
  $('#rsiState').textContent = 'Menunggu data';
  $('#scoreState').textContent = 'Menunggu data';
  $('#signalText').textContent = 'WAIT';
  $('#signalText').className = 'signal-hold';
  $('#signalHint').textContent = message;
  $('#signalReason').textContent = 'Sinyal menunggu data pasar yang valid dan candle tertutup.';
  for (const id of ['fundingFactorScore','oiFactorScore']) $('#' + id).textContent = '—';
  $('#fundingFactorState').textContent = 'data belum tersedia';
  $('#oiFactorState').textContent = 'menunggu sampel';
  $('#riskAmount').textContent = 'Risiko gross sebelum biaya: —';
  $('#riskDirection').textContent = 'WAIT · belum ada arah sinyal';
  $('#longScenario').textContent = 'Menunggu data pasar';
  $('#shortScenario').textContent = 'Menunggu data pasar';
  $('#thresholdMarker').style.left = '50%';
  $('#signalGauge').style.background = '#26313b';
  $('#paperTradeBtn').disabled = true;
  $('#paperTradeBtn').textContent = 'Tunggu data pasar';
  $('#paperFootnote').textContent = 'SIMULASI LOKAL, BUKAN ORDER OKX/NYATA. Biaya asumsi taker + slippage dan estimasi funding; SL/TP paper baru dipantau saat data segar masuk. Tidak ada protective order di OKX.';
  drawChart();
}

function formatMarketTimestamp(timestamp) {
  const value = Number(timestamp);
  return Number.isFinite(value) && value > 0
    ? new Date(value).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', second:'2-digit' })
    : '—';
}

function renderFundamentals() {
  const data = state.fundamentals || {};
  const percentage = value => Number.isFinite(value)
    ? `${value > 0 ? '+' : ''}${fmt(value * 100, 6)}%` : '—';
  const schedule = data.nextFundingTime || data.fundingTime;
  $('#fundingRate').textContent = percentage(data.fundingRate);
  $('#fundingNext').textContent = data.fundingRate === null || data.fundingRate === undefined
    ? 'Rate prediksi tidak tersedia'
    : `${data.fundingRate > 0 ? 'Positif: long bayar short' : data.fundingRate < 0 ? 'Negatif: short bayar long' : 'Rate netral'} · jadwal ${formatMarketTimestamp(schedule)}`;
  $('#settledFundingRate').textContent = percentage(data.settledFundingRate);
  $('#fundingSettledState').textContent = data.settledFundingRate === null || data.settledFundingRate === undefined
    ? 'Rate settlement tidak tersedia' : `Status settlement: ${data.settlementState || 'unknown'}`;
  $('#openInterestValue').textContent = Number.isFinite(data.openInterestUsd)
    ? `${fmt(data.openInterestUsd, 2)} USD` : Number.isFinite(data.openInterestContracts)
      ? `${fmt(data.openInterestContracts, 2)} kontrak` : '—';
  const units = [];
  if (Number.isFinite(data.openInterestContracts)) units.push(`${fmt(data.openInterestContracts, 2)} kontrak`);
  if (Number.isFinite(data.openInterestCoin)) units.push(`${fmt(data.openInterestCoin, 4)} ${data.openInterestCcy || 'aset'}`);
  $('#openInterestUnit').textContent = units.length ? units.join(' · ') : 'Unit/nilai tidak tersedia';
  $('#fundingUpdatedAt').textContent = `Funding diperbarui: ${formatMarketTimestamp(data.fundingUpdated)}`;
  $('#openInterestUpdatedAt').textContent = `OI diperbarui: ${formatMarketTimestamp(data.openInterestUpdated)}`;
}

function updateDerivativeFactors() {
  const data = state.fundamentals || {};
  const now = Date.now();
  const fundingFresh = Number.isFinite(data.fundingRate) && Number.isFinite(data.fundingUpdated)
    && now - data.fundingUpdated <= 5 * 60_000 && data.fundingUpdated <= now + 30_000;
  state.fundingScore = fundingFresh ? clamp(-data.fundingRate / 0.0005, -1, 1) : null;
  const oi = Number(data.openInterestUsd);
  const ts = Number(data.openInterestUpdated);
  if (Number.isFinite(oi) && oi > 0 && Number.isFinite(ts) && now - ts <= 5 * 60_000 && ts <= now + 30_000) {
    const existing = state.oiHistory.find(item => item.instId === state.asset && item.ts === ts);
    if (!existing) {
      state.oiHistory.push({ instId:state.asset, ts, oi, price:state.price });
      state.oiHistory = state.oiHistory.filter(item => now - item.ts <= 30 * 60_000).slice(-30);
    }
  }
  const samples = state.oiHistory.filter(item => item.instId === state.asset).slice(-2);
  if (samples.length < 2 || now - samples.at(-1).ts > 5 * 60_000
      || samples[1].ts <= samples[0].ts || samples[1].ts - samples[0].ts > 20 * 60_000) {
    state.oiScore = null;
  } else {
    const oiChange = samples[1].oi / samples[0].oi - 1;
    const priceChange = samples[1].price / samples[0].price - 1;
    state.oiScore = oiChange > 0.001 && Math.abs(priceChange) > 0.0005
      ? Math.sign(priceChange) * clamp(Math.abs(oiChange) / 0.02, 0, 1) : 0;
  }
}

async function loadMarket() {
  if (state.loading) { state.pendingMarketReload = true; return; }
  if (!state.instrument || !state.asset) { setConnection(false, 'Katalog belum siap'); return; }
  const requestedAsset = state.asset;
  const requestedBar = state.bar;
  state.loading = true;
  if (state.loadedAsset !== requestedAsset || state.loadedBar !== requestedBar) clearMarketDisplay('Memuat data OKX…');
  $('#marketStrip').setAttribute('aria-busy', 'true');
  $('#marketError').hidden = true;
  $('#paperTradeBtn').disabled = true;
  $('#refreshBtn').disabled = true;
  $('#refreshBtn').textContent = 'Memuat…';
  $('#chartEmpty').hidden = Boolean(tvChart);
  setConnection(false, 'Mengambil data');
  loadMicrostructure();
  try {
    const instrument = encodeURIComponent(requestedAsset);
    const trendPromise = state.trendFilterEnabled && requestedBar !== '4H'
      ? getJson(`${API}/candles?instId=${instrument}&bar=4H&limit=100`) : Promise.resolve(null);
    const [tickerOutcome, candleOutcome, fundingOutcome, interestOutcome, trendOutcome] = await Promise.allSettled([
      getJson(`${API}/ticker?instId=${instrument}`),
      getJson(`${API}/candles?instId=${instrument}&bar=${encodeURIComponent(requestedBar)}&limit=100`),
      getJson(`${API}/funding-rate?instId=${instrument}`),
      getJson(`${API}/open-interest?instId=${instrument}`),
      trendPromise,
    ]);
    if (tickerOutcome.status !== 'fulfilled') throw tickerOutcome.reason;
    if (candleOutcome.status !== 'fulfilled') throw candleOutcome.reason;
    const tickerResult = tickerOutcome.value;
    const candleResult = candleOutcome.value;
    const ticker = tickerResult?.data?.[0];
    const candles = candleResult?.data;
    if (state.asset !== requestedAsset || state.bar !== requestedBar) { state.pendingMarketReload = true; return; }
    if (!ticker || !Array.isArray(candles) || candles.length < 15) throw new Error('Data pasar OKX kosong atau tidak lengkap');
    const price = Number(ticker.last);
    const open24h = Number(ticker.open24h);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Harga OKX tidak valid');
    const parsed = candles.map(row => ({
      ts: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
      close: Number(row[4]), vol: Number(row[5]), confirm: row.length > 8 ? String(row[8]) : null,
    })).filter(candle => [candle.ts, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)).reverse();
    if (parsed.length < 15) throw new Error('Candlestick OKX tidak lengkap');
    const closedCandles = parsed.filter(candle => candle.confirm !== '0');
    if (closedCandles.length < 15) throw new Error('Belum cukup candle tertutup untuk menghitung indikator');
    const trendRows = requestedBar === '4H' ? closedCandles
      : trendOutcome.status === 'fulfilled' && Array.isArray(trendOutcome.value?.data) ? trendOutcome.value.data.map(row => ({ ts:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),confirm:String(row[8]) })).filter(candle => candle.confirm !== '0' && [candle.ts,candle.open,candle.high,candle.low,candle.close].every(Number.isFinite)).reverse()
        : [];
    state.price = price;
    state.open24h = Number.isFinite(open24h) && open24h > 0 ? open24h : null;
    state.volume = Number(ticker.vol24h);
    state.high24h = Number(ticker.high24h);
    state.low24h = Number(ticker.low24h);
    state.candles = parsed;
    state.analysisCandles = closedCandles;
    $('#runBacktestBtn').disabled = closedCandles.length < 35;
    state.rsi = rsi(closedCandles.map(candle => candle.close), 14);
    state.atr = atr(closedCandles, 14);
    state.taScore = clamp((50 - state.rsi) / 50, -1, 1);
    state.taTrendConfirmed = trendDirection(closedCandles);
    state.volumeConfirmed = volumeExpansion(closedCandles);
    state.trendCandles4h = trendRows;
    state.trendConfirmed = state.trendFilterEnabled ? trendDirection(trendRows) : null;
    state.trendStatus = state.trendFilterEnabled ? (state.trendConfirmed || '4H data tidak tersedia') : 'nonaktif';
    const funding = fundingOutcome.status === 'fulfilled'
      ? fundingOutcome.value?.data?.find(row => row?.instId === requestedAsset) : null;
    const interest = interestOutcome.status === 'fulfilled'
      ? interestOutcome.value?.data?.find(row => row?.instId === requestedAsset) : null;
    state.fundamentals = {
      fundingRate: funding && funding.fundingRate !== '' && Number.isFinite(Number(funding.fundingRate)) ? Number(funding.fundingRate) : null,
      settledFundingRate: funding && funding.settFundingRate !== '' && Number.isFinite(Number(funding.settFundingRate)) ? Number(funding.settFundingRate) : null,
      fundingTime: Number(funding?.fundingTime) || null,
      nextFundingTime: Number(funding?.nextFundingTime) || null,
      settlementState: typeof funding?.settState === 'string' ? funding.settState : null,
      fundingUpdated: Number(funding?.ts) || null,
      openInterestUsd: interest && interest.oiUsd !== '' && Number.isFinite(Number(interest.oiUsd)) ? Number(interest.oiUsd) : null,
      openInterestContracts: interest && interest.oi !== '' && Number.isFinite(Number(interest.oi)) ? Number(interest.oi) : null,
      openInterestCoin: interest && interest.oiCcy !== '' && Number.isFinite(Number(interest.oiCcy)) ? Number(interest.oiCcy) : null,
      openInterestUpdated: Number(interest?.ts) || null,
      openInterestCcy: state.instrument?.ctValCcy || null,
    };
    updateDerivativeFactors();
    recomputeCompositeScore();
    state.loadedAsset = requestedAsset;
    state.loadedBar = requestedBar;
    $('#marketStrip').classList.remove('is-initial-loading');
    evaluatePriceAlerts(requestedAsset, price);
    evaluatePaperExit(requestedAsset, price);
    state.connected = true;
    state.loading = false;
    updateUI();
    renderFundamentals();
    setConnection(true, 'REST · data segar');
    $('#marketStrip').setAttribute('aria-busy', 'false');
    $('#marketError').hidden = true;
    $('#updatedAt').textContent = new Date(Number(ticker.ts) || Date.now()).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#chartEmpty').hidden = Boolean(tvChart);
    renderPortfolio();
    if (state.live.available && !state.live.quote) {
      $('#liveOrderPrice').value = fmt(state.price, state.price > 100 ? 2 : 6).replace(/,/g, '');
    }
  } catch (error) {
    state.connected = false;
    setConnection(false, error.code === 'NETWORK' ? 'Backend tidak terjangkau' : 'Data tidak tersedia');
    $('#marketStrip').setAttribute('aria-busy', 'false');
    $('#marketStrip').classList.remove('is-initial-loading');
    $('#marketErrorText').textContent = error.code === 'NETWORK' ? 'Backend tidak terjangkau. Data terakhir dipertahankan; coba lagi saat koneksi tersedia.'
      : error.code === 'RATE_LIMIT' ? 'Batas permintaan OKX tercapai. Tunggu sebentar lalu coba lagi.'
        : 'Data pasar gagal diperbarui. Data terakhir tidak dianggap segar; paper order sementara nonaktif.';
    $('#marketError').hidden = false;
    const hasLastChart = Boolean(tvChart && state.candles.length);
    $('#chartEmpty').hidden = hasLastChart;
    $('#chartEmpty').textContent = error.message === 'RATE_LIMIT'
      ? 'Batas permintaan OKX tercapai. Coba perbarui lagi setelah satu menit.'
      : error.code === 'NETWORK'
        ? 'Backend aplikasi tidak terjangkau. Periksa koneksi atau alamat preview; login OKX tidak diperlukan.'
        : 'Data OKX belum tersedia atau tidak lengkap. Coba perbarui lagi.';
    if (!state.price) $('#signalHint').textContent = 'Menunggu data pasar yang valid · coba lagi';
    state.taTrendConfirmed = null;
    state.volumeConfirmed = null;
    if (state.trendFilterEnabled) { state.trendConfirmed = null; state.trendStatus = 'data stale/tidak tersedia'; }
    updateDerivativeFactors();
    recomputeCompositeScore();
    updateUI();
    renderFundamentals();
    $('#paperFootnote').textContent = 'Data refresh gagal—paper dikunci sampai data segar. Posisi yang ada tetap tersimpan; biaya dan pemantauan SL/TP hanya estimasi lokal.';
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
  if ($('#marketHigh')) $('#marketHigh').textContent = state.high24h > 0 ? fmt(state.high24h, 2) : '—';
  if ($('#marketLow')) $('#marketLow').textContent = state.low24h > 0 ? fmt(state.low24h, 2) : '—';
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
  const stale = !state.connected;
  const rawAction = state.score > 0.65 ? 'BUY' : state.score < -0.65 ? 'SELL' : 'HOLD';
  const taBlocked = !stale && state.taConfirmEnabled && rawAction !== 'HOLD'
    && (state.taTrendConfirmed !== rawAction || state.volumeConfirmed !== true);
  const trendBlocked = !stale && state.trendFilterEnabled && rawAction !== 'HOLD'
    && state.trendConfirmed !== rawAction;
  const action = stale ? 'HOLD' : scoreAction();
  const signal = $('#signalText');
  signal.textContent = action === 'HOLD' ? 'WAIT' : action === 'BUY' ? 'LONG' : 'SHORT';
  signal.className = action === 'BUY' ? 'signal-buy' : action === 'SELL' ? 'signal-sell' : 'signal-hold';
  $('#signalHint').textContent = stale ? `SNAPSHOT STALE · WAIT · refresh gagal · ${state.bar} · paper dikunci`
    : action === 'BUY' ? `BUY → LONG · skor > +0.65 · ${state.bar} · referensi SWAP`
      : action === 'SELL' ? `SELL → SHORT · skor < −0.65 · ${state.bar} · referensi SWAP`
        : `Di antara ambang ±0.65 · ${state.bar} · tunggu konfirmasi`;
  $('#scoreState').textContent = stale ? 'STALE · WAIT · paper nonaktif'
    : action === 'HOLD' ? 'WAIT · sinyal netral' : `SWAP · ${action === 'BUY' ? 'LONG / BUY' : 'SHORT / SELL'}`;
  if (taBlocked) {
    const trendLabel = state.taTrendConfirmed === rawAction ? 'EMA/MACD searah' : `EMA/MACD ${state.taTrendConfirmed || 'belum tersedia'}`;
    const volumeLabel = state.volumeConfirmed === true ? 'volume lolos' : state.volumeConfirmed === false ? 'volume <1,2× rerata' : 'volume tidak tersedia';
    $('#scoreState').textContent = `WAIT · filter ${state.bar}: ${trendLabel}, ${volumeLabel}`;
  } else if (trendBlocked) {
    $('#scoreState').textContent = `WAIT · konfirmasi 4H ${state.trendStatus}`;
  }
  $('#scoreState').style.color = action === 'BUY' ? 'var(--green)' : action === 'SELL' ? 'var(--red)' : 'var(--yellow)';
  $('#taScore').textContent = (state.taScore >= 0 ? '+' : '') + fmt(state.taScore, 2);
  $('#faScoreDisplay').textContent = (state.faScore >= 0 ? '+' : '') + fmt(state.faScore, 2);
  $('#fundingFactorScore').textContent = Number.isFinite(state.fundingScore) ? fmt(state.fundingScore, 2) : '—';
  $('#fundingFactorState').textContent = state.fundingWeight <= 0 ? 'nonaktif · 0%' : Number.isFinite(state.fundingScore) ? 'fresh · kontrarian' : 'rate stale/tidak tersedia';
  $('#oiFactorScore').textContent = Number.isFinite(state.oiScore) ? fmt(state.oiScore, 2) : '—';
  $('#oiFactorState').textContent = state.oiWeight <= 0 ? 'nonaktif · 0%' : Number.isFinite(state.oiScore) ? 'dua sampel fresh' : 'menunggu dua sampel fresh';
  $('#signalReason').textContent = stale ? `Data REST gagal; skor ${fmt(state.score,2)} dan indikator di bawah adalah snapshot lama, bukan sinyal aktif. Entry paper dinonaktifkan sampai refresh berhasil.`
    : taBlocked
    ? `Skor ${fmt(state.score,2)} melewati ambang tetapi konfirmasi ${state.bar} menahan sinyal: EMA20/MACD ${state.taTrendConfirmed || 'belum tersedia'}, volume ${state.volumeConfirmed === true ? 'lolos ambang 1,2× rerata 20 candle' : state.volumeConfirmed === false ? 'di bawah 1,2× rerata 20 candle' : 'belum tersedia'}.`
    : trendBlocked
    ? `Skor ${fmt(state.score,2)} melewati ambang, tetapi filter 4H menahan sinyal karena tren ${state.trendStatus} tidak searah atau data tidak cukup. RSI ${fmt(state.rsi,1)}; ATR ${fmt(state.atr, state.price > 100 ? 2 : 6)}.`
    : action === 'HOLD' ? `Skor ${fmt(state.score,2)} belum melewati ambang ±0.65. RSI ${fmt(state.rsi,1)} (${state.rsi < 30 ? 'oversold' : state.rsi > 70 ? 'overbought' : 'netral'}); ATR ${fmt(state.atr, state.price > 100 ? 2 : 6)} mengukur volatilitas, bukan arah.`
      : `${action === 'BUY' ? 'LONG/BUY' : 'SHORT/SELL'} karena skor ${fmt(state.score,2)} melewati ambang ${action === 'BUY' ? '+0.65' : '−0.65'}. RSI ${fmt(state.rsi,1)}, timeframe ${state.bar}${state.trendFilterEnabled ? `, konfirmasi 4H ${state.trendStatus}` : ''}.`;
  $('#thresholdMarker').style.left = (50 + clamp(state.score, -1, 1) * 46) + '%';
  const degrees = state.score >= 0 ? Math.min(180, state.score * 180) : Math.max(-180, state.score * 180);
  $('#signalGauge').style.background = `conic-gradient(${state.score >= 0 ? 'var(--green)' : 'var(--red)'} ${Math.abs(degrees)}deg,#26313b ${Math.abs(degrees)}deg 360deg)`;
  $('#atrValue').textContent = fmt(state.atr, state.price > 100 ? 2 : 6);
  const existing = state.portfolio.position;
  // Entry references follow the selected instrument's signal, not an existing position.
  const direction = action === 'SELL' ? 'short' : 'long';
  const position = calcPosition(direction);
  const digits = contractDecimals(state.instrument?.lotSz);
  const priceDigits = state.price > 100 ? 2 : 6;
  $('#riskDirection').textContent = stale ? 'WAIT · harga snapshot stale'
    : action === 'HOLD' ? 'WAIT · belum ada arah sinyal'
    : `Referensi ${direction.toUpperCase()}${existing ? ' · bukan level posisi aktif' : ' · entry mengikuti sinyal'}`;
  for (const side of ['long', 'short']) {
    const levels = calcPosition(side);
    $(`#${side}Scenario`).textContent = `Entry ${fmt(state.price, priceDigits)} · TP ${fmt(levels.tp, priceDigits)} · SL ${fmt(levels.sl, priceDigits)}${stale ? ' · SNAPSHOT LAMA' : ''}`;
  }
  $('#stopValue').textContent = action === 'HOLD' ? '—' : fmt(position.sl, priceDigits);
  $('#positionSize').textContent = `${fmt(position.qty, digits)} kontrak`;
  $('#riskAmount').textContent = 'Risiko gross sebelum biaya: ' + money(position.risk);
  $('#riskSL').textContent = action === 'HOLD' ? '—' : fmt(position.sl, priceDigits);
  $('#riskTP').textContent = action === 'HOLD' ? '—' : fmt(position.tp, priceDigits);
  $('#riskNotional').textContent = `Notional ${money(position.notional)} · margin estimasi ${money(position.margin)} @ ${fmt(position.leverage, 0)}×${stale ? ' · STALE' : ''}`;
  $('#volumeValue').textContent = Number.isFinite(state.volume) ? `${fmt(state.volume, 0)} kontrak` : '—';
  const closesPosition = existing && existing.instId === state.asset
    && ((action === 'BUY' && existing.side === 'short') || (action === 'SELL' && existing.side === 'long'));
  const blockedByPosition = existing && !closesPosition;
  $('#paperTradeBtn').disabled = !state.connected || state.loading || action === 'HOLD'
    || blockedByPosition || (!existing && position.qty < Number(state.instrument?.minSz));
  $('#paperTradeBtn').textContent = closesPosition
    ? `Tutup posisi ${existing.side.toUpperCase()} paper`
    : existing ? `Posisi ${existing.side.toUpperCase()} terbuka`
      : action === 'BUY' ? 'Simulasikan LONG' : action === 'SELL' ? 'Simulasikan SHORT' : 'Tunggu sinyal valid';
  $('#paperFootnote').textContent = closesPosition
    ? 'Sinyal berlawanan menutup posisi paper dengan fee taker 0,05%/fill dan slippage asumsi 2 bps. Funding hanya estimasi 8 jam dari rate terbaru; tidak ada order OKX.'
    : blockedByPosition ? 'Tutup posisi paper aktif sebelum mengganti aset atau membuka posisi baru.'
      : 'SWAP paper: taker 0,05%/fill + slippage asumsi 2 bps; funding estimasi memakai rate terbaru dan interval 8 jam. SL/TP dipantau pada ticker valid saat tab aktif; gap dan hasil tidak dijamin. Tidak mengirim order ke bursa.';
  drawChart();
}

function drawChart() {
  if (!tvChart || !tvCandleSeries) return;
  const candles = state.candles.filter(candle => [candle.ts, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .map(candle => ({
      time: Math.floor(candle.ts / 1000), open:candle.open, high:candle.high,
      low:candle.low, close:candle.close, volume:candle.vol,
    })).sort((a, b) => a.time - b.time);
  const unique = candles.filter((candle, index) => index === 0 || candle.time > candles[index - 1].time);
  if (!unique.length) {
    tvCandleSeries.setData([]);
    tvEmaSeries?.setData([]);
    tvBbUpperSeries?.setData([]);
    tvBbLowerSeries?.setData([]);
    tvVolumeSeries?.setData([]);
    tvMarkers?.setMarkers([]);
    for (const line of tvPriceLines) tvCandleSeries.removePriceLine(line);
    tvPriceLines = [];
    $('#chartOhlc').textContent = 'O — H — L — C —';
    $('#chartTooltip').hidden = true;
    return;
  }
  tvCandleSeries.setData(unique.map(({time, open, high, low, close}) => ({time, open, high, low, close})));
  const closes = unique.map(candle => candle.close);
  const emaValues = state.chartOverlays.ema ? ema(closes, 20) : [];
  tvEmaSeries?.setData(emaValues.flatMap((value, index) => Number.isFinite(value) ? [{time:unique[index].time,value}] : []));
  const bands = state.chartOverlays.bollinger ? bollinger(closes, 20, 2) : [];
  tvBbUpperSeries?.setData(bands.flatMap((band,index) => band ? [{time:unique[index].time,value:band.upper}] : []));
  tvBbLowerSeries?.setData(bands.flatMap((band,index) => band ? [{time:unique[index].time,value:band.lower}] : []));
  tvVolumeSeries?.setData(state.chartOverlays.volume
    ? unique.flatMap(candle => Number.isFinite(candle.volume) ? [{time:candle.time,value:candle.volume,color:candle.close >= candle.open ? '#a8e66b55' : '#f0717155'}] : [])
    : []);
  const last = unique.at(-1);
  const digits = state.price > 100 ? 2 : 6;
  $('#chartOhlc').textContent = `O ${fmt(last.open, digits)} H ${fmt(last.high, digits)} L ${fmt(last.low, digits)} C ${fmt(last.close, digits)}`;
  const identity = `${state.asset}|${state.bar}`;
  if (tvChartIdentity !== identity) {
    tvChart.timeScale().fitContent();
    tvChartIdentity = identity;
  }
  const action = scoreAction();
  const signalCandle = state.analysisCandles.at(-1) || state.candles.at(-1);
  if (signalCandle && action !== 'HOLD' && tvMarkers) {
    const isBuy = action === 'BUY';
    tvMarkers.setMarkers([{
      time: Math.floor(signalCandle.ts / 1000), position: isBuy ? 'belowBar' : 'aboveBar',
      color: isBuy ? '#a8e66b' : '#f07171', shape: isBuy ? 'arrowUp' : 'arrowDown', text: isBuy ? 'LONG · BUY' : 'SHORT · SELL',
    }]);
  } else tvMarkers?.setMarkers([]);
  for (const line of tvPriceLines) tvCandleSeries.removePriceLine(line);
  tvPriceLines = [];
  if (action !== 'HOLD' && Number.isFinite(state.price) && Number.isFinite(state.atr) && state.atr > 0) {
    const direction = action === 'SELL' ? 'short' : 'long';
    const levels = calcPosition(direction);
    const addLine = (price, title, color) => tvPriceLines.push(tvCandleSeries.createPriceLine({
      price, color, lineWidth:1, lineStyle:2, axisLabelVisible:true, title,
    }));
    addLine(state.price, `REF ${direction.toUpperCase()} ENTRY`, '#82b9a2');
    addLine(levels.sl, `REF ${direction.toUpperCase()} SL · 1.5× ATR`, '#f07171');
    addLine(levels.tp, `REF ${direction.toUpperCase()} TP · 2.5× ATR`, '#a8e66b');
  }
}

function renderPortfolio() {
  const position = state.portfolio.position;
  const equity = getEquity();
  const pnl = getUnrealized(position);
  $('#equityValue').textContent = money(equity);
  $('#cashValue').textContent = money(state.portfolio.cash);
  $('#pnlValue').textContent = (pnl >= 0 ? '+' : '') + money(pnl);
  $('#pnlValue').className = pnl > 0 ? 'positive-text' : pnl < 0 ? 'negative-text' : '';
  const name = position ? (state.instruments.find(item => item.instId === position.instId)?.baseCcy || position.instId.split('-')[0]) : '';
  $('#openPosition').textContent = position ? `${position.side.toUpperCase()} ${formatContracts(position.qty, position.instId, position.lotSz)} ${name}` : 'Tidak ada';
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
    <td><span class="side-badge ${['BUY', 'LONG'].includes(trade.side) ? 'buy' : 'sell'}">${escapeHtml(trade.side || '')}</span></td>
    <td>${money(Number(trade.price))}</td><td>${formatContracts(trade.qty, trade.asset, trade.lotSz)}</td>
    <td class="${trade.pnl > 0 ? 'positive-text' : trade.pnl < 0 ? 'negative-text' : ''}">${trade.pnl == null ? '—' : (trade.pnl >= 0 ? '+' : '') + money(trade.pnl)}</td>
    <td>SIMULASI</td>
  </tr>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function simulateBacktest(candles, taWeight = state.taWeight, manualSentiment = state.faScore) {
  if (!Array.isArray(candles) || candles.length < 35) return { error:'Butuh minimal 35 candle tertutup.' };
  const closes = candles.map(item => Number(item.close));
  if (closes.some(value => !Number.isFinite(value) || value <= 0)) return { error:'Data candle tidak valid.' };
  const trades = [];
  let position = null;
  for (let i = 30; i < candles.length; i++) {
    const candle = candles[i];
    if (position) {
      let exit = null, reason = '';
      if (position.side === 'long') {
        if (candle.low <= position.sl) { exit = position.sl; reason = 'SL'; }
        else if (candle.high >= position.tp) { exit = position.tp; reason = 'TP'; }
      } else {
        if (candle.high >= position.sl) { exit = position.sl; reason = 'SL'; }
        else if (candle.low <= position.tp) { exit = position.tp; reason = 'TP'; }
      }
      const currentRsi = rsi(closes.slice(0, i + 1), 14);
      const score = clamp(taWeight * clamp((50 - currentRsi) / 50, -1, 1) + (1 - taWeight) * manualSentiment, -1, 1);
      const opposite = position.side === 'long' ? score < -0.65 : score > 0.65;
      if (exit === null && opposite) { exit = i + 1 < candles.length ? Number(candles[i + 1].open) : candle.close; reason = 'SIGNAL'; }
      if (Number.isFinite(exit)) {
        const pnlPct = (exit / position.entry - 1) * (position.side === 'long' ? 100 : -100);
        trades.push({ pnlPct, reason, side:position.side });
        position = null;
        continue;
      }
    }
    if (!position && i + 1 < candles.length) {
      const currentRsi = rsi(closes.slice(0, i + 1), 14);
      const score = clamp(taWeight * clamp((50 - currentRsi) / 50, -1, 1) + (1 - taWeight) * manualSentiment, -1, 1);
      const side = score > 0.65 ? 'long' : score < -0.65 ? 'short' : null;
      const entry = Number(candles[i + 1].open);
      const volatility = atr(candles.slice(0, i + 1), 14);
      if (side && Number.isFinite(entry) && entry > 0 && volatility > 0) {
        const sign = side === 'long' ? 1 : -1;
        position = { side, entry, sl:entry - sign * volatility * 1.5, tp:entry + sign * volatility * 2.5 };
      }
    }
  }
  if (position) {
    const finalPrice = Number(candles.at(-1).close);
    trades.push({ pnlPct:(finalPrice / position.entry - 1) * (position.side === 'long' ? 100 : -100), reason:'END', side:position.side });
  }
  if (!trades.length) return { trades:0, winRate:0, profitFactor:0, maxDrawdown:0, netReturn:0 };
  const wins = trades.filter(trade => trade.pnlPct > 0);
  const lossAbs = trades.filter(trade => trade.pnlPct < 0).reduce((sum, trade) => sum + Math.abs(trade.pnlPct), 0);
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const trade of trades) { equity *= Math.max(0, 1 + trade.pnlPct / 100); peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak * 100 : 0); }
  return { trades:trades.length, winRate:wins.length / trades.length * 100,
    profitFactor:lossAbs > 0 ? wins.reduce((sum, trade) => sum + trade.pnlPct, 0) / lossAbs : wins.length ? Infinity : 0,
    maxDrawdown, netReturn:(equity - 1) * 100 };
}

function runBacktest() {
  const button = $('#runBacktestBtn');
  button.disabled = true;
  $('#backtestResult').textContent = 'Menghitung sinyal historis dari candle tertutup…';
  try {
    const result = simulateBacktest(state.analysisCandles);
    $('#backtestResult').textContent = result.error || `${result.trades} trades · win rate ${fmt(result.winRate,1)}% · profit factor ${Number.isFinite(result.profitFactor) ? fmt(result.profitFactor,2) : '∞'} · max drawdown ${fmt(result.maxDrawdown,2)}% · net gross ${fmt(result.netReturn,2)}%. RSI + sentimen manual saja; tanpa funding/OI, fee, slippage, spread, atau 4H filter.`;
  } finally { button.disabled = state.analysisCandles.length < 35; }
}

function renderWatchlist() {
  const select = $('#watchlistSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Pilih favorit…</option>' + state.watchlist.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
  select.value = state.watchlist.includes(current) ? current : '';
  const saved = state.watchlist.includes(state.asset);
  $('#watchToggle').textContent = saved ? '★' : '☆';
  $('#watchToggle').setAttribute('aria-pressed', String(saved));
  $('#watchToggle').setAttribute('aria-label', saved ? 'Hapus pair dari watchlist' : 'Tambahkan pair ke watchlist');
}
function toggleWatchlist() {
  state.watchlist = state.watchlist.includes(state.asset)
    ? state.watchlist.filter(id => id !== state.asset) : [...state.watchlist, state.asset].slice(-50);
  savePreferenceList('orbital-watchlist-v1', state.watchlist);
  renderWatchlist();
}
function renderPriceAlerts(message = '') {
  const list = $('#alertsList');
  if (!list) return;
  const rows = state.priceAlerts.map((alert, index) => `<div class="alert-row"><span>${escapeHtml(alert.instId)} · ${alert.direction === 'above' ? '≥' : '≤'} ${fmt(alert.price, 8)}${alert.triggeredAt ? ` · terpicu ${new Date(alert.triggeredAt).toLocaleTimeString('id-ID')}` : ''}</span><button type="button" data-alert-index="${index}" aria-label="Hapus alert ${escapeHtml(alert.instId)}">Hapus</button></div>`).join('');
  list.innerHTML = (message ? `<p>${escapeHtml(message)}</p>` : '') + (rows || '<span>Belum ada alert untuk pair ini.</span>');
  list.querySelectorAll('[data-alert-index]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.alertIndex);
    state.priceAlerts.splice(index, 1);
    savePreferenceList('orbital-alerts-v1', state.priceAlerts);
    renderPriceAlerts();
  }));
}
function priceCrossed(direction, previous, current, threshold) {
  if ([previous,current,threshold].some(value => value === null || value === undefined || String(value).trim() === '')
      || ![previous,current,threshold].every(value => Number.isFinite(Number(value)))) return false;
  const [from, to, level] = [previous,current,threshold].map(Number);
  return direction === 'above' ? from < level && to >= level
    : direction === 'below' ? from > level && to <= level : false;
}
function addPriceAlert() {
  const price = Number($('#alertPriceInput').value);
  const direction = $('#alertDirection').value;
  if (!Number.isFinite(price) || price <= 0 || !['above','below'].includes(direction)) {
    renderPriceAlerts('Masukkan harga pemicu yang valid.');
    return false;
  }
  state.priceAlerts.push({ instId:state.asset, direction, price, lastPrice:Number(state.price) || null, triggeredAt:null });
  state.priceAlerts = state.priceAlerts.slice(-50);
  savePreferenceList('orbital-alerts-v1', state.priceAlerts);
  $('#alertPriceInput').value = '';
  renderPriceAlerts('Alert dibuat. Notifikasi hanya diperiksa selama halaman aktif.');
  return true;
}
function evaluatePriceAlerts(instId, price) {
  let triggered = 0;
  for (const alert of state.priceAlerts) {
    if (alert.instId !== instId || alert.triggeredAt) continue;
    const previous = alert.lastPrice;
    if (previous !== null && previous !== undefined && priceCrossed(alert.direction, previous, price, alert.price)) {
      alert.triggeredAt = Date.now();
      triggered++;
    }
    alert.lastPrice = price;
  }
  if (triggered) {
    savePreferenceList('orbital-alerts-v1', state.priceAlerts);
    renderPriceAlerts(`${triggered} alert terpicu untuk ${instId} pada ${fmt(price, state.price > 100 ? 2 : 6)} USDT.`);
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState === 'visible') {
      new Notification('Orbital · alert harga', { body:`${instId}: ${fmt(price, state.price > 100 ? 2 : 6)} USDT` });
    }
  }
}

function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportPaperJson() {
  const backup = { schema:'orbital-paper-backup', version:1, exportedAt:new Date().toISOString(), portfolio:state.portfolio };
  downloadText(`orbital-paper-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(backup, null, 2), 'application/json');
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function exportPaperCsv() {
  const columns = ['time','asset','side','price','qty','pnl','grossPnl','entryFee','exitFee','funding','exitReason'];
  const rows = [columns.join(','), ...state.portfolio.trades.map(trade => columns.map(key => csvCell(key === 'entryFee' ? trade.entryFee ?? trade.fee : trade[key])).join(','))];
  downloadText(`orbital-trades-${new Date().toISOString().slice(0,10)}.csv`, '\ufeff' + rows.join('\r\n'), 'text/csv;charset=utf-8');
}
function validatePaperBackup(input) {
  const portfolio = input?.schema === 'orbital-paper-backup' && input.version === 1 ? input.portfolio : null;
  if (!portfolio || !Number.isFinite(Number(portfolio.cash)) || Number(portfolio.cash) < 0
      || !Array.isArray(portfolio.trades) || portfolio.trades.length > 1000) return null;
  const trades = portfolio.trades.map(trade => {
    if (!trade || !SWAP_ID.test(String(trade.asset || '')) || !['LONG','SHORT','CLOSE'].includes(trade.side)
        || !Number.isFinite(Number(trade.time)) || !Number.isFinite(Number(trade.price)) || Number(trade.price) <= 0
        || !Number.isFinite(Number(trade.qty)) || Number(trade.qty) <= 0
        || ['grossPnl','entryFee','exitFee','fee','funding'].some(key => trade[key] != null && !Number.isFinite(Number(trade[key])))
        || ['entryFee','exitFee','fee'].some(key => trade[key] != null && Number(trade[key]) < 0)
        || !(trade.pnl == null || Number.isFinite(Number(trade.pnl)))) return null;
    return { time:Number(trade.time), asset:String(trade.asset), side:trade.side, price:Number(trade.price), qty:Number(trade.qty), lotSz:String(trade.lotSz || '0.01'), pnl:trade.pnl == null ? null : Number(trade.pnl), fee:Number.isFinite(Number(trade.fee)) ? Number(trade.fee) : undefined, grossPnl:Number.isFinite(Number(trade.grossPnl)) ? Number(trade.grossPnl) : undefined, entryFee:Number.isFinite(Number(trade.entryFee ?? trade.fee)) ? Number(trade.entryFee ?? trade.fee) : undefined, exitFee:Number.isFinite(Number(trade.exitFee)) ? Number(trade.exitFee) : undefined, funding:Number.isFinite(Number(trade.funding)) ? Number(trade.funding) : undefined, exitReason:['SL','TP','SIGNAL','MANUAL','END'].includes(trade.exitReason) ? trade.exitReason : undefined };
  });
  if (trades.some(trade => !trade)) return null;
  let position = null;
  if (portfolio.position != null) {
    const p = portfolio.position;
    if (!SWAP_ID.test(String(p.instId || '')) || !['long','short'].includes(p.side)
        || ![p.qty,p.entry,p.ctVal,p.margin,p.sl,p.tp].every(value => Number.isFinite(Number(value)) && Number(value) > 0)) return null;
    position = { instId:String(p.instId), side:p.side, qty:Number(p.qty), entry:Number(p.entry), ctVal:Number(p.ctVal), margin:Number(p.margin), sl:Number(p.sl), tp:Number(p.tp), openedAt:Number(p.openedAt) || Date.now(), lotSz:String(p.lotSz || '0.01'), entryFee:Number(p.entryFee) || 0, fundingAccrued:Number(p.fundingAccrued) || 0, fundingRateAtEntry:Number(p.fundingRateAtEntry) || 0, nextFundingTime:Number(p.nextFundingTime) || null, autoExit:p.autoExit === true };
  }
  return { cash:Number(portfolio.cash), position, trades:trades.slice(-500) };
}
async function importPaperJson(file) {
  if (!file || file.size > 2_000_000) throw new Error('File backup tidak boleh melebihi 2 MB.');
  const parsed = JSON.parse(await file.text());
  const portfolio = validatePaperBackup(parsed);
  if (!portfolio) throw new Error('Format backup tidak valid atau berisi data di luar batas.');
  if (!window.confirm('Ganti saldo, posisi dan riwayat paper lokal dengan isi backup ini? Tindakan tidak dapat dibatalkan.')) return false;
  state.portfolio = portfolio;
  savePortfolio();
  updateUI();
  return true;
}
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.body.classList.toggle('theme-light', state.theme === 'light');
  $('#themeToggle').textContent = state.theme === 'light' ? 'Tema gelap' : 'Tema terang';
  $('#themeToggle').setAttribute('aria-pressed', String(state.theme === 'light'));
  if (tvChart) tvChart.applyOptions({ layout:{ background:{ type:window.LightweightCharts?.ColorType?.Solid, color:state.theme === 'light' ? '#ffffff' : '#0d1011' }, textColor:state.theme === 'light' ? '#4d5d53' : '#89928e' } });
  if (tvCandleSeries) tvCandleSeries.applyOptions({ upColor:state.theme === 'light' ? '#2d6b22' : '#a8e66b', downColor:state.theme === 'light' ? '#a82936' : '#f07171', wickUpColor:state.theme === 'light' ? '#2d6b22' : '#a8e66b', wickDownColor:state.theme === 'light' ? '#a82936' : '#f07171' });
}
function setupBottomNavigation() {
  const links = [...document.querySelectorAll('.bottom-nav a')];
  const sync = () => {
    const id = location.hash || '#overview';
    links.forEach(link => link.setAttribute('aria-current', link.getAttribute('href') === id ? 'page' : 'false'));
  };
  window.addEventListener('hashchange', sync);
  sync();
}
async function setupServiceWorkerUpdates() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    state.serviceWorkerRegistration = registration;
    const reveal = () => { if (registration.waiting && navigator.serviceWorker.controller) $('#updateAppBtn').hidden = false; };
    reveal();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => { if (installing.state === 'installed') reveal(); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (state.serviceWorkerUpdating) { state.serviceWorkerUpdating = false; location.reload(); }
    });
    setInterval(() => { if (!document.hidden) registration.update().catch(() => {}); }, 60 * 60_000);
  } catch (error) { console.warn('PWA offline cache unavailable', error); }
}

const PAPER_TAKER_FEE = 0.0005;
const PAPER_SLIPPAGE_BPS = 2;
const FUNDING_INTERVAL_ESTIMATE_MS = 8 * 60 * 60 * 1000;

function paperExit(position, exitPrice, reason = 'MANUAL') {
  if (!position || !Number.isFinite(exitPrice) || exitPrice <= 0) return false;
  const slip = PAPER_SLIPPAGE_BPS / 10_000;
  const fillPrice = exitPrice * (position.side === 'long' ? 1 - slip : 1 + slip);
  const sign = position.side === 'long' ? 1 : -1;
  const gross = (fillPrice - position.entry) * position.qty * position.ctVal * sign;
  const exitFee = fillPrice * position.qty * position.ctVal * PAPER_TAKER_FEE;
  const entryFee = Number(position.entryFee) || 0;
  const fundingAccrued = Number(position.fundingAccrued) || 0;
  state.portfolio.cash += position.margin + gross - exitFee;
  state.portfolio.trades.push({ time:Date.now(), asset:position.instId, side:'CLOSE', price:fillPrice,
    qty:position.qty, lotSz:position.lotSz || state.instrument?.lotSz || '0.01',
    pnl:gross - entryFee - exitFee + fundingAccrued, grossPnl:gross, entryFee, exitFee,
    funding:fundingAccrued, exitReason:reason });
  state.portfolio.position = null;
  savePortfolio();
  updateUI();
  return true;
}

function applyEstimatedFunding(position, price, now = Date.now()) {
  if (!position || !Number.isFinite(price)) return;
  if (!Number.isFinite(position.nextFundingTime) || position.nextFundingTime <= 0) {
    position.nextFundingTime = (Number(position.openedAt) || now) + FUNDING_INTERVAL_ESTIMATE_MS;
  }
  let iterations = 0;
  while (position.nextFundingTime <= now && iterations < 3) {
    const rate = Number(state.fundamentals?.fundingRate ?? position.fundingRateAtEntry);
    if (!Number.isFinite(rate)) break;
    const notional = position.qty * position.ctVal * price;
    const cashflow = -(position.side === 'long' ? 1 : -1) * notional * rate;
    state.portfolio.cash += cashflow;
    position.fundingAccrued = (Number(position.fundingAccrued) || 0) + cashflow;
    position.nextFundingTime += FUNDING_INTERVAL_ESTIMATE_MS;
    iterations++;
  }
  if (position.nextFundingTime <= now) position.nextFundingTime = now + FUNDING_INTERVAL_ESTIMATE_MS;
  const nextFromOkx = Number(state.fundamentals?.nextFundingTime);
  if (Number.isFinite(nextFromOkx) && nextFromOkx > now && nextFromOkx > position.nextFundingTime - FUNDING_INTERVAL_ESTIMATE_MS) position.nextFundingTime = nextFromOkx;
}

function evaluatePaperExit(instId, price) {
  const position = state.portfolio.position;
  if (!position || position.instId !== instId || position.autoExit !== true) return false;
  applyEstimatedFunding(position, price);
  if (position.side === 'long') {
    if (price <= position.sl) return paperExit(position, price, 'SL');
    if (price >= position.tp) return paperExit(position, position.tp, 'TP');
  } else {
    if (price >= position.sl) return paperExit(position, price, 'SL');
    if (price <= position.tp) return paperExit(position, position.tp, 'TP');
  }
  savePortfolio();
  return false;
}

function paperTrade() {
  const action = scoreAction();
  const existing = state.portfolio.position;
  if (!state.price || !state.connected || action === 'HOLD') return;
  const now = Date.now();
  if (!existing) {
    const direction = action === 'BUY' ? 'long' : 'short';
    const sizing = calcPosition(direction);
    const slippage = PAPER_SLIPPAGE_BPS / 10_000;
    const fillPrice = state.price * (direction === 'long' ? 1 + slippage : 1 - slippage);
    const sign = direction === 'long' ? 1 : -1;
    const entryFee = sizing.qty * Number(state.instrument.ctVal) * fillPrice * PAPER_TAKER_FEE;
    if (sizing.qty < Number(state.instrument?.minSz) || sizing.margin + entryFee > state.portfolio.cash) return;
    state.portfolio.cash -= sizing.margin + entryFee;
    state.portfolio.position = {
      instId: state.asset, side: direction, qty: sizing.qty, entry: fillPrice,
      ctVal: Number(state.instrument.ctVal), lotSz: String(state.instrument.lotSz || '0.01'), margin: sizing.margin,
      sl: fillPrice - sign * state.atr * 1.5, tp: fillPrice + sign * state.atr * 2.5,
      openedAt: now, entryFee, fundingAccrued:0,
      fundingRateAtEntry:Number.isFinite(state.fundamentals?.fundingRate) ? state.fundamentals.fundingRate : 0,
      nextFundingTime:Number(state.fundamentals?.nextFundingTime) > now
        ? Number(state.fundamentals.nextFundingTime) : now + FUNDING_INTERVAL_ESTIMATE_MS,
      autoExit:true,
    };
    state.portfolio.trades.push({ time: now, asset: state.asset, side: direction.toUpperCase(), price: fillPrice, qty: sizing.qty, lotSz: String(state.instrument.lotSz || '0.01'), fee:entryFee, pnl: null });
  } else {
    const closes = existing.instId === state.asset
      && ((action === 'BUY' && existing.side === 'short') || (action === 'SELL' && existing.side === 'long'));
    if (!closes) return;
    paperExit(existing, state.price, 'MANUAL');
    return;
  }
  savePortfolio();
  updateUI();
}

function setSentiment(value) {
  state.faScore = Number(value);
  $('#faValue').textContent = (state.faScore >= 0 ? '+' : '') + fmt(state.faScore, 2);
  recomputeCompositeScore();
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
      tdMode: $('#liveOrderMode').value,
      sz: $('#liveOrderSize').value,
      px: $('#liveOrderPrice').value,
    };
    const result = await getJson('/api/live/quote', {
      method: 'POST', headers: liveAuthorizationHeaders(), body: JSON.stringify(payload),
    });
    state.live.quote = { ...payload, challenge: result.challenge, preview: result.preview };
    const preview = result.preview;
    $('#livePreviewSummary').textContent = `${preview.side} ${preview.sizeContracts} kontrak ${preview.instId} · ${preview.tdMode.toUpperCase()} · limit ${preview.limitPrice} USDT · estimasi notional ${preview.notionalUsdt} USDT · pasar ${preview.marketPrice} USDT · akun ${preview.mode.toUpperCase()} · min ${preview.minSize} / lot ${preview.sizeStep} · tick ${preview.priceTick}`;
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
    $('#liveResult').textContent = `OKX menerima order limit ${result.order.side} ${result.order.sizeContracts} kontrak ${result.order.instrument} @ ${result.order.limitPrice} USDT · notional ${result.order.notionalUsdt} USDT. ID: ${result.order.orderId || 'tersedia di riwayat OKX'}. Status diterima tidak berarti order sudah terisi.`;
  } catch (error) {
    $('#liveResult').textContent = 'Order tidak terkonfirmasi berhasil: ' + error.message + '. Periksa riwayat OKX sebelum mencoba lagi.';
  } finally {
    button.textContent = 'Konfirmasi & kirim order nyata';
    button.disabled = !state.live.quote || $('#liveConfirmInput').value.trim() !== LIVE_CONFIRMATION;
  }
}

instrumentSearchController = createInstrumentSearch({
  inputId: 'instrumentSearch', resultsId: 'instrumentResults', statusId: 'instrumentSearchStatus',
  selectedId: () => state.asset,
  onSelect: item => selectMarketInstrument(item.instId),
});
autoInstrumentSearchController = createInstrumentSearch({
  inputId: 'autoInstrumentSearch', resultsId: 'autoInstrumentResults', statusId: 'autoInstrumentSearchStatus',
  selectedId: () => $('#autoInstrument').value || state.asset,
  onSelect: item => {
    const select = $('#autoInstrument');
    select.value = item.instId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
});

$('#faInput').addEventListener('input', event => setSentiment(event.target.value));
$('#accountConnectBtn').addEventListener('click', connectOkxAccount);
$('#autoStartBtn').addEventListener('click', startAutoTrading);
$('#autoStopBtn').addEventListener('click', stopAutoTrading);
$('#autoRefreshBtn').addEventListener('click', refreshAutoStatus);
$('#autoConfirmInput').addEventListener('input', updateAutoStartEnabled);
$('#autoRiskPct').addEventListener('input', updateAutoStartEnabled);
$('#autoInstrument').addEventListener('change', () => {
  autoInstrumentSearchController?.render();
  updateAutoStartEnabled();
});
$('#liveToken').addEventListener('input', updateAutoStartEnabled);
$('#leverageInput').addEventListener('input', event => {
  state.leverage = Number(event.target.value);
  $('#leverageValueLabel').textContent = `${fmt(effectiveLeverage(), 0)}×`;
  if (state.price) updateUI();
});
$('#riskInput').addEventListener('input', event => {
  state.riskPct = Number(event.target.value);
  $('#riskValueLabel').textContent = fmt(state.riskPct, 2) + '%';
  if (state.price) updateUI();
});
$('#weightInput').addEventListener('input', event => {
  state.taWeight = Number(event.target.value) / 100;
  $('#taWeightLabel').textContent = event.target.value + '%';
  recomputeCompositeScore();
  updateUI();
});
$('#fundingWeightInput').addEventListener('input', event => {
  state.fundingWeight = Number(event.target.value) / 100;
  $('#fundingWeightLabel').textContent = event.target.value + '%';
  recomputeCompositeScore(); updateUI();
});
$('#oiWeightInput').addEventListener('input', event => {
  state.oiWeight = Number(event.target.value) / 100;
  $('#oiWeightLabel').textContent = event.target.value + '%';
  recomputeCompositeScore(); updateUI();
});
$('#taConfirmInput').addEventListener('change', event => {
  state.taConfirmEnabled = event.target.checked;
  if (state.price) updateUI();
  loadMarket();
});
$('#trendFilterInput').addEventListener('change', event => {
  state.trendFilterEnabled = event.target.checked;
  state.trendConfirmed = null;
  state.trendStatus = state.trendFilterEnabled ? 'memuat data 4H…' : 'nonaktif';
  if (state.price) updateUI();
  loadMarket();
});
document.querySelectorAll('.chart-overlays button').forEach(button => button.addEventListener('click', () => {
  const overlay = button.dataset.overlay;
  if (!Object.hasOwn(state.chartOverlays, overlay)) return;
  state.chartOverlays[overlay] = !state.chartOverlays[overlay];
  button.setAttribute('aria-pressed', String(state.chartOverlays[overlay]));
  drawChart();
}));
$('#themeToggle').addEventListener('click', () => {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('orbital-theme-v1', state.theme); } catch {}
  applyTheme();
});
$('#watchToggle').addEventListener('click', toggleWatchlist);
$('#watchlistSelect').addEventListener('change', event => { if (event.target.value) selectMarketInstrument(event.target.value); });
$('#addPriceAlertBtn').addEventListener('click', addPriceAlert);
$('#alertPriceInput').addEventListener('keydown', event => { if (event.key === 'Enter') addPriceAlert(); });
$('#exportCsvBtn').addEventListener('click', exportPaperCsv);
$('#exportJsonBtn').addEventListener('click', exportPaperJson);
$('#importJsonInput').addEventListener('change', async event => {
  try { if (await importPaperJson(event.target.files?.[0])) renderPriceAlerts('Backup paper berhasil dipulihkan.'); }
  catch (error) { window.alert(`Impor gagal: ${error.message}`); }
  finally { event.target.value = ''; }
});
$('#runBacktestBtn').addEventListener('click', runBacktest);
$('#retryMarketBtn').addEventListener('click', loadMarket);
$('#assetSelect').addEventListener('change', event => {
  selectMarketInstrument(event.target.value);
});
document.querySelectorAll('.timeframe').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.timeframe').forEach(item => {
    item.classList.remove('selected');
    item.setAttribute('aria-pressed', 'false');
  });
  button.classList.add('selected');
  button.setAttribute('aria-pressed', 'true');
  state.bar = button.dataset.bar;
  loadMarket();
}));
$('#refreshBtn').addEventListener('click', async () => { if (!state.instruments.length) { if (await loadInstruments()) loadMarket(); } else loadMarket(); });
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
$('#updateAppBtn').addEventListener('click', () => {
  const waiting = state.serviceWorkerRegistration?.waiting;
  if (!waiting) { $('#updateAppBtn').hidden = true; return; }
  state.serviceWorkerUpdating = true;
  waiting.postMessage({ type:'SKIP_WAITING' });
  $('#updateAppBtn').disabled = true;
  $('#updateAppBtn').textContent = 'Memperbarui…';
});
$('#closeInstallHelp').addEventListener('click', () => $('#installHelp').close());
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });
window.addEventListener('resize', drawChart);
window.addEventListener('pagehide', () => { $('#liveToken').value = ''; $('#liveConfirmInput').value = ''; $('#autoConfirmInput').value = ''; });
window.addEventListener('online', loadMarket);
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  state.installPrompt = event;
  $('#installBtn').hidden = false;
});
if (state.portfolio.position?.asset) {
  state.asset = state.portfolio.position.asset;
  $('#assetSelect').value = state.asset;
}
if (window.matchMedia('(display-mode: standalone)').matches) $('#installBtn').hidden = true;
async function startApp() {
  applyTheme();
  renderWatchlist();
  renderPriceAlerts();
  setupBottomNavigation();
  setupServiceWorkerUpdates();
  initTradingViewChart();
  setToday();
  renderTrades();
  renderPortfolio();
  renderLiveStatus();
  loadLiveStatus();
  if (await loadInstruments()) {
    const leverageInput = $('#leverageInput');
    leverageInput.max = String(Math.min(20, Math.max(1, Number(state.instrument.maxLever) || 1)));
    if (Number(leverageInput.value) > Number(leverageInput.max)) leverageInput.value = leverageInput.max;
    state.leverage = Number(leverageInput.value);
    $('#leverageValueLabel').textContent = `${fmt(effectiveLeverage(), 0)}×`;
    loadMarket();
  }
  setInterval(() => { if (!document.hidden && state.instruments.length) loadMarket(); }, 60_000);
  setInterval(() => { if (!document.hidden && !state.loading && state.asset) loadMicrostructure(); }, 15_000);
  setInterval(() => { if (!document.hidden) loadInstruments(); }, 15 * 60_000);
}
if (window.matchMedia('(display-mode: standalone)').matches) $('#installBtn').hidden = true;
startApp();
