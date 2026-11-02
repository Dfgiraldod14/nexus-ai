'use strict';

class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
  }
}

function badRequest(code, message, details) {
  return new AppError(400, code, message, details);
}

function unauthorized(code, message, details) {
  return new AppError(401, code, message, details);
}

function notFound(code, message, details) {
  return new AppError(404, code, message, details);
}

function tooManyRequests(message = 'Demasiadas solicitudes. Intenta de nuevo en unos segundos.') {
  return new AppError(429, 'RATE_LIMITED', message);
}

function upstream(code, message, details) {
  return new AppError(502, code, message, details);
}

module.exports = { AppError, badRequest, unauthorized, notFound, tooManyRequests, upstream };
