'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor } = require('../middleware/authorize');
const tasks = require('../services/crm-task.service');
const auditRepo = require('../repositories/audit.repo');
const serialize = require('../domain/serialize');

const idParam = z.object({ id: z.string().min(1).max(80) });
const createSchema = z.object({
  entityType: z.enum(['lead', 'client']).optional(),
  entityId: z.string().max(120).optional(),
  title: z.string().min(1).max(400),
  due: z.string().max(40).optional(),
  userId: z.string().max(120).optional(),
});
const updateSchema = z.object({
  title: z.string().min(1).max(400).optional(),
  due: z.string().max(40).nullable().optional(),
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  userId: z.string().max(120).nullable().optional(),
});
const listQuery = z.object({
  entityType: z.enum(['lead', 'client']).optional(),
  entityId: z.string().max(120).optional(),
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

module.exports = async function crmTasksRoutes(app) {
  const guard = [app.authenticate, requireActor('staff', 'tm', 'system')];

  app.get('/crm/tasks', { preHandler: [...guard, validate({ query: listQuery })] }, async (request) => tasks.listTasks(request.query));
  app.post('/crm/tasks', { preHandler: [...guard, validate({ body: createSchema })] }, async (request, reply) => reply.code(201).send(await tasks.createTask(request.body, request.actor)));
  app.patch('/crm/tasks/:id', { preHandler: [...guard, validate({ params: idParam, body: updateSchema })] }, async (request) => tasks.updateTask(request.params.id, request.body, request.actor));
  app.delete('/crm/tasks/:id', { preHandler: [...guard, validate({ params: idParam })] }, async (request) => tasks.deleteTask(request.params.id, request.actor));

  /* Historial de auditoría real del robot (antes solo en el navegador). */
  app.get('/crm/audit', { preHandler: [...guard] }, async (request) => {
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit, 10) || 200, 1), 1000);
    const offset = Math.max(Number.parseInt(request.query.offset, 10) || 0, 0);
    const rows = await auditRepo.list({ limit, offset });
    return { items: rows.map(serialize.toAuditEvent) };
  });
};
