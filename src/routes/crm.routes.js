'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor } = require('../middleware/authorize');
const crm = require('../services/crm-admin.service');

const idParam = z.object({ id: z.string().min(1).max(120) });
const employeeParam = z.object({ employeeId: z.string().min(1).max(120) });

const departmentBody = z.object({
  id: z.string().max(80).optional(),
  key: z.string().max(80).optional(),
  name: z.string().min(1).max(160),
  active: z.boolean().optional(),
});
const departmentUpdate = z.object({
  key: z.string().max(80).optional(),
  name: z.string().min(1).max(160).optional(),
  active: z.boolean().optional(),
});

const roleBody = z.object({
  id: z.string().max(80).optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  perms: z.array(z.string().max(80)).max(200).optional(),
});
const roleUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(400).optional(),
  perms: z.array(z.string().max(80)).max(200).optional(),
});

const deskBody = z.object({
  id: z.string().max(80).optional(),
  name: z.string().min(1).max(160),
  departmentId: z.string().max(80).nullable().optional(),
  managerId: z.string().max(120).nullable().optional(),
  memberIds: z.array(z.string().max(120)).max(500).optional(),
  viewerIds: z.array(z.string().max(120)).max(500).optional(),
  active: z.boolean().optional(),
});
const deskUpdate = deskBody.partial().omit({ id: true });

const statusBody = z.object({
  id: z.string().max(80).optional(),
  label: z.string().min(1).max(80),
  tone: z.enum(['neutral', 'accent', 'up', 'down', 'warn']).optional(),
  order: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
});
const statusUpdate = statusBody.partial().omit({ id: true });

const employeeBody = z.object({
  name: z.string().min(1).max(120),
  username: z.string().max(120).nullable().optional(),
  email: z.string().email().max(160),
  phone: z.string().max(40).nullable().optional(),
  password: z.string().min(8).max(200).optional(),
  role: z.string().min(1).max(60),
  status: z.enum(['active', 'inactive']).optional(),
  departmentId: z.string().max(80).nullable().optional(),
  deskId: z.string().max(80).nullable().optional(),
  managerId: z.string().max(120).nullable().optional(),
  visibleDeskIds: z.array(z.string().max(120)).max(500).optional(),
});
const employeeUpdate = employeeBody.partial();

const passwordBody = z.object({ newPassword: z.string().min(8).max(200) });

const notesQuery = z.object({
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(120).optional(),
  limit: z.string().optional(),
});
const noteBody = z.object({
  entityType: z.enum(['lead', 'client']),
  entityId: z.string().min(1).max(120),
  text: z.string().min(1).max(4000),
});

module.exports = async function crmRoutes(app) {
  const guard = [app.authenticate, requireActor('staff', 'tm', 'system')];

  app.get('/crm/bootstrap', { preHandler: [...guard] }, async () => crm.bootstrap());

  app.get('/crm/departments', { preHandler: [...guard] }, async () => crm.listDepartments());
  app.post(
    '/crm/departments',
    { preHandler: [...guard, validate({ body: departmentBody })] },
    async (request, reply) => reply.code(201).send(await crm.createDepartment(request.body, request.actor))
  );
  app.patch(
    '/crm/departments/:id',
    { preHandler: [...guard, validate({ params: idParam, body: departmentUpdate })] },
    async (request) => crm.updateDepartment(request.params.id, request.body, request.actor)
  );
  app.delete(
    '/crm/departments/:id',
    { preHandler: [...guard, validate({ params: idParam })] },
    async (request) => crm.deleteDepartment(request.params.id, request.actor)
  );

  app.get('/crm/roles', { preHandler: [...guard] }, async () => crm.listRoles());
  app.post(
    '/crm/roles',
    { preHandler: [...guard, validate({ body: roleBody })] },
    async (request, reply) => reply.code(201).send(await crm.createRole(request.body, request.actor))
  );
  app.patch(
    '/crm/roles/:id',
    { preHandler: [...guard, validate({ params: idParam, body: roleUpdate })] },
    async (request) => crm.updateRole(request.params.id, request.body, request.actor)
  );
  app.delete(
    '/crm/roles/:id',
    { preHandler: [...guard, validate({ params: idParam })] },
    async (request) => crm.deleteRole(request.params.id, request.actor)
  );

  app.get('/crm/desks', { preHandler: [...guard] }, async () => crm.listDesks());
  app.post(
    '/crm/desks',
    { preHandler: [...guard, validate({ body: deskBody })] },
    async (request, reply) => reply.code(201).send(await crm.createDesk(request.body, request.actor))
  );
  app.patch(
    '/crm/desks/:id',
    { preHandler: [...guard, validate({ params: idParam, body: deskUpdate })] },
    async (request) => crm.updateDesk(request.params.id, request.body, request.actor)
  );
  app.delete(
    '/crm/desks/:id',
    { preHandler: [...guard, validate({ params: idParam })] },
    async (request) => crm.deleteDesk(request.params.id, request.actor)
  );

  app.get('/crm/lead-statuses', { preHandler: [...guard] }, async () => crm.listLeadStatuses());
  app.post(
    '/crm/lead-statuses',
    { preHandler: [...guard, validate({ body: statusBody })] },
    async (request, reply) => reply.code(201).send(await crm.createLeadStatus(request.body, request.actor))
  );
  app.patch(
    '/crm/lead-statuses/:id',
    { preHandler: [...guard, validate({ params: idParam, body: statusUpdate })] },
    async (request) => crm.updateLeadStatus(request.params.id, request.body, request.actor)
  );
  app.delete(
    '/crm/lead-statuses/:id',
    { preHandler: [...guard, validate({ params: idParam })] },
    async (request) => crm.deleteLeadStatus(request.params.id, request.actor)
  );

  app.get('/crm/employees', { preHandler: [...guard] }, async () => crm.listEmployees());
  app.post(
    '/crm/employees',
    { preHandler: [...guard, validate({ body: employeeBody })] },
    async (request, reply) => reply.code(201).send(await crm.createEmployee(request.body, request.actor))
  );
  app.patch(
    '/crm/employees/:employeeId',
    { preHandler: [...guard, validate({ params: employeeParam, body: employeeUpdate })] },
    async (request) => crm.updateEmployee(request.params.employeeId, request.body, request.actor)
  );
  app.delete(
    '/crm/employees/:employeeId',
    { preHandler: [...guard, validate({ params: employeeParam })] },
    async (request) => crm.deleteEmployee(request.params.employeeId, request.actor)
  );
  app.post(
    '/crm/employees/:employeeId/password',
    { preHandler: [...guard, validate({ params: employeeParam, body: passwordBody })] },
    async (request) => crm.setEmployeePassword(request.params.employeeId, request.body, request.actor)
  );

  app.get('/notes', { preHandler: [...guard, validate({ query: notesQuery })] }, async (request) =>
    crm.listNotes(request.query)
  );
  app.post(
    '/notes',
    { preHandler: [...guard, validate({ body: noteBody })] },
    async (request, reply) => reply.code(201).send(await crm.createNote(request.body, request.actor))
  );
};
