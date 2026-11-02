'use strict';

const http = require('node:http');
const { BASE_RATES } = require('../server/lib/market');

/**
 * Mock of the CDT Streamlit trading engine for local development.
 * It serves the same HTML shell on "/" as Streamlit, plus a JSON strategy
 * feed that the Nexus adapter can consume.
 *
 *   npm run mock-bot
 *   BOT_URL=http://localhost:8501 npm start
 */

const PORT = Number(process.env.MOCK_BOT_PORT) || 8501;
const API_KEY = process.env.MOCK_BOT_API_KEY || '';

function jitter(base, percent = 0.0015) {
  return base * (1 + (Math.random() - 0.5) * percent);
}

function strategyPayload() {
  const rates = {};
  for (const [code, base] of Object.entries(BASE_RATES)) {
    rates[code] = code === 'USD' ? 1 : Number(jitter(base).toFixed(6));
  }
  return {
    engine: 'cdt-arbitrage-mock',
    updatedAt: new Date().toISOString(),
    yieldBps: 62 + Math.floor(Math.random() * 34),
    liquidityUsd: 286_400,
    confidence: 0.94,
    rates,
  };
}

const streamlitShell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CDT Arbitrage Engine</title>
  </head>
  <body>
    <div id="root">
      <h1>CDT Arbitrage Engine</h1>
      <p>Streamlit mock running for PayPal Nexus AI local development.</p>
      <p>JSON strategy feed: <code>/nexus/strategy</code></p>
    </div>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid api key' }));
    return;
  }

  if (path === '/_stcore/health' || path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(streamlitShell);
    return;
  }

  if (path === '/nexus/strategy' || path === '/api/strategy' || path === '/strategy') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(strategyPayload(), null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-bot] Streamlit-style engine listening on http://localhost:${PORT}`);
  console.log(`[mock-bot] strategy feed: http://localhost:${PORT}/nexus/strategy`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
