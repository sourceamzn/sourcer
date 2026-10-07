'use strict';

const { AppError } = require('../lib/errors');

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw AppError.validation('Datos invalidos', result.error.issues);
  }
  return result.data;
}

function apply(target, schema) {
  if (!schema || target === undefined || target === null) return;
  const parsed = parse(schema, target);
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, parsed);
}

function validate(schemas = {}) {
  return async function validateHook(request) {
    apply(request.body, schemas.body);
    apply(request.params, schemas.params);
    apply(request.query, schemas.query);
  };
}

module.exports = { validate, parse };
