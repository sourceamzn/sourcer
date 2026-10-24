"use strict";
/* Lo que ha aprendido la app (lib/learn).
   GET    /learn                  -> webs con su reputacion y marcas (?resync=1 recalcula desde los contactos)
   POST   /learn/block            { host, title, url }  «No es proveedor»
   POST   /learn/unblock          { host }
   POST   /learn/forget-brand     { host, brand }
   DELETE /learn/:host            olvidar todo lo de esa web */
const express = require("express");
const learn = require("../lib/learn");
const docs = require("../lib/docstore");
const router = express.Router();
function ah(fn) { return function (req, res) { fn(req, res).catch(function (e) { res.status(500).json({ ok: false, reason: String((e && e.message) || e) }); }); }; }

router.get("/", ah(async function (req, res) {
  let list = await learn.all();
  if (req.query.resync || !list.length) {
    const contacts = await docs.list("contacts");
    for (let i = 0; i < contacts.length; i++) await learn.syncContact(contacts[i]);
    list = await learn.all();
  }
  list.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  let engines = null;
  try { engines = await learn.engineStats(); } catch (e) {}
  res.json({ ok: true, domains: list, engines: engines });
}));
router.post("/block", ah(async function (req, res) {
  const b = req.body || {};
  const d = await learn.block(b.host || b.url, { title: b.title, url: b.url });
  try { require("../lib/journal").add("decision", { what: "no_es_proveedor", host: b.host || b.url }); } catch (e) {}
  if (!d) return res.status(400).json({ ok: false, reason: "sin_web" });
  res.json({ ok: true, domain: d });
}));
router.post("/unblock", ah(async function (req, res) { res.json({ ok: true, domain: await learn.unblock((req.body || {}).host) }); }));
router.post("/forget-brand", ah(async function (req, res) { const b = req.body || {}; res.json({ ok: true, domain: await learn.forgetBrand(b.host, b.brand) }); }));
router.delete("/:host", ah(async function (req, res) { res.json({ ok: await learn.forget(req.params.host) }); }));
module.exports = router;
