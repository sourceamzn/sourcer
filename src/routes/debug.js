const events = require("../lib/events");
const jobs = require("../lib/jobs");
const { config } = require("../config");

/* GET /debug/events?limit=&kind=&job=&session=&since=   (token) */
function getEvents(req, res) {
  const q = req.query || {};
  res.json({ ok: true, events: events.list({ limit: q.limit, kind: q.kind, job: q.job, session: q.session, since: Number(q.since) || 0 }) });
}

/* POST /debug/beacon  { session, lines:[{t,msg,level}] }  (sin token: solo escribe, acotado y saneado) */
function beacon(req, res) {
  if (!events.enabled()) return res.json({ ok: true, ignored: true });
  const b = req.body || {};
  const session = events.scrub(b.session || "", 32);
  const all = Array.isArray(b.lines) ? b.lines : [];
  const lines = all.slice(0, config.beaconMaxLines);
  lines.forEach(function (l) {
    events.add("client", {
      session: session,
      level: l && events.scrub(l.level, 12),
      msg: l && events.scrub(l.msg, 240),
      at: l && events.scrub(l.t, 32)
    });
  });
  res.json({ ok: true, n: lines.length, dropped: Math.max(0, all.length - lines.length) });
}

/* GET /suppliers/log/:id  (token) -> linea de tiempo del trabajo + rechazos */
function jobLog(req, res) {
  const lg = jobs.log(req.params.id);
  if (!lg) return res.status(404).json({ ok: false, reason: "job_no_encontrado" });
  res.json({ ok: true, log: lg });
}

module.exports = { getEvents, beacon, jobLog };
