'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../lib/logger');
const { AppError } = require('../lib/errors');
const { paypalAmount } = require('../lib/money');

/**
 * Minimal PayPal Orders v2 client (REST + OAuth2 client credentials).
 *
 * We intentionally avoid a heavyweight SDK: the Orders v2 API is stable and
 * native fetch keeps the deployment footprint tiny. All calls happen
 * server-side; the client secret never reaches the browser.
 */

let tokenCache = { token: null, expiresAt: 0 };
const demoOrders = new Map();

function isConfigured() {
  return config.paypal.configured;
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new AppError(503, 'PAYPAL_NOT_CONFIGURED', 'PayPal no está configurado. La app está en modo demo.');
  }
}

async function getAccessToken({ force = false } = {}) {
  assertConfigured();
  if (!force && tokenCache.token && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const response = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    logger.error('paypal oauth failed', {
      status: response.status,
      error: data.error,
      description: data.error_description,
    });
    throw new AppError(502, 'PAYPAL_AUTH_FAILED', 'No se pudo autenticar con PayPal Sandbox. Revisa las credenciales.');
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 300) * 1000 - 60_000,
  };
  return tokenCache.token;
}

async function paypalRequest(pathname, { method = 'GET', body, requestId } = {}) {
  const doRequest = async () => {
    const token = await getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    if (requestId) headers['PayPal-Request-Id'] = requestId;

    return fetch(`${config.paypal.baseUrl}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  };

  let response = await doRequest();
  if (response.status === 401) {
    tokenCache = { token: null, expiresAt: 0 };
    response = await doRequest();
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const issue = data.details?.[0]?.issue || data.name || 'PAYPAL_ERROR';
    const description = data.details?.[0]?.description || data.message || 'PayPal rechazó la solicitud.';
    logger.warn('paypal api error', {
      path: pathname,
      status: response.status,
      issue,
      debugId: data.debug_id,
    });
    throw new AppError(
      response.status === 422 ? 422 : 502,
      'PAYPAL_API_ERROR',
      `PayPal: ${description}`,
      { issue, debugId: data.debug_id, httpStatus: response.status },
    );
  }
  return data;
}

function mapOrder(data) {
  const approval = (data.links || []).find((link) => link.rel === 'approve' || link.rel === 'payer-action');
  const unit = data.purchase_units?.[0];
  return {
    id: data.id,
    status: data.status,
    approvalUrl: approval?.href || null,
    amount: unit?.amount
      ? { value: Number(unit.amount.value), currency: unit.amount.currency_code }
      : null,
    createdAt: data.create_time || new Date().toISOString(),
  };
}

function buildDescription(quote) {
  const raw = `Nexus ${quote.sourceCountry}→${quote.destinationCountry} · ${quote.id}`;
  return raw.slice(0, 127);
}

async function createOrder({ quote, mode }) {
  if (mode !== 'demo') assertConfigured();
  const value = paypalAmount(quote.amount, quote.sourceCurrency);
  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: quote.id,
        custom_id: quote.id.slice(0, 127),
        invoice_id: `NX-${quote.id}`.slice(0, 127),
        description: buildDescription(quote),
        amount: { currency_code: quote.sourceCurrency, value },
      },
    ],
    application_context: {
      brand_name: 'PayPal Nexus AI',
      locale: 'es-ES',
      landing_page: 'LOGIN',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: `${config.publicBaseUrl}/?checkout=success`,
      cancel_url: `${config.publicBaseUrl}/?checkout=cancel`,
    },
  };

  if (mode === 'demo') {
    const id = `DEMO-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    demoOrders.set(id, { quote, createdAt: Date.now() });
    return {
      id,
      status: 'CREATED',
      approvalUrl: null,
      amount: { value: Number(value), currency: quote.sourceCurrency },
      mode: 'demo',
      createdAt: new Date().toISOString(),
    };
  }

  const data = await paypalRequest('/v2/checkout/orders', {
    method: 'POST',
    body: payload,
    requestId: `nexus-${quote.id}`,
  });
  return { ...mapOrder(data), mode: 'sandbox' };
}

function extractCapture(data) {
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0] || null;
  const payerEmail =
    data.payment_source?.paypal?.email_address ||
    data.payer?.email_address ||
    null;
  return {
    id: capture?.id || data.id,
    status: capture?.status || data.status || 'UNKNOWN',
    orderId: data.id,
    payerEmail,
    amount: capture?.amount
      ? { value: Number(capture.amount.value), currency: capture.amount.currency_code }
      : null,
    capturedAt: capture?.create_time || new Date().toISOString(),
  };
}

async function captureOrder({ orderId, quote, mode }) {
  if (mode !== 'demo') assertConfigured();

  if (mode === 'demo') {
    const record = demoOrders.get(orderId);
    if (record) demoOrders.delete(orderId);
    return {
      id: `DEMO-CAP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      status: 'COMPLETED',
      orderId,
      payerEmail: 'sandbox-buyer@nexus.demo',
      amount: { value: quote.amount, currency: quote.sourceCurrency },
      capturedAt: new Date().toISOString(),
      mode: 'demo',
    };
  }

  const data = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    body: {},
    requestId: `nexus-cap-${orderId}`.slice(0, 108),
  });
  return { ...extractCapture(data), mode: 'sandbox' };
}

async function verifyWebhook({ headers, event }) {
  if (!isConfigured() || !config.paypal.webhookId) {
    return { verified: false, reason: 'webhook_not_configured' };
  }
  const authAlgo = headers['paypal-auth-algo'];
  const certUrl = headers['paypal-cert-url'];
  const transmissionId = headers['paypal-transmission-id'];
  const transmissionSig = headers['paypal-transmission-sig'];
  const transmissionTime = headers['paypal-transmission-time'];

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    return { verified: false, reason: 'missing_headers' };
  }

  const data = await paypalRequest('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: config.paypal.webhookId,
      webhook_event: event,
    },
  });
  return { verified: data.verification_status === 'SUCCESS', reason: data.verification_status };
}

module.exports = {
  isConfigured,
  getAccessToken,
  createOrder,
  captureOrder,
  verifyWebhook,
  demoOrders,
  mapOrder,
  extractCapture,
};
