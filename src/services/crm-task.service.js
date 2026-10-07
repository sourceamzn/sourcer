'use strict';

const ids = require('../lib/ids');
const { AppError } = require('../lib/errors');
const serialize = require('../domain/serialize');
const tasks = require('../repositories/crm-task.repo');
const audit = require('../repositories/audit.repo');

const STATUSES = ['open', 'done', 'cancelled'];

async function createTask(input, actor) {
  if (!input.title || !String(input.title).trim()) throw AppError.validation('Indique el título de la tarea');
  const number = await tasks.nextNumber();
  const row = await tasks.insert({
    id: ids.crmTaskId(number),
    entityType: input.entityType || null,
    entityId: input.entityId || null,
    title: String(input.title).trim(),
    due: input.due || null,
    status: 'open',
    userId: input.userId || actor.id,
  });
  await audit.record({
    actorType: actor.type,
    actorId: actor.id,
    action: 'crm.task.create',
    object: row.id,
    details: { entityType: row.entity_type, entityId: row.entity_id },
  });
  return serialize.toCrmTask(row);
}

async function listTasks(query = {}) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 500, 1), 2000);
  const offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
  const entityType = query.entityType || undefined;
  const entityId = query.entityId || undefined;
  const status = STATUSES.indexOf(query.status) >= 0 ? query.status : undefined;
  const rows = await tasks.list({ entityType, entityId, status, limit, offset });
  return { items: rows.map(serialize.toCrmTask) };
}

async function updateTask(id, changes, actor) {
  const existing = await tasks.findById(id);
  if (!existing) throw AppError.notFound('Tarea no encontrada');
  if (changes.status !== undefined && STATUSES.indexOf(changes.status) < 0) {
    throw AppError.validation('Estado de tarea no válido');
  }
  const row = await tasks.update(id, changes);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.task.update', object: id });
  return serialize.toCrmTask(row);
}

async function deleteTask(id, actor) {
  const existing = await tasks.findById(id);
  if (!existing) throw AppError.notFound('Tarea no encontrada');
  await tasks.remove(id);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'crm.task.delete', object: id });
  return { ok: true, id };
}

module.exports = { createTask, listTasks, updateTask, deleteTask };
