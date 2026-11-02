'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

const port = num(process.env.PORT, 3000);
const paypalClientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
const paypalClientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
const paypalEnv = String(process.env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
const paypalConfigured = Boolean(paypalClientId && paypalClientSecret);
const inferredBaseUrl = process.env.RENDER_EXTERNAL_URL
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
  || `http://localhost:${port}`;

const config = {
  version: require('../package.json').version,
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port,
  publicBaseUrl: stripTrailingSlash(process.env.PUBLIC_BASE_URL || inferredBaseUrl),
  mode: paypalConfigured ? paypalEnv : 'demo',
  paypal: {
    clientId: paypalClientId,
    clientSecret: paypalClientSecret,
    env: paypalEnv,
    configured: paypalConfigured,
    baseUrl: paypalEnv === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
    webhookId: String(process.env.PAYPAL_WEBHOOK_ID || '').trim(),
    currency: 'USD',
  },
  bot: {
    url: stripTrailingSlash(process.env.BOT_URL || 'http://150.136.227.127:8501'),
    strategyPaths: String(
      process.env.BOT_STRATEGY_PATH || '/nexus/strategy,/api/strategy,/strategy,/.well-known/nexus.json',
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    apiKey: String(process.env.BOT_API_KEY || '').trim(),
    timeoutMs: Math.max(800, num(process.env.BOT_TIMEOUT_MS, 3500)),
    cacheMs: Math.max(2000, num(process.env.BOT_CACHE_MS, 15000)),
    offline: bool(process.env.NEXUS_OFFLINE, false),
  },
  fees: {
    crossBorderPct: Math.min(20, Math.max(0, num(process.env.CROSS_BORDER_FEE_PCT, 4.99))),
    fxSpreadPct: Math.min(20, Math.max(0, num(process.env.FX_SPREAD_PCT, 4.0))),
  },
  limits: {
    minAmount: Math.max(0.01, num(process.env.MIN_TRANSFER_AMOUNT, 1)),
    maxAmount: Math.max(1, num(process.env.MAX_TRANSFER_AMOUNT, 25000)),
  },
  quoteSecret: String(process.env.QUOTE_SECRET || '').trim() || crypto.randomBytes(32).toString('hex'),
  quoteTtlMs: 10 * 60 * 1000,
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR || './data'),
  seedDemo: bool(process.env.SEED_DEMO, !paypalConfigured),
  allowedOrigins: String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

config.fees.totalPct = Number((config.fees.crossBorderPct + config.fees.fxSpreadPct).toFixed(2));

module.exports = config;
