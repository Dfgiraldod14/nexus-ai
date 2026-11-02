'use strict';

const { tooManyRequests } = require('./errors');

/**
 * Small in-memory fixed-window rate limiter. Good enough for a single-instance
 * hackathon deployment; swap for Redis/Upstash if you scale horizontally.
 */
function rateLimit({ windowMs = 60_000, max = 60, name = 'default' } = {}) {
  const buckets = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 30_000));
  if (timer.unref) timer.unref();

  return function limiter(req, res, next) {
    const key = `${name}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    let entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(tooManyRequests());
    }
    return next();
  };
}

module.exports = { rateLimit };
