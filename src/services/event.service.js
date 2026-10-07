'use strict';

const audit = require('../repositories/audit.repo');

function normalizeAt(value) {
  const date = value === undefined || value === null ? new Date() : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function dedupe(events) {
  const seen = new Set();
  const unique = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  return unique;
}

function objectRef(event) {
  const object = event.payload && event.payload.object;
  return object === undefined || object === null ? event.id : String(object);
}

async function ingestBatch(input, actor) {
  const events = dedupe(input.events);
  const rows = events.map((event) => ({
    eventId: event.id,
    actorType: actor.type,
    actorId: actor.id,
    action: event.type,
    object: objectRef(event),
    details: {
      eventId: event.id,
      at: normalizeAt(event.at),
      clientId: input.clientId || null,
      accountId: input.accountId || null,
      payload: event.payload || {},
      meta: event.meta || {},
      source: 'trading-manager',
    },
  }));

  const accepted = await audit.recordBatch(rows);
  return { accepted, duplicates: events.length - accepted };
}

module.exports = { ingestBatch };
