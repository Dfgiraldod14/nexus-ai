'use strict';

const config = require('../config');
const { COUNTRY_BY_CODE, currencyMeta } = require('./market');
const { roundMoney } = require('./money');
const { badRequest } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function parseRecipientEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  const email = String(value).trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw badRequest('INVALID_EMAIL', 'El correo del destinatario no es válido.');
  }
  return email;
}

/**
 * Validates and normalizes the transfer payload coming from the browser.
 * The currency is always derived from the chosen countries, never trusted
 * from the client, so a caller cannot smuggle arbitrary amounts/currencies.
 */
function parseTransferInput(body = {}) {
  if (!body || typeof body !== 'object') {
    throw badRequest('INVALID_BODY', 'El cuerpo de la solicitud no es válido.');
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw badRequest('INVALID_AMOUNT', 'Ingresa un monto válido mayor que cero.');
  }

  const sourceCountryCode = String(body.sourceCountry || 'US').trim().toUpperCase();
  const destinationCountryCode = String(body.destinationCountry || 'CO').trim().toUpperCase();
  const sourceCountry = COUNTRY_BY_CODE.get(sourceCountryCode);
  const destinationCountry = COUNTRY_BY_CODE.get(destinationCountryCode);

  if (!sourceCountry || !sourceCountry.send) {
    throw badRequest('UNSUPPORTED_SOURCE', 'El país de origen no está disponible para enviar.', {
      sourceCountry: sourceCountryCode,
    });
  }
  if (!destinationCountry || !destinationCountry.receive) {
    throw badRequest('UNSUPPORTED_DESTINATION', 'El país de destino no está disponible.', {
      destinationCountry: destinationCountryCode,
    });
  }
  if (sourceCountry.code === destinationCountry.code) {
    throw badRequest('SAME_COUNTRY', 'Elige un país de destino distinto al de origen: Nexus opera transferencias internacionales.');
  }
  if (amount < config.limits.minAmount) {
    throw badRequest('AMOUNT_TOO_LOW', `El mínimo por transferencia es ${config.limits.minAmount} ${sourceCountry.currency}.`);
  }
  if (amount > config.limits.maxAmount) {
    throw badRequest('AMOUNT_TOO_HIGH', `El máximo por transferencia es ${config.limits.maxAmount} ${sourceCountry.currency}.`, {
      maxAmount: config.limits.maxAmount,
    });
  }

  const sourceCurrency = sourceCountry.currency;
  const targetCurrency = destinationCountry.currency;

  if (currencyMeta(sourceCurrency).decimals === 0 && !Number.isInteger(amount)) {
    throw badRequest('INVALID_AMOUNT', `El monto en ${sourceCurrency} debe ser un número entero.`);
  }

  // Opt-in "yield engine": only a literal boolean true enables it, and it
  // requires an explicit acknowledgement of the trading-risk disclaimer.
  const botSubsidy = body.botSubsidy === true;
  if (botSubsidy && body.riskAcknowledged !== true) {
    throw badRequest(
      'RISK_NOT_ACKNOWLEDGED',
      'Para activar el motor de rendimiento debes aceptar el aviso de riesgo del trading.',
    );
  }

  return {
    amount: roundMoney(amount, sourceCurrency),
    sourceCountry: sourceCountry.code,
    destinationCountry: destinationCountry.code,
    sourceCurrency,
    targetCurrency,
    recipientEmail: parseRecipientEmail(body.recipientEmail),
    botSubsidy,
  };
}

function parseCaptureInput(body = {}) {
  const orderId = String(body.orderId || '').trim();
  if (!/^[A-Za-z0-9._-]{4,64}$/.test(orderId)) {
    throw badRequest('INVALID_ORDER_ID', 'El identificador de la orden no es válido.');
  }
  return { orderId, quoteToken: body.quoteToken ? String(body.quoteToken) : null };
}

module.exports = { parseTransferInput, parseCaptureInput };
