"use strict";
/* GET  /outreach            -> estado (SMTP/IMAP, reglas, remitente, ultima pasada)
   PUT  /outreach/sender     -> datos del remitente para las plantillas
   POST /outreach/test       -> { to } correo de prueba + comprobacion IMAP
   POST /outreach/run        -> pasada inmediata (leer respuestas y enviar lo que toque)
   POST /outreach/preview    -> { contactId, attempt } plantilla tal y como se enviaria */
const express = require("express");
const outreach = require("../lib/outreach");
const docs = require("../lib/docstore");
const router = express.Router();
function ah(fn) { return function (req, res) { fn(req, res).catch(function (e) { res.status(500).json({ ok: false, reason: String((e && e.message) || e).slice(0, 300) }); }); }; }

router.get("/", ah(async function (req, res) { res.json({ ok: true, status: await outreach.status() }); }));
router.put("/sender", ah(async function (req, res) { res.json({ ok: true, sender: await outreach.setSender(req.body || {}) }); }));
router.post("/test", ah(async function (req, res) { res.json(await outreach.testSend(String((req.body || {}).to || "").trim())); }));
router.post("/run", ah(async function (req, res) { res.json(await outreach.tick((req.body || {}).force ? "manual_force" : "manual")); }));
router.get("/metrics", ah(async function (req, res) { res.json({ ok: true, metrics: await outreach.metrics() }); }));
router.get("/templates", ah(async function (req, res) { res.json({ ok: true, templates: await outreach.getTemplates(), vars: outreach.VARS }); }));
router.put("/templates", ah(async function (req, res) { res.json({ ok: true, templates: await outreach.setTemplates(req.body || {}) }); }));
router.post("/preview", ah(async function (req, res) {
  const b = req.body || {};
  const c = (await docs.get("contacts", String(b.contactId || ""))) || { products: [{ name: "Producto de ejemplo", ean: "8412345678905", model: "REF-123", brand: "Marca" }], company: "Proveedor de ejemplo" };
  const n = Math.max(1, Math.min(10, parseInt(b.attempt, 10) || 1));
  const tpl = b.templates ? { items: b.templates.items || [] } : await outreach.getTemplates();
  res.json({ ok: true, attempt: n, mail: outreach.render(c, await outreach.getSender(), tpl, n, b.variant || "A") });
}));
module.exports = router;
