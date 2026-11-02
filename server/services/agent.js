'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const bot = require('./bot');
const { BASE_RATES, COUNTRY_BY_CODE } = require('../lib/market');
const { roundMoney, round } = require('../lib/money');
const { signQuote } = require('../lib/quote');

function usableRate(code, rates) {
  const rate = Number(rates?.[code]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const base = BASE_RATES[code];
  if (base && (rate < base * 0.5 || rate > base * 2)) return null;
  return rate;
}

function fmtNumber(value, maxDecimals = 2) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxDecimals }).format(value);
}

function buildSteps({ strategyResult, pair, rateSource, coveragePct, benchmarkTotal, quoteId, startedAt }) {
  let cursor = startedAt;
  const steps = [];
  const rateSourceLabel =
    rateSource === 'live-bot' ? 'feed bot' : rateSource === 'nexus-bridge' ? 'puente Nexus' : 'simulación';

  const push = (id, label, detail, status = 'ok') => {
    const at = Date.now();
    steps.push({
      id,
      label,
      detail,
      status,
      durationMs: Math.max(0, at - cursor),
      at: new Date(at).toISOString(),
    });
    cursor = at;
  };

  const { source, latencyMs, httpStatus, strategy } = strategyResult;
  const connectionDetail =
    source === 'bot'
      ? `${config.bot.url} · HTTP ${httpStatus || 200} · feed JSON · ${latencyMs || 0} ms`
      : source === 'bridge'
        ? `${config.bot.url} · HTTP 200 · feed no expuesto · puente Nexus`
        : `${config.bot.url} · sin respuesta · motor determinista local`;

  push('connect', 'Conectando con el motor de trading', connectionDetail, source === 'simulated' ? 'warn' : 'ok');
  push(
    'hedge',
    'Calculando cobertura de tasa cambiaria',
    `${pair.from}/${pair.to} ${fmtNumber(pair.rate, 4)} · spread 0.00% · mid-market · ${rateSourceLabel}`,
  );
  push(
    'liquidity',
    'Enrutando micro-arbitraje de liquidez',
    `Yield ${strategy.yieldBps} bps · profundidad $${fmtNumber(strategy.liquidityUsd, 0)} · cobertura ${coveragePct}%`,
  );
  push(
    'absorb',
    'Absorbiendo comisiones de PayPal',
    `${fmtNumber(benchmarkTotal, 2)} ${pair.sourceCurrency} cubiertos · tarifa al usuario 0.00`,
    coveragePct < 99.5 ? 'warn' : 'ok',
  );
  push(
    'sign',
    'Firmando cotización de pago',
    `Quote ${quoteId} · HMAC-SHA256 · expira en 10 min`,
  );

  return steps;
}

async function optimize(input) {
  const requestedAt = Date.now();
  const strategyResult = await bot.getStrategy();
  const { strategy, source } = strategyResult;

  const sourceRate = usableRate(input.sourceCurrency, strategy.rates);
  const targetRate = usableRate(input.targetCurrency, strategy.rates);
  if (!sourceRate || !targetRate) {
    throw new Error('No se pudo resolver la tasa de cambio para el corredor solicitado.');
  }

  const amountUsd = round(input.amount / sourceRate, 2);
  const exchangeRate = targetRate / sourceRate;
  const recipientAmount = roundMoney(input.amount * exchangeRate, input.targetCurrency);

  const paypalFee = roundMoney((input.amount * config.fees.crossBorderPct) / 100, input.sourceCurrency);
  const fxFee = roundMoney((input.amount * config.fees.fxSpreadPct) / 100, input.sourceCurrency);
  const benchmarkTotal = roundMoney(paypalFee + fxFee, input.sourceCurrency);
  const absorbedUsd = round(benchmarkTotal / sourceRate, 2);

  const capacityUsd = round((strategy.liquidityUsd * strategy.yieldBps) / 10_000, 2);
  const rawCoverage = absorbedUsd > 0 ? (capacityUsd / absorbedUsd) * 100 : 100;
  const coveragePct = round(Math.max(0, Math.min(100, rawCoverage)), 1);

  const provided = new Set(strategy.providedRates || []);
  const hasLivePair =
    source === 'bot' &&
    (input.sourceCurrency === 'USD' || provided.has(input.sourceCurrency)) &&
    (input.targetCurrency === 'USD' || provided.has(input.targetCurrency));
  const rateSource = source === 'simulated' ? 'simulated' : hasLivePair ? 'live-bot' : 'nexus-bridge';

  const id = `q_${crypto.randomBytes(6).toString('hex')}`;
  const now = Date.now();
  const expiresAt = now + config.quoteTtlMs;

  const sourceCountry = COUNTRY_BY_CODE.get(input.sourceCountry);
  const destinationCountry = COUNTRY_BY_CODE.get(input.destinationCountry);

  const steps = buildSteps({
    strategyResult,
    pair: {
      from: input.sourceCurrency,
      to: input.targetCurrency,
      rate: exchangeRate,
      sourceCurrency: input.sourceCurrency,
    },
    rateSource,
    coveragePct,
    benchmarkTotal,
    quoteId: id,
    startedAt: requestedAt,
  });

  const summary =
    `Ruta óptima ${input.sourceCountry}→${input.destinationCountry}: el motor cubre ` +
    `${fmtNumber(benchmarkTotal, 2)} ${input.sourceCurrency} (${coveragePct}%) de comisiones. ` +
    `Tarifa Nexus: 0.00.`;

  const payload = {
    v: 1,
    id,
    createdAt: now,
    exp: expiresAt,
    mode: config.mode,
    amount: input.amount,
    sourceCurrency: input.sourceCurrency,
    sourceCountry: input.sourceCountry,
    targetCurrency: input.targetCurrency,
    destinationCountry: input.destinationCountry,
    recipientEmail: input.recipientEmail || null,
    exchangeRate,
    recipientAmount,
    amountUsd,
    benchmark: {
      paypalFee,
      fxFee,
      total: benchmarkTotal,
      currency: input.sourceCurrency,
    },
    absorbedUsd,
    strategy: {
      source,
      rateSource,
      yieldBps: strategy.yieldBps,
      liquidityUsd: strategy.liquidityUsd,
      engine: strategy.engine,
      latencyMs: strategyResult.latencyMs,
      coveragePct,
      updatedAt: strategy.updatedAt,
    },
  };

  const token = signQuote(payload);

  return {
    id,
    token,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    mode: config.mode,
    input: {
      amount: input.amount,
      sourceCurrency: input.sourceCurrency,
      sourceCountry: input.sourceCountry,
      targetCurrency: input.targetCurrency,
      destinationCountry: input.destinationCountry,
      recipientEmail: input.recipientEmail || null,
    },
    corridor: {
      from: input.sourceCountry,
      to: input.destinationCountry,
      fromName: sourceCountry.name,
      toName: destinationCountry.name,
      fromFlag: sourceCountry.flag,
      toFlag: destinationCountry.flag,
      label: `${sourceCountry.flag} ${sourceCountry.name} → ${destinationCountry.flag} ${destinationCountry.name}`,
    },
    amount: input.amount,
    sourceCurrency: input.sourceCurrency,
    amountUsd,
    exchangeRate,
    recipientAmount,
    recipientCurrency: input.targetCurrency,
    fees: {
      charged: { amount: 0, currency: input.sourceCurrency, pct: 0 },
      benchmark: {
        paypalPct: config.fees.crossBorderPct,
        fxPct: config.fees.fxSpreadPct,
        totalPct: config.fees.totalPct,
        paypalFee,
        fxFee,
        total: benchmarkTotal,
        currency: input.sourceCurrency,
      },
      absorbed: {
        amount: benchmarkTotal,
        currency: input.sourceCurrency,
        usd: absorbedUsd,
        pct: 100,
      },
    },
    savings: {
      amount: benchmarkTotal,
      currency: input.sourceCurrency,
      usd: absorbedUsd,
      pct: config.fees.totalPct,
    },
    strategy: {
      source,
      label: bot.sourceLabel(source),
      rateSource,
      engine: strategy.engine,
      yieldBps: strategy.yieldBps,
      liquidityUsd: strategy.liquidityUsd,
      capacityUsd,
      coveragePct,
      confidence: strategy.confidence,
      latencyMs: strategyResult.latencyMs,
      updatedAt: strategy.updatedAt,
      endpoint: strategyResult.endpoint,
      botUrl: config.bot.url,
      feedExposed: Boolean(strategyResult.feedExposed),
    },
    steps,
    summary,
    simulated: source !== 'bot',
    disclaimer:
      'Demo hackathon: las comisiones se calculan contra una ruta tradicional de referencia. Los rendimientos del motor son simulados salvo que el feed del bot esté expuesto.',
    processingMs: Date.now() - requestedAt,
  };
}

module.exports = { optimize, usableRate };
