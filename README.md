# Orbital OKX Perpetual Terminal

PWA berbahasa Indonesia untuk memantau **OKX USDT-settled linear perpetual swaps**, menganalisis RSI/ATR dan skor sinyal, serta mencoba ukuran posisi dalam kontrak melalui paper trading lokal. Ini bukan aplikasi resmi OKX dan bukan saran investasi.

## Yang tersedia

- **Katalog dinamis:** backend mengambil semua instrumen SWAP aktif yang diselesaikan dalam USDT dan bertipe linear dari endpoint publik OKX. Tidak ada daftar BTC/ETH/SOL yang dikunci di frontend. Pencarian menyaring katalog, kontrak yang nilainya berbeda ditampilkan dengan ukuran/minimum/lot/tick masing-masing, dan katalog diperbarui berkala. Kontrak inverse dan instrumen yang tidak aktif tidak ikut ditampilkan.
- **Pasar Swap:** ticker, candle 15m/1H/4H/1D, order book, transaksi, funding rate, dan open interest diambil melalui proxy Worker same-origin. Kuantitas order book/tape dan order memakai satuan kontrak.
- **Chart TradingView:** candlestick interaktif memakai Lightweight Charts 5.2.0 yang dibundel lokal, bukan feed chart TradingView. Data candle tetap berasal dari OKX; chart mendukung zoom/geser, crosshair OHLC, penanda BUY/SELL, dan garis estimasi entry/SL/TP. Library mengikuti Apache-2.0 serta atribusi TradingView di UI dan berkas NOTICE.
- **Analisis teknikal:** RSI(14) dan ATR(14) memakai smoothing Wilder pada candle tertutup; skor teknikal dinormalisasi dari RSI lalu dikombinasikan dengan input sentimen manual. Bobot TA awal 70%, ambang sinyal ±0,65. BUY/SELL/WAIT adalah aturan indikator eksperimental, bukan kepastian atau prediksi hasil.
- **Konteks fundamental kontrak:** panel terpisah menunjukkan funding prediksi/settlement dan open interest dengan timestamp dari OKX Public API. Funding positif berarti long membayar short sesuai dokumentasi OKX. Metrik ini menggambarkan posisi/pembiayaan derivatif, bukan valuasi fundamental token; market cap dan supply belum tersedia (unknown) dan tidak ikut menentukan skor. Jika endpoint gagal atau field kosong, UI menunjukkan —, bukan estimasi.
- **Sizing risiko:** ukuran kontrak dibulatkan turun ke lot step OKX dan memperhatikan `ctVal`, minimum order, target risiko paper, jarak stop 1,5× ATR, serta batas collateral × leverage simulasi. Target take-profit paper 2,5× ATR. UI menampilkan kontrak, estimasi risiko, notional, dan margin. Leverage ini hanya untuk simulasi lokal; tidak mengubah pengaturan akun OKX.
- **Paper long/short:** tombol simulasi membuka posisi sesuai sinyal BUY/SELL atau menutup posisi paper yang berlawanan. Saldo dan riwayat hanya disimpan di browser/perangkat yang dipakai. Paper tidak memodelkan biaya, funding, likuidasi, slippage, atau protective order.
- **Tampilan:** antarmuka web dan mode PWA yang sama pada desktop/mobile, dengan chart TradingView yang disimpan lokal untuk penggunaan offline setelah shell dimuat, ikon koin eksternal dan fallback inisial bila ikon tidak tersedia. Preview menampilkan data pasar publik saja.
- **Koneksi akun privat (read-only):** jika dikonfigurasi pada Worker privat, backend dapat menguji API OKX dan menampilkan saldo USDT serta posisi Swap yang sudah ada. Jalur baca hanya memerlukan kredensial server dan token pemilik; tidak bergantung pada flag eksekusi. API key/secret/passphrase hanya dibaca Worker; frontend tidak menerima atau menyimpan kredensial itu.
- **Kode eksekusi manual/otomatis:** tersedia tetapi terkunci pada konfigurasi read-only. Quote/order manual, auto-start, dan alarm Durable Object tetap fail-closed kecuali flag eksekusi terkait diaktifkan secara eksplisit pada server. Tidak ada strategi atau bot yang dimulai oleh perubahan ini.

## Analisis dan unit kontrak

Dokumentasi resmi OKX menjelaskan instrumen perpetual melalui [Get instruments](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-instruments), termasuk `ctVal`, `ctValCcy`, `minSz`, `lotSz`, dan `tickSz`. Pada kontrak linear, notional bergantung pada jumlah kontrak × nilai kontrak × harga; harga pada preview order adalah estimasi berdasarkan harga limit.

Rumus sizing paper yang digunakan:

```text
risiko target = ekuitas paper × persentase risiko
jarak stop = ATR(14) × 1,5
kontrak = floor ke lot step(min(risiko target / (jarak stop × ctVal), collateral × leverage / (harga × ctVal)))
notional estimasi = kontrak × ctVal × harga
margin estimasi = notional / leverage simulasi
```

Sizing yang ditampilkan bukan jumlah yang dijamin dapat dibuka pada akun: exchange dapat menerapkan tier risiko, margin, fee, funding, posisi lain, dan aturan akun. Paper stop/target juga tidak memasang order SL/TP di OKX.

## Trading dan keamanan

**Status saat ini:** Worker Orbital sudah dideploy ke akun Cloudflare baru di [orbital-okx-terminal.erlanggarangga564.workers.dev](https://orbital-okx-terminal.erlanggarangga564.workers.dev). Halaman aplikasi dan proxy data pasar publik dapat diakses dari internet. Koneksi akun privat **belum dikonfigurasi**: tidak ada token admin atau kredensial API OKX pada Worker, sehingga saldo/posisi akun tidak dapat dibaca. Tidak ada API key di frontend, repo, atau browser storage; jangan memasukkan token atau kredensial pada URL publik.

Worker dideploy dengan mode **demo** dan `ORBITAL_TRADING_ENABLED=false`, `ORBITAL_AUTO_TRADING_ENABLED=false`. Mode demo saja tidak mengizinkan eksekusi: jalur order memerlukan flag trading yang aktif, Durable Object guard, dan challenge; auto-trading memerlukan tambahan flag serta acknowledgement eksplisit. Semua sakelar eksekusi tetap mati. Dokumentasi protokol: [OKX API v5 — Place order](https://www.okx.com/docs-v5/en/#rest-api-trade-post-place-order), [autentikasi REST](https://www.okx.com/docs-v5/en/#rest-authentication), dan [Get balance](https://www.okx.com/docs-v5/en/#rest-api-account-get-balance).

### Konfigurasi yang dimaksudkan untuk deployment read-only

Koneksi baca akun baru dapat diaktifkan setelah pemilik menyiapkan token admin dan kredensial OKX Demo sebagai **Worker secrets**. Sampai itu dilakukan, posture deployment read-only mempertahankan:

   ```text
   ORBITAL_TRADING_MODE=demo
   ORBITAL_TRADING_ENABLED=false
   ORBITAL_AUTO_TRADING_ENABLED=false
   ```

Untuk endpoint baca, Worker memerlukan `ORBITAL_ADMIN_TOKEN` minimal 32 karakter dan kredensial OKX server-side; jangan masukkan API secret di browser, file `.env` yang di-commit, repo, log, atau chat. Jika nanti pemilik membuat API key, gunakan **Demo Trading** dengan izin **Read + Trade**, tanpa **Withdraw**, dan pembatasan IP bila tersedia. Status aman akan memisahkan `accountReadAvailable` dari `tradingAvailable:false` dan `autoTradingAvailable:false`. Jangan mengaktifkan flag eksekusi, acknowledgement, strategi, parameter risiko, atau bot tanpa otorisasi baru yang eksplisit. Saat ini tidak ada koneksi akun maupun langkah aktivasi order.

Mode live dan `ORBITAL_LIVE_ACK=I_ACCEPT_REAL_TRADING_RISK` tidak termasuk cakupan konfigurasi ini dan tidak boleh diaktifkan.

### Batasan dan proteksi auto-trade

- Satu bot global per deployment dan satu pair yang dipilih; hanya crossing RSI pada candle 1H tertutup. Paper portfolio tetap independen.
- Satu posisi/order yang sudah ada pada pair itu menyebabkan bot menunggu; bot tidak membalik, menambah, atau mengelola posisi manual. SL/TP hanya dilampirkan pada order entry otomatis.
- Auto size memakai isolated mode, saldo tersedia, ATR, lot step/minimum, max notional server, dan limit eksposur konservatif. Leverage akun tidak dibaca sebagai target dan tidak pernah diubah.
- Stop menunggu permintaan bursa yang sedang berlangsung; hasil yang tidak pasti menghentikan bot. Periksa riwayat/order OKX sebelum memulai lagi.
- Tidak ada order bursa nyata atau demo yang dikirim oleh pengujian; semua jalur order diuji dengan `fetch` tiruan.

## Menjalankan lokal dan tes

Gunakan Wrangler agar Worker proxy dan PWA tersedia bersama:

```bash
npx --yes wrangler@4.102.0 dev worker/index.js --local --compatibility-date 2026-11-06 --assets public
```

Untuk tes UI, jalankan server statis di terminal terpisah, lalu tes memakai fixture sintetis:

```bash
python3 -m http.server 5173 --directory public
python3 tests/ui-smoke.py
```

Tes lainnya:

```bash
node --input-type=module --check < public/app.js
node --input-type=module --check < worker/index.js
node tests/worker-smoke.mjs
node tests/app-logic.mjs
node tests/market-client.mjs
node tests/pwa-cache.mjs
```

Tes gateway memakai kredensial palsu dan `fetch` tiruan; tidak menghubungi akun OKX dan tidak mengirim order. Tes UI memakai Chromium lokal dan tidak menghubungi API bursa.

## Preview

Preview sementara yang lama tetap tersedia di https://orbital-okx-preview.tiny-scilla.workers.dev dan hanya memakai data pasar publik/paper. Deployment akun baru ada di URL Workers di atas; Durable Objects terikat pada Worker itu, tetapi belum menyimpan state atau rahasia koneksi akun. Tidak ada API key Demo dibuat atau rahasia OKX diunggah. PWA dan paper portfolio lama pada origin lain tidak berpindah otomatis.
