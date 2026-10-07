'use strict';

const db = require('../db');
const ids = require('../lib/ids');

function runner(client) {
  return client || db.pool;
}

async function nextAccountNumber(client) {
  const { rows } = await runner(client).query("SELECT nextval('account_number_seq') AS n");
  return Number(rows[0].n);
}

async function insert(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO trading_accounts
       (account_id, number, client_id, account_type_id, currency, leverage,
        balance, equity, margin, free_margin, status, archived)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      data.accountId,
      data.number,
      data.clientId,
      data.accountTypeId,
      data.currency || 'EUR',
      data.leverage,
      data.balance || 0,
      data.equity || 0,
      data.margin || 0,
      data.freeMargin || 0,
      data.status || 'pending',
      data.archived || false,
    ]
  );
  return rows[0];
}

async function findById(accountId, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM trading_accounts WHERE account_id = $1',
    [accountId]
  );
  return rows[0] || null;
}

async function findByNumber(number, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM trading_accounts WHERE number = $1',
    [number]
  );
  return rows[0] || null;
}

async function listByClient(clientId, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM trading_accounts WHERE client_id = $1 ORDER BY created_at ASC',
    [clientId]
  );
  return rows;
}

async function list({ clientId, status, limit, offset } = {}, client) {
  const params = [];
  const where = [];
  if (clientId) {
    params.push(clientId);
    where.push(`ta.client_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`ta.status = $${params.length}`);
  }
  params.push(limit, offset);
  const { rows } = await runner(client).query(
    `SELECT ta.*,
            c.first_name, c.last_name, c.email AS client_email
       FROM trading_accounts ta
       LEFT JOIN clients c ON c.client_id = ta.client_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ta.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function count({ clientId, status } = {}, client) {
  const params = [];
  const where = [];
  if (clientId) {
    params.push(clientId);
    where.push(`client_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  const { rows } = await runner(client).query(
    `SELECT COUNT(*)::int AS total FROM trading_accounts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params
  );
  return rows[0].total;
}

async function findActiveByClient(clientId, client, { forUpdate = false } = {}) {
  const { rows } = await runner(client).query(
    `SELECT * FROM trading_accounts
      WHERE client_id = $1 AND archived = false
      ${forUpdate ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

async function setStatus(accountId, status, client) {
  const { rows } = await runner(client).query(
    'UPDATE trading_accounts SET status = $2, updated_at = now() WHERE account_id = $1 RETURNING *',
    [accountId, status]
  );
  return rows[0] || null;
}

async function setArchived(accountId, archived, client) {
  const { rows } = await runner(client).query(
    'UPDATE trading_accounts SET archived = $2, updated_at = now() WHERE account_id = $1 RETURNING *',
    [accountId, !!archived]
  );
  return rows[0] || null;
}

/* Borrado definitivo de una cuenta y TODA su operativa. Las claves foraneas de
   orders/positions/trades/transactions y cash_requests apuntan a
   trading_accounts(number) sin ON DELETE CASCADE, asi que se eliminan
   explicitamente en la misma transaccion que abre el servicio. Los tickets de
   soporte conservan su historial: solo se desvinculan de la cuenta. Las
   solicitudes de aprovisionamiento que apuntaban a esta cuenta se liberan para
   no romper su FK. */
async function removeAccount(account, client) {
  const r = runner(client);
  const number = account.number;
  const accountId = account.account_id;
  await r.query('DELETE FROM positions WHERE account_number = $1', [number]);
  await r.query('DELETE FROM orders WHERE account_number = $1', [number]);
  await r.query('DELETE FROM trades WHERE account_number = $1', [number]);
  await r.query('DELETE FROM transactions WHERE account_number = $1', [number]);
  await r.query('DELETE FROM cash_requests WHERE account_number = $1', [number]);
  await r.query('UPDATE support_tickets SET account_number = NULL WHERE account_number = $1', [number]);
  await r.query('DELETE FROM operativa_counters WHERE account_number = $1', [number]);
  await r.query('UPDATE account_requests SET provisioned_account_id = NULL WHERE provisioned_account_id = $1', [accountId]);
  await r.query('DELETE FROM trading_accounts WHERE account_id = $1', [accountId]);
}

/* Aplica un movimiento al saldo (P/L al cerrar, depósito, retirada…). Mantiene
   equity y margen libre alineados con el nuevo saldo más el crédito (bono), ya
   que el motor no retiene margen. */
async function applyBalance(accountId, delta, client) {
  const { rows } = await runner(client).query(
    `UPDATE trading_accounts
        SET balance     = balance + $2,
            equity      = balance + $2 + bonus,
            free_margin = balance + $2 + bonus,
            last_activity = now(),
            updated_at  = now()
      WHERE account_id = $1
      RETURNING *`,
    [accountId, delta]
  );
  return rows[0] || null;
}

/* Aplica un movimiento al crédito (bono). El bono no es retirable: solo suma
   al patrimonio disponible. `delta` positivo añade; negativo retira. */
async function applyBonus(accountId, delta, client) {
  const { rows } = await runner(client).query(
    `UPDATE trading_accounts
        SET bonus       = bonus + $2,
            equity      = balance + bonus + $2,
            free_margin = balance + bonus + $2,
            last_activity = now(),
            updated_at  = now()
      WHERE account_id = $1
      RETURNING *`,
    [accountId, delta]
  );
  return rows[0] || null;
}

module.exports = {
  nextAccountNumber,
  insert,
  findById,
  findByNumber,
  listByClient,
  list,
  count,
  findActiveByClient,
  setStatus,
  setArchived,
  removeAccount,
  applyBalance,
  applyBonus,
};
