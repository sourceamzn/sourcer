'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor } = require('../middleware/authorize');
const service = require('../services/support-ticket.service');

const clientIdParam = z.object({ clientId: z.string().regex(/^C\d{6}$/) });
const idParam = z.object({ id: z.string().regex(/^TK-\d{5}$/) });
const createSchema = z.object({
  clientId: z.string().regex(/^C\d{6}$/).optional(),
  accountNumber: z.union([z.string(), z.number()]).optional(),
  subject: z.string().min(1).max(200),
  category: z.enum(['account', 'deposit', 'withdrawal', 'trading', 'technical', 'verification', 'other']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  message: z.string().min(1).max(4000),
});
const messageSchema = z.object({ message: z.string().min(1).max(4000) });
const statusSchema = z.object({ status: z.enum(['open', 'waiting', 'resolved', 'closed']) });
const listQuery = z.object({
  status: z.enum(['open', 'waiting', 'resolved', 'closed']).optional(),
  clientId: z.string().regex(/^C\d{6}$/).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

module.exports = async function supportTicketsRoutes(app) {
  app.post(
    '/tickets',
    { preHandler: [app.authenticate, validate({ body: createSchema })] },
    async (request, reply) => reply.code(201).send(await service.createTicket(request.body, request.actor))
  );

  app.get(
    '/clients/:clientId/tickets',
    { preHandler: [app.authenticate, validate({ params: clientIdParam })] },
    async (request) => service.listByClient(request.params.clientId, request.actor)
  );

  app.get(
    '/tickets',
    { preHandler: [app.authenticate, requireActor('tm', 'staff', 'system'), validate({ query: listQuery })] },
    async (request) => service.listTickets(request.query)
  );

  app.post(
    '/tickets/:id/messages',
    { preHandler: [app.authenticate, validate({ params: idParam, body: messageSchema })] },
    async (request) => service.reply(request.params.id, request.body, request.actor)
  );

  app.patch(
    '/tickets/:id',
    { preHandler: [app.authenticate, requireActor('tm', 'staff', 'system'), validate({ params: idParam, body: statusSchema })] },
    async (request) => service.setStatus(request.params.id, request.body.status, request.actor)
  );
};
