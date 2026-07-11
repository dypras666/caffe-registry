const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const cache = {};

async function loadTemplate(name) {
  if (cache[name]) return cache[name];

  try {
    const db = require('../config/database');
    const [rows] = await db.query('SELECT html FROM system_templates WHERE name = ?', [name]);
    if (rows.length && rows[0].html) {
      cache[name] = rows[0].html;
      return cache[name];
    }
  } catch (_) {}

  try {
    const filePath = path.join(TEMPLATES_DIR, name);
    cache[name] = fs.readFileSync(filePath, 'utf8');
    return cache[name];
  } catch (_) {
    throw new Error(`Template "${name}" tidak ditemukan`);
  }
}

function invalidateCache(name) {
  if (name) delete cache[name];
  else Object.keys(cache).forEach(k => delete cache[k]);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function renderTemplate(html, vars) {
  let result = html;
  for (const [key, value] of Object.entries(vars)) {
    const replaced = value !== undefined && value !== null ? String(value) : '';
    result = result.replace(new RegExp(`\\{\\{\\{\\s*${key}\\s*\\}\\}\\}`, 'g'), replaced);
    result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), escapeHtml(replaced));
  }
  return result;
}

function createTransporter(provider) {
  return nodemailer.createTransport({
    host: provider.host,
    port: provider.port || 465,
    secure: (provider.port || 465) === 465,
    auth: { user: provider.user, pass: provider.pass },
  });
}

async function loadProviders() {
  // Priority: SMTP_PROVIDERS env → DB smtp_providers → legacy SMTP_* env
  const envProviders = process.env.SMTP_PROVIDERS;
  if (envProviders) {
    try { const p = JSON.parse(envProviders); if (Array.isArray(p) && p.length) return p; } catch (_) {}
  }

  try {
    const db = require('../config/database');
    const [rows] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'smtp_providers'");
    if (rows.length && rows[0].setting_value) {
      const parsed = JSON.parse(rows[0].setting_value);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (_) {}

  // Legacy fallback: one provider from env vars
  if (process.env.SMTP_USER) {
    return [{
      name: process.env.SMTP_PROVIDER || 'SMTP',
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 465,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM,
    }];
  }

  return [];
}

async function sendViaResend(html, { to, subject, fromAddr }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  const { Resend } = require('resend');
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: fromAddr,
    to: [to],
    subject,
    html,
  });
  if (error) throw new Error(error.message || JSON.stringify(error));
}

async function sendMail({ to, subject, template, vars, from }) {
  const html = renderTemplate(await loadTemplate(template), vars);

  // Resend requires a verified domain; fallback to their default for free accounts
  const resendFrom = process.env.RESEND_FROM || 'Caffe.id <onboarding@resend.dev>';
  const smtpFrom = from || process.env.SMTP_FROM || 'noreply@caffe.my.id';
  const fromAddr = smtpFrom;

  const mailOpts = { from: `"Caffe.id" <${fromAddr}>`, to, subject, html };

  // 1. Try Resend API first (works from any VPS, no port restrictions)
  if (process.env.RESEND_API_KEY) {
    try {
      await sendViaResend(html, { to, subject, fromAddr: resendFrom });
      console.log(`[Email] SENT via Resend: ${subject} → ${to}`);
      return { sent: true, provider: 'resend' };
    } catch (err) {
      console.warn(`[Email] Resend failed: ${err.message} — falling back to SMTP`);
    }
  }

  // 2. Fallback to SMTP providers
  const providers = await loadProviders();
  if (!providers.length) {
    console.log(`[Email] SKIP (no provider): ${subject} → ${to}`);
    return { skipped: true, reason: 'no provider' };
  }

  const sorted = [...providers].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  for (const provider of sorted) {
    try {
      const transporter = createTransporter(provider);
      await transporter.sendMail(mailOpts);
      console.log(`[Email] SENT via ${provider.name || provider.host}: ${subject} → ${to}`);
      return { sent: true, provider: provider.name || provider.host };
    } catch (err) {
      console.warn(`[Email] FAILED ${provider.name || provider.host}: ${err.message}`);
    }
  }

  throw new Error(`Semua provider gagal untuk "${subject}" → ${to}`);
}

async function sendWelcome({ to, name, adminUrl, email, password, plan }) {
  return sendMail({
    to, subject: '☕ Selamat Datang di Cafe Azzura!',
    template: 'welcome.html',
    vars: { name, adminUrl, email, password, plan },
  });
}

async function sendForgotPassword({ to, name, resetUrl }) {
  return sendMail({
    to, subject: '🔐 Reset Password Cafe Azzura',
    template: 'forgot-password.html',
    vars: { name, resetUrl },
  });
}

async function sendLoginInfo({ to, name, cafeName, adminUrl, email, role }) {
  return sendMail({
    to, subject: '🔑 Informasi Login Cafe Azzura',
    template: 'login-info.html',
    vars: { name, cafeName, adminUrl, email, role },
  });
}

async function sendBillingWarning({ to, name, slug, balance, dailyCost, daysLeft, topupUrl }) {
  return sendMail({
    to, subject: '⚠️ Saldo Cafe Azzura Hampir Habis',
    template: 'balance-warning.html',
    vars: { name, slug, balance, dailyCost, daysLeft, topupUrl },
  });
}

async function sendSuspended({ to, name, slug, topupUrl }) {
  return sendMail({
    to, subject: '⛔ Layanan Cafe Azzura Dihentikan',
    template: 'suspended.html',
    vars: { name, slug, topupUrl },
  });
}

module.exports = { sendMail, sendWelcome, sendForgotPassword, sendLoginInfo, sendBillingWarning, sendSuspended, loadTemplate, invalidateCache };
