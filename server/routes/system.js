'use strict';

const express = require('express');
const config = require('../config');
const bot = require('../services/bot');
const { COUNTRIES, CURRENCY_META } = require('../lib/market');

function createSystemRouter({ ledger }) {
  const router = express.Router();
  const startedAt = Date.now();

  router.get('/', (req, res) => {
    res.json({
      ok: true,
      name: 'PayPal Nexus AI API',
      version: config.version,
      mode: config.mode,
      endpoints: [
        'GET  /api/health',
        'GET  /api/config',
        'GET  /api/agent/status',
        'POST /api/agent/optimize',
        'POST /api/paypal/create-order',
        'POST /api/paypal/capture-order',
        'POST /api/paypal/webhook',
        'GET  /api/dashboard',
        'GET  /api/dashboard/transactions',
        'GET  /api/dashboard/export.csv',
      ],
    });
  });

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      status: 'ok',
      service: 'paypal-nexus-ai',
      version: config.version,
      mode: config.mode,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      paypalConfigured: config.paypal.configured,
      botUrl: config.bot.url,
      ledger: { records: ledger.transactions.length, persistent: !ledger.memoryOnly },
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/config', (req, res) => {
    res.json({
      ok: true,
      app: {
        name: 'PayPal Nexus AI',
        version: config.version,
        mode: config.mode,
        environment: config.paypal.env,
        tagline: 'Autonomous liquidity engine for zero-fee international transfers',
      },
      paypal: {
        configured: config.paypal.configured,
        clientId: config.paypal.configured ? config.paypal.clientId : null,
        currency: config.paypal.currency,
        sdk: 'https://www.paypal.com/sdk/js',
        webhookConfigured: Boolean(config.paypal.webhookId),
      },
      bot: {
        url: config.bot.url,
        cacheTtlMs: config.bot.cacheMs,
        strategyPaths: config.bot.strategyPaths,
        offlineForced: config.bot.offline,
      },
      fees: config.fees,
      limits: config.limits,
      quoteTtlSeconds: Math.round(config.quoteTtlMs / 1000),
      countries: COUNTRIES,
      currencies: CURRENCY_META,
      disclaimers: [
        'Entorno de hackathon: usa PayPal Sandbox, no dinero real.',
        'El ahorro se calcula contra una ruta transfronteriza de referencia (comisión + spread FX).',
        'La telemetría del motor se marca como live, bridge o simulada en cada cotización.',
      ],
    });
  });

  router.get('/agent/status', async (req, res, next) => {
    try {
      const status = await bot.getStatus();
      res.json({ ok: true, mode: config.mode, ...status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSystemRouter };
