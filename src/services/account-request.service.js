'use strict';

const db = require('../db');
const ids = require('../lib/ids');
const { AppError } = require('../lib/errors');
const { isUniqueViolation } = require('../lib/pg-errors');
const { parsePagination, paginate } = require('../lib/pagination');
const serialize = require('../domain/serialize');
const clients = require('../repositories/client.repo');
const accounts = require('../repositories/trading-account.repo');
const requests = require('../repositories/account-request.repo');
const accountTypes = require('../repositories/account-type.repo');
const audit = require('../repositories/audit.repo');

function requestedByType(actor) {
  if (actor.type === 'client') return 'client-area';
  if (actor.type === 'system') return 'system';
  if (actor.type === 'tm') return 'staff';
  return 'crm';
}

async function createRequest(input, actor) {
  if (actor.type === 'client' && actor.clientId !== input.clientId) {
    throw AppError.forbidden('Solo puedes solicitar cuentas para tu propio perfil');
  }

  return db.withTransaction(async (tx) => {
    const client = await clients.findById(input.clientId, tx);
    if (!client) throw AppError.notFound('Cliente no encontrado');
    if (client.status === 'closed' || client.status === 'blocked') {
      throw AppError.accountRequestNotAllowed('El cliente no puede solicitar cuentas en este momento');
    }
    if (client.kyc_status === 'rejected') {
      throw AppError.accountRequestNotAllowed('El cliente tiene el KYC rechazado');
    }

    const active = await accounts.findActiveByClient(client.client_id, tx, { forUpdate: true });
    if (active) throw AppError.conflict('El cliente ya tiene una cuenta real activa');

    const open = await requests.findOpenByClient(client.client_id, tx);
    if (open) throw AppError.conflict('Ya existe una solicitud de cuenta en curso', { requestId: open.request_id });

    const type = await accountTypes.findById(input.accountTypeId, tx);
    if (!type || type.status !== 'active') throw AppError.validation('Tipo de cuenta invalido');

    const hasPrior = await requests.hasProvisionedByClient(client.client_id, tx);
    if (!hasPrior && input.accountTypeId !== 'at-essential') {
      throw AppError.accountRequestNotAllowed('La primera cuenta debe ser at-essential', {
        requiredAccountTypeId: 'at-essential',
      });
    }

    const requestId = await requests.nextRequestId(tx);
    let row = await requests.insert(
      {
        requestId,
        clientId: client.client_id,
        accountTypeId: input.accountTypeId,
        currency: input.currency,
        requestedByType: requestedByType(actor),
        requestedById: actor.id,
        notes: input.notes,
        status: 'received',
      },
      tx
    );
    row = await requests.markInReview(requestId, tx);

    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'account_request.create', object: requestId, details: { clientId: client.client_id, accountTypeId: input.accountTypeId } },
      tx
    );

    return serialize.toAccountRequest(row);
  });
}

async function getRequest(requestId, actor) {
  const row = await requests.findById(requestId);
  if (!row) throw AppError.notFound('Solicitud no encontrada');
  if (actor.type === 'client' && actor.clientId !== row.client_id) throw AppError.forbidden();
  return serialize.toAccountRequest(row);
}

async function listByClient(clientId, actor) {
  if (actor.type === 'client' && actor.clientId !== clientId) throw AppError.forbidden();
  const rows = await requests.listByClient(clientId);
  return rows.map(serialize.toAccountRequest);
}

const REQUEST_STATUSES = ['received', 'in_review', 'approved', 'rejected', 'provisioned'];
const PENDING_STATUSES = ['received', 'in_review'];
const STATUS_ALIASES = { pending: PENDING_STATUSES, open: PENDING_STATUSES };

function resolveStatuses(status) {
  if (!status || status === 'all') return null;
  const key = String(status).toLowerCase();
  if (STATUS_ALIASES[key]) return STATUS_ALIASES[key];
  if (REQUEST_STATUSES.includes(key)) return [key];
  return null;
}

async function listRequests(query) {
  const { limit, offset } = parsePagination(query);
  const statuses = resolveStatuses(query.status);
  const rows = await requests.list({ statuses, limit, offset });
  const total = await requests.count({ statuses });
  return paginate(rows.map(serialize.toAccountRequest), limit, offset, total);
}

async function approveRequest(requestId, actor) {
  try {
    return await db.withTransaction(async (tx) => {
      const request = await requests.findById(requestId, tx, { forUpdate: true });
      if (!request) throw AppError.notFound('Solicitud no encontrada');

      if (request.status === 'provisioned') {
        const account = await accounts.findById(request.provisioned_account_id, tx);
        return {
          request: serialize.toAccountRequest(request),
          account: serialize.toTradingAccount(account),
          idempotent: true,
        };
      }
      if (request.status === 'rejected') throw AppError.conflict('La solicitud fue rechazada');

      const active = await accounts.findActiveByClient(request.client_id, tx, { forUpdate: true });
      if (active) throw AppError.conflict('El cliente ya tiene una cuenta real activa');

      const type = await accountTypes.findById(request.account_type_id, tx);
      if (!type) throw AppError.validation('Tipo de cuenta invalido');

      const accountId = ids.accountId();
      const number = await accounts.nextAccountNumber(tx);
      const account = await accounts.insert(
        {
          accountId,
          number,
          clientId: request.client_id,
          accountTypeId: request.account_type_id,
          currency: request.currency,
          leverage: type.leverage || 100,
          status: 'active',
        },
        tx
      );

      const updated = await requests.markProvisioned(requestId, accountId, actor.id, tx);

      await audit.record(
        { actorType: actor.type, actorId: actor.id, action: 'account_request.provision', object: requestId, details: { accountId, number } },
        tx
      );

      return {
        request: serialize.toAccountRequest(updated),
        account: serialize.toTradingAccount(account),
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('El cliente ya tiene una cuenta real activa');
    throw err;
  }
}

async function rejectRequest(requestId, input, actor) {
  return db.withTransaction(async (tx) => {
    const request = await requests.findById(requestId, tx, { forUpdate: true });
    if (!request) throw AppError.notFound('Solicitud no encontrada');
    if (request.status === 'provisioned') throw AppError.conflict('La solicitud ya fue provisionada');
    if (request.status === 'rejected') return serialize.toAccountRequest(request);

    const updated = await requests.markRejected(requestId, actor.id, input.notes, tx);
    await audit.record(
      { actorType: actor.type, actorId: actor.id, action: 'account_request.reject', object: requestId, details: { notes: input.notes || null } },
      tx
    );
    return serialize.toAccountRequest(updated);
  });
}

module.exports = { createRequest, getRequest, listByClient, listRequests, approveRequest, rejectRequest };
