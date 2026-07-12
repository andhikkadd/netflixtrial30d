# 🎬 Netflix Cookie Login Auto-Automation

Program sederhana menggunakan **Node.js** dan **Playwright** untuk login otomatis ke Netflix tanpa perlu memasukkan email dan password, melainkan menggunakan cookies aktif (misalnya `NetflixId` dan `SecureNetflixId`).

---

## 🛠️ Persyaratan Sistem
1. **Node.js** terinstall (versi 16 atau lebih baru).
2. Browser **Google Chrome** terinstall secara normal di komputer Anda (program ini dikonfigurasi untuk langsung menggunakan Chrome bawaan Windows Anda agar hemat kuota download).

---

## 🚀 Cara Penggunaan

### Langkah 1: Persiapan Program
1. Buka folder ini di Terminal atau VS Code Anda.
2. Install dependensi (Playwright) dengan menjalankan perintah berikut di terminal:
   ```bash
   npm install
   ```

---

### Langkah 2: Mengambil Cookies Netflix Anda
Untuk login menggunakan cookies, Anda perlu mengekspor cookies dari browser Anda saat Anda sedang login di Netflix.

1. Buka browser Anda (Google Chrome / Edge / Firefox).
2. Install ekstensi browser bernama **Cookie-Editor** atau **EditThisCookie**:
   - [Cookie-Editor untuk Chrome](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhceonfjbgcoackieibmjco)
3. Buka situs [Netflix](https://www.netflix.com) dan pastikan Anda sudah **login** ke akun Anda.
4. Klik ikon ekstensi **Cookie-Editor** di pojok kanan atas browser Anda.
5. Klik tombol **Export** di bagian bawah menu ekstensi tersebut, lalu pilih opsi **JSON**.
   *Ini akan menyalin (copy) seluruh cookies Netflix Anda ke clipboard.*

---

### Langkah 3: Menyiapkan File `cookies.json`
1. Di dalam folder project ini, buat file baru bernama **`cookies.json`** (atau salin dari `cookies.json.example`).
2. Paste (tempel) isi clipboard yang Anda copy dari Langkah 2 ke dalam file `cookies.json` tersebut.
3. Simpan file tersebut.

---

### Langkah 4: Menjalankan Program
1. Jalankan perintah berikut di terminal Anda:
   ```bash
   npm start
   ```
2. Browser Google Chrome baru akan terbuka secara otomatis dan langsung menavigasi ke Netflix dalam keadaan sudah login!

---

## 📝 Catatan Penting
* **Validitas Cookies**: Jika cookies Anda sudah expired (misalnya karena Anda log out dari perangkat asli Anda atau session telah berakhir), program ini tidak akan otomatis login. Anda harus mengambil cookies yang baru lagi.
* **Keamanan**: Jangan pernah membagikan isi file `cookies.json` Anda kepada orang lain, karena siapa pun yang memiliki file tersebut dapat mengakses akun Netflix Anda tanpa mengetahui email atau password Anda.

---

## 🤖 Mode Bot Telegram (Sistem Kredit & Voucher)

Anda juga bisa menjalankan program ini sebagai **Bot Telegram otomatis**. Bot ini menggunakan browser secara senyap (*headless* di background server/VPS Anda), memproses email, memantau inbox T-Mail secara otomatis, dan mengirimkan link pendaftaran langsung ke chat Telegram pengguna setelah memotong kredit mereka.

### ⚙️ Konfigurasi Bot
1. Buka file `config.json` di folder project ini.
2. Edit konfigurasinya:
   - `botToken`: Masukkan token bot Anda yang didapatkan dari `@BotFather` di Telegram.
   - `adminId`: Masukkan ID angka Telegram Anda (misal `123456789`). Anda bisa melihat ID Anda saat mengirim chat pertama kali ke bot (ID Anda akan ter-log di console terminal).
   - `defaultTmailHost`: Host default API T-Mail teman Anda (opsional, contoh: `https://gaugai.my.id`).
3. Simpan file `config.json`.

### 🚀 Menjalankan Bot
Jalankan perintah berikut di terminal:
```bash
npm run bot
```

### 🎮 Perintah Bot (Commands)
* **Untuk Pengguna**:
  - `/start` atau `/help` - Melihat menu bantuan dan saldo kredit saat ini.
  - `/redeem <KODE_VOUCHER>` - Menukarkan kode voucher untuk menambah kredit.
  - `/trial <email>` - Menjalankan pendaftaran Netflix otomatis (Biaya: 1 Kredit). Link pendaftaran akan langsung dikirim di Telegram setelah proses selesai.
* **Untuk Admin (Hanya Anda)**:
  - `/genvoucher <jumlah_kredit> <jumlah_voucher>` - Membuat kode voucher baru untuk dijual ke pembeli (contoh: `/genvoucher 5 3` untuk membuat 3 kode voucher senilai masing-masing 5 kredit).
  - `/addcredits <telegram_user_id> <jumlah_kredit>` - Menambah kredit user secara langsung secara manual.
  - `/listvouchers` - Menampilkan daftar voucher aktif yang belum terpakai.

