const mysql = require('mysql2/promise');
require('dotenv').config();

const features = [
  {
    title: 'POS Kasir Modern',
    slug: 'pos-kasir',
    subtitle: 'Transaksi cepat, antrean lancar.',
    description: 'Sistem kasir cerdas yang didesain khusus untuk kafe dan restoran. Mendukung split bill, diskon, multi-payment (QRIS, Tunai, EDC), dan offline-first mode (tetap bisa transaksi meski internet putus).',
    icon: 'point_of_sale',
    cover_image: '',
    images: '[]',
    video_url: '',
    video_embed: '',
    is_home: 1,
    sort_order: 1,
    is_active: 1
  },
  {
    title: 'Manajemen Inventori & Resep',
    slug: 'manajemen-inventori',
    subtitle: 'Pantau stok bahan baku real-time.',
    description: 'Kontrol stok bahan baku (raw material) hingga produk jadi. Dilengkapi dengan manajemen resep (BOM) sehingga setiap menu yang terjual akan otomatis memotong stok bahan baku sesuai takaran.',
    icon: 'inventory_2',
    cover_image: '',
    images: '[]',
    video_url: '',
    video_embed: '',
    is_home: 1,
    sort_order: 2,
    is_active: 1
  },
  {
    title: 'Sistem HR & Absensi',
    slug: 'hr-absensi',
    subtitle: 'Kelola shift dan absensi karyawan.',
    description: 'Bebas ribet hitung jam kerja! Fitur absensi dengan foto (Selfie + GPS), manajemen shift karyawan, pengajuan cuti, hingga perhitungan gaji (payroll) otomatis.',
    icon: 'badge',
    cover_image: '',
    images: '[]',
    video_url: '',
    video_embed: '',
    is_home: 1,
    sort_order: 3,
    is_active: 1
  },
  {
    title: 'Manajemen Multi Cabang',
    slug: 'multi-cabang',
    subtitle: 'Satu dashboard untuk semua cabang.',
    description: 'Pantau laporan penjualan, stok, dan absensi dari semua cabang kafe Anda secara real-time dari satu dashboard terpusat. Cocok untuk bisnis franchise atau kafe dengan banyak outlet.',
    icon: 'storefront',
    cover_image: '',
    images: '[]',
    video_url: '',
    video_embed: '',
    is_home: 1,
    sort_order: 4,
    is_active: 1
  },
  {
    title: 'Laporan Analitik Mendalam',
    slug: 'laporan-analitik',
    subtitle: 'Keputusan bisnis berbasis data.',
    description: 'Dapatkan insight penjualan, produk terlaris, jam paling ramai, hingga laporan laba rugi. Export laporan ke Excel atau PDF dengan mudah kapan saja.',
    icon: 'analytics',
    cover_image: '',
    images: '[]',
    video_url: '',
    video_embed: '',
    is_home: 0,
    sort_order: 5,
    is_active: 1
  },
  {
    title: 'Manajemen Dapur (Kitchen Display)',
    slug: 'kitchen-display',
    subtitle: 'Pesanan langsung masuk ke dapur.',
    description: 'Kurangi kesalahan order dengan Kitchen Display System (KDS). Pesanan dari kasir akan langsung tampil di layar dapur dengan status antrean yang jelas.',
    icon: 'restaurant',
    cover_image: '',
    images: '[]',
    video_url: '',
    video_embed: '',
    is_home: 0,
    sort_order: 6,
    is_active: 1
  },
  {
    title: 'Sistem Loyalitas (Member)',
    slug: 'sistem-loyalitas',
    subtitle: 'Pertahankan pelanggan setia.',
    description: 'Buat program membership, poin reward, dan voucher diskon. Pelanggan bisa mengumpulkan poin setiap transaksi dan menukarkannya dengan promo menarik.',
    icon: 'loyalty',
    cover_image: '',
    images: '[]',
    video_url: '',
    video_embed: '',
    is_home: 0,
    sort_order: 7,
    is_active: 1
  },
  {
    title: 'QR Self-Order',
    slug: 'qr-self-order',
    subtitle: 'Pelanggan pesan sendiri dari meja.',
    description: 'Tingkatkan efisiensi pelayanan dengan QR Self-Order. Pelanggan cukup scan QR Code di meja, pilih menu, dan pesanan otomatis masuk ke sistem kasir dan dapur.',
    icon: 'qr_code_scanner',
    cover_image: '',
    images: '[]',
    video_url: '',
    video_embed: '',
    is_home: 0,
    sort_order: 8,
    is_active: 1
  }
];

async function seed() {
  let conn;
  try {
    conn = require('./config/database');

    console.log("Connected to DB, creating table landing_features...");
    await conn.query(`
      CREATE TABLE IF NOT EXISTS landing_features (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL UNIQUE,
        subtitle VARCHAR(255),
        description TEXT,
        icon VARCHAR(100),
        cover_image VARCHAR(255),
        images TEXT,
        video_url VARCHAR(255),
        video_embed TEXT,
        is_home TINYINT(1) DEFAULT 0,
        sort_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    console.log("Emptying table...");
    await conn.query("TRUNCATE TABLE landing_features");

    console.log("Inserting features...");
    for (const f of features) {
      await conn.query(`
        INSERT INTO landing_features 
        (title, slug, subtitle, description, icon, cover_image, images, video_url, video_embed, is_home, sort_order, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        f.title, f.slug, f.subtitle, f.description, f.icon, f.cover_image, f.images, f.video_url, f.video_embed, f.is_home, f.sort_order, f.is_active
      ]);
      console.log(`Inserted: ${f.title}`);
    }

    console.log("Seeding complete!");
  } catch (err) {
    console.error("Seeding failed:", err);
  } finally {
    if (conn) await conn.end();
  }
}

seed();
