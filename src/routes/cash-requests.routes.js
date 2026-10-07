'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor } = require('../middleware/authorize');
const service = require('../services/cash-request.service');

const clientIdParam = z.object({ clientId: z.string().regex(/^C\d{6}$/) });
const idParam = z.object({ id: z.string().regex(/^CR-\d{5}$/) });
const createSchema = z.object({
  accountNumber: z.union([z.string(), z.number()]),
  amount: z.number().positive(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
  comment: z.string().max(280).optional(),
  beneficiary: z.string().max(160).optional(),
  iban: z.string().max(60).optional(),
  bic: z.string().max(40).optional(),
});
const listQuery = z.object({
  status: z.enum(['pending', 'approved', 'completed', 'rejected', 'cancelled']).optional(),
  kind: z.enum(['deposit', 'withdrawal']).optional(),
  clientId: z.string().regex(/^C\d{6}$/).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});
const rejectSchema = z.object({ notes: z.string().max(2000).optional() });

module.exports = async function cashRequestsRoutes(app) {
  /* El cliente (o el personal) registra una solicitud de depósito/retirada.
     No mueve saldo: queda pendiente de aprobación. */
  app.post(
    '/clients/:clientId/deposits',
    { preHandler: [app.authenticate, validate({ params: clientIdParam, body: createSchema })] },
    async (request, reply) =>
      reply.code(201).send(await service.createRequest(request.params.clientId, 'deposit', request.body, request.actor))
  );
  app.post(
    '/clients/:clientId/withdrawals',
    { preHandler: [app.authenticate, validate({ params: clientIdParam, body: createSchema })] },
    async (request, reply) =>
      reply.code(201).send(await service.createRequest(request.params.clientId, 'withdrawal', request.body, request.actor))
  );

  app.get(
    '/clients/:clientId/deposits',
    { preHandler: [app.authenticate, validate({ params: clientIdParam })] },
    async (request) => service.listByClient(request.params.clientId, 'deposit', request.actor)
  );
  app.get(
    '/clients/:clientId/withdrawals',
    { preHandler: [app.authenticate, validate({ params: clientIdParam })] },
    async (request) => service.listByClient(request.params.clientId, 'withdrawal', request.actor)
  );

  /* Cola de solicitudes para el personal (CRM / Trading Manager). */
  app.get(
    '/cash-requests',
    { preHandler: [app.authenticate, requireActor('tm', 'staff', 'system'), validate({ query: listQuery })] },
    async (request) => service.listRequests(request.query)
  );
  app.post(
    '/cash-requests/:id/approve',
    { preHandler: [app.authenticate, requireActor('tm', 'staff', 'system'), validate({ params: idParam })] },
    async (request) => service.approve(request.params.id, request.actor)
  );
  app.post(
    '/cash-requests/:id/reject',
    { preHandler: [app.authenticate, requireActor('tm', 'staff', 'system'), validate({ params: idParam, body: rejectSchema })] },
    async (request) => service.reject(request.params.id, request.body, request.actor)
  );
};
