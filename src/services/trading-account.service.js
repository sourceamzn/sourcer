'use strict';

const db = require('../db');
const ids = require('../lib/ids');
const { AppError } = require('../lib/errors');
const { isUniqueViolation } = require('../lib/pg-errors');
const { parsePagination, paginate } = require('../lib/pagination');
const serialize = require('../domain/serialize');
const { assertClientAccess } = require('../middleware/authorize');
const clients = require('../repositories/client.repo');
const accounts = require('../repositories/trading-account.repo');
const requests = require('../repositories/account-request.repo');
const accountTypes = require('../repositories/account-type.repo');
const operativa = require('../repositories/operativa.repo');
const audit = require('../repositories/audit.repo');

async function createAccount(input, actor) {
  /* Un cliente solo puede abrir cuentas a su nombre; el personal y el sistema
     pueden abrirlas para cualquier cliente. */
  assertClientAccess(actor, input.clientId);
  try {
    return await db.withTransaction(async (tx) => {
      const client = await clients.findById(input.clientId, tx);
      if (!client) throw AppError.notFound('Cliente no encontrado');

      const active = await accounts.findActiveByClient(client.client_id, tx, { forUpdate: true });
      if (active) throw AppError.conflict('El cliente ya tiene una cuenta real activa');

      const type = await accountTypes.findById(input.accountTypeId, tx);
      if (!type || type.status !== 'active') throw AppError.validation('Tipo de cuenta invalido');

      const accountId = ids.accountId();
      const number = await accounts.nextAccountNumber(tx);
      const account = await accounts.insert(
        {
          accountId,
          number,
          clientId: client.client_id,
          accountTypeId: input.accountTypeId,
          currency: input.currency,
          leverage: input.leverage || type.leverage || 100,
          status: input.status || 'active',
        },
        tx
      );

      if (input.requestId) {
        const request = await requests.findById(input.requestId, tx, { forUpdate: true });
        if (request && request.status !== 'provisioned') {
          await requests.markProvisioned(request.request_id, accountId, actor.id, tx);
        }
      }

      await audit.record(
        { actorType: actor.type, actorId: actor.id, action: 'trading_account.create', object: accountId, details: { clientId: client.client_id, number } },
        tx
      );

      return serialize.toTradingAccount(account);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('El cliente ya tiene una cuenta real activa');
    throw err;
  }
}

async function getAccount(accountId, actor) {
  const row = await accounts.findById(accountId);
  if (!row) throw AppError.notFound('Cuenta no encontrada');
  assertClientAccess(actor, row.client_id);
  return serialize.toTradingAccount(row);
}

async function listByClient(clientId, actor) {
  assertClientAccess(actor, clientId);
  const rows = await accounts.listByClient(clientId);
  return rows.map(serialize.toTradingAccount);
}

async function listAccounts(query) {
  const { limit, offset } = parsePagination(query);
  const filter = { clientId: query.clientId, status: query.status };
  const rows = await accounts.list({ ...filter, limit, offset });
  const total = await accounts.count(filter);
  return paginate(rows.map(serialize.toTradingAccount), limit, offset, total);
}

async function getOperativa(accountId, kind, actor) {
  const row = await accounts.findById(accountId);
  if (!row) throw AppError.notFound('Cuenta no encontrada');
  assertClientAccess(actor, row.client_id);

  switch (kind) {
    case 'positions':
      return (await operativa.listPositions(row.number)).map(serialize.toPosition);
    case 'orders':
      return (await operativa.listOrders(row.number)).map(serialize.toOrder);
    case 'trades':
      return (await operativa.listTrades(row.number)).map(serialize.toTrade);
    case 'transactions':
      return (await operativa.listTransactions(row.number)).map(serialize.toTransaction);
    default:
      throw AppError.notFound('Recurso no encontrado');
  }
}

/* Activa o suspende una cuenta (bloquear/desbloquear). El estado se guarda en
   el robot para que sobreviva a cualquier recarga de las apps. */
async function updateStatus(accountId, status, actor) {
  return db.withTransaction(async (tx) => {
    const row = await accounts.findById(accountId, tx);
    if (!row) throw AppError.notFound('Cuenta no encontrada');
    const updated = await accounts.setStatus(accountId, status, tx);
    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'trading_account.status', object: accountId, details: { number: row.number, from: row.status, to: status } },
      tx
    );
    return serialize.toTradingAccount(updated);
  });
}

/* Archiva o restaura una cuenta (soft delete). No se archiva si tiene
   posiciones abiertas; el historial se conserva. */
async function setArchived(accountId, archived, actor) {
  return db.withTransaction(async (tx) => {
    const row = await accounts.findById(accountId, tx);
    if (!row) throw AppError.notFound('Cuenta no encontrada');
    if (archived && !row.archived) {
      const positions = await operativa.listPositions(row.number, tx);
      if (positions.some((p) => p.status === 'open')) {
        throw AppError.conflict('No se puede archivar una cuenta con posiciones abiertas');
      }
    }
    const updated = await accounts.setArchived(accountId, archived, tx);
    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: archived ? 'trading_account.archive' : 'trading_account.unarchive', object: accountId, details: { number: row.number } },
      tx
    );
    return serialize.toTradingAccount(updated);
  });
}

/* Borrado definitivo de una cuenta (no del cliente) y su operativa en cascada. */
async function deleteAccount(accountId, actor) {
  return db.withTransaction(async (tx) => {
    const row = await accounts.findById(accountId, tx);
    if (!row) throw AppError.notFound('Cuenta no encontrada');
    const positions = await operativa.listPositions(row.number, tx);
    if (positions.some((p) => p.status === 'open')) {
      throw AppError.conflict('No se puede eliminar una cuenta con posiciones abiertas');
    }
    await accounts.removeAccount(row, tx);
    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'trading_account.delete', object: accountId, details: { number: row.number, clientId: row.client_id } },
      tx
    );
    return { deleted: true, accountId, number: row.number };
  });
}

module.exports = { createAccount, getAccount, listByClient, listAccounts, getOperativa, updateStatus, setArchived, deleteAccount };
