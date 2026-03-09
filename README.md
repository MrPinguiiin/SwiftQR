# QRIS Dinamis Gateway

Frontend + backend pembayaran QRIS dinamis dengan tampilan modern, input nominal fleksibel, upload gambar QRIS statis, polling status pembayaran, dan webhook notifier.

Proyek ini menggunakan **SwiftQR** sebagai acuan/generator QRIS dinamis:

- Repo: `https://github.com/MrPinguiiin/SwiftQR`

## Fitur Utama

- Nominal dinamis langsung dari form (tidak wajib pakai query param)
- Upload gambar QRIS statis, payload dibaca otomatis di browser
- Validasi payload EMV + CRC sebelum dipakai
- Generate QRIS dinamis berdasarkan nominal
- Polling status pembayaran dari backend
- Webhook endpoint untuk update status transaksi
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
6. Backend menyimpan transaksi ke PostgreSQL
7. Frontend menampilkan QR dan polling status (`PENDING`, `PAID`, `EXPIRED`, `FAILED`)
8. Webhook provider mengubah status transaksi secara real-time

## Menjalankan Secara Lokal (Bun)

Prasyarat:

- Bun terpasang (versi terbaru disarankan)
- PostgreSQL aktif

Jalankan:

```bash
bun install
cp .env.example .env
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

## Endpoint Backend

- `POST /api/payments/create` membuat transaksi + generate QR dinamis
- `GET /api/payments/:transactionId/status` cek status transaksi
- `POST /api/webhooks/payment` menerima callback webhook dari provider
- `POST /api/gobiz/journals/search` hit manual journals search Gobiz (proxy aman di backend)
- `POST /api/gobiz/journals/match` cari 1 data transaksi yang match nominal + rentang waktu
- `GET /api/health` health check

Saat match ditemukan, UI akan menampilkan kartu "Pembayaran Terdeteksi" lalu otomatis mereset nominal dan QR dinamis untuk transaksi berikutnya (payload QRIS statis tetap tersimpan).

Contoh payload webhook:

```json
{
  "eventId": "evt_001",
  "eventType": "payment.update",
  "transactionId": "uuid-payment",
  "providerTxId": "provider-123",
  "status": "PAID"
}
```

Jika `SWIFTQR_WEBHOOK_SECRET` diisi, kirim header `x-swiftqr-signature` (HMAC SHA256 body raw).

## Manual Hit Gobiz Journals

Isi konfigurasi ini di `.env`:

- `GOBIZ_BEARER_TOKEN`
- `GOBIZ_AUTHENTICATION_TYPE`
- `GOBIZ_BASE_URL`

Contoh request ke backend:

```bash
curl -X POST http://localhost:8000/api/gobiz/journals/search \
  -H 'Content-Type: application/json' \
  -d '{
    "merchantId": "G947637517",
    "from": 0,
    "size": 20,
    "fromTimeISO": "2026-03-08T17:00:00.000Z",
    "toTimeISO": "2026-03-09T16:59:59.999Z",
    "settlementOnly": true,
    "qrisOnly": true
  }'
```

Response endpoint ini mengembalikan:

- `summary`: ringkasan hasil (count, paidCount, totalAmount, latestTransactionTime)
- `normalized`: data yang sudah diringkas untuk dipakai aplikasi
- `raw`: payload asli Gobiz (hanya jika `includeRaw: true`)

Contoh cari 1 match berdasarkan nominal + waktu:

```bash
curl -X POST http://localhost:8000/api/gobiz/journals/match \
  -H 'Content-Type: application/json' \
  -d '{
    "amount": 200,
    "fromTimeISO": "2026-03-09T05:30:00.000Z",
    "toTimeISO": "2026-03-09T05:45:00.000Z"
  }'
```

Jika cocok, frontend otomatis menampilkan kartu "Pembayaran Terdeteksi" di bawah QR.

## Konfigurasi SwiftQR Upstream

Pengaturan ada di `.env`:

- `SWIFTQR_BASE_URL`
- `SWIFTQR_CREATE_PATH`
- `SWIFTQR_API_KEY` (opsional)

Backend akan memanggil upstream tersebut saat endpoint create payment dipanggil.

## Struktur File

```text
├── index.html       # Halaman utama pembayaran
├── style.css        # Styling dan tema
├── script.js        # Logic frontend + polling status
├── 404.html         # Halaman fallback
├── server/index.ts  # API server, webhook, database layer
├── .env.example     # Contoh konfigurasi environment
├── package.json     # Script run dengan Bun
└── image/           # Asset gambar
```

## Teknologi

- HTML5, CSS3, JavaScript
- Bun + Hono
- PostgreSQL (`pg`)
- Bootstrap 5
- Font Awesome 6
- QRCode.js
- jsQR
- Zod

## Catatan

- Pastikan gambar QRIS yang diupload jelas (tidak blur/terpotong)
- Untuk production, sangat disarankan memakai endpoint SwiftQR milik sendiri
- Jangan menyimpan data sensitif di sisi frontend
