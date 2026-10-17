const events = require("../lib/events");
const jobs = require("../lib/jobs");

/* GET /debug/events?limit=&kind=&job=&session=&since=   (token) */
function getEvents(req, res) {
  const q = req.query || {};
  res.json({ ok: true, events: events.list({ limit: q.limit, kind: q.kind, job: q.job, session: q.session, since: Number(q.since) || 0 }) });
}

/* POST /debug/beacon  { session, lines:[{t,msg,level}] }  (sin token: solo escribe, acotado y saneado) */
function beacon(req, res) {
  if (!events.enabled()) return res.json({ ok: true, ignored: true });
  const b = req.body || {};
  const session = events.scrub(b.session || "", 40);
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 50) : [];
  lines.forEach(function (l) {
    events.add("client", { session: session, level: l && l.level, msg: l && l.msg, at: l && l.t });
  });
  res.json({ ok: true, n: lines.length });
}

/* GET /suppliers/log/:id  (token) -> linea de tiempo del trabajo + rechazos */
function jobLog(req, res) {
  const lg = jobs.log(req.params.id);
  if (!lg) return res.status(404).json({ ok: false, reason: "job_no_encontrado" });
  res.json({ ok: true, log: lg });
}

module.exports = { getEvents, beacon, jobLog };
