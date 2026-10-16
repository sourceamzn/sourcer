/* Trabajos en segundo plano para "Buscar proveedores".
   start() responde al instante con un id; el frontend consulta status(id) cada
   pocos segundos y recibe resultados PARCIALES segun terminan las fuentes. Asi
   no hay una unica peticion de 60 s que el proxy o el navegador puedan cortar. */

const crypto = require("crypto");
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
    state: "running", running: [], done: [], matches: [], searched: [], result: null, error: null
  };
  jobs.set(id, job);
  const hooks = {
    onStart: function (srcId, label) { job.running.push({ source: srcId, label: label, since: Date.now() }); },
    onSource: function (entry, recs) {
      job.running = job.running.filter(function (r) { return r.source !== entry.source; });
      job.done.push(entry.source);
      job.searched.push(entry);
      recs.forEach(function (r) { if (!(r.price > 0 && body && Number(body.priceMax) > 0 && r.price > Number(body.priceMax))) job.matches.push(r); });
    }
  };
  Promise.resolve()
    .then(function () { return inverso.actions.sources(body || {}, {}, hooks); })
    .then(function (r) {
      job.result = r && r.data ? r.data : r;
      job.state = r && r.ok === false ? "error" : "done";
      if (r && r.ok === false) job.error = r.reason || "error";
    })
    .catch(function (e) { job.state = "error"; job.error = String((e && e.message) || e); })
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
    partial: finished ? undefined : sortMatches(j.matches).slice(0, 40),
    result: finished ? j.result : null,
    error: j.error
  };
}

module.exports = { start, status };