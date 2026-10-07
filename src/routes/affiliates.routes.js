'use strict';

const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { requireActor } = require('../middleware/authorize');
const affiliateService = require('../services/affiliate.service');

const listQuery = z.object({
  limit: z.string().optional(),
  offset: z.string().optional(),
  cursor: z.string().optional(),
  status: z.enum(['active', 'paused', 'closed']).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(160),
  code: z.string().max(60).optional(),
  email: z.string().email().max(160).optional(),
  company: z.string().max(160).optional(),
  status: z.enum(['active', 'paused', 'closed']).optional(),
  commissionType: z.enum(['cpa', 'revshare', 'hybrid']).optional(),
  commissionValue: z.coerce.number().nonnegative().max(1000000).optional(),
  notes: z.string().max(2000).optional(),
});

const updateSchema = createSchema.partial().omit({ code: true });
const affiliateIdParam = z.object({ affiliateId: z.string().min(1).max(40) });

module.exports = async function affiliatesRoutes(app) {
  app.get(
    '/affiliates',
    { preHandler: [app.authenticate, requireActor('staff', 'tm', 'system'), validate({ query: listQuery })] },
    async (request) => affiliateService.listAffiliates(request.query)
  );

  app.post(
    '/affiliates',
    { preHandler: [app.authenticate, requireActor('staff', 'tm', 'system'), validate({ body: createSchema })] },
    async (request, reply) => reply.code(201).send(await affiliateService.createAffiliate(request.body, request.actor))
  );

  app.get(
    '/affiliates/:affiliateId',
    { preHandler: [app.authenticate, requireActor('staff', 'tm', 'system'), validate({ params: affiliateIdParam })] },
    async (request) => affiliateService.getAffiliate(request.params.affiliateId, request.query)
  );

  app.patch(
    '/affiliates/:affiliateId',
    {
      preHandler: [
        app.authenticate,
        requireActor('staff', 'tm', 'system'),
        validate({ params: affiliateIdParam, body: updateSchema }),
      ],
    },
    async (request) => affiliateService.updateAffiliate(request.params.affiliateId, request.body, request.actor)
  );
};
