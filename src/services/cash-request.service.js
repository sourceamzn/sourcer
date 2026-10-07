'use strict';

const ids = require('../lib/ids');
const { AppError } = require('../lib/errors');
const { assertClientAccess } = require('../middleware/authorize');
const serialize = require('../domain/serialize');
const requests = require('../repositories/cash-request.repo');
const accounts = require('../repositories/trading-account.repo');
const audit = require('../repositories/audit.repo');
const money = require('./trading-money.service');

const KINDS = ['deposit', 'withdrawal'];
const METHODS = ['card', 'transfer', 'bank'];
const OPEN = ['pending'];

async function accountFor(clientId, accountNumber) {
  const account = await accounts.findByNumber(Number(accountNumber));
  if (!account) throw AppError.notFound('Cuenta no encontrada');
  if (account.client_id !== clientId) throw AppError.forbidden('La cuenta no pertenece al cliente');
  return account;
}

function normalizeAmount(value) {
  const amount = Math.round((Number(value) || 0) * 100) / 100;
  if (!(amount > 0)) throw AppError.validation('Importe no válido');
  return amount;
}

/* El cliente registra una solicitud de depósito o retirada. NO mueve saldo:
   queda 'pending' hasta que el personal la aprueba. */
async function createRequest(clientId, kind, input, actor) {
  assertClientAccess(actor, clientId);
  if (KINDS.indexOf(kind) < 0) throw AppError.validation('Tipo de solicitud no válido');
  const account = await accountFor(clientId, input.accountNumber);
  const amount = normalizeAmount(input.amount);
  const method = METHODS.indexOf(input.method) >= 0 ? input.method : kind === 'deposit' ? 'transfer' : 'bank';

  if (kind === 'withdrawal') {
    if (account.status !== 'active') throw AppError.conflict('La cuenta no está activa');
    if (account.archived) throw AppError.conflict('La cuenta está archivada');
    if (amount > Number(account.balance)) {
      throw AppError.conflict(`Saldo insuficiente: dispone de ${Number(account.balance).toFixed(2)} ${account.currency}`);
    }
  }

  const number = await requests.nextNumber();
  const row = await requests.insert({
    id: ids.cashRequestId(number),
    clientId,
    accountNumber: account.number,
    kind,
    amount,
    currency: account.currency,
    method,
    reference: input.reference,
    comment: input.comment,
    beneficiary: input.beneficiary,
    iban: input.iban,
    bic: input.bic,
    status: 'pending',
  });
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: `cash.${kind}.request`,
    object: row.id,
    details: { clientId, accountNumber: account.number, amount, currency: account.currency },
  });
  return serialize.toCashRequest(row);
}

async function listByClient(clientId, kind, actor) {
  assertClientAccess(actor, clientId);
  const rows = await requests.listByClient(clientId, KINDS.indexOf(kind) >= 0 ? kind : null);
  return { items: rows.map(serialize.toCashRequest) };
}

async function listRequests(query = {}) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
  const status = ['pending', 'approved', 'completed', 'rejected', 'cancelled'].indexOf(query.status) >= 0 ? query.status : undefined;
  const kind = KINDS.indexOf(query.kind) >= 0 ? query.kind : undefined;
  const clientId = query.clientId ? String(query.clientId) : undefined;
  const rows = await requests.list({ status, kind, clientId, limit, offset });
  return { items: rows.map(serialize.toCashRequest) };
}

/* Aprobación del personal: aquí SÍ se mueve el dinero, reutilizando el servicio
   de dinero del Trading Manager (fuente de verdad del saldo y del libro). */
async function approve(id, actor) {
  const request = await requests.findById(id);
  if (!request) throw AppError.notFound('Solicitud no encontrada');
  if (OPEN.indexOf(request.status) < 0) throw AppError.conflict('La solicitud ya fue gestionada');

  const account = await accounts.findByNumber(request.account_number);
  if (!account) throw AppError.notFound('Cuenta no encontrada');

  const input = {
    amount: Number(request.amount),
    method: request.method,
    reference: request.reference,
    comment: request.comment,
    idempotencyKey: `cr-${request.id}`,
  };
  const tx = request.kind === 'deposit'
    ? await money.deposit(account.account_id, input, actor)
    : await money.withdraw(account.account_id, input, actor);

  const row = await requests.decide(request.id, {
    status: 'completed',
    transactionId: tx && tx.id,
    reviewedBy: actor.id,
  });
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: `cash.${request.kind}.approve`,
    object: request.id,
    details: { clientId: request.client_id, accountNumber: request.account_number, amount: Number(request.amount) },
  });
  return serialize.toCashRequest(row);
}

async function reject(id, input, actor) {
  const request = await requests.findById(id);
  if (!request) throw AppError.notFound('Solicitud no encontrada');
  if (OPEN.indexOf(request.status) < 0) throw AppError.conflict('La solicitud ya fue gestionada');
  const row = await requests.decide(request.id, {
    status: 'rejected',
    reviewedBy: actor.id,
    notes: input && input.notes ? String(input.notes).slice(0, 2000) : null,
  });
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: `cash.${request.kind}.reject`,
    object: request.id,
    details: { clientId: request.client_id, accountNumber: request.account_number },
  });
  return serialize.toCashRequest(row);
}

module.exports = { createRequest, listByClient, listRequests, approve, reject };
