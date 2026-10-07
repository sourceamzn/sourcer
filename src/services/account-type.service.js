'use strict';

const accountTypes = require('../repositories/account-type.repo');
const serialize = require('../domain/serialize');
const { AppError } = require('../lib/errors');

async function listAccountTypes() {
  const rows = await accountTypes.list({ onlyActive: true });
  return rows.map(serialize.toAccountType);
}

async function getAccountType(accountTypeId) {
  const row = await accountTypes.findById(accountTypeId);
  if (!row) throw AppError.notFound('Tipo de cuenta no encontrado');
  return serialize.toAccountType(row);
}

module.exports = { listAccountTypes, getAccountType };
