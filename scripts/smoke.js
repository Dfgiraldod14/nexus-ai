'use strict';

/**
 * Self-contained smoke test: boots the app on a random port in DEMO mode,
 * runs an optimize → create-order → capture-order flow and prints a summary.
 *
 *   npm run smoke
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.NEXUS_OFFLINE = '1';
process.env.SEED_DEMO = '0';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.QUOTE_SECRET = 'smoke-test-secret-0123456789';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-smoke-'));

const { createApp } = require('../server/app');

const app = createApp();
const server = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await fetch(`${base}/api/health`).then((res) => res.json());
    const config = await fetch(`${base}/api/config`).then((res) => res.json());

    const optimize = await fetch(`${base}/api/agent/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 500,
        sourceCountry: 'US',
        destinationCountry: 'CO',
        recipientEmail: 'smoke@example.com',
      }),
    }).then((res) => res.json());

    const quote = optimize.quote;
    const order = await fetch(`${base}/api/paypal/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: quote.id, quoteToken: quote.token }),
    }).then((res) => res.json());

    const capture = await fetch(`${base}/api/paypal/capture-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: order.order.id, quoteToken: quote.token }),
    }).then((res) => res.json());

    if (quote.fees.charged.amount !== 0 || capture.capture.status !== 'COMPLETED') {
      throw new Error('Unexpected quote/capture result');
    }

    console.log('PayPal Nexus AI smoke test');
    console.log(`  mode:        ${health.mode} (${config.app.environment})`);
    console.log(`  corridor:    ${quote.corridor.label}`);
    console.log(`  you send:    ${quote.amount} ${quote.sourceCurrency}`);
    console.log(`  recipient:   ${quote.recipientAmount} ${quote.recipientCurrency}`);
    console.log(`  nexus fee:   ${quote.fees.charged.amount} ${quote.sourceCurrency}`);
    console.log(`  absorbed:    ${quote.savings.amount} ${quote.sourceCurrency} (${quote.savings.pct}%)`);
    console.log(`  strategy:    ${quote.strategy.source} / ${quote.strategy.rateSource}`);
    console.log(`  order:       ${order.order.id} → ${capture.capture.status}`);
    console.log('Smoke test OK');
  } catch (error) {
    console.error('Smoke test FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    server.close(() => process.exit(process.exitCode || 0));
  }
});
