# Orbital OKX Perpetual Terminal

**Aplikasi live saat ini:** [Buka Orbital OKX Terminal](https://orbital-okx-terminal.erlanggarangga564.workers.dev). Revisi fitur di branch review lokal belum dideploy; deployment publik tetap memakai versi sebelumnya. Order nyata dan auto-trading tetap nonaktif.

PWA berbahasa Indonesia untuk memantau **OKX USDT-settled linear perpetual swaps**, menganalisis RSI/ATR, faktor derivatif opsional, dan tren multi-timeframe, serta mencoba ukuran posisi dalam kontrak melalui paper trading lokal. Ini bukan aplikasi resmi OKX dan bukan saran investasi.

## SWAP: LONG dan SHORT, bukan spot saja

Terminal ini memakai kontrak perpetual SWAP USDT, bukan pembelian/penjualan aset spot. Saat belum ada posisi paper, sinyal **BUY berarti skenario LONG** (diuntungkan oleh kenaikan harga) dan **SELL berarti skenario SHORT** (diuntungkan oleh penurunan harga). Sinyal tidak menutup posisi otomatis: posisi paper yang sedang aktif bisa ditutup kapan saja lewat tombol khusus, termasuk saat sinyal WAIT. Hanya satu posisi paper dapat terbuka; pair dan timeframe chart tetap bisa diganti selama posisi berjalan.

| Arah | Stop-loss referensi | Take-profit referensi |
| --- | --- | --- |
| LONG | Entry − 1,5 × ATR, di bawah entry | Entry + 2,5 × ATR, di atas entry |
| SHORT | Entry + 1,5 × ATR, di atas entry | Entry − 2,5 × ATR, di bawah entry |

UI menampilkan dua skenario LONG/SHORT dari harga saat ini agar arah TP/SL dapat dibandingkan, termasuk saat WAIT. Keduanya adalah referensi, **bukan dua sinyal entry sekaligus**. Chart menampilkan entry/SL/TP aktual saat pair posisi dibuka sedang dilihat; panel paper tetap menampilkan harga mark dan P&L posisi bila chart berpindah ke pair lain. Contoh entry 100 dan ATR 10: LONG SL 85 / TP 125; SHORT SL 115 / TP 75.

Untuk posisi paper baru, SL/TP dipantau dari ticker pair posisi setiap 15 detik saat tab aktif; posisi ditutup dengan fill simulasi ketika harga mencapai/melewati level. Tombol **Tutup posisi paper** juga selalu tersedia dan mengambil harga terbaru sebelum mencatat fill simulasi. Pemantauan berhenti saat tab tertutup/offline, gap dapat memperburuk fill, dan tidak ada protective order di OKX. Posisi lama yang tersimpan tidak mendapat auto-exit retroaktif, tetapi tetap bisa ditutup manual. Mode order nyata dan auto-trading tetap nonaktif; perubahan ini tidak mengirim order exchange atau mengubah konfigurasi akun.

## Yang tersedia

- **Katalog dinamis:** backend mengambil semua instrumen SWAP aktif yang diselesaikan dalam USDT dan bertipe linear dari endpoint publik OKX. Tidak ada daftar BTC/ETH/SOL yang dikunci di frontend. Pencarian menyaring katalog, kontrak yang nilainya berbeda ditampilkan dengan ukuran/minimum/lot/tick masing-masing, dan katalog diperbarui berkala. Kontrak inverse dan instrumen yang tidak aktif tidak ikut ditampilkan.
- **Pasar Swap:** ticker, candle 15m/1H/4H/1D, order book, transaksi, funding rate, dan open interest diambil melalui proxy Worker same-origin. Kuantitas order book/tape dan order memakai satuan kontrak.
- **Chart TradingView:** candlestick interaktif memakai Lightweight Charts 5.2.0 yang dibundel lokal, bukan feed chart TradingView. Data candle tetap berasal dari OKX; chart mendukung zoom/geser, crosshair OHLC, penanda BUY/SELL, dan garis estimasi entry/SL/TP. Pair dan timeframe dapat diganti saat posisi paper terbuka; saat pair posisi ditampilkan, garis menunjukkan entry/SL/TP aktual. Library mengikuti Apache-2.0 serta atribusi TradingView di UI dan berkas NOTICE.
- **Analisis teknikal dan alasan sinyal:** RSI(14) dan ATR(14) memakai smoothing Wilder pada candle tertutup. Kartu sinyal menjelaskan skor, RSI, timeframe, serta alasan filter menahan arah. Filter timeframe aktif opsional meminta EMA20 + MACD searah dan volume candle tertutup minimal 1,2× rata-rata 20 candle; tanpa data cukup, sinyal ditahan. EMA, MACD, Bollinger, dan volume juga tersedia sebagai overlay chart. Filter default mati. BUY/SELL/WAIT adalah aturan eksperimental, bukan prediksi atau kepastian hasil.
- **Konteks derivatif (terpisah):** panel menampilkan funding prediksi/settlement dan open interest beserta timestamp OKX. Funding positif berarti long membayar short menurut dokumentasi OKX. Faktor funding kontrarian dan perubahan OI+harga dapat diberi bobot opsional (default 0%); funding/OI stale atau tidak tersedia dikeluarkan dari skor. OI perlu dua sampel segar pair yang sama. Ini bukan valuasi token; market cap/supply tetap tidak tersedia.
- **Konfirmasi 4H opsional:** bila diaktifkan, arah harus sejalan dengan harga vs EMA20 dan histogram MACD 4H. Data 4H tidak cukup/stale atau konflik menahan sinyal (fail closed). Default mati agar perilaku skor sebelumnya tetap dipertahankan.
- **Sizing risiko:** kontrak dibulatkan turun ke lot step OKX, memperhatikan `ctVal`, minimum order, target risiko paper, jarak stop 1,5× ATR, collateral/leverage simulasi, dan reserve fee taker asumsi. Nilai risiko nominal yang ditampilkan adalah gross sebelum fee, slippage, dan funding; hasil paper bersih dapat berbeda. TP referensi 2,5× ATR. Leverage hanya lokal dan tidak mengubah akun OKX.
- **Paper long/short:** satu posisi aktif dengan tombol tutup manual; sinyal berlawanan tidak menutupnya. P&L, funding, dan exit SL/TP mengikuti ticker pair posisi secara independen dari pair chart. Quote posisi diperbarui setiap 15 detik saat tab aktif; tombol tutup mengambil quote terbaru. Posisi baru mengasumsikan taker fee 0,05% tiap fill dan slippage 2 bps per fill; funding memakai rate posisi dan jadwal OKX, dengan asumsi fallback interval 8 jam (maksimum tiga interval terlewat per refresh). Ini estimasi, bukan fee-tier, rate historis atau settlement aktual. Maker, spread, partial fill, likuidasi, dan protective order tidak dimodelkan.
- **Backtest lokal:** sampai 100 candle tertutup pada timeframe terpilih, sinyal RSI+sentimen manual, entry di open candle berikutnya, stop diperiksa konservatif lebih dulu bila SL/TP tersentuh di candle yang sama. Menampilkan win rate, profit factor, max drawdown, dan compounded gross return; tidak memakai filter EMA/MACD-volume atau 4H, funding/OI, fee, slippage, atau spread. Bukan jaminan performa live.
- **Preferensi & portabilitas:** watchlist dan alert tersimpan lokal; alert hanya mengecek crossing saat tab aktif menerima ticker (bukan push/background). Overlay EMA/Bollinger/volume dan tema terang/gelap bersifat visual. CSV mengekspor histori; backup JSON mencakup portfolio dan perlu konfirmasi sebelum mengganti data lokal saat impor.
- **Tampilan dan loading:** data lewat REST polling (ticker chart sekitar 60 detik, microstructure dan ticker posisi aktif sekitar 15 detik), bukan WebSocket. Ada pesan gagal/retry, data terakhir tetap terlihat sebagai snapshot, skeleton saat pertama memuat, tabel riwayat dapat digeser horizontal, navigasi bawah mobile, dan PWA menunggu tombol “Perbarui aplikasi” sebelum takeover.
- **Koneksi akun privat (read-only):** bila Worker privat dikonfigurasi, backend dapat membaca saldo/posisi dengan token sementara di halaman; field token dihapus saat halaman ditutup dan tidak disimpan di localStorage. Pada deployment publik saat ini tanpa account backend, seluruh panel akun/eksekusi disembunyikan.
- **Keamanan:** revisi lokal menambahkan rate limit fixed-window Durable Object per hash SHA-256 IP: market 120/min, private account 60/min, quote 30/min, order 10/min, auto status 60/min, auto start/stop 10/min. Jika binding tidak tersedia, endpoint terproteksi menolak request. Token akses tidak pernah disimpan di localStorage. Quote/order manual, auto-start dan alarm tetap fail-closed; semua flag eksekusi terus mati.

## Analisis dan unit kontrak

Dokumentasi resmi OKX menjelaskan instrumen perpetual melalui [Get instruments](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-instruments), termasuk `ctVal`, `ctValCcy`, `minSz`, `lotSz`, dan `tickSz`. Pada kontrak linear, notional bergantung pada jumlah kontrak × nilai kontrak × harga; harga pada preview order adalah estimasi berdasarkan harga limit.

Rumus sizing paper yang digunakan:

```text
risiko target = ekuitas paper × persentase risiko
jarak stop = ATR(14) × 1,5
kontrak = floor ke lot step(min(risiko target / (jarak stop × ctVal), saldo / (harga × ctVal × (1/leverage + fee taker))))
notional estimasi = kontrak × ctVal × harga
margin estimasi = notional / leverage simulasi
fee entry/exit = harga fill × kontrak × ctVal × 0,05% (asumsi)
```

Sizing yang ditampilkan bukan jumlah yang dijamin dapat dibuka pada akun: exchange dapat menerapkan tier risiko, margin, fee, funding, posisi lain, dan aturan akun. Simulasi memakai taker fee tetap dan slippage 2 bps, bukan biaya akun aktual. Paper stop/target tidak memasang order SL/TP di OKX.

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

## Aplikasi live

Gunakan [deployment utama Orbital](https://orbital-okx-terminal.erlanggarangga564.workers.dev). Aplikasi menyajikan katalog dan data pasar publik OKX serta simulasi paper lokal. Koneksi akun privat belum dikonfigurasi, dan eksekusi order manual maupun otomatis tetap nonaktif. Data PWA dan paper portfolio tersimpan per perangkat/origin, sehingga tidak berpindah otomatis dari deployment lain.
