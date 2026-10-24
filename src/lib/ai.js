"use strict";
/* IA (Claude Haiku) para tareas cortas y baratas: leer respuestas de
   proveedores, clasificar webs, planificar busquedas. Nunca decide sola si un
   producto es rentable (eso lo hacen los numeros de Keepa).
   - ANTHROPIC_API_KEY: clave de la API de Anthropic.
   - AI_MODEL (por defecto claude-haiku-5-5) y AI_FALLBACK_MODEL
     (claude-haiku-4-5) si el primero no esta disponible en tu cuenta.
   - AI_DAILY_LIMIT: llamadas maximas al dia (tope de gasto). 0 = apagada. */

const httpLib = require("./http");
const docs = require("./docstore");
const events = require("./events");

function env(k, d) { const v = process.env[k]; return v == null || String(v).trim() === "" ? d : String(v).trim(); }
function cfg() {
  return {
    key: env("ANTHROPIC_API_KEY", ""),
    model: env("AI_MODEL", "claude-haiku-5-5"),
    fallback: env("AI_FALLBACK_MODEL", "claude-haiku-4-5"),
    daily: Math.max(0, parseInt(env("AI_DAILY_LIMIT", "300"), 10) || 0),
    enabled: env("AI_ENABLED", "1") !== "0"
  };
}
function ready() { const c = cfg(); return Boolean(c.enabled && c.key && c.daily > 0); }

function today() { return new Date().toISOString().slice(0, 10); }
async function usage() {
  const u = (await docs.get("settings", "ai_usage")) || {};
  if (u.day !== today()) return { day: today(), calls: 0, inTok: 0, outTok: 0, byPurpose: {}, model: u.model || "" };
  return u;
}
async function note(purpose, data, model) {
  try {
    const u = await usage();
    u.calls += 1;
    u.inTok += Number(data && data.usage && data.usage.input_tokens) || 0;
    u.outTok += Number(data && data.usage && data.usage.output_tokens) || 0;
    u.byPurpose[purpose] = (u.byPurpose[purpose] || 0) + 1;
    u.model = model;
    await docs.put("settings", "ai_usage", u);
    const inT = Number(data && data.usage && data.usage.input_tokens) || 0, outT = Number(data && data.usage && data.usage.output_tokens) || 0;
    /* Precio de Haiku 4.5: 1 $ / millon de entrada, 5 $ / millon de salida. */
    require("./usage").add("ai", { calls: 1, inTok: inT, outTok: outT, estUsd: inT / 1e6 * 1 + outT / 1e6 * 5, ["p_" + String(purpose || "otro")]: 1 });
  } catch (e) {}
}

let workingModel = null;
/* Se "pre-rellena" la respuesta con "{" para que el modelo conteste solo con
   el JSON (sin texto ni bloques ``` alrededor). */
async function call(model, system, user, maxTokens) {
  return httpLib.jsonFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg().key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: model, max_tokens: maxTokens || 700, system: system, messages: [{ role: "user", content: user }, { role: "assistant", content: "{" }] })
  }, 45000);
}
/* JSON tolerante: quita ``` y, si la respuesta se corto por longitud, cierra
   lo que falte (se pierde como mucho el ultimo elemento incompleto). */
function parseLoose(text) {
  let t = String(text || "").replace(/```(?:json)?/gi, "").trim();
  if (t[0] !== "{") t = "{" + t;
  const end = t.lastIndexOf("}");
  try { return JSON.parse(t.slice(0, end + 1)); } catch (e) {}
  /* Reparar truncado: cortar en el ultimo objeto completo de un array y cerrar. */
  for (let cut = t.length; cut > 1; cut = t.lastIndexOf("}", cut - 1)) {
    const head = t.slice(0, cut + 1);
    const opens = (head.match(/\[/g) || []).length - (head.match(/\]/g) || []).length;
    const braces = (head.match(/\{/g) || []).length - (head.match(/\}/g) || []).length;
    if (opens < 0 || braces < 0) continue;
    try { return JSON.parse(head + "]".repeat(opens) + "}".repeat(braces)); } catch (e) {}
    if (cut <= 0) break;
  }
  return null;
}

/* Devuelve { ok, text, json } o { ok:false, reason }. Espera JSON en la respuesta. */
async function askJson(purpose, system, user, maxTokens) {
  if (!ready()) return { ok: false, reason: "ia_no_configurada" };
  const u = await usage();
  if (u.calls >= cfg().daily) return { ok: false, reason: "tope_diario_ia" };
  let model = workingModel || cfg().model;
  let r = await call(model, system, user, maxTokens);
  if (!r.ok && (r.status === 404 || (r.status === 400 && /model/i.test(JSON.stringify(r.data || ""))))) {
    model = cfg().fallback;
    r = await call(model, system, user, maxTokens);
  }
  if (!r.ok) {
    try { events.add("ai", { purpose: purpose, ok: false, status: r.status, detail: JSON.stringify(r.data || r.error || "").slice(0, 200) }); } catch (e) {}
    return { ok: false, reason: "ia_http_" + r.status };
  }
  workingModel = model;
  await note(purpose, r.data, model);
  const text = ((r.data && r.data.content) || []).map(function (b) { return b && b.text ? b.text : ""; }).join("").trim();
  const json = parseLoose(text);
  try { events.add("ai", { purpose: purpose, ok: Boolean(json), model: model, stop: r.data && r.data.stop_reason, head: json ? undefined : text.slice(0, 160) }); } catch (e) {}
  return { ok: Boolean(json), text: text, json: json, model: model, reason: json ? null : "respuesta_no_json" };
}

/* Correcciones del usuario («Esto esta mal») como ejemplos para la IA. */
async function lessons(purpose, n) {
  try {
    const ex = await require("./feedback").examples(purpose, n || 8);
    if (!ex.length) return "";
    return "\n\nCorrecciones que hizo el usuario en casos anteriores (aprende de ellas y no repitas esos errores):\n" + JSON.stringify(ex);
  } catch (e) { return ""; }
}

/* ---------- 1. Leer la respuesta de un proveedor ---------- */
const REPLY_TYPES = ["tarifa", "pide_alta", "pide_info", "pregunta_canal", "solo_distribuidores", "no_distribuye", "rechazo", "baja", "automatica", "otro"];
async function analyzeReply(ctx) {
  ctx = ctx || {};
  const products = (ctx.products || []).slice(0, 5).map(function (p) { return "- " + (p.name || "") + (p.model ? " · Ref. " + p.model : "") + (p.ean ? " · EAN " + p.ean : "") + (p.priceMaxNet ? " · nuestro precio maximo sin IVA " + p.priceMaxNet + " EUR" : ""); }).join("\n");
  const system = "Eres el asistente de compras de una empresa de comercio online en Espana. Lees la respuesta de un proveedor (fabricante o distribuidor) a nuestra solicitud de tarifa y devuelves SOLO un JSON valido, sin texto alrededor. No inventes datos: si algo no aparece en el correo, usa null. Nunca menciones Amazon.";
  const user = "Productos por los que preguntamos:\n" + (products || "(sin detalle)") +
    "\n\nProveedor: " + (ctx.supplier || "") +
    "\nNuestro nombre y empresa para firmar: " + [ctx.senderName, ctx.senderCompany].filter(Boolean).join(", ") +
    "\n\nAsunto de su correo: " + (ctx.subject || "") +
    "\nTexto de su correo:\n\"\"\"\n" + String(ctx.text || "").slice(0, 3500) + "\n\"\"\"\n\n" +
    "Devuelve este JSON:\n{\"tipo\": uno de " + JSON.stringify(REPLY_TYPES) + " (tarifa = envian tarifa, precios o catalogo con precios; pide_alta = piden CIF, formulario o alta de cliente; pide_info = piden mas datos; pregunta_canal = preguntan donde o como vendemos (tienda, web, marketplaces); solo_distribuidores = dicen que solo venden a traves de distribuidores/mayoristas; rechazo = no trabajan con nuevos clientes o no les interesa; automatica = respuesta automatica tipo 'fuera de la oficina'; baja = piden no recibir mas correos)," +
    "\"idioma\": codigo ISO de 2 letras del idioma del correo," +
    "\"traduccion_es\": traduccion fiel al espanol del correo si NO esta en espanol, si no null," +
    "\"distribuidor_indicado\": si mencionan a que distribuidor dirigirnos {\"nombre\": ..., \"web\": ..., \"email\": ..., \"telefono\": ...} con null en lo que no digan; si no, null," +
    "\"resumen\": \"una frase en espanol\"," +
    "\"precio_neto\": numero o null, \"moneda\": \"EUR\" o null, \"iva_incluido\": true/false/null," +
    "\"pedido_minimo\": \"texto o null\", \"condiciones\": \"pago, envio, plazos... o null\"," +
    "\"adjuntos_mencionados\": true/false," +
    "\"siguiente_paso\": \"que deberiamos hacer ahora, en una frase\"," +
    "\"borrador_respuesta\": \"respuesta breve y educada, en el idioma del proveedor, para que la revisemos antes de enviarla, firmada con nuestro nombre y empresa; sin inventar precios, cantidades ni compromisos; sin mencionar Amazon ni marketplaces, sin revelar precio objetivo ni datos de ventas; si preguntan por el canal de venta, pon null (eso lo responde una persona)\"}";
  const r = await askJson("respuesta", system, user + (await lessons("respuesta", 6)), 2000);
  if (!r.ok) return r;
  const j = r.json;
  if (REPLY_TYPES.indexOf(j.tipo) === -1) j.tipo = "otro";
  return { ok: true, analysis: j, model: r.model };
}

/* ---------- 1b. Traducir un correo (plantilla en espanol -> idioma del proveedor) ---------- */
const LANG_NAMES = { en: "ingles", fr: "frances", de: "aleman", it: "italiano", pt: "portugues", nl: "neerlandes", pl: "polaco", sv: "sueco", da: "danes", cs: "checo", fi: "finlandes", no: "noruego", el: "griego", ro: "rumano", hu: "hungaro" };
async function translateEmail(m) {
  const lang = String((m && m.lang) || "").toLowerCase();
  const name = LANG_NAMES[lang] || lang;
  const system = "Traduces correos comerciales B2B del espanol a otros idiomas. Traduccion fiel, natural y profesional, con el mismo tono (cercano y educado). No anadas ni quites nada: ni frases, ni datos, ni enlaces. Mantén exactamente nombres propios, marcas, referencias, EAN, cifras, emails, telefonos y webs. Devuelve SOLO JSON valido.";
  const user = "Traduce al " + name + " (" + lang + ") este correo.\n\nAsunto:\n" + String(m.subject || "") + "\n\nCuerpo:\n\"\"\"\n" + String(m.text || "") + "\n\"\"\"\n\nDevuelve: {\"asunto\": \"...\", \"cuerpo\": \"...\"} (si el asunto empieza por \"Re: \", conservalo tal cual al principio).";
  const r = await askJson("traducir_correo", system, user, 2500);
  if (!r.ok) return r;
  const subject = String(r.json.asunto || "").trim(), text = String(r.json.cuerpo || "").trim();
  if (!subject || !text) return { ok: false, reason: "traduccion_vacia" };
  /* Comprobacion: las cifras/EAN del original deben seguir en la traduccion. */
  const nums = (String(m.text || "").match(/\d{6,}/g) || []);
  const lost = nums.filter(function (n) { return text.indexOf(n) === -1; });
  if (lost.length) return { ok: false, reason: "traduccion_pierde_datos" };
  return { ok: true, subject: subject, text: text };
}

/* ---------- 2. Proveedores: consultas extra y clasificacion de webs ---------- */
function prodLine(ctx) {
  return [ctx.name ? "Producto: " + ctx.name : "", ctx.brand ? "Marca (segun Amazon): " + ctx.brand : "", ctx.manufacturer ? "Fabricante (segun Amazon): " + ctx.manufacturer : "",
    ctx.model ? "Referencia: " + ctx.model : "", ctx.ean ? "EAN: " + ctx.ean : ""].filter(Boolean).join("\n");
}
async function suggestSupplierQueries(ctx) {
  const system = "Ayudas a una empresa de compras en Espana a encontrar el FABRICANTE y los DISTRIBUIDORES o MAYORISTAS (no tiendas) de un producto. Devuelve SOLO JSON valido.";
  const user = prodLine(ctx) + "\n\nYa vamos a buscar en Google: " + JSON.stringify((ctx.existing || []).slice(0, 12)) +
    "\n\nPropon como maximo 3 busquedas de Google NUEVAS y distintas que ayuden a encontrar al fabricante o a sus distribuidores/mayoristas en Espana (por ejemplo, con el nombre de la empresa titular de la marca si la conoces con seguridad, o terminos del sector como 'material electrico mayorista'). No repitas las existentes." +
    "\nDevuelve: {\"titular_marca\": \"empresa titular de la marca si lo sabes con seguridad, si no null\", \"consultas\": [\"...\"]}";
  const r = await askJson("proveedores_consultas", system, user, 700);
  if (!r.ok) return r;
  const q = (Array.isArray(r.json.consultas) ? r.json.consultas : []).map(function (x) { return String(x || "").trim().slice(0, 120); }).filter(Boolean).slice(0, 3);
  return { ok: true, queries: q, owner: r.json.titular_marca ? String(r.json.titular_marca).slice(0, 80) : null };
}
const LEAD_ROLES = ["fabricante", "distribuidor_oficial", "mayorista", "marketplace_b2b", "info_ean", "minorista", "irrelevante"];
async function classifyLeads(ctx, items) {
  if (!items.length) return { ok: true, items: [] };
  const system = "Clasificas webs encontradas al buscar proveedores de un producto para una empresa que compra para revender. Devuelve SOLO JSON valido. Se prudente: si no hay pruebas, usa vende_producto null.";
  const list = items.map(function (x) {
    return { id: x.id, web: x.host, titulo: String(x.title || "").slice(0, 140), fragmento: String(x.snippet || "").slice(0, 240), texto_pagina: String(x.text || "").slice(0, 700) };
  });
  const user = prodLine(ctx) + "\n\nWebs:\n" + JSON.stringify(list) +
    "\n\nPara cada web devuelve su papel: fabricante (la marca o su fabricante), distribuidor_oficial, mayorista (vende a profesionales/B2B, aunque no sea oficial), marketplace_b2b (Alibaba, Ankorstore...), info_ean (base de datos de codigos), minorista (tienda al consumidor), irrelevante (blog, foro, noticia, manual, otra cosa)." +
    "\nDevuelve: {\"webs\": [{\"id\": ..., \"rol\": uno de " + JSON.stringify(LEAD_ROLES) + ", \"vende_producto\": true/false/null (si ofrece este producto o esta marca), \"motivo\": \"max 12 palabras\"}]}";
  const r = await askJson("proveedores_clasificar", system, user + (await lessons("proveedores_clasificar", 10)), 3000);
  if (!r.ok) return r;
  const out = (Array.isArray(r.json.webs) ? r.json.webs : []).filter(function (w) { return w && LEAD_ROLES.indexOf(w.rol) !== -1; });
  return { ok: true, items: out };
}

/* ---------- 3. Productos: revisar titulos antes de gastar tokens de Buy Box ---------- */
async function reviewTitles(query, items) {
  if (!items.length) return { ok: true, drop: [], suggestions: [] };
  const system = "Ayudas a un vendedor de Amazon.es (arbitraje: revende productos de marca que ya tienen ficha) a filtrar resultados de una busqueda. Devuelve SOLO JSON valido. Descarta solo lo claro: si dudas, no lo descartes.";
  const list = items.map(function (x) { return { asin: x.asin, titulo: String(x.title || "").slice(0, 160) }; });
  const user = "Busqueda del usuario: \"" + String(query || "").slice(0, 80) + "\"\n\nResultados:\n" + JSON.stringify(list) +
    "\n\nMarca para descartar SOLO los que claramente no son lo que el usuario busca: repuestos o accesorios de otro producto, fundas, recambios, productos de otra categoria. NO descartes por precio, marca o calidad." +
    "\nAnade hasta 4 busquedas relacionadas (en espanol, 1-3 palabras) con buen potencial para arbitraje en Amazon.es." +
    "\nDevuelve: {\"descartar\": [{\"asin\": \"...\", \"motivo\": \"max 8 palabras\"}], \"sugerencias\": [\"...\"]}";
  const r = await askJson("productos_titulos", system, user + (await lessons("productos_titulos", 8)), 1500);
  if (!r.ok) return r;
  const valid = {};
  items.forEach(function (x) { valid[x.asin] = 1; });
  const drop = (Array.isArray(r.json.descartar) ? r.json.descartar : []).filter(function (d) { return d && valid[d.asin]; });
  /* Salvaguarda: si la IA quiere quitar mas de la mitad, se ignora (algo va mal). */
  const safeDrop = drop.length > items.length / 2 ? [] : drop;
  const sug = (Array.isArray(r.json.sugerencias) ? r.json.sugerencias : []).map(function (x) { return String(x || "").trim().slice(0, 40); }).filter(Boolean).slice(0, 4);
  return { ok: true, drop: safeDrop, ignored: drop.length - safeDrop.length, suggestions: sug };
}

async function status() {
  const c = cfg();
  return { ready: ready(), model: workingModel || c.model, fallback: c.fallback, dailyLimit: c.daily, usage: await usage() };
}

module.exports = { parseLoose, ready, askJson, analyzeReply, translateEmail, suggestSupplierQueries, classifyLeads, reviewTitles, status, cfg, REPLY_TYPES, LEAD_ROLES };
