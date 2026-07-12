const express = require('express');
const mysql = require('mysql2/promise');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const TENANTS_DIR = '/opt/cafe-azzura/tenants';

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
    '.wasm': 'application/wasm', '.txt': 'text/plain', '.xml': 'text/xml',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
    '.map': 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

async function getTenantConfig(slug) {
  try {
    const conn = await mysql.createConnection({
      host: '127.0.0.1',
      user: 'root',
      password: 'CafeAzzura2024',
      database: 'cafe_registry'
    });
    const [rows] = await conn.query(
      'SELECT slug, backend_port, ui_port, admin_port FROM tenants WHERE slug = ? AND status = ?',
      [slug, 'active']
    );
    await conn.end();
    if (rows.length === 0) return null;
    return rows[0];
  } catch (error) {
    console.error('DB error:', error.message);
    return null;
  }
}

function extractTenantSlug(host) {
  if (!host) return null;
  host = host.split(':')[0];
  const domains = ['caffe.my.id', 'caffe.id'];
  let matched = null;
  for (const d of domains) {
    if (host.endsWith(`.${d}`)) { matched = d; break; }
  }
  if (!matched) return null;
  if (host.startsWith('office-')) {
    return {
      slug: host.replace('office-', '').replace(`.${matched}`, ''),
      type: 'admin'
    };
  }
  return {
    slug: host.replace(`.${matched}`, ''),
    type: 'ui'
  };
}

function proxyRequest(req, res, targetPort) {
  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.originalUrl || req.url,
    method: req.method,
    headers: { ...req.headers, host: 'localhost' }
  };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    console.error('Proxy error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'Backend unavailable' });
  });
  req.pipe(proxyReq);
}

function serveStaticFallback(req, res, slug) {
  // Legacy fallback: serve from tenant dir if no Docker ports
  let basePath = path.join(TENANTS_DIR, slug, 'backend', 'public', req.tenantType === 'admin' ? 'admin' : 'ui');
  let urlPath = req.originalUrl;
  if (req.tenantType !== 'admin' && urlPath.startsWith('/admin')) {
    basePath = path.join(TENANTS_DIR, slug, 'backend', 'public', 'admin');
    urlPath = urlPath.replace('/admin', '') || '/';
  }
  let filePath = path.join(basePath, urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.setHeader('Content-Type', getMimeType(filePath));
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    return res.sendFile(filePath);
  }
  const indexPath = path.join(basePath, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).json({ error: 'Not found' });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'tenant-router' });
});

app.use(async (req, res, next) => {
  const host = req.headers.host || '';
  const extracted = extractTenantSlug(host);
  if (!extracted || !extracted.slug || extracted.slug === 'caffe') {
    return res.status(404).json({ error: 'Tenant not found' });
  }
  if (extracted.slug === 'api') {
    return res.status(404).json({ error: 'Invalid subdomain' });
  }
  req.tenantSlug = extracted.slug;
  req.tenantType = extracted.type;
  const config = await getTenantConfig(extracted.slug);
  if (!config) return res.status(404).json({ error: 'Tenant not found or inactive' });
  req.tenantConfig = config;
  next();
});

app.use('/', (req, res) => {
  const slug = req.tenantSlug;
  const config = req.tenantConfig;

  // API always proxies to backend container
  if (req.originalUrl.startsWith('/api')) {
    return proxyRequest(req, res, config.backend_port);
  }

  // Docker path: proxy to UI or admin container
  if (config.ui_port || config.admin_port) {
    const targetPort = req.tenantType === 'admin' ? config.admin_port : config.ui_port;
    return proxyRequest(req, res, targetPort);
  }

  // Legacy static fallback
  serveStaticFallback(req, res, slug);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tenant Router running on port ${PORT}`);
});

// Prevent process from exiting when stdin/stdout pipes close (systemd)
process.stdin.resume();
