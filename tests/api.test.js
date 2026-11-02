'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

process.env.NEXUS_OFFLINE = '1';
process.env.SEED_DEMO = '0';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.QUOTE_SECRET = 'test-api-secret-please-change-0123456789';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-api-'));

let server;
let baseUrl;

before(async () => {
  const { createApp } = require('../server/app');
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json();
  return { status: response.status, data };
}

test('health and config are public but never expose the client secret', async () => {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');
  assert.equal(health.data.mode, 'demo');

  const config = await request('/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.data.app.mode, 'demo');
  assert.equal(config.data.paypal.clientId, null);
  assert.equal(config.data.paypal.clientSecret, undefined);
  assert.ok(config.data.countries.length > 20);
});

test('full demo checkout flow: optimize → create → capture → dashboard', async () => {
  const optimized = await request('/api/agent/optimize', {
    method: 'POST',
    body: JSON.stringify({
      amount: 500,
      sourceCountry: 'US',
      destinationCountry: 'CO',
      recipientEmail: 'ana@example.com',
    }),
  });
  assert.equal(optimized.status, 200);
  const quote = optimized.data.quote;
  assert.equal(quote.fees.charged.amount, 0);
  assert.equal(quote.savings.amount, 44.95);

  const created = await request('/api/paypal/create-order', {
    method: 'POST',
    body: JSON.stringify({ quoteId: quote.id, quoteToken: quote.token }),
  });
  assert.equal(created.status, 201);
  assert.match(created.data.order.id, /^DEMO-/);
  assert.equal(created.data.order.status, 'CREATED');

  const captured = await request('/api/paypal/capture-order', {
    method: 'POST',
    body: JSON.stringify({ orderId: created.data.order.id, quoteToken: quote.token }),
  });
  assert.equal(captured.status, 200);
  assert.equal(captured.data.capture.status, 'COMPLETED');
  assert.equal(captured.data.transaction.fees.charged, 0);
  assert.equal(captured.data.transaction.savings.usd, 44.95);
  assert.equal(captured.data.transaction.demo, true);
  assert.equal(captured.data.transaction.quoteId, quote.id);

  // Retried captures must be idempotent and must not duplicate the ledger.
  const retried = await request('/api/paypal/capture-order', {
    method: 'POST',
    body: JSON.stringify({ orderId: created.data.order.id, quoteToken: quote.token }),
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.duplicate, true);

  // An order id alone must not expose the receipt without a signed quote.
  const withoutQuote = await request('/api/paypal/capture-order', {
    method: 'POST',
    body: JSON.stringify({ orderId: created.data.order.id }),
  });
  assert.equal(withoutQuote.status, 400);
  assert.equal(withoutQuote.data.error.code, 'QUOTE_REQUIRED');

  const dashboard = await request('/api/dashboard?limit=10');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.totals.count, 1);
  assert.equal(dashboard.data.totals.savingsUsd, 44.95);
  assert.equal(dashboard.data.transactions.length, 1);
  assert.equal(dashboard.data.transactions[0].id, captured.data.transaction.id);
});

test('rejects tampered quotes, unsupported corridors and invalid amounts', async () => {
  const optimized = await request('/api/agent/optimize', {
    method: 'POST',
    body: JSON.stringify({ amount: 100, sourceCountry: 'US', destinationCountry: 'MX' }),
  });
  const quote = optimized.data.quote;
  const [body, signature] = quote.token.split('.');
  const tampered = `${body}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;

  const tamperedResponse = await request('/api/paypal/create-order', {
    method: 'POST',
    body: JSON.stringify({ quoteToken: tampered }),
  });
  assert.equal(tamperedResponse.status, 401);

  const sameCountry = await request('/api/agent/optimize', {
    method: 'POST',
    body: JSON.stringify({ amount: 100, sourceCountry: 'US', destinationCountry: 'US' }),
  });
  assert.equal(sameCountry.status, 400);
  assert.equal(sameCountry.data.error.code, 'SAME_COUNTRY');

  const negative = await request('/api/agent/optimize', {
    method: 'POST',
    body: JSON.stringify({ amount: -5, sourceCountry: 'US', destinationCountry: 'CO' }),
  });
  assert.equal(negative.status, 400);
  assert.equal(negative.data.error.code, 'INVALID_AMOUNT');

  const tooLarge = await request('/api/agent/optimize', {
    method: 'POST',
    body: JSON.stringify({ amount: 999999, sourceCountry: 'US', destinationCountry: 'CO' }),
  });
  assert.equal(tooLarge.status, 400);
  assert.equal(tooLarge.data.error.code, 'AMOUNT_TOO_HIGH');
});

test('serves the SPA with security headers and a JSON 404 for unknown APIs', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /PayPal Nexus AI/);
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

  const missing = await request('/api/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.ok, false);
  assert.equal(missing.data.error.code, 'NOT_FOUND');
});
