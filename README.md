# QRIS Dinamis Gateway

Frontend pembayaran QRIS dinamis dengan tampilan modern, input nominal fleksibel, dan dukungan upload gambar QRIS statis untuk ekstraksi payload otomatis.

Proyek ini menggunakan **SwiftQR** sebagai acuan/generator QRIS dinamis:

- Repo: `https://github.com/MrPinguiiin/SwiftQR`

## Fitur Utama

- Nominal dinamis langsung dari form (tidak wajib pakai query param)
- Upload gambar QRIS statis, payload dibaca otomatis di browser
- Validasi payload EMV + CRC sebelum dipakai
- Generate QRIS dinamis berdasarkan nominal
- Countdown 15 menit untuk masa berlaku pembayaran
- Download, copy, dan share QR
- Dark mode / light mode
- Layout responsif untuk mobile dan desktop

## Cara Kerja Singkat

1. User upload gambar QRIS statis merchant
2. Aplikasi mengekstrak payload QR dengan `jsQR`
3. Payload diverifikasi (format + CRC)
4. Nominal dimasukkan user
5. Payload + nominal dikirim ke service generator QRIS dinamis (SwiftQR-based)
6. QR dinamis ditampilkan untuk pembayaran

## Menjalankan Secara Lokal (Bun)

Prasyarat:

- Bun terpasang (versi terbaru disarankan)

Jalankan:

```bash
bun install
bun run dev
```

Buka di browser:

`http://localhost:8000`

## Cara Pakai

1. Buka halaman aplikasi
2. Isi nominal pembayaran (contoh: `10000`)
3. Upload gambar QRIS statis pada bagian **Upload QRIS Statis**
4. Klik **Baca dari Gambar**
5. Jika payload valid, QRIS dinamis akan tergenerate otomatis

Opsional lewat URL:

- Nominal: `?pay=10000`
- Payload langsung: `?qris=PAYLOAD_QRIS_STATIS`

Contoh:

`https://domainkamu.com/?pay=10000`

## Konfigurasi Endpoint Generator

Endpoint request generator ada di fungsi `qris()` pada file `script.js`.

Jika kamu ingin memakai instance SwiftQR milik sendiri, ganti URL fetch di fungsi tersebut sesuai endpoint API kamu.

## Struktur File

```text
├── index.html       # Halaman utama pembayaran
├── style.css        # Styling dan tema
├── script.js        # Logic nominal, upload QR, validasi, generate QRIS
├── 404.html         # Halaman fallback
├── package.json     # Script run dengan Bun
└── image/           # Asset gambar
```

## Teknologi

- HTML5, CSS3, JavaScript
- Bootstrap 5
- Font Awesome 6
- QRCode.js
- jsQR
- Bun (dev server)

## Catatan

- Pastikan gambar QRIS yang diupload jelas (tidak blur/terpotong)
- Untuk production, sangat disarankan memakai endpoint SwiftQR milik sendiri
- Jangan menyimpan data sensitif di sisi frontend
