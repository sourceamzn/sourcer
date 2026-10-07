'use strict';

const db = require('../db');

function runner(client) {
  return client || db.pool;
}

async function list({ onlyActive = false } = {}, client) {
  const where = onlyActive ? "WHERE status = 'active'" : '';
  const { rows } = await runner(client).query(
    `SELECT * FROM account_types ${where} ORDER BY account_type_id`
  );
  return rows;
}

async function findById(accountTypeId, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM account_types WHERE account_type_id = $1',
    [accountTypeId]
  );
  return rows[0] || null;
}

module.exports = { list, findById };
