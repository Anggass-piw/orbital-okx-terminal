# Orbital Quant Terminal

PWA berbahasa Indonesia untuk melihat pasar spot OKX, menghitung indikator teknikal dan skor sentimen manual, mencoba strategi dengan paper portfolio lokal, serta menyediakan kerangka gateway order privat yang **mati secara default**.

## Fitur

- Proxy same-origin di Cloudflare Worker mengambil ticker dan candlestick OKX untuk BTC-USDT, ETH-USDT, dan SOL-USDT. Browser tidak perlu memanggil domain OKX langsung. Backend memakai domain REST resmi yang direkomendasikan OKX, `openapi.okx.com` ([pengumuman OKX](https://www.okx.com/docs-v5/log_en/#2026-05-20)).
- Grafik candlestick dengan pilihan 15 menit, 1 jam, 4 jam, dan 1 hari; indikator RSI(14) dan ATR(14) memakai smoothing Wilder.
- Skor teknikal `(50 - RSI) / 50`, ditambah skor sentimen fundamental yang dimasukkan manual, dengan bobot awal 70% TA dan ambang BUY/SELL ±0.65. Ini bukan model prediksi otomatis atau saran investasi.
- Sizing paper berdasarkan risiko 0.25–2% dari ekuitas dan stop 1.5× ATR; simulasi long-only tersimpan hanya di browser setempat. Tidak ada transaksi bursa dari paper trading.
- PWA dapat dipasang. Shell halaman bisa dibuka offline setelah dimuat, tetapi service worker tidak menyimpan respons API. Proxy edge hanya menahan data publik sebentar (ticker 30 detik, candles 60 detik) untuk mengurangi rate limit; jam update di layar memakai timestamp sumber OKX. Data akun dan order tidak di-cache.
- Gateway order spot **limit saja** untuk tiga aset yang diizinkan. Jika backend dikonfigurasi secara terpisah, halaman meminta token backend sementara, membuat preview bertanda tangan yang berlaku 90 detik, memvalidasi min-size/lot-step/price-tick dari OKX, lalu menunggu pengguna mengetik `KIRIM ORDER LIVE` dan menekan tombol kirim. Durable Object SQLite menandai permintaan sekali-pakai dan menolak pengulangan; status hasil disimpan agar respons yang hilang tidak mengirim order kedua. Tidak ada auto-trading.

## Jalankan lokal

Gunakan Wrangler agar proxy Worker dan aset PWA berjalan bersama. Folder `public/` hanya berisi aset yang dimuat halaman; source Worker ada di `worker/`:

```bash
npx --yes wrangler@4.102.0 dev worker/index.js --local --compatibility-date 2026-06-24 --assets public
```

Buka URL localhost yang ditampilkan Wrangler. Alternatif server statis biasa dapat menampilkan antarmuka, tetapi `/api/*` memerlukan Worker dan data OKX tidak akan tersedia tanpa proxy.
Tanggal lokal di atas adalah batas runtime `workerd` yang tersedia pada alat pengujian ini. Cloudflare menolak tanggal `2026-11-07` sebagai masa depan karena deploy berlangsung pada `2026-11-06` UTC; preview memakai `2026-11-06` sebagai tanggal kompatibilitas terdekat yang diterima.

Jalankan pemeriksaan dasar tanpa mengubah konfigurasi akun:

```bash
node --input-type=module --check < public/app.js
node --input-type=module --check < worker/index.js
node tests/worker-smoke.mjs
node tests/app-logic.mjs
```

Tes gateway menggunakan kredensial palsu dan `fetch` tiruan untuk memeriksa signing, validasi, serta replay. Tes ini tidak mengirim order ke OKX dan bukan pengganti uji pada akun demo sungguhan.

## Deployment preview

Preview sementara terbaru: https://orbital-okx-terminal.dune-grandiflora.workers.dev

Folder `public/` adalah satu-satunya folder aset yang perlu dideploy; jangan deploy root repo. Preview statis menggunakan perintah berikut di lingkungan tanpa kredensial Cloudflare:

```bash
npx --yes wrangler@4.102.0 deploy worker/index.js --temporary --name orbital-okx-terminal --compatibility-date 2026-11-06 --assets public
```

URL preview bersifat publik: siapa pun yang memiliki tautan dapat membuka aplikasi. Deployment preview ini tidak memiliki konfigurasi live-trading. `GET /api/status` harus melaporkan `tradingAvailable: false`; indikator itu memastikan halaman tidak menampilkan form order yang aktif.

Tombol **Pasang aplikasi** membuka prompt native bila browser menyediakannya, atau panduan pemasangan. Di Android gunakan menu Chrome → Instal aplikasi / Tambahkan ke layar utama; di iOS buka halaman di Safari → Bagikan → Tambahkan ke Layar Utama. Pemasangan tidak mengaktifkan trading dan data paper tetap per perangkat.

Jika OKX membalas rate limit `50011`, proxy mencoba satu endpoint publik resmi alternatif: `history-candles` untuk riwayat dan `tickers?instType=SPOT` yang difilter kembali ke instrumen yang diminta. Jika keduanya gagal, aplikasi menampilkan data tidak tersedia dan mematikan paper execution; tidak ada harga palsu atau fallback ke bursa lain.

## Mengaktifkan gateway pada deployment privat yang dikelola pemilik

Jangan mengaktifkan trading pada URL preview publik. Untuk deployment privat terpisah, siapkan Cloudflare Access atau pembatasan akses yang sesuai, simpan seluruh nilai berikut sebagai **Worker secrets** (bukan di repo, HTML, JavaScript, atau `localStorage`), dan gunakan API key OKX khusus trading dengan izin penarikan dimatikan serta IP allowlist bila tersedia:

- `ORBITAL_TRADING_ENABLED=true` sebagai variable Worker.
- `ORBITAL_TRADING_MODE=demo` untuk lingkungan demo (default aman). Semua permintaan order demo diberi header simulated trading OKX.
- Binding Durable Object `ORBITAL_ORDER_GUARD` disediakan oleh `wrangler.jsonc`; jangan menghapus binding/migrasi SQLite karena endpoint order memerlukan proteksi idempotensi.
- `ORBITAL_ADMIN_TOKEN`: token acak minimal 32 karakter; token ini diminta oleh form aplikasi dan hanya berada di memori halaman selama digunakan.
- `ORBITAL_CHALLENGE_SECRET`: secret acak terpisah minimal 32 karakter untuk menandatangani preview order.
- `OKX_API_KEY`, `OKX_API_SECRET`, dan `OKX_API_PASSPHRASE`: kredensial disimpan hanya sebagai Worker secrets.
- `ORBITAL_MAX_NOTIONAL_USDT`: batas order opsional; default 25 USDT dan nilai apa pun dibatasi keras maksimum 100 USDT per order.

Mode demo harus dites dahulu dengan akun demo OKX. Mengubah `ORBITAL_TRADING_MODE` ke `live` memerlukan secret tambahan `ORBITAL_LIVE_ACK=I_ACCEPT_REAL_TRADING_RISK`. Ini sengaja menjadi langkah terpisah dan tidak boleh dilakukan pada preview publik. Walau mode live aktif, backend membatasi order ke spot limit, tiga instrumen tersebut, maksimum notional, dan selisih harga maksimal 10% dari harga pasar. Order hanya terkirim setelah pengguna meminta preview, memeriksa detail, memasukkan frasa konfirmasi, dan menekan tombol konfirmasi.

Langkah konfigurasi ini belum dijalankan pada URL preview. Tidak ada API key OKX yang tersedia/tersimpan di aplikasi, tidak ada order nyata yang dikirim, dan tidak ada klaim bahwa trading live siap digunakan. Jangan menganggap batasan ini sebagai jaminan keuntungan atau pengganti pemeriksaan transaksi di OKX.

## Keamanan dan batasan

- Backend order hanya diaktifkan jika flag aktivasi, token owner, challenge secret, dan tiga kredensial OKX tersedia. Mode live membutuhkan secret persetujuan tambahan.
- Aplikasi publik tidak dapat mengenali identitas pemilik hanya dari tautan; karena itu jangan mengaktifkan Worker berisi kredensial trading di deployment publik tanpa kontrol akses tambahan. Rahasia token aplikasi bukan pengganti Cloudflare Access, pembatasan jaringan, atau keamanan perangkat.
- Endpoint proxy membatasi metode, instrumen, dan interval yang diterima; endpoint order tidak menawarkan withdrawal, transfer, derivatif, leverage, market order, atau strategi otomatis.
- Level SL/TP dan kontrol risiko pada dashboard adalah estimasi paper, bukan protective order aktif. Gateway live mengirim order limit manual tanpa SL/TP otomatis; pemilik tetap harus memantau dan mengelola order langsung di OKX.
- Paper trading dan riwayat disimpan lokal pada browser/perangkat ini. Menghapus data situs dapat menghapusnya.
- Harga, indikator, sinyal, sizing, dan simulasi adalah untuk eksperimen. Hasil simulasi tidak membuktikan strategi akan menguntungkan.
