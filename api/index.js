'use strict';

/**
 * Vercel serverless adapter.
 *
 * vercel.json rewrites every /api/* endpoint to this function with the
 * internal route in the `__route` query parameter. We reconstruct the
 * original URL and hand it to the same Express app used by Render/Docker,
 * so there is a single implementation of the API.
 */

const { createApp } = require('../server/app');

const app = createApp();

module.exports = (req, res) => {
  const route = req.query?.__route;

  if (route !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query || {})) {
      if (key === '__route') continue;
      if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
      else params.append(key, value);
    }
    const query = params.toString();
    req.url = `/api/${String(route).replace(/^\/+/, '')}${query ? `?${query}` : ''}`;
  }

  return app(req, res);
};
