'use strict';

const express = require('express');
const config = require('../config');

function createDashboardRouter({ ledger }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const stats = ledger.stats();
    res.json({
      ok: true,
      mode: config.mode,
      app: 'PayPal Nexus AI',
      ...stats,
      transactions: ledger.list({ limit }),
    });
  });

  router.get('/transactions', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    res.json({ ok: true, transactions: ledger.list({ limit }), mode: config.mode });
  });

  router.get('/transactions/:id', (req, res) => {
    const tx = ledger.transactions.find((item) => item.id === req.params.id);
    if (!tx) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Transacción no encontrada.' } });
    }
    return res.json({ ok: true, transaction: tx });
  });

  router.get('/export.csv', (req, res) => {
    const rows = ledger.list({ limit: 100 });
    const header = ['id', 'fecha', 'corredor', 'monto', 'moneda', 'monto_usd', 'recibe', 'moneda_destino', 'comision', 'ahorro_usd', 'estado', 'modo'];
    const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [header.join(',')];
    for (const tx of rows) {
      lines.push(
        [
          tx.id,
          tx.createdAt,
          `${tx.corridor?.from || ''}-${tx.corridor?.to || ''}`,
          tx.amount,
          tx.sourceCurrency,
          tx.amountUsd,
          tx.recipientAmount,
          tx.recipientCurrency,
          tx.fees?.charged ?? 0,
          tx.savings?.usd ?? 0,
          tx.status,
          tx.mode,
        ]
          .map(escape)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="nexus-transfers.csv"');
    res.send(lines.join('\n'));
  });

  return router;
}

module.exports = { createDashboardRouter };
