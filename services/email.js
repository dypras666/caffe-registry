const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const cache = {};

async function loadTemplate(name) {
  if (cache[name]) return cache[name];

  // Try DB first
  try {
    const db = require('../config/database');
    const [rows] = await db.query('SELECT html FROM system_templates WHERE name = ?', [name]);
    if (rows.length && rows[0].html) {
      cache[name] = rows[0].html;
      return cache[name];
    }
  } catch (_) {}

  // Fallback to file
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
    // {{{var}}} = raw (unescaped), {{var}} = auto-escaped
    result = result.replace(new RegExp(`\\{\\{\\{\\s*${key}\\s*\\}\\}\\}`, 'g'), replaced);
    result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), escapeHtml(replaced));
  }
  return result;
}

async function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT) || 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendMail({ to, subject, template, vars, from }) {
  const smtpUser = process.env.SMTP_USER;
  if (!smtpUser) {
    console.log(`[Email] SKIP (no SMTP): ${subject} → ${to}`);
    return { skipped: true };
  }

  let fromAddr = from || process.env.SMTP_FROM;
  try {
    const db = require('../config/database');
    const [rows] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'smtp_from'");
    if (rows.length && rows[0].setting_value) fromAddr = rows[0].setting_value;
  } catch (_) {}
  if (!fromAddr) fromAddr = 'noreply@cafeazzura.com';

  const html = renderTemplate(await loadTemplate(template), vars);
  const transporter = await getTransporter();

  await transporter.sendMail({
    from: `"Cafe Azzura" <${fromAddr}>`,
    to,
    subject,
    html,
  });

  console.log(`[Email] SENT: ${subject} → ${to}`);
  return { sent: true };
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
