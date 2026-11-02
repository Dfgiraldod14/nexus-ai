'use strict';

const config = require('../config');
const logger = require('../lib/logger');
const { request } = require('../lib/http');
const { BASE_RATES } = require('../lib/market');
const { round } = require('../lib/money');

/**
 * Nexus trading-engine adapter.
 *
 * The bot is a Streamlit app: it serves an HTML shell on every path, so a
 * plain GET cannot extract its internal state. The adapter therefore:
 *   1. probes a configurable list of JSON strategy endpoints;
 *   2. falls back to the Streamlit health endpoint (`/_stcore/health`);
 *   3. falls back to a deterministic, minute-seeded liquidity model.
 *
 * Every result is explicitly tagged (bot | bridge | simulated) and surfaced
 * in the UI, so the demo never pretends simulated data is live trading data.
 */

const cache = { at: 0, result: null, promise: null };

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticStrategy() {
  const minute = Math.floor(Date.now() / 60_000);
  const rng = mulberry32(hash(`nexus-arb:${minute}`));
  const rates = {};
  for (const [code, base] of Object.entries(BASE_RATES)) {
    if (code === 'USD') {
      rates[code] = 1;
      continue;
    }
    const drift = 1 + Math.sin(minute / 37 + (hash(code) % 97)) * 0.0012 + (rng() - 0.5) * 0.0026;
    rates[code] = round(base * drift, 6);
  }
  return {
    rates,
    yieldBps: 55 + Math.floor(rng() * 70),
    liquidityUsd: 120_000 + Math.floor(rng() * 380_000),
    confidence: round(0.9 + rng() * 0.09, 3),
    engine: 'cdt-arbitrage',
    updatedAt: new Date().toISOString(),
  };
}

function looseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,\s]/g, '').toLowerCase();
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([km])?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  if (match[2] === 'k') return n * 1_000;
  if (match[2] === 'm') return n * 1_000_000;
  return n;
}

function firstNumber(candidates) {
  for (const candidate of candidates) {
    const n = looseNumber(candidate);
    if (n !== null && Number.isFinite(n)) return n;
  }
  return null;
}

function extractRates(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw =
    payload.rates ||
    payload.fxRates ||
    payload.fx?.rates ||
    payload.market?.rates ||
    payload.pairs ||
    payload.quotes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const rates = {};
  for (const [key, value] of Object.entries(raw)) {
    const rate = looseNumber(value && typeof value === 'object' ? value.rate ?? value.value ?? value.price : value);
    if (rate === null || rate <= 0) continue;
    const token = String(key).toUpperCase().replace(/[^A-Z]/g, '');
    if (token.length === 6) {
      const from = token.slice(0, 3);
      const to = token.slice(3);
      if (from === 'USD') rates[to] = rate;
      else if (to === 'USD') rates[from] = round(1 / rate, 8);
    } else if (token.length === 3 && token !== 'USD') {
      rates[token] = rate;
    }
  }
  if (!Object.keys(rates).length) return null;
  return rates;
}

function normalizeStrategy(payload, latencyMs, endpoint) {
  const rates = extractRates(payload);
  if (!rates) return null;

  const strategyBlock = payload.strategy && typeof payload.strategy === 'object' ? payload.strategy : {};
  const yieldRaw = firstNumber([
    payload.yieldBps,
    payload.yield_bps,
    strategyBlock.yieldBps,
    strategyBlock.yield_bps,
    payload.dailyYieldPct !== undefined ? Number(payload.dailyYieldPct) * 100 : null,
  ]);
  const liquidityRaw = firstNumber([
    payload.liquidityUsd,
    payload.liquidity_usd,
    payload.liquidity,
    payload.depthUsd,
    payload.capitalUsd,
    strategyBlock.liquidityUsd,
  ]);
  const confidenceRaw = firstNumber([payload.confidence, strategyBlock.confidence]);

  const updatedAt = payload.updatedAt || payload.updated_at || payload.timestamp;
  const parsedDate = updatedAt ? new Date(updatedAt) : null;

  const providedRates = Object.keys(rates).filter((code) => Number.isFinite(rates[code]));
  return {
    rates: { ...syntheticStrategy().rates, ...rates, USD: 1 },
    providedRates,
    yieldBps: Math.max(10, Math.min(4_000, yieldRaw === null ? 74 : Math.round(yieldRaw))),
    liquidityUsd:
      liquidityRaw === null ? 180_000 : Math.max(1_000, Math.min(50_000_000, Math.round(liquidityRaw))),
    confidence: confidenceRaw === null ? 0.92 : Math.max(0, Math.min(1, confidenceRaw)),
    engine: String(payload.engine || payload.name || 'cdt-arbitrage').slice(0, 64),
    updatedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : new Date().toISOString(),
    endpoint,
    latencyMs,
  };
}

function authHeaders() {
  const headers = { accept: 'application/json', 'user-agent': 'PayPal-Nexus-AI/1.0' };
  if (config.bot.apiKey) headers['x-api-key'] = config.bot.apiKey;
  return headers;
}

async function checkHealth(timeoutMs) {
  const paths = ['/_stcore/health', '/healthz', '/api/health'];
  for (const pathName of paths) {
    try {
      const res = await request(`${config.bot.url}${pathName}`, {
        timeoutMs,
        headers: { accept: 'text/plain, application/json', 'user-agent': 'PayPal-Nexus-AI/1.0' },
      });
      if (!res.ok) continue;
      const body = (res.text || '').trim();
      if (body.length > 200) continue;
      if (/^(ok|healthy|up|pass)$/i.test(body) || (/json/i.test(res.contentType) && res.json?.status === 'ok')) {
        return { reachable: true, path: pathName, latencyMs: res.latencyMs, httpStatus: res.status };
      }
    } catch {
      // Try the next health path, then fall through to offline.
    }
  }
  return { reachable: false, path: null, latencyMs: null, httpStatus: null };
}

async function probe() {
  const startedAt = Date.now();
  const synthetic = syntheticStrategy();
  let htmlDetected = false;
  let lastStatus = null;
  let endpoint = null;
  let networkFailure = false;

  if (!config.bot.offline) {
    for (const pathName of config.bot.strategyPaths) {
      try {
        const res = await request(`${config.bot.url}${pathName}`, {
          timeoutMs: config.bot.timeoutMs,
          headers: authHeaders(),
        });
        lastStatus = res.status;
        if (res.json && typeof res.json === 'object') {
          const normalized = normalizeStrategy(res.json, res.latencyMs, pathName);
          if (normalized) {
            logger.info('bot strategy feed detected', {
              endpoint: pathName,
              status: res.status,
              latencyMs: res.latencyMs,
              rates: normalized.providedRates.length,
            });
            return {
              reachable: true,
              source: 'bot',
              httpStatus: res.status,
              endpoint: pathName,
              latencyMs: res.latencyMs,
              checkedAt: new Date().toISOString(),
              feedExposed: true,
              strategy: { ...normalized, source: 'bot', feedExposed: true },
            };
          }
        }
        if (/text\/html/i.test(res.contentType)) {
          htmlDetected = true;
          endpoint = pathName;
          break;
        }
      } catch (err) {
        networkFailure = true;
        logger.warn('bot strategy probe failed', { endpoint: pathName, error: err.name });
        break;
      }
    }

    const health = networkFailure
      ? { reachable: false, path: null, latencyMs: null }
      : await checkHealth(Math.min(1_800, config.bot.timeoutMs));

    if (health.reachable) {
      logger.info('bot online, strategy feed via nexus bridge', {
        healthPath: health.path,
        latencyMs: health.latencyMs,
        htmlDetected,
        lastStatus,
      });
      return {
        reachable: true,
        source: 'bridge',
        httpStatus: 200,
        endpoint: endpoint || health.path,
        latencyMs: health.latencyMs,
        checkedAt: new Date().toISOString(),
        feedExposed: false,
        strategy: {
          ...synthetic,
          source: 'bridge',
          engine: 'cdt-arbitrage',
          feedExposed: false,
          probeMs: Date.now() - startedAt,
        },
      };
    }
  }

  logger.warn('bot unreachable, using deterministic simulation', {
    botUrl: config.bot.url,
    offline: config.bot.offline,
    probeMs: Date.now() - startedAt,
  });
  return {
    reachable: false,
    source: 'simulated',
    httpStatus: lastStatus,
    endpoint: null,
    latencyMs: null,
    checkedAt: new Date().toISOString(),
    feedExposed: false,
    strategy: { ...synthetic, source: 'simulated', engine: 'cdt-arbitrage', feedExposed: false },
  };
}

async function getStrategy({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.result && now - cache.at < config.bot.cacheMs) {
    return cache.result;
  }
  if (cache.promise) return cache.promise;

  cache.promise = probe()
    .catch((err) => {
      logger.error('bot probe crashed', { error: err.message });
      const synthetic = syntheticStrategy();
      return {
        reachable: false,
        source: 'simulated',
        httpStatus: null,
        endpoint: null,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        feedExposed: false,
        strategy: { ...synthetic, source: 'simulated' },
      };
    })
    .then((result) => {
      cache.result = result;
      cache.at = Date.now();
      return result;
    })
    .finally(() => {
      cache.promise = null;
    });

  return cache.promise;
}

function sourceLabel(source) {
  if (source === 'bot') return 'Motor en vivo';
  if (source === 'bridge') return 'Motor vinculado · puente Nexus';
  return 'Simulación determinista';
}

function engineStatus(source) {
  if (source === 'bot') return { state: 'live', label: 'Motor en vivo', tone: 'live' };
  if (source === 'bridge') return { state: 'linked', label: 'Motor en línea · puente', tone: 'warn' };
  return { state: 'offline', label: 'Modo simulación', tone: 'offline' };
}

async function getStatus() {
  const result = await getStrategy();
  const status = engineStatus(result.source);
  return {
    engine: status.state,
    label: status.label,
    tone: status.tone,
    source: result.source,
    sourceLabel: sourceLabel(result.source),
    reachable: result.reachable,
    botUrl: config.bot.url,
    endpoint: result.endpoint,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    feedExposed: result.feedExposed,
    checkedAt: result.checkedAt,
    cacheTtlMs: config.bot.cacheMs,
    strategy: {
      engine: result.strategy.engine,
      yieldBps: result.strategy.yieldBps,
      liquidityUsd: result.strategy.liquidityUsd,
      confidence: result.strategy.confidence,
      updatedAt: result.strategy.updatedAt,
      pairCount: Object.keys(result.strategy.rates || {}).length,
    },
  };
}

module.exports = {
  getStrategy,
  getStatus,
  syntheticStrategy,
  extractRates,
  normalizeStrategy,
  sourceLabel,
  engineStatus,
  config,
};
