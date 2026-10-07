'use strict';

const ids = require('../lib/ids');
const { AppError } = require('../lib/errors');
const { assertClientAccess } = require('../middleware/authorize');
const serialize = require('../domain/serialize');
const tickets = require('../repositories/support-ticket.repo');
const accounts = require('../repositories/trading-account.repo');
const audit = require('../repositories/audit.repo');

const CATEGORIES = ['account', 'deposit', 'withdrawal', 'trading', 'technical', 'verification', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'waiting', 'resolved', 'closed'];

function resolveClientId(actor, input) {
  if (actor.type === 'client') return actor.clientId;
  const clientId = input.clientId ? String(input.clientId) : null;
  if (!clientId) throw AppError.validation('clientId requerido');
  return clientId;
}

async function resolveAccount(clientId, accountNumber) {
  if (accountNumber == null || accountNumber === '') return null;
  const account = await accounts.findByNumber(Number(accountNumber));
  if (!account) throw AppError.notFound('Cuenta no encontrada');
  if (account.client_id !== clientId) throw AppError.forbidden('La cuenta no pertenece al cliente');
  return account;
}

async function createTicket(input, actor) {
  const clientId = resolveClientId(actor, input);
  assertClientAccess(actor, clientId);
  if (!input.subject || !String(input.subject).trim()) throw AppError.validation('Indique un asunto');
  if (!input.message || !String(input.message).trim()) throw AppError.validation('Indique un mensaje');
  const account = await resolveAccount(clientId, input.accountNumber);
  const category = CATEGORIES.indexOf(input.category) >= 0 ? input.category : 'other';
  const priority = PRIORITIES.indexOf(input.priority) >= 0 ? input.priority : 'normal';
  const number = await tickets.nextNumber();
  const message = {
    from: actor.type === 'client' ? 'client' : 'staff',
    author: actor.id,
    text: String(input.message).trim(),
    at: new Date().toISOString(),
  };
  const row = await tickets.insert({
    id: ids.supportTicketId(number),
    clientId,
    accountNumber: account ? account.number : null,
    subject: String(input.subject).trim(),
    category,
    priority,
    status: 'open',
    messages: [message],
  });
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'ticket.create',
    object: row.id,
    details: { clientId, category },
  });
  return serialize.toSupportTicket(row);
}

async function listByClient(clientId, actor) {
  assertClientAccess(actor, clientId);
  const rows = await tickets.listByClient(clientId);
  return { items: rows.map(serialize.toSupportTicket) };
}

async function listTickets(query = {}) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
  const status = STATUSES.indexOf(query.status) >= 0 ? query.status : undefined;
  const clientId = query.clientId ? String(query.clientId) : undefined;
  const rows = await tickets.list({ status, clientId, limit, offset });
  return { items: rows.map(serialize.toSupportTicket) };
}

async function reply(id, input, actor) {
  const ticket = await tickets.findById(id);
  if (!ticket) throw AppError.notFound('Ticket no encontrado');
  assertClientAccess(actor, ticket.client_id);
  if (!input.message || !String(input.message).trim()) throw AppError.validation('Escriba un mensaje');
  const message = {
    from: actor.type === 'client' ? 'client' : 'staff',
    author: actor.id,
    text: String(input.message).trim(),
    at: new Date().toISOString(),
  };
  const reopen = actor.type === 'client' && (ticket.status === 'resolved' || ticket.status === 'closed');
  const status = actor.type === 'client' ? (reopen ? 'open' : 'waiting') : 'waiting';
  const row = await tickets.appendMessage(id, message, status);
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'ticket.message',
    object: id,
    details: { clientId: ticket.client_id, from: message.from },
  });
  return serialize.toSupportTicket(row);
}

async function setStatus(id, status, actor) {
  const ticket = await tickets.findById(id);
  if (!ticket) throw AppError.notFound('Ticket no encontrado');
  if (STATUSES.indexOf(status) < 0) throw AppError.validation('Estado no válido');
  const row = await tickets.setStatus(id, status);
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'ticket.status',
    object: id,
    details: { clientId: ticket.client_id, status },
  });
  return serialize.toSupportTicket(row);
}

module.exports = { createTicket, listByClient, listTickets, reply, setStatus };
