'use strict';

const { z } = require('zod');
const { config } = require('../lib/config');
const { validate } = require('../middleware/validate');
const publicLead = require('../services/public-lead.service');

/* Formulario de la web. "website" es el campo trampa (honeypot): invisible para
   una persona, los robots lo rellenan. "consent" es obligatorio (RGPD). */
const leadSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().max(100).optional(),
  email: z.string().email().max(160),
  phone: z.string().max(40).optional(),
  country: z.string().max(80).optional(),
  age: z.number().int().positive().max(120).optional(),
  message: z.string().max(2000).optional(),
  consent: z.literal(true),
  referral: z.string().max(60).optional(),
  campaignId: z.string().max(80).optional(),
  source: z.string().max(40).optional(),
  utm: z
    .object({
      source: z.string().max(120).optional(),
      medium: z.string().max(120).optional(),
      campaign: z.string().max(120).optional(),
      content: z.string().max(120).optional(),
      term: z.string().max(120).optional(),
    })
    .optional(),
  website: z.string().max(200).optional(),
});

const referralParam = z.object({ code: z.string().min(1).max(60) });

function publicRateLimitConfig() {
  if (!config.publicRateLimit.enabled) return { rateLimit: false };
  return { rateLimit: { max: config.publicRateLimit.max, timeWindow: config.publicRateLimit.window } };
}

module.exports = async function publicRoutes(app) {
  app.post(
    '/public/leads',
    { preHandler: [validate({ body: leadSchema })], config: publicRateLimitConfig() },
    async (request, reply) => {
      const result = await publicLead.createPublicLead(request.body, { ip: request.ip });
      return reply.code(201).send(result);
    }
  );

  app.get(
    '/public/affiliates/:code',
    { preHandler: [validate({ params: referralParam })] },
    async (request) => publicLead.resolveReferral(request.params.code)
  );
};
