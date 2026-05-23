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

## 3. Strategi Deployment (Split Deployment)

Kita akan membagi deployment menjadi 3 bagian:
1. **Database**: PostgreSQL di Cloud (neon.tech / Supabase / Railway).
2. **Backend**: Express Server + Ingestor di Cloud (Render / Railway / Fly.io).
3. **Frontend**: Dashboard Statis di Cloud (Vercel / Netlify).

### Langkah A: Deploy Database PostgreSQL
Anda memerlukan PostgreSQL cloud gratis. Salah satu opsi termudah dan tercepat adalah **Neon** (neon.tech) atau **Supabase**:
1. Daftar di [Neon.tech](https://neon.tech/) atau [Supabase](https://supabase.com/).
2. Buat project baru dan pilih database PostgreSQL.
3. Salin **Connection String** yang diberikan (biasanya berformat `postgresql://user:password@host:port/dbname`).
4. Catat detail kredensial tersebut untuk dikonfigurasi di environment variables backend.

### Langkah B: Deploy Backend (Node.js & Ingestor)
Anda bisa menggunakan **Render** atau **Railway**:

#### Menggunakan Render (render.com):
1. Masuk ke dashboard Render dan buat **New Web Service**.
2. Hubungkan akun GitHub Anda dan pilih repositori `web3-analytics-dashboard`.
3. Gunakan konfigurasi berikut:
   * **Root Directory**: `backend` (atau kosongkan dan atur Build/Start command dengan path). Lebih mudah jika Root Directory diatur ke `backend`.
   * **Runtime**: `Node`
   * **Build Command**: `npm install`
   * **Start Command**: `node src/server.js`
4. Tambahkan **Environment Variables** di tab *Environment*:
   * `PORT`: `3001` (atau Render otomatis akan mendeteksi port)
   * `DB_USER`: `<User database cloud Anda>`
   * `DB_PASSWORD`: `<Password database cloud Anda>`
   * `DB_HOST`: `<Host database cloud Anda>`
   * `DB_PORT`: `5432`
   * `DB_NAME`: `<Nama database cloud Anda>`
   * `TRACKED_TOKEN_ADDRESS`: `<Alamat token ERC-20 yang ingin dipantau di Sepolia>`
   * `SEPOLIA_RPC_URL`: `https://ethereum-sepolia-rpc.publicnode.com` (atau endpoint RPC milik Anda sendiri dari Alchemy/Infura agar lebih stabil)
5. Klik **Deploy Web Service** dan tunggu hingga aktif. Salin URL backend Anda (misalnya `https://web3-analytics-backend.onrender.com`).

---

### Langkah C: Menghubungkan Frontend ke Backend Produksi
Sebelum men-deploy frontend ke Vercel/Netlify, Anda perlu memastikan frontend menembak URL backend produksi yang baru saja dibuat di Render/Railway.

Buka file [dashboard/app.js](file:///c:/dev/web3-analytics-dashboard/dashboard/app.js) dan perhatikan baris ke-11:
```javascript
const API_BASE = window.location.protocol.startsWith('http') ? '' : 'http://localhost:3001';
```

Ubah baris tersebut agar mengarah ke backend produksi Anda saat di-deploy:
```javascript
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001'
  : 'https://web3-analytics-backend.onrender.com'; // Ganti dengan URL Backend Render/Railway Anda
```

Setelah mengubahnya, lakukan commit dan push perubahan tersebut ke GitHub:
```bash
git add dashboard/app.js
git commit -m "chore: update API_BASE to production backend URL"
git push origin main
```

---

### Langkah D: Deploy Frontend (Vercel / Netlify)

#### Menggunakan Vercel:
1. Masuk ke dashboard [Vercel](https://vercel.com/) dan buat project baru (**Add New Project**).
2. Impor repositori GitHub `web3-analytics-dashboard` Anda.
3. Pada halaman konfigurasi project:
   * **Framework Preset**: Pilih `Other` atau `Vite` (jika menggunakan build tool, namun untuk project vanilla HTML ini pilih `Other`).
   * **Root Directory**: Ubah atau edit dan arahkan ke folder `dashboard` (karena file `index.html` berada di dalam folder `/dashboard`).
4. Klik **Deploy**.
5. Selesai! Vercel akan menyajikan frontend Anda dengan HTTPS yang aman dan performa sangat cepat.

#### Menggunakan Netlify:
1. Masuk ke dashboard [Netlify](https://www.netlify.com/) dan pilih **Import from Git**.
2. Pilih repositori GitHub `web3-analytics-dashboard`.
3. Pada tab konfigurasi build:
   * **Base Directory**: `dashboard`
   * **Build Command**: Kosongkan (karena menggunakan vanilla HTML/JS/CSS statis).
   * **Publish Directory**: `.` (merujuk ke root dari Base Directory, yaitu folder `dashboard`).
4. Klik **Deploy site**.
