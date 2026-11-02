'use strict';

/**
 * Fetch helper with a hard timeout and latency measurement.
 * Never throws for HTTP error statuses; only for network/timeout failures.
 */
async function request(url, options = {}) {
  const { timeoutMs = 4000, headers = {}, method = 'GET', body, redirect = 'follow' } = options;
  const startedAt = Date.now();
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    contentType: response.headers.get('content-type') || '',
    text,
    json,
    latencyMs: Date.now() - startedAt,
  };
}

function isJson(response) {
  return /application\/(json|[\w.+-]+\+json)/i.test(response.contentType) && response.json !== null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { request, isJson, sleep };
