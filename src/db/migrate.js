'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pool, close } = require('./index');

const SQL_DIR = path.resolve(__dirname, '..', '..', 'sql');

async function ensureMigrationsTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
}

async function appliedSet(client) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((row) => row.filename));
}

function migrationFiles() {
  return fs.readdirSync(SQL_DIR).filter((file) => file.endsWith('.sql')).sort();
}

async function run() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedSet(client);
    const pending = migrationFiles().filter((file) => !applied.has(file));
    if (!pending.length) {
      console.log('No hay migraciones pendientes.');
      return;
    }
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
      console.log(`Aplicando ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log(`${pending.length} migracion(es) aplicadas.`);
  } finally {
    client.release();
  }
}

async function status() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedSet(client);
    for (const file of migrationFiles()) {
      console.log(`${applied.has(file) ? '[x]' : '[ ]'} ${file}`);
    }
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const task = process.argv[2] === '--status' ? status : run;
  task()
    .then(() => close())
    .catch((err) => {
      console.error(err);
      close().finally(() => process.exit(1));
    });
}

module.exports = { run, status };
