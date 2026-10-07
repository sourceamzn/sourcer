'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor, requireManagerOrAdmin, assertClientAccess } = require('../middleware/authorize');
const clientService = require('../services/client.service');

const clientIdParam = z.object({ clientId: z.string().regex(/^C\d{6}$/, 'clientId canonico requerido (C######)') });

const createSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  country: z.string().max(80).optional(),
  age: z.number().int().positive().max(120).optional(),
  description: z.string().max(2000).optional(),
  source: z.enum(['web', 'crm', 'manual']).optional(),
  campaignId: z.string().max(80).optional(),
  campaign: z.string().max(120).optional(),
  agentId: z.string().max(80).optional(),
  managerId: z.string().max(80).optional(),
  deskId: z.string().max(80).optional(),
  leadId: z.string().max(20).optional(),
});

const updateSchema = createSchema.partial().extend({
  kycStatus: z.enum(['pending', 'in_review', 'approved', 'rejected']).optional(),
  status: z.enum(['active', 'dormant', 'blocked', 'closed']).optional(),
  /* Agente/manager/desk/campaña vaciables (desasignar) desde el CRM. */
  agentId: z.string().max(80).nullable().optional(),
  managerId: z.string().max(80).nullable().optional(),
  deskId: z.string().max(80).nullable().optional(),
  campaign: z.string().max(120).nullable().optional(),
});

const listQuery = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
  offset: z.string().optional(),
  search: z.string().max(120).optional(),
});

const convertSchema = z.object({
  leadId: z.string().max(20).optional(),
  agentId: z.string().max(80).optional(),
  managerId: z.string().max(80).optional(),
  deskId: z.string().max(80).optional(),
  campaignId: z.string().max(80).optional(),
  campaign: z.string().max(120).optional(),
});

const passwordSchema = z.object({
  newPassword: z.string().min(8).max(200),
});

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().regex(/^C\d{6}$/, 'clientId canonico requerido (C######)')).min(1).max(1000),
});

module.exports = async function clientsRoutes(app) {
  app.post(
    '/clients',
    { preHandler: [app.authenticate, requireActor('staff', 'system'), validate({ body: createSchema })] },
    async (request, reply) => {
      const result = await clientService.createClient(request.body, request.actor);
      return reply.code(result.created ? 201 : 200).send(result.client);
    }
  );

  app.get(
    '/clients',
    { preHandler: [app.authenticate, requireActor('staff', 'tm', 'system'), validate({ query: listQuery })] },
    async (request) => clientService.listClients(request.query)
  );

  app.get(
    '/clients/:clientId',
    { preHandler: [app.authenticate, validate({ params: clientIdParam })] },
    async (request) => {
      assertClientAccess(request.actor, request.params.clientId);
      return clientService.getClient(request.params.clientId);
    }
  );

  app.patch(
    '/clients/:clientId',
    { preHandler: [app.authenticate, validate({ params: clientIdParam, body: updateSchema })] },
    async (request) => {
      assertClientAccess(request.actor, request.params.clientId);
      return clientService.updateClient(request.params.clientId, request.body, request.actor);
    }
  );

  app.delete(
    '/clients/:clientId',
    {
      preHandler: [
        app.authenticate,
        requireActor('staff', 'tm', 'system'),
        requireManagerOrAdmin(),
        validate({ params: clientIdParam }),
      ],
    },
    async (request) => clientService.deleteClient(request.params.clientId, request.actor)
  );

  app.post(
    '/clients/:clientId/convert',
    { preHandler: [app.authenticate, requireActor('staff', 'system'), validate({ params: clientIdParam, body: convertSchema })] },
    async (request) => clientService.convertClient(request.params.clientId, request.body, request.actor)
  );

  app.post(
    '/clients/:clientId/password',
    { preHandler: [app.authenticate, requireActor('staff', 'system'), validate({ params: clientIdParam, body: passwordSchema })] },
    async (request) => clientService.setClientPassword(request.params.clientId, request.body, request.actor)
  );

  /* Borrado definitivo por selección ("seleccionar todo" del CRM). Reservado a
     manager/superadmin. */
  app.post(
    '/clients/bulk-delete',
    {
      preHandler: [
        app.authenticate,
        requireActor('staff', 'tm', 'system'),
        requireManagerOrAdmin(),
        validate({ body: bulkDeleteSchema }),
      ],
    },
    async (request) => clientService.deleteClients(request.body.ids, request.actor)
  );
};
