const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config } = require("../config");

/* Persistencia del vigilante de precios.
   - Si existe DATABASE_URL se usa Postgres (Railway) con tres tablas: watches, price_history, alerts.
   - Si no, se usa un fichero JSON local (backend/data/alerts.json) para que el servicio
     funcione igual sin configuracion extra. Misma interfaz en ambos casos. */

let backend = null;

function newId(prefix) {
  return String(prefix || "id") + "_" + crypto.randomBytes(8).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

/* Clave estable de un producto de catalogo para detectar altas nuevas y bajadas. */
function catalogKey(it) {
  const raw = (it && (it.url || it.reference || it.ean || it.name)) || "";
  return String(raw).slice(0, 240);
}

/* EAN/UPC normalizado (solo digitos) para cruzar tarifas por codigo de barras. */
function cleanEan(value) {
  const digits = String(value == null ? "" : value).replace(/\D/g, "");
  return digits.length >= 8 ? digits : "";
}

function numOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/* ---------------- backend de fichero (fallback) ---------------- */
function createFileBackend(file) {
  let state = { watches: [], price_history: [], alerts: [], catalog: [], tariffs: [] };

  function load() {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        state = {
          watches: Array.isArray(parsed.watches) ? parsed.watches : [],
          price_history: Array.isArray(parsed.price_history) ? parsed.price_history : [],
          alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
          catalog: Array.isArray(parsed.catalog) ? parsed.catalog : [],
          tariffs: Array.isArray(parsed.tariffs) ? parsed.tariffs : []
        };
      }
    } catch (e) {
      state = { watches: [], price_history: [], alerts: [], catalog: [], tariffs: [] };
    }
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
      /* si el disco no es escribible no rompemos el servicio */
    }
  }

  load();

  return {
    kind: "file",
    async init() {
      return this;
    },
    async close() {},
    async listWatches() {
      return state.watches.slice();
    },
    async getWatch(id) {
      return state.watches.find((w) => w.id === id) || null;
    },
    async saveWatch(w) {
      const i = state.watches.findIndex((x) => x.id === w.id);
      if (i === -1) state.watches.push(w);
      else state.watches[i] = w;
      persist();
      return w;
    },
    async updateWatch(id, patch) {
      const w = state.watches.find((x) => x.id === id);
      if (!w) return null;
      Object.assign(w, patch);
      persist();
      return w;
    },
    async deleteWatch(id) {
      const before = state.watches.length;
      state.watches = state.watches.filter((x) => x.id !== id);
      state.price_history = state.price_history.filter((x) => x.watch_id !== id);
      state.alerts = state.alerts.filter((x) => x.watch_id !== id);
      persist();
      return state.watches.length < before;
    },
    async recordPrice(id, price) {
      const at = nowIso();
      const entry = { watch_id: id, price: price, at: at };
      state.price_history.push(entry);
      if (state.price_history.length > 5000) state.price_history = state.price_history.slice(-5000);
      const w = state.watches.find((x) => x.id === id);
      if (w) {
        w.last_price = price;
        w.last_checked = at;
      }
      persist();
      return entry;
    },
    async priceHistory(id, limit) {
      return state.price_history.filter((x) => x.watch_id === id).slice(-(limit || 50));
    },
    async listAlerts(opts) {
      opts = opts || {};
      let list = state.alerts.slice();
      if (!opts.includeDismissed) list = list.filter((a) => !a.dismissed);
      list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return list.slice(0, opts.limit || 100);
    },
    async addAlert(a) {
      state.alerts.push(a);
      persist();
      return a;
    },
    async dismissAlert(id) {
      const a = state.alerts.find((x) => x.id === id);
      if (!a) return null;
      a.dismissed = true;
      persist();
      return a;
    },
    async clearAlerts(kind) {
      const before = state.alerts.length;
      state.alerts = kind ? state.alerts.filter((a) => a.kind !== kind) : [];
      persist();
      return before - state.alerts.length;
    },
    async catalogUpsert(source, items) {
      const now = nowIso();
      const out = {};
      (items || []).forEach(function (it) {
        const skey = catalogKey(it);
        if (!skey) return;
        const price = it.price == null || it.price === "" ? null : Number(it.price);
        const ex = state.catalog.find((c) => c.source === source && c.skey === skey);
        if (!ex) {
          state.catalog.push({ source, skey, name: it.name || "", url: it.url || "", price, last_price: price, first_seen: now, last_seen: now });
          it.isNew = true;
          it.dropPct = null;
          out[skey] = { isNew: true, drop: null };
        } else {
          let drop = null;
          if (ex.last_price != null && price != null && price < ex.last_price) {
            drop = { from: ex.last_price, to: price, pct: Math.round((1 - price / ex.last_price) * 100) };
          }
          ex.last_seen = now;
          ex.name = it.name || ex.name;
          ex.url = it.url || ex.url;
          if (price != null) { ex.price = price; ex.last_price = price; }
          it.isNew = false;
          it.dropPct = drop ? drop.pct : null;
          it.dropFrom = drop ? drop.from : null;
          out[skey] = { isNew: false, drop };
        }
      });
      if (state.catalog.length > 20000) state.catalog = state.catalog.slice(-20000);
      persist();
      return out;
    },
    async catalogHasSource(source) {
      return state.catalog.some((c) => c.source === source);
    },
    async tariffUpsert(items, source) {
      const now = nowIso();
      let n = 0;
      (items || []).forEach(function (it) {
        const ean = cleanEan(it && it.ean);
        if (!ean) return;
        const net = it.net != null ? numOrNull(it.net) : numOrNull(it.price);
        const row = {
          source: source || it.source || "tarifas",
          ean: ean,
          name: it.name || "",
          brand: it.brand || "",
          model: it.model || "",
          reference: it.reference || "",
          net: net,
          price: numOrNull(it.price),
          url: it.url || "",
          at: now
        };
        const ex = state.tariffs.find((t) => t.source === row.source && t.ean === ean);
        if (ex) Object.assign(ex, row);
        else state.tariffs.push(row);
        n++;
      });
      if (state.tariffs.length > 100000) state.tariffs = state.tariffs.slice(-100000);
      if (n) persist();
      return n;
    },
    async tariffFind(eans) {
      const want = {};
      (Array.isArray(eans) ? eans : [eans]).forEach(function (e) {
        const c = cleanEan(e);
        if (c) want[c] = true;
      });
      const keys = Object.keys(want);
      if (!keys.length) return [];
      return state.tariffs
        .filter((t) => want[t.ean])
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    },
    async stats() {
      return {
        mode: "file",
        watches: state.watches.length,
        active: state.watches.filter((w) => w.active !== false).length,
        alerts: state.alerts.filter((a) => !a.dismissed).length,
        history: state.price_history.length,
        catalog: state.catalog.length,
        tariffs: state.tariffs.length
      };
    }
  };
}

/* ---------------- backend Postgres ---------------- */
function createPgBackend(url) {
  const { Pool } = require("pg");
  const needsSsl = !/railway\.internal|localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });
  pool.on("error", function () {
    /* una conexion inactiva caida no debe tumbar el servicio */
  });

  function mapWatch(r) {
    return {
      id: r.id,
      source: r.source,
      name: r.name,
      brand: r.brand,
      model: r.model,
      reference: r.reference,
      ean: r.ean,
      url: r.url,
      asin: r.asin,
      image: r.image,
      key: r.wkey,
      base_price: r.base_price,
      last_price: r.last_price,
      target_pct: r.target_pct,
      active: r.active,
      created_at: iso(r.created_at),
      last_checked: iso(r.last_checked)
    };
  }

  function mapAlert(r) {
    return {
      id: r.id,
      watch_id: r.watch_id,
      kind: r.kind,
      title: r.title,
      detail: r.detail,
      price: r.price,
      prev_price: r.prev_price,
      pct: r.pct,
      at: iso(r.at),
      dismissed: r.dismissed
    };
  }

  return {
    kind: "postgres",
    async init() {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS watches (" +
          "id TEXT PRIMARY KEY, source TEXT, name TEXT, brand TEXT, model TEXT, reference TEXT, " +
          "ean TEXT, url TEXT, asin TEXT, image TEXT, wkey TEXT, base_price DOUBLE PRECISION, " +
          "last_price DOUBLE PRECISION, target_pct DOUBLE PRECISION, active BOOLEAN DEFAULT TRUE, " +
          "created_at TIMESTAMPTZ DEFAULT NOW(), last_checked TIMESTAMPTZ)"
      );
      await pool.query(
        "CREATE TABLE IF NOT EXISTS price_history (" +
          "id SERIAL PRIMARY KEY, watch_id TEXT, price DOUBLE PRECISION, at TIMESTAMPTZ DEFAULT NOW())"
      );
      await pool.query(
        "CREATE TABLE IF NOT EXISTS alerts (" +
          "id TEXT PRIMARY KEY, watch_id TEXT, kind TEXT, title TEXT, detail TEXT, " +
          "price DOUBLE PRECISION, prev_price DOUBLE PRECISION, pct DOUBLE PRECISION, " +
          "at TIMESTAMPTZ DEFAULT NOW(), dismissed BOOLEAN DEFAULT FALSE)"
      );
      await pool.query(
        "CREATE TABLE IF NOT EXISTS catalog_seen (" +
          "source TEXT, skey TEXT, name TEXT, url TEXT, price DOUBLE PRECISION, " +
          "last_price DOUBLE PRECISION, first_seen TIMESTAMPTZ DEFAULT NOW(), " +
          "last_seen TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (source, skey))"
      );
      await pool.query(
        "CREATE TABLE IF NOT EXISTS tariff_seen (" +
          "source TEXT, ean TEXT, name TEXT, brand TEXT, model TEXT, reference TEXT, " +
          "net DOUBLE PRECISION, price DOUBLE PRECISION, url TEXT, at TIMESTAMPTZ DEFAULT NOW(), " +
          "PRIMARY KEY (source, ean))"
      );
      return this;
    },
    async close() {
      await pool.end();
    },
    async listWatches() {
      const out = await pool.query("SELECT * FROM watches ORDER BY created_at ASC");
      return out.rows.map(mapWatch);
    },
    async getWatch(id) {
      const out = await pool.query("SELECT * FROM watches WHERE id=$1", [id]);
      return out.rows[0] ? mapWatch(out.rows[0]) : null;
    },
    async saveWatch(w) {
      await pool.query(
        "INSERT INTO watches (id,source,name,brand,model,reference,ean,url,asin,image,wkey,base_price,last_price,target_pct,active,created_at,last_checked) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) " +
          "ON CONFLICT (id) DO UPDATE SET source=$2,name=$3,brand=$4,model=$5,reference=$6,ean=$7,url=$8,asin=$9,image=$10,wkey=$11,base_price=$12,last_price=$13,target_pct=$14,active=$15,last_checked=$17",
        [w.id, w.source, w.name, w.brand, w.model, w.reference, w.ean, w.url, w.asin, w.image, w.key, w.base_price, w.last_price, w.target_pct, w.active !== false, w.created_at || nowIso(), w.last_checked || null]
      );
      return w;
    },
    async updateWatch(id, patch) {
      const allowed = ["name", "brand", "model", "reference", "ean", "url", "asin", "image", "key", "base_price", "last_price", "target_pct", "active", "last_checked"];
      const cols = { key: "wkey" };
      const sets = [];
      const vals = [];
      let i = 1;
      Object.keys(patch).forEach((k) => {
        if (allowed.indexOf(k) === -1) return;
        sets.push((cols[k] || k) + "=$" + i);
        vals.push(patch[k]);
        i++;
      });
      if (!sets.length) return this.getWatch(id);
      vals.push(id);
      const out = await pool.query("UPDATE watches SET " + sets.join(",") + " WHERE id=$" + i + " RETURNING *", vals);
      return out.rows[0] ? mapWatch(out.rows[0]) : null;
    },
    async deleteWatch(id) {
      await pool.query("DELETE FROM price_history WHERE watch_id=$1", [id]);
      await pool.query("DELETE FROM alerts WHERE watch_id=$1", [id]);
      const out = await pool.query("DELETE FROM watches WHERE id=$1", [id]);
      return out.rowCount > 0;
    },
    async recordPrice(id, price) {
      const at = nowIso();
      await pool.query("INSERT INTO price_history (watch_id,price,at) VALUES ($1,$2,$3)", [id, price, at]);
      await pool.query("UPDATE watches SET last_price=$1, last_checked=$2 WHERE id=$3", [price, at, id]);
      return { watch_id: id, price: price, at: at };
    },
    async priceHistory(id, limit) {
      const out = await pool.query("SELECT * FROM price_history WHERE watch_id=$1 ORDER BY at ASC", [id]);
      const rows = out.rows.slice(-(limit || 50));
      return rows.map((r) => ({ watch_id: r.watch_id, price: r.price, at: iso(r.at) }));
    },
    async listAlerts(opts) {
      opts = opts || {};
      const where = opts.includeDismissed ? "" : " WHERE dismissed=FALSE";
      const out = await pool.query("SELECT * FROM alerts" + where + " ORDER BY at DESC LIMIT $1", [opts.limit || 100]);
      return out.rows.map(mapAlert);
    },
    async addAlert(a) {
      await pool.query(
        "INSERT INTO alerts (id,watch_id,kind,title,detail,price,prev_price,pct,at,dismissed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING",
        [a.id, a.watch_id, a.kind, a.title, a.detail, a.price, a.prev_price, a.pct, a.at || nowIso(), a.dismissed || false]
      );
      return a;
    },
    async dismissAlert(id) {
      const out = await pool.query("UPDATE alerts SET dismissed=TRUE WHERE id=$1 RETURNING *", [id]);
      return out.rows[0] ? mapAlert(out.rows[0]) : null;
    },
    async clearAlerts(kind) {
      const out = kind
        ? await pool.query("DELETE FROM alerts WHERE kind=$1", [kind])
        : await pool.query("DELETE FROM alerts");
      return out.rowCount || 0;
    },
    async catalogUpsert(source, items) {
      const now = nowIso();
      const out = {};
      for (const it of items || []) {
        const skey = catalogKey(it);
        if (!skey) continue;
        const price = it.price == null || it.price === "" ? null : Number(it.price);
        const prev = await pool.query("SELECT last_price FROM catalog_seen WHERE source=$1 AND skey=$2", [source, skey]);
        if (!prev.rows[0]) {
          await pool.query(
            "INSERT INTO catalog_seen (source,skey,name,url,price,last_price,first_seen,last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (source,skey) DO NOTHING",
            [source, skey, it.name || "", it.url || "", price, price, now]
          );
          it.isNew = true;
          it.dropPct = null;
          out[skey] = { isNew: true, drop: null };
        } else {
          const last = prev.rows[0].last_price;
          let drop = null;
          if (last != null && price != null && price < Number(last)) {
            drop = { from: Number(last), to: price, pct: Math.round((1 - price / Number(last)) * 100) };
          }
          await pool.query(
            "UPDATE catalog_seen SET last_seen=$3, name=$4, url=$5, price=COALESCE($6,price), last_price=COALESCE($6,last_price) WHERE source=$1 AND skey=$2",
            [source, skey, now, it.name || "", it.url || "", price]
          );
          it.isNew = false;
          it.dropPct = drop ? drop.pct : null;
          it.dropFrom = drop ? drop.from : null;
          out[skey] = { isNew: false, drop };
        }
      }
      return out;
    },
    async catalogHasSource(source) {
      const r = await pool.query("SELECT 1 FROM catalog_seen WHERE source=$1 LIMIT 1", [source]);
      return Boolean(r.rows[0]);
    },
    async tariffUpsert(items, source) {
      const now = nowIso();
      let n = 0;
      for (const it of items || []) {
        const ean = cleanEan(it && it.ean);
        if (!ean) continue;
        const net = it.net != null ? numOrNull(it.net) : numOrNull(it.price);
        await pool.query(
          "INSERT INTO tariff_seen (source,ean,name,brand,model,reference,net,price,url,at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) " +
            "ON CONFLICT (source,ean) DO UPDATE SET name=$3,brand=$4,model=$5,reference=$6,net=$7,price=$8,url=$9,at=$10",
          [source || it.source || "tarifas", ean, it.name || "", it.brand || "", it.model || "", it.reference || "", net, numOrNull(it.price), it.url || "", now]
        );
        n++;
      }
      return n;
    },
    async tariffFind(eans) {
      const want = (Array.isArray(eans) ? eans : [eans]).map(cleanEan).filter(Boolean);
      if (!want.length) return [];
      const out = await pool.query("SELECT * FROM tariff_seen WHERE ean = ANY($1) ORDER BY at DESC", [want]);
      return out.rows;
    },
    async stats() {
      const w = await pool.query("SELECT COUNT(*)::int AS c FROM watches");
      const wa = await pool.query("SELECT COUNT(*)::int AS c FROM watches WHERE active=TRUE");
      const a = await pool.query("SELECT COUNT(*)::int AS c FROM alerts WHERE dismissed=FALSE");
      const h = await pool.query("SELECT COUNT(*)::int AS c FROM price_history");
      const c = await pool.query("SELECT COUNT(*)::int AS c FROM catalog_seen");
      const t = await pool.query("SELECT COUNT(*)::int AS c FROM tariff_seen");
      return { mode: "postgres", watches: w.rows[0].c, active: wa.rows[0].c, alerts: a.rows[0].c, history: h.rows[0].c, catalog: c.rows[0].c, tariffs: t.rows[0].c };
    }
  };
}

async function init() {
  if (backend) return backend;
  if (config.databaseUrl) {
    try {
      backend = createPgBackend(config.databaseUrl);
      await backend.init();
    } catch (e) {
      console.error("[alerts] Postgres no disponible (" + String((e && e.message) || e) + "); uso almacen en fichero.");
      backend = createFileBackend(config.alerts.dataFile);
    }
  } else {
    backend = createFileBackend(config.alerts.dataFile);
  }
  return backend;
}

async function ready() {
  if (!backend) await init();
  return backend;
}

module.exports = {
  newId,
  nowIso,
  init,
  mode: () => (backend ? backend.kind : "uninitialized"),
  close: async () => {
    if (backend && typeof backend.close === "function") await backend.close();
    backend = null;
  },
  stats: async () => (await ready()).stats(),
  listWatches: async () => (await ready()).listWatches(),
  getWatch: async (id) => (await ready()).getWatch(id),
  saveWatch: async (w) => (await ready()).saveWatch(w),
  updateWatch: async (id, patch) => (await ready()).updateWatch(id, patch),
  deleteWatch: async (id) => (await ready()).deleteWatch(id),
  recordPrice: async (id, price) => (await ready()).recordPrice(id, price),
  priceHistory: async (id, limit) => (await ready()).priceHistory(id, limit),
  listAlerts: async (opts) => (await ready()).listAlerts(opts),
  addAlert: async (a) => (await ready()).addAlert(a),
  dismissAlert: async (id) => (await ready()).dismissAlert(id),
  clearAlerts: async (kind) => (await ready()).clearAlerts(kind),
  catalogUpsert: async (source, items) => (await ready()).catalogUpsert(source, items),
  catalogHasSource: async (source) => (await ready()).catalogHasSource(source),
  tariffUpsert: async (items, source) => (await ready()).tariffUpsert(items, source),
  tariffFind: async (eans) => (await ready()).tariffFind(eans)
};
