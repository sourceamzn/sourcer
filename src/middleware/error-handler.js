'use strict';

const { ZodError } = require('zod');
const { AppError } = require('../lib/errors');

function errorHandler(err, request, reply) {
  if (err instanceof AppError) {
    reply.code(err.status).send({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    reply.code(422).send({
      error: { code: 'validation_error', message: 'Datos invalidos', details: err.issues },
    });
    return;
  }

  if (err && err.statusCode === 429) {
    reply.code(429).send({ error: { code: 'rate_limited', message: 'Demasiadas solicitudes' } });
    return;
  }

  if (err && err.code === '23505') {
    reply.code(409).send({ error: { code: 'conflict', message: 'El recurso ya existe' } });
    return;
  }

  if (err && err.code === '23503') {
    reply.code(409).send({ error: { code: 'conflict', message: 'Referencia invalida' } });
    return;
  }

  if (err && err.validation) {
    reply.code(400).send({ error: { code: 'validation_error', message: err.message } });
    return;
  }

  request.log.error(err);
  reply.code(500).send({ error: { code: 'internal_error', message: 'Error interno del servidor' } });
}

module.exports = { errorHandler };
