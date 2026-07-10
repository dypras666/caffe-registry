const express = require('express');
const mysql = require('mysql2/promise');
const http = require('http');
const path = require('path');
const fs = require('fs');
const mimeModule = require('mime');
const mime = mimeModule.default || mimeModule;

function getMimeType(filePath) {
  if (!mime) return 'application/octet-stream';
  if (mime.getType) return mime.getType(filePath) || 'application/octet-stream';
  return 'application/octet-stream';
}

const app = express();
const PORT = process.env.PORT || 3001;
const TENANTS_DIR = '/opt/cafe-azzura/tenants';

async function getTenantConfig(slug) {
  try {
    const conn = await mysql.createConnection({
      host: '127.0.0.1',
      user: 'root',
      password: 'CafeAzzura2024',
      database: 'cafe_registry'
    });
    
    const [rows] = await conn.query(
      'SELECT slug, backend_port FROM tenants WHERE slug = ? AND status = ?',
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
  
  if (host.startsWith('office-')) {
    return {
      slug: host.replace('office-', '').replace('.caffe.my.id', ''),
      type: 'admin'
    };
  }
  
  return {
    slug: host.replace('.caffe.my.id', ''),
    type: 'ui'
  };
}

function proxyRequest(req, res, targetPort) {
  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.originalUrl || req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: 'localhost'
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    console.error('Proxy error:', e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Backend unavailable' });
    }
  });

  req.pipe(proxyReq);
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
  if (!config) {
    return res.status(404).json({ error: 'Tenant not found or inactive' });
  }
  
  req.tenantConfig = config;
  next();
});

app.use('/', (req, res) => {
  const slug = req.tenantSlug;
  const config = req.tenantConfig;
  
  // Proxy API requests to tenant backend
  if (req.originalUrl.startsWith('/api')) {
    return proxyRequest(req, res, config.backend_port);
  }
  
  let basePath;
  let urlPath = req.originalUrl;
  
  if (urlPath.startsWith('/admin')) {
    basePath = path.join(TENANTS_DIR, slug, 'backend', 'public', 'admin');
    urlPath = urlPath.replace('/admin', '') || '/';
  } else {
    // Check admin assets too (admin index.html references /assets/...)
    const adminAssetPath = path.join(TENANTS_DIR, slug, 'backend', 'public', 'admin', urlPath.replace(/^\//, ''));
    if (fs.existsSync(adminAssetPath) && fs.statSync(adminAssetPath).isFile()) {
      const mimeType = getMimeType(adminAssetPath);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      return res.sendFile(adminAssetPath);
    }
    basePath = path.join(TENANTS_DIR, slug, 'backend', 'public', 'ui');
  }
  
  let filePath = path.join(basePath, urlPath);
  
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const mimeType = getMimeType(filePath);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    return res.sendFile(filePath);
  }
  
  const indexPath = path.join(basePath, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tenant Router running on port ${PORT}`);
});
