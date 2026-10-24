/* ICECAT (Open Icecat / Full Icecat) como fuente de identidad de producto.

   No usa "API key": la API Live autentica con el USUARIO y la CONTRASENA de
   la cuenta de Icecat (HTTP Basic) y exige que la IP del servidor este
   autorizada en el panel. Devuelve ficha por GTIN/EAN, marca+MPN o IcecatId:
   titulo, marca, MPN, categoria, imagen y descripcion. No devuelve precio ni
   stock, asi que no es un proveedor: sirve para resolver el EAN y para que el
   resto de fuentes acierten mas.

   Base: https://live.icecat.biz/api/
   Docs: https://icecat.biz/en/menu/help/api.html */

const { config, icecatReady } = require("../config");
const { jsonFetch } = require("../lib/http");
const gtinLib = require("../lib/gtin");

function base() {
  return config.icecat.base.replace(/\/+$/, "");
}

function authHeader() {
  const raw = String(config.icecat.username || "") + ":" + String(config.icecat.password || "");
  return "Basic " + Buffer.from(raw, "utf8").toString("base64");
}

function cleanCode(value) {
  return String(value == null ? "" : value).replace(/[^0-9A-Za-z]/g, "").trim();
}

function hintFor(res) {
  const st = res && res.status;
  const body = res && res.data;
  const apiMsg = body && (body.Message || body.msg || body.Error || body.error);
  if (st === 401 || st === 403) {
    return "Icecat rechaza la autenticacion (" + st + "). Con tokens, revisa que el api-token sea valido; sin tokens, autoriza la IP de salida y usa el shopname correcto.";
  }
  if (st === 429) return "Limite de peticiones de Icecat alcanzado (429). Reintenta mas tarde.";
  if (st === 404 && /api.?token/i.test(String(apiMsg || ""))) {
    return "API token de Icecat invalido o revocado (404). Genera uno nuevo en My Icecat > Access Tokens.";
  }
  if (st === 404) return "Icecat no tiene ficha para ese codigo (404). Puede ser una marca no patrocinada en Open Icecat.";
  if (st === 400) return apiMsg ? ("Icecat: " + apiMsg + ". Ese GTIN no esta en su catalogo.") : "Icecat no reconoce ese GTIN/EAN (400).";
  return apiMsg ? String(apiMsg) : ((res && res.error) ? String(res.error) : "Icecat no devolvio datos.");
}

async function request(params) {
  /* Los tokens dinamicos van en cabeceras y sustituyen a Basic auth y a la IP
     permitida. Solo se cae a usuario/contrasena si no hay API token. */
  const token = String(config.icecat.apiToken || "").trim();
  const qs = new URLSearchParams();
  qs.set("lang", String(config.icecat.lang || "es").toLowerCase());
  if (config.icecat.shopname) qs.set("shopname", config.icecat.shopname);
  if (!token) {
    qs.set("UserName", String(config.icecat.username || ""));
    qs.set("Language", String(config.icecat.lang || "es").toUpperCase());
  }
  qs.set("content", "");
  Object.keys(params).forEach(function (k) {
    if (params[k] != null && params[k] !== "") qs.set(k, String(params[k]));
  });
  const headers = { Accept: "application/json", "User-Agent": "sourcer/0.8" };
  if (token) {
    headers["api-token"] = token;
    if (config.icecat.contentToken) headers["content-token"] = config.icecat.contentToken;
  } else {
    headers.Authorization = authHeader();
  }
  const res = await jsonFetch(base() + "/api/?" + qs.toString(), {
    method: "GET",
    headers: headers
  }, 20000);
  try { require("../lib/usage").add("icecat", { calls: 1, errors: res.ok ? 0 : 1 }); } catch (e) {}
  if (!res.ok) return { ok: false, res, reason: "icecat_http_" + (res.status || 0), hint: hintFor(res) };
  const body = res.data || {};
  const data = body.data || null;
  if (!data || (body.status && String(body.status).toLowerCase() !== "success")) {
    return { ok: false, res, reason: "icecat_sin_ficha", hint: (body.msg && String(body.msg)) || hintFor(res) };
  }
  return { ok: true, res, data };
}

function generalOf(data) {
  return (data && (data.GeneralInfo || data.generalInfo)) || data || {};
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? textOf(value[0]) : "";
  if (typeof value === "object") {
    if (value.Value != null) return textOf(value.Value);
    if (value.Name != null) return textOf(value.Name);
    return String(value.LongDesc || value.ShortDesc || value.Title || value.Text || "");
  }
  return String(value);
}

/* Icecat devuelve GTIN como ARRAY (varios EAN del mismo producto). Si se
   concatenan, el codigo resultante no coincide con el de Amazon y la ficha se
   descarta. Se toma el primer GTIN valido. */
function allGtins(value) {
  if (value == null) return [];
  let list = value;
  if (!Array.isArray(list)) list = String(list).split(/[,;|\s]+/);
  /* GTINs suele ser [{GTIN:"...",IsApproved:true}, ...]. */
  list = list.map(function (x) {
    if (x && typeof x === "object") return x.GTIN || x.Value || x.Gtin || "";
    return x;
  });
  return gtinLib.normalizeAll(list);
}

function toItem(data) {
  const g = generalOf(data);
  const image = data.Image || data.image || {};
  const category = g.Category || g.category || {};
  const eans = allGtins(g.GTIN || g.GTINs || g.Gtin || g.EAN || "");
  const gtin = eans[0] || "";
  const code = textOf(g.BrandPartCode || g.ProductCode || g.MPN || g.ProductName || "").trim();
  const summary = g.SummaryDescription || {};
  const descSource = textOf(g.Description) || textOf(g.ShortDescription) || textOf(g.LongDescription) ||
    summary.LongSummaryDescription || summary.ShortSummaryDescription || "";
  return {
    source: "icecat",
    name: String(g.Title || g.ProductName || code || gtin).slice(0, 200),
    brand: textOf(g.Brand || g.BrandName),
    model: code,
    reference: textOf(g.IcecatId || ""),
    ean: gtin,
    price: null,
    oldPrice: null,
    stock: null,
    available: false,
    url: textOf(g.ProductPage || g.ProductURL || ""),
    image: String(image.HighPic || image.LowPic || image.Pic500x500 || ""),
    attrs: {
      description: String(descSource).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400),
      category: textOf(category.Name || category),
      eans: eans,
      platform: "icecat",
      priceIncludesVAT: null
    },
    capturedAt: new Date().toISOString()
  };
}

async function lookup(body) {
  body = body || {};
  const ean = cleanCode(body.ean || body.gtin || body.upc || "");
  const brand = String(body.brand || "").trim();
  const code = cleanCode(body.productCode || body.mpn || body.model || "");
  const icecatId = cleanCode(body.icecatId || "");

  if (!ean && !(brand && code) && !icecatId) {
    return { ok: false, reason: "ean_required", hint: "Icecat necesita GTIN/EAN, o marca + MPN; no tiene busqueda por texto libre." };
  }
  if (!icecatReady()) {
    return { ok: false, reason: "icecat_not_configured", hint: "Configura ICECAT_API_TOKEN (recomendado) o ICECAT_USERNAME/ICECAT_PASSWORD." };
  }

  const params = {};
  if (ean) params.GTIN = ean;
  else if (icecatId) params.IcecatId = icecatId;
  else {
    params.Brand = brand;
    params.ProductCode = code;
  }

  const out = await request(params);
  if (!out.ok) return { ok: false, reason: out.reason, status: out.res && out.res.status, hint: out.hint };

  const item = toItem(out.data);
  return {
    ok: true,
    data: { source: "icecat", query: ean || (brand + " " + code) || icecatId, count: 1, items: [item] }
  };
}

/* La app habla "search"; en Icecat buscar es resolver un codigo, no escribir
   una frase. Si llega texto, se rechaza con el motivo en vez de inventar. */
async function search(body) {
  body = body || {};
  if (!body.ean && !body.gtin && !body.upc && body.query) {
    const q = String(body.query).trim();
    if (/^[0-9]{8,14}$/.test(q)) return lookup({ ean: q });
    return { ok: false, reason: "ean_required", hint: "La busqueda de Icecat es por GTIN/EAN o marca + MPN, no por texto libre." };
  }
  return lookup(body);
}

const icecat = {
  id: "icecat",
  label: "Icecat (ficha por EAN)",
  kind: "catalog",
  supplier: false,
  actions: {
    /* No basta con "hay usuario y contrasena": se prueba una ficha real para
       distinguir 401/403 (autenticacion/IP) de 400 (GTIN que Icecat no tiene).
       Asi el panel de Conexiones no miente diciendo que Icecat funciona. */
    ping: async () => {
      const useToken = Boolean(config.icecat.apiToken);
      const info = {
        configured: icecatReady(), base: base(),
        language: config.icecat.lang, auth: useToken ? "api-token" : "basic",
        tokens: { api: Boolean(config.icecat.apiToken), content: Boolean(config.icecat.contentToken) },
        shopname: config.icecat.shopname || null
      };
      if (!icecatReady()) {
        return Object.assign(info, {
          ok: false, reason: "icecat_not_configured",
          note: "Configura ICECAT_API_TOKEN (recomendado) o ICECAT_USERNAME/ICECAT_PASSWORD: la fuente esta apagada."
        });
      }
      let probe = null;
      try { probe = await request({ GTIN: "4948570114344" }); } catch (e) {}
      const status = (probe && probe.res && probe.res.status) || 0;
      const apiMsg = probe && probe.res && probe.res.data && (probe.res.data.Message || probe.res.data.msg || probe.res.data.Error);
      const tokenRejected = status === 404 && /api.?token/i.test(String(apiMsg || ""));
      const authOk = Boolean((probe && probe.ok) || (status && status !== 401 && status !== 403 && !tokenRejected));
      return Object.assign(info, {
        ok: authOk, status: status, authOk: authOk,
        reason: authOk ? null : ((probe && probe.reason) || "icecat_auth"),
        hint: authOk ? null : ((probe && probe.hint) || "Revisa el usuario/shopname y la IP permitida en Icecat."),
        note: authOk
          ? (probe && probe.ok
            ? (useToken ? "Token valido: ficha de prueba recuperada." : "Conexion verificada con un GTIN de prueba (usuario y IP validos).")
            : "Autenticacion aceptada; Icecat no tiene el GTIN de prueba en este catalogo, pero el acceso funciona.")
          : (useToken
            ? "Icecat rechaza el API token (invalido o revocado)."
            : "Icecat rechaza el usuario/shopname o la IP del servidor (401/403).")
      });
    },
    lookup,
    search
  }
};

/* Expuesto solo para tests: convierte la respuesta cruda de Icecat en oferta. */
icecat._toItem = toItem;

module.exports = icecat;
