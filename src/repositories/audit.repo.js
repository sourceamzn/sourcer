'use strict';

const db = require('../db');

function runner(client) {
  return client || db.pool;
}

async function record(event, client) {
  await runner(client).query(
    `INSERT INTO audit_events (actor_type, actor_id, action, object, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      event.actorType || 'system',
      event.actorId || null,
      event.action,
      event.object || null,
      event.details ? JSON.stringify(event.details) : null,
    ]
  );
}

async function recordBatch(events, client) {
  if (!events.length) return 0;
  const values = [];
  const params = [];
  events.forEach((event, index) => {
    const base = index * 6;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
    params.push(
      event.eventId || null,
      event.actorType || 'system',
      event.actorId || null,
      event.action,
      event.object || null,
      event.details ? JSON.stringify(event.details) : null
    );
  });
  const { rowCount } = await runner(client).query(
    `INSERT INTO audit_events (event_id, actor_type, actor_id, action, object, details)
     VALUES ${values.join(', ')}
     ON CONFLICT (event_id) DO NOTHING`,
    params
  );
  return rowCount;
}

/* Historial de auditoría (pantalla "Historial / Auditoría" del CRM). Antes el
   CRM lo guardaba solo en el navegador; ahora se lee del robot. */
async function list({ limit = 200, offset = 0 } = {}, client) {
  const { rows } = await runner(client).query(
    `SELECT id, at, actor_type, actor_id, action, object, details
       FROM audit_events
      ORDER BY at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

module.exports = { record, recordBatch, list };
