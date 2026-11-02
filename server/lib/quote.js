'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { AppError, unauthorized } = require('./errors');

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function signature(body) {
  return crypto.createHmac('sha256', config.quoteSecret).update(body).digest('base64url');
}

/**
 * Quotes are self-contained signed tokens. This keeps them valid across
 * serverless invocations and prevents a client from tampering with the rate,
 * amount or absorbed fee before creating a PayPal order.
 */
function signQuote(payload) {
  const body = encode(JSON.stringify(payload));
  return `${body}.${signature(body)}`;
}

function verifyQuote(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 8192) {
    throw unauthorized('INVALID_QUOTE', 'La cotización no es válida. Genera una nueva.');
  }
  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    throw unauthorized('INVALID_QUOTE', 'La cotización no es válida. Genera una nueva.');
  }
  const body = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const expected = signature(body);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw unauthorized('INVALID_QUOTE', 'La firma de la cotización no coincide. Genera una nueva.');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw unauthorized('INVALID_QUOTE', 'La cotización no se pudo interpretar.');
  }

  if (!payload || typeof payload !== 'object' || !payload.id || !payload.exp) {
    throw unauthorized('INVALID_QUOTE', 'La cotización está incompleta.');
  }
  if (Number(payload.exp) < Date.now()) {
    throw new AppError(410, 'QUOTE_EXPIRED', 'La cotización expiró. Vuelve a optimizar la transferencia.');
  }
  return payload;
}

module.exports = { signQuote, verifyQuote };
