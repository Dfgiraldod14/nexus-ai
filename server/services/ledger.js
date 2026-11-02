'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../lib/logger');
const { BASE_RATES, COUNTRY_BY_CODE, currencyMeta } = require('../lib/market');
const { roundMoney, round } = require('../lib/money');

/**
 * Tiny JSON ledger with atomic writes and an in-memory fallback for
 * read-only / serverless filesystems.
 */
class Ledger {
  constructor({ dataDir = config.dataDir, seedDemo = config.seedDemo } = {}) {
    this.file = path.join(dataDir, 'transactions.json');
    this.transactions = [];
    this.memoryOnly = false;
    this.load();
    if (seedDemo && this.transactions.length === 0) this.seedDemo();
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.transactions)) {
          this.transactions = parsed.transactions.slice(0, 500);
        }
      }
    } catch (err) {
      this.memoryOnly = true;
      logger.warn('ledger load failed, using memory', { error: err.message });
    }
  }

  persist() {
    if (this.memoryOnly) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, transactions: this.transactions }, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.memoryOnly = true;
      logger.warn('ledger is read-only, continuing in memory', { error: err.message });
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* noop */
      }
    }
  }

  add(transaction) {
    this.transactions.unshift(transaction);
    if (this.transactions.length > 500) this.transactions.length = 500;
    this.persist();
    return transaction;
  }

  findByOrderId(orderId) {
    return this.transactions.find((tx) => tx.orderId === orderId) || null;
  }

  list({ limit = 25 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    return this.transactions.slice(0, safeLimit);
  }

  stats() {
    const totals = this.transactions.reduce(
      (acc, tx) => {
        acc.count += 1;
        acc.volumeUsd += Number(tx.amountUsd) || 0;
        acc.savingsUsd += Number(tx.savings?.usd) || 0;
        acc.absorbedUsd += Number(tx.fees?.absorbedUsd) || 0;
        if (tx.demo) acc.demoCount += 1;
        return acc;
      },
      { count: 0, volumeUsd: 0, savingsUsd: 0, absorbedUsd: 0, demoCount: 0 },
    );

    const series = [];
    const today = new Date();
    const dayFormatter = new Intl.DateTimeFormat('es', { weekday: 'short', timeZone: 'UTC' });
    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
      const key = day.toISOString().slice(0, 10);
      const entries = this.transactions.filter((tx) => String(tx.createdAt).slice(0, 10) === key);
      series.push({
        date: key,
        label: dayFormatter.format(day).replace('.', ''),
        count: entries.length,
        volumeUsd: round(entries.reduce((sum, tx) => sum + (Number(tx.amountUsd) || 0), 0), 2),
        savingsUsd: round(entries.reduce((sum, tx) => sum + (Number(tx.savings?.usd) || 0), 0), 2),
      });
    }

    const corridors = new Map();
    for (const tx of this.transactions) {
      const key = `${tx.corridor?.from || '?'}→${tx.corridor?.to || '?'}`;
      const entry = corridors.get(key) || { label: key, count: 0, savingsUsd: 0 };
      entry.count += 1;
      entry.savingsUsd += Number(tx.savings?.usd) || 0;
      corridors.set(key, entry);
    }

    const avgCoverage =
      this.transactions.length > 0
        ? this.transactions.reduce((sum, tx) => sum + (Number(tx.strategy?.coveragePct) || 0), 0) /
          this.transactions.length
        : 0;

    return {
      totals: {
        count: totals.count,
        volumeUsd: round(totals.volumeUsd, 2),
        savingsUsd: round(totals.savingsUsd, 2),
        absorbedUsd: round(totals.absorbedUsd, 2),
        avgSavingsPct:
          totals.volumeUsd > 0 ? round((totals.savingsUsd / totals.volumeUsd) * 100, 2) : 0,
        avgCoveragePct: round(avgCoverage, 1),
        demoCount: totals.demoCount,
      },
      series,
      corridors: [...corridors.values()]
        .sort((a, b) => b.savingsUsd - a.savingsUsd)
        .slice(0, 4)
        .map((c) => ({ ...c, savingsUsd: round(c.savingsUsd, 2) })),
      updatedAt: new Date().toISOString(),
    };
  }

  seedDemo() {
    const corridors = [
      ['US', 'CO', 480],
      ['US', 'MX', 1200],
      ['ES', 'BR', 350],
      ['US', 'AR', 220],
      ['GB', 'NG', 900],
      ['US', 'PH', 640],
      ['CA', 'IN', 1500],
      ['US', 'PE', 300],
    ];

    let seed = 1337;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const now = Date.now();
    const created = corridors.map(([from, to, amount], index) => {
      const source = COUNTRY_BY_CODE.get(from);
      const dest = COUNTRY_BY_CODE.get(to);
      const sourceRate = BASE_RATES[source.currency] || 1;
      const targetRate = BASE_RATES[dest.currency] || 1;
      const exchangeRate = targetRate / sourceRate;
      const savings = roundMoney((amount * config.fees.totalPct) / 100, source.currency);
      const amountUsd = round(amount / sourceRate, 2);
      const daysAgo = index % 7;
      const timestamp = new Date(now - daysAgo * 86_400_000 - Math.floor(rng() * 6) * 3_600_000);
      const yieldBps = 60 + Math.floor(rng() * 50);

      return {
        id: `TX-DEMO-${String(index + 1).padStart(3, '0')}`,
        createdAt: timestamp.toISOString(),
        status: 'COMPLETED',
        mode: 'demo',
        demo: true,
        orderId: `DEMO-SEED-${String(index + 1).padStart(3, '0')}`,
        captureId: `DEMO-CAP-SEED-${String(index + 1).padStart(3, '0')}`,
        corridor: {
          from,
          to,
          fromName: source.name,
          toName: dest.name,
          fromFlag: source.flag,
          toFlag: dest.flag,
          label: `${source.flag} ${source.name} → ${dest.flag} ${dest.name}`,
        },
        amount,
        sourceCurrency: source.currency,
        amountUsd,
        recipientAmount: roundMoney(amount * exchangeRate, dest.currency),
        recipientCurrency: dest.currency,
        exchangeRate,
        recipientEmail: null,
        payerEmail: 's***@sandbox.demo',
        fees: {
          charged: 0,
          currency: source.currency,
          benchmarkTotal: savings,
          absorbedUsd: round(savings / sourceRate, 2),
        },
        savings: { amount: savings, currency: source.currency, usd: round(savings / sourceRate, 2), pct: config.fees.totalPct },
        strategy: {
          source: 'simulated',
          yieldBps,
          latencyMs: 30 + Math.floor(rng() * 60),
          coveragePct: 100,
        },
      };
    });

    this.transactions = created.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    this.persist();
    logger.info('seeded demo ledger', { count: this.transactions.length });
  }
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const [local, domain] = email.split('@');
  if (!domain) return null;
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(2, Math.min(4, local.length - 1)))}@${domain}`;
}

function buildTransaction({ quote, capture, mode }) {
  const sourceCountry = COUNTRY_BY_CODE.get(quote.sourceCountry);
  const destinationCountry = COUNTRY_BY_CODE.get(quote.destinationCountry);
  const currency = quote.sourceCurrency;
  const decimals = currencyMeta(currency).decimals;
  const now = new Date().toISOString();

  return {
    id: `TX-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
    createdAt: now,
    status: capture.status === 'COMPLETED' ? 'COMPLETED' : capture.status || 'COMPLETED',
    mode: mode || quote.mode || config.mode,
    demo: (mode || quote.mode || config.mode) === 'demo',
    quoteId: quote.id,
    orderId: capture.orderId,
    captureId: capture.id,
    corridor: {
      from: quote.sourceCountry,
      to: quote.destinationCountry,
      fromName: sourceCountry?.name || quote.sourceCountry,
      toName: destinationCountry?.name || quote.destinationCountry,
      fromFlag: sourceCountry?.flag || '',
      toFlag: destinationCountry?.flag || '',
      label: `${sourceCountry?.flag || ''} ${sourceCountry?.name || quote.sourceCountry} → ${destinationCountry?.flag || ''} ${
        destinationCountry?.name || quote.destinationCountry
      }`,
    },
    amount: roundMoney(quote.amount, currency),
    amountUsd: round(Number(quote.amountUsd) || 0, 2),
    sourceCurrency: currency,
    recipientAmount: quote.recipientAmount,
    recipientCurrency: quote.targetCurrency,
    exchangeRate: quote.exchangeRate,
    recipientEmail: maskEmail(quote.recipientEmail),
    payerEmail: maskEmail(capture.payerEmail),
    decimals,
    fees: {
      charged: 0,
      currency,
      benchmarkTotal: quote.benchmark.total,
      absorbedUsd: quote.absorbedUsd,
    },
    savings: {
      amount: quote.benchmark.total,
      currency,
      usd: quote.absorbedUsd,
      pct: config.fees.totalPct,
    },
    strategy: {
      source: quote.strategy.source,
      rateSource: quote.strategy.rateSource,
      yieldBps: quote.strategy.yieldBps,
      latencyMs: quote.strategy.latencyMs,
      coveragePct: quote.strategy.coveragePct,
    },
  };
}

module.exports = { Ledger, buildTransaction, maskEmail };
