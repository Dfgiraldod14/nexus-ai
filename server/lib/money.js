'use strict';

const { currencyMeta } = require('./market');

function decimalsFor(currency) {
  return currencyMeta(currency).decimals;
}

function roundMoney(value, currency) {
  const factor = 10 ** decimalsFor(currency);
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/** PayPal expects a string with the currency's number of decimals (JPY = 0). */
function paypalAmount(value, currency) {
  return Number(value).toFixed(decimalsFor(currency));
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

module.exports = { decimalsFor, roundMoney, paypalAmount, round };
