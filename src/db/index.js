'use strict';

const { Pool } = require('pg');
const { config } = require('../lib/config');

const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: config.db.max,
});

pool.on('error', (err) => {
  console.error('[db] error inesperado en cliente inactivo', err);
});

function run(client) {
  return client || pool;
}

async function query(text, params, client) {
  return run(client).query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function ping() {
  await pool.query('SELECT 1');
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, withTransaction, ping, close };
