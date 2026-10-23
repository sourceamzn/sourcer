"use strict";
/* Almacen generico de documentos JSON por coleccion (contactos de
   fabricantes/distribuidores, y lo que venga: hilos de correo, plantillas).
   - Con DATABASE_URL: tabla Postgres `docs(coll, id, data jsonb, updated_at)`.
   - Sin ella: fichero JSON (data/docs.json). En Railway sin Postgres el
     fichero se pierde en cada despliegue: conviene tener Postgres. */

const fs = require("fs");
const path = require("path");
const { config } = require("../config");

let impl = null;

function fileImpl(file) {
  let state = {};
  try { if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (e) { state = {}; }
  function persist() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state), "utf8"); } catch (e) {}
  }
  return {
    kind: "file",
    async list(coll) { return Object.values(state[coll] || {}); },
    async get(coll, id) { return (state[coll] || {})[id] || null; },
    async put(coll, id, data) { state[coll] = state[coll] || {}; state[coll][id] = data; persist(); return data; },
    async del(coll, id) { const had = Boolean(state[coll] && state[coll][id]); if (had) { delete state[coll][id]; persist(); } return had; }
  };
}

function pgImpl(url) {
  const { Pool } = require("pg");
  const needsSsl = !/railway\.internal|localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false, max: 3, connectionTimeoutMillis: 10000 });
  pool.on("error", function () {});
  let ready = null;
  function init() {
    if (!ready) {
      ready = pool.query("CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (coll, id))");
    }
    return ready;
  }
  return {
    kind: "postgres",
    async list(coll) { await init(); const r = await pool.query("SELECT data FROM docs WHERE coll=$1 ORDER BY updated_at DESC LIMIT 2000", [coll]); return r.rows.map(function (x) { return x.data; }); },
    async get(coll, id) { await init(); const r = await pool.query("SELECT data FROM docs WHERE coll=$1 AND id=$2", [coll, id]); return r.rows[0] ? r.rows[0].data : null; },
    async put(coll, id, data) { await init(); await pool.query("INSERT INTO docs (coll,id,data,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()", [coll, id, JSON.stringify(data)]); return data; },
    async del(coll, id) { await init(); const r = await pool.query("DELETE FROM docs WHERE coll=$1 AND id=$2", [coll, id]); return r.rowCount > 0; }
  };
}

function get() {
  if (impl) return impl;
  if (config.databaseUrl) {
    try { impl = pgImpl(config.databaseUrl); } catch (e) { impl = null; }
  }
  if (!impl) impl = fileImpl(process.env.DOCS_DATA_FILE || path.join(__dirname, "..", "..", "data", "docs.json"));
  return impl;
}

module.exports = {
  kind: function () { return get().kind; },
  list: function (c) { return get().list(c); },
  get: function (c, id) { return get().get(c, id); },
  put: function (c, id, d) { return get().put(c, id, d); },
  del: function (c, id) { return get().del(c, id); },
  _setForTests: function (x) { impl = x; }
};
