# Orbital Quant Terminal

PWA dashboard kripto berbahasa Indonesia untuk membaca data pasar publik OKX, menggabungkan sinyal teknikal dan sentimen fundamental manual, menghitung ukuran posisi berbasis risiko, dan menguji alur lewat paper trading lokal.

## Jalankan lokal

Buka folder `public/` dengan server statis, misalnya:

```bash
cd public
python3 -m http.server 8080
```

Lalu kunjungi `http://localhost:8080`. Instalasi PWA membutuhkan HTTPS atau localhost.

## Fitur saat ini

- Data ticker dan OHLC candlestick spot dari endpoint publik OKX; tidak memerlukan akun maupun API key.
- RSI(14), ATR(14), skor TA yang dinormalisasi dengan rumus `(50 - RSI) / 50`, dan input manual sentimen FA pada rentang -1 hingga +1.
- Skor komposit `Wta × Sta + Wfa × Sfa`, bobot awal 70% TA dan 30% FA, ambang BUY di atas +0.65 dan SELL di bawah -0.65.
- Sizing risiko fraksional: saldo paper × risiko per trade ÷ jarak stop 1.5× ATR, dibatasi agar notional spot tidak melebihi kas paper. Target paper ditampilkan pada 2.5× ATR.
- Simulasi long-only dan riwayat lokal melalui `localStorage`; tidak ada order yang dikirim ke bursa.
- PWA dengan shell antarmuka yang dapat dibuka offline setelah pemuatan awal.

## Batas keamanan penting

Versi publik hanya frontend statis dan **tidak menerima atau menyimpan API key**. Fitur order nyata sengaja tidak disediakan di preview ini. Jangan memasukkan kredensial bursa di halaman publik. Integrasi live baru layak ditambahkan setelah ada backend privat terautentikasi dengan penyimpanan kunci terenkripsi, pembatasan IP/izin API, validasi risiko di sisi server, audit log, dan konfirmasi eksplisit per aktivasi/order. Tidak ada transaksi nyata yang dijalankan selama pengembangan.

Data pasar dan hitungan indikator adalah alat eksperimen, bukan saran investasi. Paper trading bukan bukti bahwa strategi akan menguntungkan di pasar nyata.
