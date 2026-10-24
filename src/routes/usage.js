"use strict";
/* Panel de APIs: estado, consumo del mes, coste y avisos de cada servicio.
   GET  /usage              -> todo (para el panel)
   POST /usage/test {svc}   -> prueba real de conexion (keepa | apify | amazon | brave | ai) */
const express = require("express");
const { config, keepaReady, apifyReady, amazonReady } = require("../config");
const usage = require("../lib/usage");
const breaker = require("../lib/breaker");
const { jsonFetch } = require("../lib/http");
const router = express.Router();
function ah(fn) { return function (req, res) { fn(req, res).catch(function (e) { res.status(500).json({ ok: false, reason: String((e && e.message) || e) }); }); }; }

const USD_EUR = 0.92;
/* Planes de la API de Keepa por recarga (tokens/minuto) -> euros al mes. */
const KEEPA_PLANS = { 20: 49, 60: 129, 250: 459, 500: 879, 2000: 2499, 10000: 11099 };

const live = { at: 0, data: null };
async function apifyAccount() {
  if (!apifyReady()) return null;
  const base = config.apify.base || "https://api.apify.com";
  const tok = encodeURIComponent(config.apify.token);
  const [lim, me] = await Promise.all([
    jsonFetch(base + "/v2/users/me/limits?token=" + tok, {}, 12000),
    jsonFetch(base + "/v2/users/me?token=" + tok, {}, 12000)
  ]);
  const L = (lim && lim.ok && lim.data && lim.data.data) || {};
  const M = (me && me.ok && me.data && me.data.data) || {};
  const plan = M.plan || {};
  return {
    ok: Boolean(lim && lim.ok),
    usedUsd: L.current && L.current.monthlyUsageUsd != null ? Number(L.current.monthlyUsageUsd) : null,
    limitUsd: L.limits && L.limits.maxMonthlyUsageUsd != null ? Number(L.limits.maxMonthlyUsageUsd) : null,
    cycleEnd: L.monthlyUsageCycle && L.monthlyUsageCycle.endAt ? L.monthlyUsageCycle.endAt : null,
    plan: plan.id || "", planCreditsUsd: plan.monthlyUsageCreditsUsd != null ? Number(plan.monthlyUsageCreditsUsd) : null,
    error: lim && !lim.ok ? ("HTTP " + lim.status) : ""
  };
}
async function keepaAccount() {
  if (!keepaReady()) return null;
  try { return await require("../adapters/inverso").keepaTokens(); } catch (e) { return null; }
}
async function liveInfo(force) {
  if (!force && live.data && Date.now() - live.at < 5 * 60000) return live.data;
  const [k, a] = await Promise.all([keepaAccount().catch(function () { return null; }), apifyAccount().catch(function () { return null; })]);
  live.data = { keepa: k, apify: a };
  live.at = Date.now();
  return live.data;
}

function n(v) { return Math.round(Number(v) || 0); }
function br(name) { const b = breaker.snapshot()[name]; return b && b.open ? b : null; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

router.get("/", ah(async function (req, res) {
  const m = await usage.month();
  const days = await usage.lastDays(30);
  const t = m.total || {};
  const L = await liveInfo(req.query.refresh === "1");
  const now = new Date();
  const dim = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  const dom = now.getUTCDate();
  const proj = function (eur) { return round2((eur / Math.max(1, dom)) * dim); };
  const alerts = [];
  const S = [];
  const V = t.value || {};
  let eng = null;
  try { eng = await require("../lib/learn").engineStats(); } catch (e) {}
  const eg = function (k) { return (eng && eng[k]) || {}; };

  /* Keepa */
  const kt = t.keepa || {}, kl = L.keepa;
  const refill = kl && kl.refillRate ? Math.round(kl.refillRate) : (require("../lib/keepacost").usage.refillRate || null);
  const kPlan = refill && KEEPA_PLANS[refill] ? KEEPA_PLANS[refill] : null;
  const kLeft = kl ? kl.tokensLeft : require("../lib/keepacost").usage.tokensLeft;
  if (keepaReady() && kLeft != null && kLeft < 100) alerts.push({ svc: "keepa", level: "warn", text: "Keepa casi sin tokens (" + kLeft + "). Se recarga a " + (refill || "?") + " por minuto." });
  S.push({ id: "keepa", name: "Keepa", role: "Histórico de Amazon: Buy Box 90 d, ventas, vendedores", configured: keepaReady(),
    status: !keepaReady() ? "off" : (kLeft != null && kLeft < 100 ? "warn" : "ok"),
    metrics: [["Tokens gastados este mes", kt.tokens || 0], ["Peticiones", kt.requests || 0], ["Tokens disponibles ahora", kLeft == null ? "—" : kLeft], ["Recarga", refill ? refill + "/min" : "—"]],
    aporta: [["Productos analizados", n(kt.productos)], ["Oportunidades detectadas en búsquedas", n(kt.aptos)], ["Servidos de caché (tokens ahorrados)", n(kt.cacheHits)]],
    costEur: kPlan, projectedEur: kPlan, costNote: kPlan ? "Plan fijo mensual (" + refill + " tokens/min)" : "Plan fijo mensual",
    dashboard: "https://keepa.com/#!api", docs: "https://keepa.com/api-docs/" });

  /* Amazon SP-API */
  const sp = require("../lib/spapi").status();
  const spOpen = br("spapi");
  if (spOpen) alerts.push({ svc: "spapi", level: "bad", text: "Amazon SP-API en pausa: " + spOpen.lastError });
  S.push({ id: "spapi", name: "Amazon SP-API", role: "Tu cuenta: comisiones reales, restricciones, ofertas actuales, catálogo por EAN", configured: amazonReady(),
    status: !amazonReady() ? "off" : (spOpen ? "bad" : (sp.usage.errors && !sp.usage.ok ? "warn" : "ok")),
    metrics: [["Llamadas este mes", (t.spapi || {}).calls || 0], ["Desde el arranque: correctas", sp.usage.ok], ["Esperas por límite", sp.usage.throttled], ["Último error", sp.usage.lastError || "—"]],
    aporta: [["EAN resueltos gratis en tarifas (tokens Keepa ahorrados)", n((t.spapi || {}).eansFree)], ["Comisiones reales de tu cuenta", n((t.spapi || {}).feesReal)], ["Productos que necesitan aprobación detectados", n((t.spapi || {}).restrictions)]],
    costEur: 0, projectedEur: 0, costNote: "Gratis", dashboard: "https://solutionproviderportal.amazon.com", docs: "https://developer-docs.amazon.com/sp-api" });

  /* Brave */
  const bt = t.brave || {}, bs = require("../adapters/discovery").braveStats;
  const braveOn = Boolean(config.discovery && config.discovery.apiKey);
  const bUsd = Math.max(0, (bt.queries || 0) * 0.005 - 5);
  if (braveOn && bs.monthLeft != null && bs.monthLimit && bs.monthLeft / bs.monthLimit < 0.15) alerts.push({ svc: "brave", level: "warn", text: "Brave: quedan " + bs.monthLeft + " consultas este mes." });
  if (br("brave")) alerts.push({ svc: "brave", level: "bad", text: "Brave en pausa: " + br("brave").lastError + " (busca solo Google)." });
  S.push({ id: "brave", name: "Brave Search", role: "Buscador de fabricantes y distribuidores", configured: braveOn,
    status: !braveOn ? "off" : (br("brave") ? "bad" : (bs.monthLeft != null && bs.monthLimit && bs.monthLeft / bs.monthLimit < 0.15 ? "warn" : "ok")),
    metrics: [["Consultas este mes", bt.queries || 0], ["Quedan del cupo", bs.monthLeft == null ? "—" : bs.monthLeft + (bs.monthLimit ? " de " + bs.monthLimit : "")], ["Errores", bt.errors || 0]],
    aporta: [["Proveedores que solo encontró Brave", n(eg("soloBrave").proveedores)], ["De ellos guardados / responden / tarifa", n(eg("soloBrave").guardados) + " / " + n(eg("soloBrave").responden) + " / " + n(eg("soloBrave").tarifas)], ["Encontrados también por Google", n(eg("ambos").proveedores)]],
    costEur: round2(bUsd * USD_EUR), projectedEur: proj(bUsd * USD_EUR), costNote: "5 $ / 1.000 consultas; los primeros 5 $ del mes son crédito",
    dashboard: "https://api-dashboard.search.brave.com/app/dashboard", docs: "https://api-dashboard.search.brave.com/app/documentation" });

  /* Apify */
  const at = t.apify || {}, al = L.apify;
  const aUsd = al && al.usedUsd != null ? al.usedUsd : (at.estUsd || 0);
  if (al && al.limitUsd && al.usedUsd != null && al.usedUsd / al.limitUsd > 0.8) alerts.push({ svc: "apify", level: "warn", text: "Apify: gastado " + round2(al.usedUsd) + " $ de " + al.limitUsd + " $ del mes." });
  if (br("apify_search")) alerts.push({ svc: "apify", level: "bad", text: "Google (Apify) en pausa: " + br("apify_search").lastError });
  S.push({ id: "apify", name: "Apify (Google)", role: "Búsqueda en Google de proveedores", configured: apifyReady(),
    status: !apifyReady() ? "off" : (br("apify_search") ? "bad" : (al && al.limitUsd && al.usedUsd / al.limitUsd > 0.8 ? "warn" : "ok")),
    metrics: [["Ejecuciones este mes", at.runs || 0], ["Gastado (cuenta Apify)", al && al.usedUsd != null ? round2(al.usedUsd) + " $" : "—"], ["Límite mensual", al && al.limitUsd != null ? al.limitUsd + " $" : "—"], ["Plan", al && al.plan ? al.plan : "—"]],
    aporta: [["Proveedores que solo encontró Google", n(eg("soloGoogle").proveedores)], ["De ellos guardados / responden / tarifa", n(eg("soloGoogle").guardados) + " / " + n(eg("soloGoogle").responden) + " / " + n(eg("soloGoogle").tarifas)], ["Encontrados también por Brave", n(eg("ambos").proveedores)]],
    costEur: round2(aUsd * USD_EUR), projectedEur: proj(aUsd * USD_EUR), costNote: al && al.usedUsd != null ? "Dato real de tu cuenta Apify" : "Estimado por la herramienta",
    dashboard: "https://console.apify.com/billing", docs: "https://docs.apify.com/api/v2" });

  /* IA */
  const ait = t.ai || {};
  let aiSt = null;
  try { aiSt = await require("../lib/ai").status(); } catch (e) {}
  const aiOn = Boolean(aiSt && aiSt.ready);
  const today = aiSt && aiSt.usage ? aiSt.usage.calls : 0;
  if (aiOn && aiSt.dailyLimit && today / aiSt.dailyLimit > 0.85) alerts.push({ svc: "ai", level: "warn", text: "IA: " + today + " de " + aiSt.dailyLimit + " llamadas permitidas hoy." });
  S.push({ id: "ai", name: "IA (Anthropic · Claude)", role: "Clasifica webs, lee respuestas de proveedores, traduce, propone búsquedas", configured: aiOn,
    status: !aiOn ? "off" : (aiSt.dailyLimit && today >= aiSt.dailyLimit ? "bad" : (aiSt.dailyLimit && today / aiSt.dailyLimit > 0.85 ? "warn" : "ok")),
    metrics: [["Llamadas este mes", ait.calls || 0], ["Tokens entrada / salida", (ait.inTok || 0).toLocaleString("es-ES") + " / " + (ait.outTok || 0).toLocaleString("es-ES")], ["Hoy", today + (aiSt && aiSt.dailyLimit ? " de " + aiSt.dailyLimit : "")], ["Modelo", (aiSt && aiSt.model) || "—"]],
    aporta: [["Respuestas de proveedores leídas y resumidas", n(ait.p_respuesta)], ["Webs clasificadas (fabricante, distribuidor, tienda)", n(ait.p_proveedores_clasificar)], ["Correos traducidos", n(ait.p_traducir_correo)], ["Búsquedas de proveedor propuestas", n(ait.p_proveedores_consultas)], ["Resultados de producto revisados", n(ait.p_productos_titulos)]],
    costEur: round2((ait.estUsd || 0) * USD_EUR), projectedEur: proj((ait.estUsd || 0) * USD_EUR), costNote: "Estimado con precios de Haiku",
    dashboard: "https://console.anthropic.com", docs: "https://docs.claude.com" });

  /* Icecat */
  const it = t.icecat || {};
  const icOn = require("../config").icecatReady();
  S.push({ id: "icecat", name: "Icecat", role: "Marca, fabricante y ficha por EAN", configured: icOn, status: icOn ? "ok" : "off",
    metrics: [["Consultas este mes", it.calls || 0], ["Errores", it.errors || 0]], aporta: [["Fichas con marca y fabricante encontradas", n(it.fichas)]], costEur: 0, projectedEur: 0, costNote: "Gratis (catálogo abierto)",
    dashboard: "https://icecat.biz", docs: "https://iceclog.com/manual-for-icecat-json-product-requests/" });

  /* Correo */
  const mt = t.mail || {};
  const mailOn = Boolean(config.mail && config.mail.smtp && config.mail.smtp.host);
  S.push({ id: "mail", name: "Correo (SMTP + puente)", role: "Envía la secuencia y los mensajes del chat", configured: mailOn, status: mailOn ? "ok" : "off",
    aporta: [["Respuestas de proveedores recibidas", n(mt.replies)], ["Respuestas con tarifa adjunta", n(mt.tariffs)]],
    metrics: [["Correos enviados este mes", mt.sent || 0], ["Vía", config.mail && config.mail.relay && config.mail.relay.url ? "puente PHP" : "SMTP directo"]], costEur: 0, projectedEur: 0, costNote: "Incluido en tu hosting",
    dashboard: "", docs: "" });

  /* Servidor y base de datos */
  let db = null;
  try { db = await require("../lib/cache").dbInfo(); } catch (e) {}
  const cache = await require("../lib/cache").snapshot();
  S.push({ id: "railway", name: "Servidor (Railway) y base de datos", role: "Donde vive el backend, la base de datos y la caché", configured: true, status: "ok",
    metrics: [["Base de datos", db && db.mb != null ? db.mb + " MB" : "—"], ["Caché: aciertos", cache.hitRate == null ? "—" : cache.hitRate + " %"], ["Caché: elementos", cache.rows != null ? cache.rows : cache.l1], ["Versión", require("../../package.json").version]],
    aporta: [["Búsquedas de proveedor repetidas sin coste (webs reutilizadas)", n(V.websReutilizadas)], ["Consultas al buscador servidas de caché", n(V.consultasCache)]],
    costEur: null, projectedEur: null, costNote: "Ver en Railway", dashboard: "https://railway.com/dashboard", docs: "" });

  const known = S.filter(function (x) { return x.costEur != null; });
  res.json({
    ok: true, month: m.month, generatedAt: now.toISOString(), usdEur: USD_EUR,
    totalEur: round2(known.reduce(function (n, x) { return n + (x.costEur || 0); }, 0)),
    projectedEur: round2(known.reduce(function (n, x) { return n + (x.projectedEur || 0); }, 0)),
    value: { oportunidadesTarifa: n(V.oportunidades), tarifasCruzadas: n(V.tarifas), filasCruzadas: n(V.tarifaFilas), radarNuevas: n(V.radar), busquedasProveedor: n(V.busquedasProveedor), proveedoresEncontrados: n(V.proveedores), aptosBusqueda: n(kt.aptos), respuestas: n(mt.replies), tarifasRecibidas: n(mt.tariffs), correos: n(mt.sent) },
    services: S, alerts: alerts, days: days, cache: cache, breakers: breaker.snapshot()
  });
}));

router.post("/test", ah(async function (req, res) {
  const svc = String((req.body && req.body.svc) || "");
  let out = { ok: false, reason: "servicio_desconocido" };
  if (svc === "keepa") { const k = await keepaAccount(); out = k ? { ok: true, text: k.tokensLeft + " tokens disponibles · recarga " + k.refillRate + "/min" } : { ok: false, reason: keepaReady() ? "Keepa no responde" : "Falta KEEPA_API_KEY" }; }
  else if (svc === "apify") { const a = await apifyAccount(); out = a && a.ok ? { ok: true, text: "Cuenta OK · plan " + (a.plan || "?") + (a.usedUsd != null ? " · gastado " + round2(a.usedUsd) + " $" : "") } : { ok: false, reason: apifyReady() ? ("Apify no responde " + ((a && a.error) || "")) : "Falta APIFY_TOKEN" }; }
  else if (svc === "spapi") { const r = await require("../lib/spapi").check(); out = r.ok ? { ok: true, text: "Conectado" + (r.current ? " · " + (r.current.store || r.current.name || r.current.country) : "") } : { ok: false, reason: r.reason }; }
  else if (svc === "brave") {
    if (!(config.discovery && config.discovery.apiKey)) out = { ok: false, reason: "Falta BRAVE_API_KEY" };
    else {
      const d = require("../adapters/discovery");
      const r = await d.searchQueries([{ q: "distribuidor oficial mayorista España" }], { perQuery: 5, timeoutMs: 15000 });
      out = r.engines.some(function (e) { return /brave/.test(e); }) ? { ok: true, text: "Responde · quedan " + (d.braveStats.monthLeft == null ? "?" : d.braveStats.monthLeft) + " consultas" } : { ok: false, reason: (r.errors || []).filter(function (e) { return /brave/.test(e); }).join(", ") || "sin respuesta" };
    }
  }
  else if (svc === "ai") {
    const ai = require("../lib/ai");
    if (!ai.ready()) out = { ok: false, reason: "Falta ANTHROPIC_API_KEY o la IA está desactivada" };
    else { const r = await ai.askJson("prueba", "Responde solo JSON.", "Devuelve {\"ok\":true}", 20); out = r.ok ? { ok: true, text: "Responde · modelo " + r.model } : { ok: false, reason: r.reason || "sin respuesta" }; }
  }
  if (out.ok) live.at = 0;
  res.json(out);
}));

module.exports = router;
