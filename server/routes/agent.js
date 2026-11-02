'use strict';

const express = require('express');
const config = require('../config');
const agent = require('../services/agent');
const { parseTransferInput } = require('../lib/validate');

function createAgentRouter({ limiter }) {
  const router = express.Router();

  router.post('/optimize', limiter, async (req, res, next) => {
    try {
      const input = parseTransferInput(req.body);
      const quote = await agent.optimize(input);
      res.json({ ok: true, quote, mode: config.mode });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAgentRouter };
