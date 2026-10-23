/* Trabajos en segundo plano para "Buscar proveedores".
   start() responde al instante con un id; el frontend consulta status(id) cada
   pocos segundos y recibe resultados PARCIALES segun terminan las fuentes. Asi
   no hay una unica peticion de 60 s que el proxy o el navegador puedan cortar. */

const crypto = require("crypto");
const events = require("./events");
const jobs = new Map();
const TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 200;

function gc() {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > TTL_MS) jobs.delete(id);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
}

function sortMatches(list) {
  return list.slice().sort(function (a, b) {
    const pa = a.price > 0, pb = b.price > 0;
    if (pa && pb) return a.price - b.price;
    if (pa) return -1;
    if (pb) return 1;
    return (b.rel || 0) - (a.rel || 0);
  });
}

function start(body, inverso) {
  gc();
  const id = crypto.randomBytes(8).toString("hex");
  const job = {
    id: id, createdAt: Date.now(), startedAt: new Date().toISOString(), finishedAt: null,
    state: "running", running: [], done: [], matches: [], searched: [], result: null, error: null, timeline: [], seenMatch: {}
  };
  jobs.set(id, job);
  const tl = function (kind, d) { d = d || {}; d.job = id; job.timeline.push({ t: new Date().toISOString(), kind: kind, d: d }); events.add(kind, d); };
  tl("job", { phase: "start", asin: body && body.asin, brand: body && body.brand, model: body && body.model, name: body && body.name, ean: body && body.ean });
  const hooks = {
    onStart: function (srcId, label) { tl("source", { source: srcId, phase: "start" }); job.running.push({ source: srcId, label: label, since: Date.now() }); },
    onSource: function (entry, recs) {
      tl("source", { source: entry.source, phase: "end", ok: entry.ok, count: entry.count, ms: entry.ms, reason: entry.reason, detail: entry.detail });
      job.running = job.running.filter(function (r) { return r.source !== entry.source; });
      if (job.done.indexOf(entry.source) === -1) { job.done.push(entry.source); job.searched.push(entry); }
      recs.forEach(function (r, idx) {
        if (r.price > 0 && body && Number(body.priceMax) > 0 && r.price > Number(body.priceMax)) return;
        const k = entry.source + "|" + idx + "|" + String(r.url || "") + "|" + String(r.price || "") + "|" + String(r.name || "");
        if (job.seenMatch[k]) return;
        job.seenMatch[k] = 1;
        job.matches.push(r);
      });
    }
  };
  Promise.resolve()
    .then(function () { return inverso.actions.sources(body || {}, {}, hooks); })
    .then(function (r) {
      job.result = r && r.data ? r.data : r;
      job.state = r && r.ok === false ? "error" : "done";
      if (r && r.ok === false) job.error = r.reason || "error";
      const rej = (job.result && job.result.rejected) || [];
      rej.forEach(function (x) { tl("reject", { source: x.source, name: x.name, reason: x.reason }); });
      tl("job", { phase: "end", state: job.state, error: job.error, matches: job.matches.length, rejected: rej.length });
      /* Historial: el resultado queda guardado por ASIN/EAN (sin volver a
         gastar Apify al reabrir la ficha). */
      if (job.state === "done" && job.result) {
        try {
          const history = require("./history");
          const key = history.supKey(body);
          if (key) {
            const r = job.result;
            const slim = {
              matches: (r.matches || []).slice(0, 40), overMax: (r.overMax || []).slice(0, 12), review: (r.review || []).slice(0, 25),
              searched: r.searched || [], diagnosis: r.diagnosis || null, summary: r.summary || null, phases: r.phases || null,
              identity: r.identity || null, cheapestVerified: r.cheapestVerified || null, leads: r.leads || null,
              googleShopping: r.googleShopping || "", coverage: r.coverage || null, rejected: (r.rejected || []).slice(0, 40)
            };
            history.save("suppliers", key, {
              asin: String((body && body.asin) || ""), ean: String((body && body.ean) || ""), name: String((body && body.name) || "").slice(0, 160),
              image: String((body && body.image) || ""), leads: r.leads ? (r.leads.leads || []).length : 0, matches: (r.matches || []).length
            }, slim).catch(function () {});
            job.result.historyId = key;
          }
        } catch (e) {}
      }
    })
    .catch(function (e) { job.state = "error"; job.error = String((e && e.message) || e); tl("error", { phase: "job", msg: job.error }); })
    .then(function () { job.finishedAt = new Date().toISOString(); job.running = []; });
  return id;
}

function status(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const finished = j.state !== "running";
  return {
    id: j.id, state: j.state, startedAt: j.startedAt, finishedAt: j.finishedAt,
    elapsedMs: (j.finishedAt ? Date.parse(j.finishedAt) : Date.now()) - j.createdAt,
    running: j.running.map(function (r) { return { source: r.source, label: r.label, seconds: Math.round((Date.now() - r.since) / 1000) }; }),
    searched: j.searched,
    coverage: finished ? ((j.result && j.result.coverage) || null) : null,
    partial: finished ? undefined : sortMatches(j.matches).slice(0, 40),
    result: finished ? j.result : null,
    error: j.error
  };
}

/* Linea de tiempo completa del trabajo (solo via /suppliers/log/:id con token). */
function log(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, state: j.state, startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error, searched: j.searched, timeline: j.timeline };
}

module.exports = { start, status, log };