'use strict';

const db = require('../db');

function runner(client) {
  return client || db.pool;
}

/* ------------------------------- Lectura -------------------------------- */
async function listPositions(accountNumber, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM positions WHERE account_number = $1 ORDER BY opened_at DESC',
    [accountNumber]
  );
  return rows;
}

async function listOrders(accountNumber, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM orders WHERE account_number = $1 ORDER BY created_at DESC',
    [accountNumber]
  );
  return rows;
}

async function listTrades(accountNumber, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM trades WHERE account_number = $1 ORDER BY closed_at DESC NULLS LAST',
    [accountNumber]
  );
  return rows;
}

async function listTransactions(accountNumber, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM transactions WHERE account_number = $1 ORDER BY created_at DESC',
    [accountNumber]
  );
  return rows;
}

async function findInstrument(symbol, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM instruments WHERE symbol = $1 AND enabled = true',
    [symbol]
  );
  return rows[0] || null;
}

/* Instrumentos de varios símbolos de una vez, indexados por símbolo. Lo usa la
   valoración para no consultar la tabla una vez por posición. */
async function findInstrumentsBySymbols(symbols, client) {
  if (!symbols || !symbols.length) return {};
  const { rows } = await runner(client).query(
    'SELECT * FROM instruments WHERE symbol = ANY($1)',
    [symbols]
  );
  const map = {};
  rows.forEach((row) => { map[row.symbol] = row; });
  return map;
}

/* Posiciones abiertas de varias cuentas de una vez. */
async function listPositionsByAccounts(accountNumbers, client) {
  if (!accountNumbers || !accountNumbers.length) return [];
  const { rows } = await runner(client).query(
    'SELECT * FROM positions WHERE account_number = ANY($1) ORDER BY opened_at DESC',
    [accountNumbers]
  );
  return rows;
}

/* --------------------------- Secuencias de ids -------------------------- */
const NUMBER_SEQ = { trade: 'trade_number_seq', transaction: 'transaction_number_seq' };

/* Ticket de posicion / orden / historial POR CUENTA. Cada cuenta (cliente)
   empieza en 1 y no arrastra la numeracion de otros clientes. El contador se
   incrementa en una sola sentencia (atómica y segura con varias conexiones). */
async function nextTicket(kind, accountNumber, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO operativa_counters (account_number, kind, value)
     VALUES ($1, $2, 1)
     ON CONFLICT (account_number, kind)
     DO UPDATE SET value = operativa_counters.value + 1
     RETURNING value`,
    [accountNumber, kind]
  );
  return Number(rows[0].value);
}

async function nextNumber(kind, client) {
  const seq = NUMBER_SEQ[kind];
  const { rows } = await runner(client).query(`SELECT nextval('${seq}') AS n`);
  return Number(rows[0].n);
}

/* ------------------------------- Posiciones ----------------------------- */
async function insertPosition(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO positions
       (id, ticket, account_number, symbol, side, volume, open_price, sl, tp, profit, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.id,
      data.ticket,
      data.accountNumber,
      data.symbol,
      data.side,
      data.volume,
      data.openPrice == null ? null : data.openPrice,
      data.sl == null ? null : data.sl,
      data.tp == null ? null : data.tp,
      data.profit || 0,
      data.status || 'open',
    ]
  );
  return rows[0];
}

async function findPositionById(id, client, { forUpdate = false } = {}) {
  const { rows } = await runner(client).query(
    `SELECT * FROM positions WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return rows[0] || null;
}

async function updatePosition(id, patch, client) {
  const columns = [];
  const params = [id];
  ['sl', 'tp', 'volume', 'profit', 'status', 'open_price'].forEach((key) => {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      columns.push(`${key} = $${params.length}`);
    }
  });
  if (!columns.length) return findPositionById(id, client);
  const { rows } = await runner(client).query(
    `UPDATE positions SET ${columns.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] || null;
}

async function deletePosition(id, client) {
  await runner(client).query('DELETE FROM positions WHERE id = $1', [id]);
}

/* -------------------------------- Órdenes ------------------------------- */
async function insertOrder(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO orders
       (id, ticket, account_number, symbol, type, side, volume, price, sl, tp, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.id,
      data.ticket,
      data.accountNumber,
      data.symbol,
      data.type,
      data.side,
      data.volume,
      data.price == null ? null : data.price,
      data.sl == null ? null : data.sl,
      data.tp == null ? null : data.tp,
      data.status || 'pending',
    ]
  );
  return rows[0];
}

async function findOrderById(id, client, { forUpdate = false } = {}) {
  const { rows } = await runner(client).query(
    `SELECT * FROM orders WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return rows[0] || null;
}

async function updateOrder(id, patch, client) {
  const columns = [];
  const params = [id];
  ['status', 'price', 'sl', 'tp'].forEach((key) => {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      columns.push(`${key} = $${params.length}`);
    }
  });
  if (!columns.length) return findOrderById(id, client);
  const { rows } = await runner(client).query(
    `UPDATE orders SET ${columns.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] || null;
}

/* -------------------------------- Trades -------------------------------- */
async function insertTrade(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO trades
       (id, ticket, account_number, symbol, side, volume, open_price, close_price, profit, opened_at, closed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.id,
      data.ticket,
      data.accountNumber,
      data.symbol,
      data.side,
      data.volume,
      data.openPrice == null ? null : data.openPrice,
      data.closePrice == null ? null : data.closePrice,
      data.profit || 0,
      data.openedAt || null,
      data.closedAt || new Date(),
    ]
  );
  return rows[0];
}

/* ----------------------------- Transacciones ---------------------------- */
async function insertTransaction(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO transactions
       (id, account_number, type, amount, currency, balance_after, note, idempotency_key, ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      data.id,
      data.accountNumber,
      data.type,
      data.amount,
      data.currency || 'EUR',
      data.balanceAfter || 0,
      data.note || null,
      data.idempotencyKey || null,
      data.ref || null,
    ]
  );
  return rows[0];
}

async function findTransactionByIdempotency(key, client) {
  if (!key) return null;
  const { rows } = await runner(client).query(
    'SELECT * FROM transactions WHERE idempotency_key = $1',
    [key]
  );
  return rows[0] || null;
}

module.exports = {
  listPositions,
  listOrders,
  listTrades,
  listTransactions,
  findInstrument,
  findInstrumentsBySymbols,
  listPositionsByAccounts,
  nextTicket,
  nextNumber,
  insertPosition,
  findPositionById,
  updatePosition,
  deletePosition,
  insertOrder,
  findOrderById,
  updateOrder,
  insertTrade,
  insertTransaction,
  findTransactionByIdempotency,
};
