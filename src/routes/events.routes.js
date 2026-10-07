'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor } = require('../middleware/authorize');
const service = require('../services/event.service');

const ingestSchema = z.object({
  clientId: z.string().regex(/^C\d{6}$/).nullish(),
  accountId: z.string().regex(/^acc_[0-9a-f]{32}$/).nullish(),
  events: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        type: z.string().min(1).max(64),
        at: z.union([z.number(), z.string()]).optional(),
        payload: z.record(z.any()).optional(),
        meta: z.record(z.any()).optional(),
      })
    )
    .min(1)
    .max(100),
});

module.exports = async function eventsRoutes(app) {
  app.post(
    '/events',
    { preHandler: [app.authenticate, requireActor('tm', 'system'), validate({ body: ingestSchema })] },
    async (request, reply) => reply.code(202).send(await service.ingestBatch(request.body, request.actor))
  );
};
