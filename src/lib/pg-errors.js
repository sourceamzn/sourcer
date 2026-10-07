'use strict';

function isUniqueViolation(err) {
  return err && err.code === '23505';
}

function isForeignKeyViolation(err) {
  return err && err.code === '23503';
}

module.exports = { isUniqueViolation, isForeignKeyViolation };
