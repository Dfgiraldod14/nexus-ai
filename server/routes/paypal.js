'use strict';

const express = require('express');
const config = require('../config');
const logger = require('../lib/logger');
const paypal = require('../services/paypal');
const { verifyQuote } = require('../lib/quote');
const { parseCaptureInput } = require('../lib/validate');
const { buildTransaction } = require('../services/ledger');
const { badRequest, unauthorized } = require('../lib/errors');

function createPayPalRouter({ ledger, limiter }) {
  const router = express.Router();

  router.post('/create-order', limiter, async (req, res, next) => {
    try {
      const quoteToken = String(req.body?.quoteToken || '');
      const quote = verifyQuote(quoteToken);
      if (req.body?.quoteId && String(req.body.quoteId) !== quote.id) {
        throw unauthorized('QUOTE_MISMATCH', 'La cotización no coincide con el identificador enviado.');
      }
      if (quote.exp < Date.now()) {
        throw unauthorized('QUOTE_EXPIRED', 'La cotización expiró. Vuelve a optimizar.');
      }

      const order = await paypal.createOrder({ quote, mode: config.mode });
      logger.info('paypal order created', { orderId: order.id, mode: order.mode, quoteId: quote.id });
      res.status(201).json({ ok: true, order });
    } catch (err) {
      next(err);
    }
  });

  router.post('/capture-order', limiter, async (req, res, next) => {
    try {
      const { orderId, quoteToken } = parseCaptureInput(req.body);

      // Idempotent capture: a retried request returns the original ledger entry.
      // A signed quote is still required so an order id alone cannot read a receipt.
      const existing = ledger.findByOrderId(orderId);
      if (existing) {
        if (!quoteToken) {
          throw badRequest('QUOTE_REQUIRED', 'Falta la cotización firmada para consultar la orden.');
        }
        const duplicateQuote = verifyQuote(quoteToken);
        if (existing.quoteId && existing.quoteId !== duplicateQuote.id) {
          throw unauthorized('QUOTE_MISMATCH', 'La cotización no corresponde a esta orden.');
        }
        return res.json({ ok: true, duplicate: true, transaction: existing, capture: { orderId, status: existing.status } });
      }

      if (!quoteToken) {
        throw badRequest('QUOTE_REQUIRED', 'Falta la cotización firmada para capturar la orden.');
      }
      const quote = verifyQuote(quoteToken);

      const capture = await paypal.captureOrder({ orderId, quote, mode: config.mode });
      const transaction = ledger.add(buildTransaction({ quote, capture, mode: config.mode }));
      logger.info('transfer captured', {
        orderId,
        captureId: capture.id,
        transactionId: transaction.id,
        amount: transaction.amount,
        currency: transaction.sourceCurrency,
      });

      res.json({
        ok: true,
        capture: {
          id: capture.id,
          orderId: capture.orderId,
          status: capture.status,
          payerEmail: capture.payerEmail || null,
          amount: capture.amount,
          capturedAt: capture.capturedAt,
          mode: capture.mode || config.mode,
        },
        transaction,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/webhook', async (req, res, next) => {
    try {
      const event = req.body;
      if (!event || typeof event !== 'object' || !event.event_type) {
        throw badRequest('INVALID_WEBHOOK', 'Evento de webhook inválido.');
      }

      if (!config.paypal.webhookId || !config.paypal.configured) {
        logger.warn('webhook received but verification is not configured', { eventType: event.event_type });
        return res.status(200).json({ ok: true, received: true, verified: false, note: 'webhook id not configured' });
      }

      const verification = await paypal.verifyWebhook({ headers: req.headers, event });
      if (!verification.verified) {
        logger.warn('webhook signature rejected', { eventType: event.event_type, reason: verification.reason });
        return res.status(400).json({ ok: false, error: { code: 'INVALID_WEBHOOK_SIGNATURE' } });
      }

      logger.info('verified paypal webhook', {
        eventType: event.event_type,
        resourceId: event.resource?.id,
        status: event.resource?.status,
      });

      if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
        const captureId = event.resource?.id;
        const tx = ledger.transactions.find((item) => item.captureId === captureId);
        if (tx && tx.status !== 'COMPLETED') {
          tx.status = 'COMPLETED';
          ledger.persist();
        }
      }

      res.status(200).json({ ok: true, received: true, verified: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createPayPalRouter };
