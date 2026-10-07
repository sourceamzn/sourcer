'use strict';

const CODES = {
  invalid_credentials: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_error: 422,
  rate_limited: 429,
  account_request_not_allowed: 409,
  internal_error: 500,
};

class AppError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = CODES[code] || 400;
    this.details = details;
  }

  static invalidCredentials(message = 'Credenciales invalidas') {
    return new AppError('invalid_credentials', message);
  }
  static unauthorized(message = 'Autenticacion requerida') {
    return new AppError('unauthorized', message);
  }
  static forbidden(message = 'No autorizado') {
    return new AppError('forbidden', message);
  }
  static notFound(message = 'Recurso no encontrado') {
    return new AppError('not_found', message);
  }
  static conflict(message = 'Conflicto', details) {
    return new AppError('conflict', message, details);
  }
  static validation(message = 'Datos invalidos', details) {
    return new AppError('validation_error', message, details);
  }
  static accountRequestNotAllowed(message = 'Solicitud de cuenta no permitida', details) {
    return new AppError('account_request_not_allowed', message, details);
  }
}

module.exports = { AppError, CODES };
