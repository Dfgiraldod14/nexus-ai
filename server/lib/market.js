'use strict';

/**
 * Reference market data.
 *
 * These rates are only a deterministic fallback used when the trading engine
 * does not expose a JSON strategy feed. They are NOT live market quotes.
 * Rates are expressed as "units of currency per 1 USD".
 */

const BASE_RATES = {
  USD: 1,
  EUR: 0.9214,
  GBP: 0.7831,
  CAD: 1.3712,
  AUD: 1.5124,
  MXN: 18.42,
  BRL: 5.43,
  JPY: 151.34,
  SGD: 1.3412,
  HKD: 7.8102,
  COP: 4021.5,
  ARS: 985.4,
  CLP: 945.2,
  PEN: 3.781,
  INR: 83.42,
  PHP: 56.82,
  NGN: 1583.0,
  ZAR: 18.62,
  AED: 3.6725,
  CRC: 512.4,
  DOP: 59.2,
  GTQ: 7.82,
  UYU: 39.5,
  BOB: 6.91,
  PYG: 7300.0,
};

const CURRENCY_META = {
  USD: { name: 'Dólar estadounidense', symbol: '$', decimals: 2 },
  EUR: { name: 'Euro', symbol: '€', decimals: 2 },
  GBP: { name: 'Libra esterlina', symbol: '£', decimals: 2 },
  CAD: { name: 'Dólar canadiense', symbol: 'C$', decimals: 2 },
  AUD: { name: 'Dólar australiano', symbol: 'A$', decimals: 2 },
  MXN: { name: 'Peso mexicano', symbol: 'MX$', decimals: 2 },
  BRL: { name: 'Real brasileño', symbol: 'R$', decimals: 2 },
  JPY: { name: 'Yen japonés', symbol: '¥', decimals: 0 },
  SGD: { name: 'Dólar de Singapur', symbol: 'S$', decimals: 2 },
  HKD: { name: 'Dólar de Hong Kong', symbol: 'HK$', decimals: 2 },
  COP: { name: 'Peso colombiano', symbol: '$', decimals: 0 },
  ARS: { name: 'Peso argentino', symbol: '$', decimals: 2 },
  CLP: { name: 'Peso chileno', symbol: '$', decimals: 0 },
  PEN: { name: 'Sol peruano', symbol: 'S/', decimals: 2 },
  INR: { name: 'Rupia india', symbol: '₹', decimals: 2 },
  PHP: { name: 'Peso filipino', symbol: '₱', decimals: 2 },
  NGN: { name: 'Naira nigeriana', symbol: '₦', decimals: 2 },
  ZAR: { name: 'Rand sudafricano', symbol: 'R', decimals: 2 },
  AED: { name: 'Dirham de EAU', symbol: 'د.إ', decimals: 2 },
  CRC: { name: 'Colón costarricense', symbol: '₡', decimals: 2 },
  DOP: { name: 'Peso dominicano', symbol: 'RD$', decimals: 2 },
  GTQ: { name: 'Quetzal guatemalteco', symbol: 'Q', decimals: 2 },
  UYU: { name: 'Peso uruguayo', symbol: '$U', decimals: 2 },
  BOB: { name: 'Boliviano', symbol: 'Bs', decimals: 2 },
  PYG: { name: 'Guaraní paraguayo', symbol: '₲', decimals: 0 },
};

/** Currencies accepted by the PayPal Orders v2 API for this demo. */
const PAYPAL_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'MXN', 'BRL', 'JPY', 'SGD', 'HKD']);

const COUNTRIES = [
  { code: 'US', name: 'Estados Unidos', currency: 'USD', flag: '🇺🇸', send: true, receive: true },
  { code: 'ES', name: 'España', currency: 'EUR', flag: '🇪🇸', send: true, receive: true },
  { code: 'DE', name: 'Alemania', currency: 'EUR', flag: '🇩🇪', send: true, receive: true },
  { code: 'FR', name: 'Francia', currency: 'EUR', flag: '🇫🇷', send: true, receive: true },
  { code: 'GB', name: 'Reino Unido', currency: 'GBP', flag: '🇬🇧', send: true, receive: true },
  { code: 'CA', name: 'Canadá', currency: 'CAD', flag: '🇨🇦', send: true, receive: true },
  { code: 'AU', name: 'Australia', currency: 'AUD', flag: '🇦🇺', send: true, receive: true },
  { code: 'MX', name: 'México', currency: 'MXN', flag: '🇲🇽', send: true, receive: true },
  { code: 'BR', name: 'Brasil', currency: 'BRL', flag: '🇧🇷', send: true, receive: true },
  { code: 'JP', name: 'Japón', currency: 'JPY', flag: '🇯🇵', send: true, receive: true },
  { code: 'SG', name: 'Singapur', currency: 'SGD', flag: '🇸🇬', send: true, receive: true },
  { code: 'CO', name: 'Colombia', currency: 'COP', flag: '🇨🇴', send: false, receive: true },
  { code: 'AR', name: 'Argentina', currency: 'ARS', flag: '🇦🇷', send: false, receive: true },
  { code: 'CL', name: 'Chile', currency: 'CLP', flag: '🇨🇱', send: false, receive: true },
  { code: 'PE', name: 'Perú', currency: 'PEN', flag: '🇵🇪', send: false, receive: true },
  { code: 'EC', name: 'Ecuador', currency: 'USD', flag: '🇪🇨', send: false, receive: true },
  { code: 'IN', name: 'India', currency: 'INR', flag: '🇮🇳', send: false, receive: true },
  { code: 'PH', name: 'Filipinas', currency: 'PHP', flag: '🇵🇭', send: false, receive: true },
  { code: 'NG', name: 'Nigeria', currency: 'NGN', flag: '🇳🇬', send: false, receive: true },
  { code: 'ZA', name: 'Sudáfrica', currency: 'ZAR', flag: '🇿🇦', send: false, receive: true },
  { code: 'AE', name: 'Emiratos Árabes Unidos', currency: 'AED', flag: '🇦🇪', send: false, receive: true },
  { code: 'CR', name: 'Costa Rica', currency: 'CRC', flag: '🇨🇷', send: false, receive: true },
  { code: 'DO', name: 'República Dominicana', currency: 'DOP', flag: '🇩🇴', send: false, receive: true },
  { code: 'GT', name: 'Guatemala', currency: 'GTQ', flag: '🇬🇹', send: false, receive: true },
  { code: 'UY', name: 'Uruguay', currency: 'UYU', flag: '🇺🇾', send: false, receive: true },
  { code: 'BO', name: 'Bolivia', currency: 'BOB', flag: '🇧🇴', send: false, receive: true },
  { code: 'PY', name: 'Paraguay', currency: 'PYG', flag: '🇵🇾', send: false, receive: true },
];

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

function currencyMeta(code) {
  return CURRENCY_META[code] || { name: code, symbol: code, decimals: 2 };
}

module.exports = {
  BASE_RATES,
  CURRENCY_META,
  PAYPAL_CURRENCIES,
  COUNTRIES,
  COUNTRY_BY_CODE,
  currencyMeta,
};
