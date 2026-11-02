'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before } = require('node:test');

process.env.NEXUS_OFFLINE = '1';
process.env.SEED_DEMO = '0';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.QUOTE_SECRET = 'test-quote-secret-please-change-0123456789';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agent-'));

let agent;
let verifyQuote;
let signQuote;

before(() => {
  agent = require('../server/services/agent');
  ({ verifyQuote, signQuote } = require('../server/lib/quote'));
});

test('optimizer quotes a zero-fee USD → COP transfer with a signed token', async () => {
  const quote = await agent.optimize({
    amount: 500,
    sourceCountry: 'US',
    destinationCountry: 'CO',
    sourceCurrency: 'USD',
    targetCurrency: 'COP',
    recipientEmail: 'ana@example.com',
    botSubsidy: true,
  });

  assert.equal(quote.fees.charged.amount, 0);
  assert.equal(quote.fees.benchmark.paypalFee, 24.95);
  assert.equal(quote.fees.benchmark.fxFee, 20);
  assert.equal(quote.savings.amount, 44.95);
  assert.equal(quote.savings.pct, 8.99);
  assert.equal(quote.strategy.coveragePct, 100);
  assert.equal(quote.strategy.source, 'simulated');
  assert.equal(quote.recipientCurrency, 'COP');
  assert.ok(quote.recipientAmount > 1_000_000, 'COP payout should be in the millions');
  assert.match(quote.summary, /comisiones/i);
  assert.equal(quote.steps.length, 5);

  const payload = verifyQuote(quote.token);
  assert.equal(payload.id, quote.id);
  assert.equal(payload.amount, 500);
  assert.equal(payload.absorbedUsd, 44.95);
  assert.ok(payload.exp > Date.now());

  const [body, signature] = quote.token.split('.');
  const flipped = `${body}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  assert.throws(
    () => verifyQuote(flipped),
    (error) => error.status === 401 && error.code === 'INVALID_QUOTE',
  );
});

test('optimizer converts EUR → BRL and keeps the fee at zero', async () => {
  const quote = await agent.optimize({
    amount: 250,
    sourceCountry: 'ES',
    destinationCountry: 'BR',
    sourceCurrency: 'EUR',
    targetCurrency: 'BRL',
    botSubsidy: true,
  });

  assert.equal(quote.sourceCurrency, 'EUR');
  assert.equal(quote.fees.charged.amount, 0);
  assert.equal(quote.fees.benchmark.currency, 'EUR');
  assert.equal(quote.savings.currency, 'EUR');
  assert.ok(quote.recipientAmount > 500);
  assert.equal(quote.steps[1].status, 'ok');
});

test('expired signed quotes are rejected', () => {
  const token = signQuote({ id: 'q_expired', exp: Date.now() - 60_000, amount: 10 });
  assert.throws(
    () => verifyQuote(token),
    (error) => error.status === 410 && error.code === 'QUOTE_EXPIRED',
  );
});

test('optimizer never trusts a client rate (rate comes from the strategy feed)', async () => {
  const quote = await agent.optimize({
    amount: 100,
    sourceCountry: 'US',
    destinationCountry: 'MX',
    sourceCurrency: 'USD',
    targetCurrency: 'MXN',
    exchangeRate: 1,
  });
  assert.notEqual(quote.exchangeRate, 1);
  assert.ok(quote.recipientAmount > 1_000);
});

test('without the yield engine (default) the standard fee is charged and nothing is subsidized', async () => {
  const quote = await agent.optimize({
    amount: 500,
    sourceCountry: 'US',
    destinationCountry: 'CO',
    sourceCurrency: 'USD',
    targetCurrency: 'COP',
  });

  assert.equal(quote.botSubsidy, false);
  assert.equal(quote.subsidy.enabled, false);
  assert.equal(quote.subsidy.disclaimer, null);
  assert.equal(quote.fees.charged.amount, 24.95);
  assert.equal(quote.totalCharge, 524.95);
  assert.equal(quote.savings.amount, 0);
  assert.equal(quote.fees.absorbed.pct, 0);
  assert.equal(quote.steps.length, 4);

  const payload = verifyQuote(quote.token);
  assert.equal(payload.botSubsidy, false);
  assert.equal(payload.chargedFee, 24.95);
  assert.equal(payload.absorbedUsd, 0);
});

test('with the yield engine the fee is $0.00, flagged non-guaranteed and carries the risk disclaimer', async () => {
  const quote = await agent.optimize({
    amount: 500,
    sourceCountry: 'US',
    destinationCountry: 'CO',
    sourceCurrency: 'USD',
    targetCurrency: 'COP',
    botSubsidy: true,
  });

  assert.equal(quote.botSubsidy, true);
  assert.equal(quote.subsidy.guaranteed, false);
  assert.match(quote.subsidy.disclaimer, /trading conlleva riesgos/i);
  assert.match(quote.disclaimer, /no están garantizados/i);
  assert.equal(quote.totalCharge, 500);
  assert.equal(verifyQuote(quote.token).chargedFee, 0);
});
