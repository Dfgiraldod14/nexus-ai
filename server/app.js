'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const logger = require('./lib/logger');
const { Ledger } = require('./services/ledger');
const { rateLimit } = require('./lib/rate-limit');
const { AppError } = require('./lib/errors');
const { createSystemRouter } = require('./routes/system');
const { createAgentRouter } = require('./routes/agent');
const { createPayPalRouter } = require('./routes/paypal');
const { createDashboardRouter } = require('./routes/dashboard');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function securityHeaders(req, res, next) {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self' https://*.paypal.com https://*.paypalobjects.com",
    "style-src 'self' 'unsafe-inline' https://*.paypalobjects.com",
    "img-src 'self' data: https://*.paypalobjects.com https://*.paypal.com",
    "font-src 'self' data:",
    "connect-src 'self' https://*.paypal.com https://*.paypalobjects.com",
    "frame-src https://*.paypal.com",
    "form-action 'self' https://*.paypal.com",
    "frame-ancestors 'none'",
    ...(config.isProd ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.length) {
    if (config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.setHeader('Vary', 'Origin');
    }
  }
  if (req.method === 'OPTIONS' && req.originalUrl.startsWith('/api')) {
    return res.status(204).end();
  }
  return next();
}

function createApp({ ledger = new Ledger() } = {}) {
  const app = express();
  app.locals.ledger = ledger;
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    req.requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 80);
    res.setHeader('X-Request-Id', req.requestId);
    securityHeaders(req, res, next);
  });

  app.use(cors);

  // Vercel / serverless runtimes may pre-parse the JSON body. Tell body-parser
  // to skip its own read in that case (it checks req._body).
  app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      req._body = true;
    }
    next();
  });

  app.use(
    express.json({
      limit: '64kb',
      verify: (req, res, buffer) => {
        req.rawBody = buffer;
      },
    }),
  );

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      if (req.originalUrl === '/api/health') return;
      const meta = {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - startedAt,
        requestId: req.requestId,
      };
      if (res.statusCode >= 500) logger.error('request failed', meta);
      else if (req.originalUrl.startsWith('/api')) logger.info('api request', meta);
    });
    next();
  });

  app.use('/api', rateLimit({ windowMs: 60_000, max: 240, name: 'api' }));
  app.use('/api', createSystemRouter({ ledger }));
  app.use('/api/agent', createAgentRouter({ limiter: rateLimit({ windowMs: 60_000, max: 30, name: 'agent' }) }));
  app.use(
    '/api/paypal',
    createPayPalRouter({ ledger, limiter: rateLimit({ windowMs: 60_000, max: 30, name: 'checkout' }) }),
  );
  app.use('/api/dashboard', createDashboardRouter({ ledger }));

  app.use('/api', (req, res, next) => {
    next(new AppError(404, 'NOT_FOUND', `Endpoint no encontrado: ${req.method} ${req.originalUrl}`));
  });

  app.use(
    express.static(PUBLIC_DIR, {
      extensions: ['html'],
      maxAge: '1h',
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', config.isProd ? 'public, max-age=3600' : 'no-cache');
        }
      },
    }),
  );

  app.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  app.use((req, res, next) => {
    next(new AppError(404, 'NOT_FOUND', 'Recurso no encontrado.'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    let status = Number(err.status) || 500;
    let code = err.code || 'INTERNAL_ERROR';
    let message = err instanceof AppError ? err.message : 'Error interno del servidor.';

    if (err.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'El cuerpo de la solicitud no es JSON válido.';
    } else if (err.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'La solicitud es demasiado grande.';
    }

    if (status >= 500) {
      logger.error('unhandled request error', {
        requestId: req.requestId,
        code,
        message: err.message,
        stack: err.stack,
      });
    }

    const body = {
      ok: false,
      error: {
        code,
        message,
        requestId: req.requestId,
        ...(err.details && status < 500 ? { details: err.details } : {}),
      },
    };
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp, PUBLIC_DIR };
