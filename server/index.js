'use strict';

const config = require('./config');
const logger = require('./lib/logger');
const { createApp } = require('./app');

const app = createApp();

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info('PayPal Nexus AI online', {
    url: `http://localhost:${config.port}`,
    mode: config.mode,
    bot: config.bot.url,
    paypal: config.paypal.configured ? config.paypal.env : 'demo',
  });
  if (!config.paypal.configured) {
    logger.warn('PayPal credentials missing: running in DEMO checkout mode');
  }
  if (/change-me/i.test(config.quoteSecret)) {
    logger.warn('QUOTE_SECRET is still the example value; set a strong secret in production');
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});

module.exports = server;
