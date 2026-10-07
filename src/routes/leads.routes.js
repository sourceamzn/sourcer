'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor, requireManagerOrAdmin } = require('../middleware/authorize');
const leadService = require('../services/lead.service');

const listQuery = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
  offset: z.string().optional(),
  search: z.string().max(120).optional(),
  statusId: z.string().max(40).optional(),
});

const bodySchema = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().max(160).optional(),
  age: z.number().int().positive().max(120).optional(),
  description: z.string().max(4000).optional(),
  statusId: z.string().max(40).optional(),
  agentId: z.string().max(120).optional(),
  managerId: z.string().max(120).optional(),
  deskId: z.string().max(80).optional(),
  campaignId: z.string().max(80).optional(),
  campaign: z.string().max(120).optional(),
  source: z.string().max(40).optional(),
});

/* En la edición, agente/manager/desk/campaña pueden vaciarse (null) para
   desasignar: el CRM los ofrece como desplegables con opción vacía. */
const updateSchema = bodySchema.partial().extend({
  agentId: z.string().max(120).nullable().optional(),
  managerId: z.string().max(120).nullable().optional(),
  deskId: z.string().max(80).nullable().optional(),
  campaign: z.string().max(120).nullable().optional(),
});

const leadIdParam = z.object({ leadId: z.string().min(1).max(40) });

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1).max(40)).min(1).max(2000),
});

const importLeadSchema = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().max(160).optional(),
  description: z.string().max(4000).optional(),
  statusId: z.string().max(40).optional(),
  agentId: z.string().max(120).nullable().optional(),
  managerId: z.string().max(120).nullable().optional(),
  deskId: z.string().max(80).nullable().optional(),
  campaignId: z.string().max(80).nullable().optional(),
  campaign: z.string().max(120).nullable().optional(),
  source: z.string().max(40).nullable().optional(),
});

const importSchema = z.object({
  leads: z.array(importLeadSchema).min(1).max(2000),
});

module.exports = async function leadsRoutes(app) {
  app.get(
    '/leads',
    { preHandler: [app.authenticate, requireActor('staff', 'tm', 'system'), validate({ query: listQuery })] },
    async (request) => leadService.listLeads(request.query)
  );

  app.post(
    '/leads',
    { preHandler: [app.authenticate, requireActor('staff', 'tm', 'system'), validate({ body: bodySchema })] },
    async (request, reply) => reply.code(201).send(await leadService.createLead(request.body, request.actor))
  );

  app.patch(
    '/leads/:leadId',
    { preHandler: [app.authenticate, requireActor('staff', 'tm', 'system'), validate({ params: leadIdParam, body: updateSchema })] },
    async (request) => leadService.updateLead(request.params.leadId, request.body, request.actor)
  );

  app.delete(
    '/leads/:leadId',
    {
      preHandler: [
        app.authenticate,
        requireActor('staff', 'tm', 'system'),
        requireManagerOrAdmin(),
        validate({ params: leadIdParam }),
      ],
    },
    async (request) => leadService.deleteLead(request.params.leadId, request.actor)
  );

  /* Borrado definitivo por selección ("seleccionar todo" del CRM). Reservado a
     manager/superadmin: el agente no puede vaciar cartera. */
  app.post(
    '/leads/bulk-delete',
    {
      preHandler: [
        app.authenticate,
        requireActor('staff', 'tm', 'system'),
        requireManagerOrAdmin(),
        validate({ body: bulkDeleteSchema }),
      ],
    },
    async (request) => leadService.deleteLeads(request.body.ids, request.actor)
  );

  /* Importación masiva de leads (una base de excel/piped como MyInvestor). */
  app.post(
    '/leads/import',
    {
      preHandler: [
        app.authenticate,
        requireActor('staff', 'tm', 'system'),
        requireManagerOrAdmin(),
        validate({ body: importSchema }),
      ],
    },
    async (request) => leadService.importLeads(request.body.leads, request.actor)
  );

  /* Deshace la ultima importacion masiva: elimina los leads del ultimo lote.
     Reservado a manager/superadmin, igual que el propio importador. */
  app.post(
    '/leads/import/undo',
    {
      preHandler: [
        app.authenticate,
        requireActor('staff', 'tm', 'system'),
        requireManagerOrAdmin(),
      ],
    },
    async (request) => leadService.undoLastImport(request.actor)
  );

  /* Rellena el CRM con las altas antiguas: crea un lead para cada cliente que
     no tenga uno. Idempotente (se puede llamar varias veces). */
  app.post(
    '/leads/backfill',
    { preHandler: [app.authenticate, requireActor('staff', 'tm', 'system')] },
    async () => leadService.backfillLeads()
  );
};
