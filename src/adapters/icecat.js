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
  if (st === 401 || st === 403) return "Icecat rechaza las credenciales (" + st + "). Revisa usuario y contrasena y que la IP del servidor figure en 'Direccion IP permitida'.";
  if (st === 429) return "Limite de peticiones de Icecat alcanzado (429). Reintenta mas tarde.";
  if (st === 404) return "Icecat no tiene ficha para ese codigo (404). Puede ser una marca no patrocinada en Open Icecat.";
  return (res && res.error) ? String(res.error) : "Icecat no devolvio datos.";
}

async function request(params) {
  const qs = new URLSearchParams();
  qs.set("UserName", String(config.icecat.username || ""));
  qs.set("Language", String(config.icecat.lang || "es").toUpperCase());
  Object.keys(params).forEach(function (k) {
    if (params[k] != null && params[k] !== "") qs.set(k, String(params[k]));
  });
  const res = await jsonFetch(base() + "/api/?" + qs.toString(), {
    method: "GET",
    headers: { Authorization: authHeader(), Accept: "application/json", "User-Agent": "sourcer/0.8" }
  }, 20000);
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
  if (typeof value === "string") return value;
  if (typeof value === "object") return String(value.LongDesc || value.ShortDesc || value.Value || value.Name || "");
  return String(value);
}

function toItem(data) {
  const g = generalOf(data);
  const image = data.Image || data.image || {};
  const category = g.Category || g.category || {};
  const gtin = cleanCode(g.GTIN || g.Gtin || g.EAN || "");
  const code = String(g.ProductCode || g.MPN || "").trim();
  return {
    source: "icecat",
    name: String(g.Title || g.ProductName || code || gtin).slice(0, 200),
    brand: textOf(g.Brand || g.BrandName),
    model: code,
    reference: String(g.IcecatId || ""),
    ean: gtin,
    price: null,
    oldPrice: null,
    stock: null,
    available: false,
    url: String(g.ProductPage || g.ProductURL || ""),
    image: String(image.HighPic || image.LowPic || image.Pic500x500 || ""),
    attrs: {
      description: textOf(g.Description || g.ShortDescription || g.LongDescription).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400),
      category: textOf(category),
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
    return { ok: false, reason: "icecat_not_configured", hint: "Configura ICECAT_USERNAME e ICECAT_PASSWORD (no es una API key)." };
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
    ping: async () => ({
      ok: icecatReady(),
      configured: icecatReady(),
      reason: icecatReady() ? null : "icecat_not_configured",
      base: base(),
      language: config.icecat.lang,
      auth: "basic",
      note: icecatReady()
        ? "Usuario y contrasena cargados. Si la IP no esta autorizada en Icecat, la API respondera 401/403."
        : "Sin ICECAT_USERNAME/ICECAT_PASSWORD: la fuente esta apagada."
    }),
    lookup,
    search
  }
};

module.exports = icecat;
