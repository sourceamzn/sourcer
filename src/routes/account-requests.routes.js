'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor } = require('../middleware/authorize');
const service = require('../services/account-request.service');

const clientIdParam = z.object({ clientId: z.string().regex(/^C\d{6}$/) });
const requestIdParam = z.object({ requestId: z.string().regex(/^R-\d{4,}$/) });
const createSchema = z.object({
  clientId: z.string().regex(/^C\d{6}$/, 'clientId canonico requerido (C######)'),
  accountTypeId: z.string().regex(/^at-[a-z-]+$/),
  currency: z.string().length(3).optional(),
  notes: z.string().max(2000).optional(),
});
const rejectSchema = z.object({ notes: z.string().max(2000).optional() });
const listQuery = z.object({
  status: z.enum(['pending', 'open', 'all', 'received', 'in_review', 'approved', 'rejected', 'provisioned']).optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
  offset: z.string().optional(),
});

module.exports = async function accountRequestsRoutes(app) {
  app.post(
    '/account-requests',
    { preHandler: [app.authenticate, validate({ body: createSchema })] },
    async (request, reply) => reply.code(201).send(await service.createRequest(request.body, request.actor))
  );

  app.get(
    '/account-requests',
    { preHandler: [app.authenticate, requireActor('tm', 'staff', 'system'), validate({ query: listQuery })] },
    async (request) => service.listRequests(request.query)
  );

  app.get(
    '/account-requests/:requestId',
    { preHandler: [app.authenticate, validate({ params: requestIdParam })] },
    async (request) => service.getRequest(request.params.requestId, request.actor)
  );

  app.get(
    '/clients/:clientId/account-requests',
    { preHandler: [app.authenticate, validate({ params: clientIdParam })] },
    async (request) => ({ items: await service.listByClient(request.params.clientId, request.actor) })
  );

  app.post(
    '/account-requests/:requestId/approve',
    { preHandler: [app.authenticate, requireActor('tm', 'system'), validate({ params: requestIdParam })] },
    async (request) => service.approveRequest(request.params.requestId, request.actor)
  );

  app.post(
    '/account-requests/:requestId/reject',
    { preHandler: [app.authenticate, requireActor('tm', 'system'), validate({ params: requestIdParam, body: rejectSchema })] },
    async (request) => service.rejectRequest(request.params.requestId, request.body, request.actor)
  );
};
