# Panduan Deployment - Web3 Analytics Dashboard

Dokumen ini berisi panduan lengkap untuk melakukan push repositori ke GitHub dan men-deploy aplikasi secara penuh (Frontend, Backend, dan Database).

---

## 1. Push ke GitHub

Repositori Git lokal Anda sudah diinisialisasi dan seluruh file awal telah di-commit ke branch `main`. Untuk mem-push kode Anda ke GitHub, ikuti langkah-langkah berikut:

1. Buka [GitHub](https://github.com/) dan buat repositori baru (misal dengan nama `web3-analytics-dashboard`).
   > [!IMPORTANT]  
   > Jangan mencentang opsi **"Initialize this repository with a README"**, **Add .gitignore**, atau **Choose a license**, karena file-file tersebut sudah ada di folder lokal Anda.
2. Salin URL repositori GitHub Anda (contoh: `https://github.com/username/web3-analytics-dashboard.git`).
3. Jalankan perintah berikut pada terminal PowerShell/Command Prompt di direktori root project Anda (`c:\dev\web3-analytics-dashboard`):
   ```bash
   # Tambahkan remote repository
   git remote add origin https://github.com/USERNAME/REPO-NAME.git

   # Push code ke branch main di GitHub
   git push -u origin main
   ```

---

## 2. Apakah Backend Harus Jalan Terus?

**Ya, Backend harus berjalan terus (24/7).**

Alasannya adalah:
1. **Blockchain Ingestor (`ingestor.js`)**: Backend bertindak sebagai pengambil data (ingestor) yang memantau event smart contract (seperti transfer token) dari blockchain (Sepolia/Local Node) secara real-time. Jika backend mati, data transfer baru di blockchain tidak akan tercatat ke database Anda.
2. **REST API**: Frontend (dashboard) membutuhkan REST API (`/api/stats`, `/api/transfers`, dll.) untuk menyajikan visualisasi data kapan pun diakses oleh pengguna.

Oleh karena itu, backend **tidak bisa** di-deploy di Vercel atau Netlify yang sifatnya *serverless/static hosting* (memiliki timeout eksekusi singkat). Backend harus di-deploy di platform cloud yang mendukung proses Node.js yang berjalan terus-menerus (*persistent process*).

---

### 3. Strategi Deployment (Direct-to-Supabase Serverless/Hybrid)

Untuk menghindari kendala kartu kredit pada platform server Node.js 24/7 (seperti Render atau Railway), aplikasi ini diprogram menggunakan arsitektur **Direct-to-Supabase (Serverless/Hybrid)** yang **100% gratis, aman, dan tanpa kartu kredit**:

1. **Database**: PostgreSQL di Cloud (Supabase) - 100% Gratis.
2. **Frontend**: Dashboard di Cloud (Netlify) - 100% Gratis.
3. **Ingestor & Traffic Generator**: Berjalan secara lokal di laptop Anda saat menyala. Data tersinkronisasi permanen di cloud (Supabase) sehingga dashboard Anda di Netlify ter-update secara *real-time*.

---

### Langkah A: Deploy Database Supabase
Database PostgreSQL Supabase Anda sudah terhubung.
1. Daftar di [Supabase](https://supabase.com/).
2. Buat proyek baru dan pilih database PostgreSQL.
3. Gunakan kredensial database Anda (Host, Port, Database Name, User, Password) untuk mengisi file `.env` lokal Anda.
4. **Penting**: Backend lokal akan otomatis membuatkan tabel-tabel (`token_transfers`, `user_activities`, `_meta`) secara otomatis saat dijalankan untuk pertama kali. Anda tidak perlu mengimpor SQL secara manual!

---

### Langkah B: Konfigurasi Frontend (Supabase Anon Key)
Sebelum men-deploy frontend ke Netlify, pastikan dashboard terhubung ke Supabase menggunakan **Public Anon Key** Anda.

1. Buka Supabase Dashboard -> **Project Settings (Ikon Gerigi)** -> **API**.
2. Salin key berlabel **`anon` `public`**.
3. Buka file [dashboard/app.js](file:///c:/dev/web3-analytics-dashboard/dashboard/app.js) dan isi nilai konfigurasi di bagian atas:
   ```javascript
   const SUPABASE_URL = 'https://gqlgcunzwpzanfkgjlkp.supabase.co';
   const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
   ```
4. Simpan, lakukan commit, dan push perubahan tersebut ke GitHub:
   ```bash
   git add dashboard/app.js
   git commit -m "feat: configure direct-to-supabase connection for production"
   git push origin main
   ```

---

### Langkah C: Deploy Frontend ke Netlify
Netlify 100% gratis dan tidak meminta kartu kredit untuk hosting web statis.

1. Masuk ke dashboard [Netlify](https://www.netlify.com/) dan login menggunakan **GitHub**.
2. Klik tombol **"Add new site"** -> pilih **"Import an existing project"**.
3. Pilih repositori GitHub Anda: `web3-analytics-dashboard`.
4. Konfigurasikan build setting:
   * **Base Directory**: `dashboard`
   * **Build Command**: *(kosongkan / biarkan kosong)*
   * **Publish Directory**: `.` (merujuk ke folder dashboard)
5. Klik **"Deploy site"** dan tunggu beberapa detik. Web Anda akan aktif dengan HTTPS yang aman dan performa loading instan!

---

### Langkah D: Sinkronisasi Data & Demo Live (Ingestor Lokal)
Untuk memantau transaksi Sepolia dan menyuplai data ke dashboard Netlify:

1. Pastikan file `.env` di root proyek Anda sudah berisi kredensial Supabase Anda.
2. Buka terminal di laptop Anda, masuk ke folder backend, dan jalankan:
   ```bash
   cd backend
   npm start
   ```
3. Backend lokal Anda akan:
   * Menghubungkan ke blockchain Sepolia Testnet.
   * Menyalakan **Background Traffic Generator** untuk menyimulasikan transaksi transfer token `ANLT` acak ke alamat Ethereum acak secara otomatis setiap 15 menit (selama saldo > 0.05 Sepolia ETH).
   * **Ingestor** akan memantau transaksi baru tersebut dan menyimpannya langsung ke database Supabase Cloud.
4. Kapan pun ada pengunjung membuka URL Netlify Anda, mereka akan langsung melihat statistik dan grafik transaksi terbaru yang telah disinkronkan tersebut secara instan!
