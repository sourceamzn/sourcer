/* FABRICANTES Y DISTRIBUIDORES (busqueda de quien suministra un EAN).

   Accion `find` (y `search`, mismo contrato):
     body: { ean, eans[], brand, manufacturer, model, partNumber, name, asin }
   1. Monta las consultas de la busqueda manual ("<EAN>" mayorista,
      "<EAN>" distribuidor, "<marca>" distribuidor oficial...) -> lib/leads.
   2. Las lanza literalmente en Google (Apify) / Brave / DuckDuckGo-Bing.
   3. Agrupa por dominio y clasifica: fabricante, distribuidor oficial,
      mayorista, marketplace B2B, base de datos EAN, minorista (se aparta).
   4. Abre las mejores paginas para confirmar: EAN en la pagina, senales B2B,
      precios tras registro, email/telefono y enlace a "distribuidores".
   No exige precio ni ficha schema.org: un proveedor B2B casi nunca los tiene. */

const { config, apifyReady, discoveryReady } = require("../config");
const { jsonFetch, isSafeRemoteUrl } = require("../lib/http");
const leadsLib = require("../lib/leads");
const gtin = require("../lib/gtin");
const events = require("../lib/events");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function cfg() {
  const c = config.leads || {};
  return {
    enabled: c.enabled !== false,
    maxQueries: c.maxQueries || 10,
    perQuery: c.perQuery || 10,
    pageChecks: c.pageChecks == null ? 8 : c.pageChecks,
    pageMs: c.pageMs || 8000,
    timeoutMs: c.timeoutMs || 90000
  };
}

async function readPage(url, ms) {
  if (!isSafeRemoteUrl(url)) return null;
  const r = await jsonFetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "es-ES,es;q=0.9,en;q=0.6" } }, ms);
  if (r && r.ok && typeof r.data === "string" && r.data.length > 200) return r.data;
  return null;
}

async function find(body, hooks) {
  body = body || {};
  hooks = hooks || {};
  const c = cfg();
  const t0 = Date.now();
  const eans = gtin.normalizeAll([].concat(body.eans || [], body.ean || []));
  let brand = String(body.brand || "").trim();
  /* Sin marca pero con EAN: se intenta resolver la marca por el codigo. */
  if (!brand && eans.length) {
    try {
      const eanLib = require("../lib/ean");
      const info = await eanLib.lookup(eans[0]);
      if (info && info.ok && info.data && info.data.brand) brand = info.data.brand;
    } catch (e) {}
  }
  const ctx = { eans: eans, brand: brand, manufacturer: String(body.manufacturer || "").trim(), brands: leadsLib.brandCandidates(Object.assign({}, body, { brand: brand })) };
  const queries = leadsLib.buildLeadQueries(Object.assign({}, body, { brand: brand }), { max: c.maxQueries, lang: (config.discovery && config.discovery.lang) || "es" });
  const links = leadsLib.googleLinks(queries);
  if (!queries.length) {
    return { ok: false, reason: "sin_identidad", data: { queries: [], googleLinks: [], leads: [], retailers: [], note: "Sin EAN ni marca no se puede buscar fabricante/distribuidor." } };
  }
  const discovery = require("./discovery");
  const sr = await discovery.searchQueries(queries, { perQuery: c.perQuery, timeoutMs: c.timeoutMs });
  const ranked = leadsLib.rankLeads(sr.results || [], ctx);

  /* Confirmar en la pagina las mejores pistas (no minoristas, no bases EAN). */
  const toCheck = ranked.leads.filter(function (l) { return l.role !== "info_ean"; }).slice(0, c.pageChecks);
  let checked = 0;
  if (toCheck.length) {
    let i = 0;
    const worker = async function () {
      while (i < toCheck.length) {
        const lead = toCheck[i++];
        try {
          const html = await readPage(lead.url, c.pageMs);
          if (!html) continue;
          checked++;
          leadsLib.applyPage(lead, leadsLib.pageSignals(html, ctx, lead.url));
        } catch (e) {}
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  /* La pagina puede haber convertido una pista en minorista. */
  const leads = [], retailers = ranked.retailers.slice();
  ranked.leads.forEach(function (l) {
    if (l.role === "minorista" || l.role === "minorista_probable") retailers.push(l); else leads.push(l);
  });
  /* Precio del candidato frente al precio maximo de compra y al punto de
     equilibrio (lib/plan). Solo ordena y etiqueta: no descarta. */
  const target = {
    priceMax: Number(body.priceMax) || 0, priceMaxNet: Number(body.priceMaxNet) || 0,
    breakEven: Number(body.breakEven) || 0, breakEvenNet: Number(body.breakEvenNet) || 0
  };
  leads.concat(retailers).forEach(function (l) { l.priceCheck = leadsLib.priceBand(l, target); });
  /* Una tienda que vende POR DEBAJO del precio maximo tambien es una compra
     valida (arbitraje online): se sube a la lista principal, marcada. */
  for (let i = retailers.length - 1; i >= 0; i--) {
    const r = retailers[i];
    if (r.priceCheck && r.priceCheck.band === "ok") {
      r.retailOk = true;
      r.roleLabel = "Tienda con precio que deja margen";
      leads.push(r);
      retailers.splice(i, 1);
    }
  }
  leads.sort(leadsLib.compareLeads);

  const counts = {};
  leads.forEach(function (l) { counts[l.role] = (counts[l.role] || 0) + 1; });
  const engines = sr.engines || [];
  let diagnosis = null;
  if (!sr.results || !sr.results.length) {
    diagnosis = {
      reason: "buscador_sin_resultados",
      message: (apifyReady() || discoveryReady())
        ? "El buscador no devolvio resultados (" + ((sr.errors || []).join(", ") || "sin detalle") + "). Abre las busquedas de Google de abajo para comprobarlo a mano."
        : "No hay APIFY_TOKEN ni BRAVE_API_KEY: solo se usa DuckDuckGo/Bing desde el servidor y suelen bloquearlo. Configura Apify (Google) para esta busqueda."
    };
  } else if (!leads.length) {
    diagnosis = {
      reason: "solo_minoristas",
      message: "Las " + sr.results.length + " paginas encontradas son tiendas minoristas o comparadores. El EAN no aparece en webs de fabricante/mayorista indexadas: prueba las busquedas por marca o contacta con la marca."
    };
  }
  const out = {
    source: "fabricantes", ean: leadsLib.bestEans(body)[0] || "", brand: brand, manufacturer: ctx.manufacturer,
    queries: queries, googleLinks: links, engines: engines, errors: sr.errors || [],
    rawResults: (sr.results || []).length, pagesChecked: checked,
    leads: leads.slice(0, 30), retailers: retailers.slice(0, 20), counts: counts, target: target,
    diagnosis: diagnosis, ms: Date.now() - t0
  };
  try {
    events.add("job", { phase: "leads", ean: out.ean, brand: brand, brands: ctx.brands.join("|"), raw: out.rawResults, leads: leads.length, retailers: retailers.length, engines: engines.join("+"), ms: out.ms, errors: (sr.errors || []).join(",") });
    events.add("leads", { q: queries.map(function (x) { return x.q; }).join(" || ").slice(0, 390) });
    /* Una linea por pista (auditable en /debug/events?kind=lead). */
    leads.slice(0, 25).concat(retailers.slice(0, 10)).forEach(function (l) {
      events.add("lead", { host: l.host, role: l.role, score: l.score, ean: Boolean(l.eanOnSerp || (l.page && l.page.eanOnPage)), sig: (l.signals || []).join(","), title: String(l.title || "").slice(0, 120), url: String(l.url || "").slice(0, 200) });
    });
  } catch (e) {}
  return { ok: true, data: out };
}

module.exports = {
  id: "fabricantes",
  label: "Fabricante / distribuidor (EAN en Google)",
  kind: "leads",
  /* No es una fuente de ofertas: la cascada de precios no la consulta. */
  exactOnly: true,
  ean: false,
  actions: {
    ping: async function () {
      return { ok: true, configured: true, mode: apifyReady() ? "google(apify)" : (discoveryReady() ? "brave" : "web_fallback") };
    },
    find: find,
    lookup: find
  },
  find: find
};
