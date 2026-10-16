/* ALIEXPRESS como PROVEEDOR con API (Open Platform / affiliate).

   Firma TOP: se ordenan los parametros, se concatenan como clave+valor, se
   envuelve con el app_secret y se hashea (md5 por defecto; hmac-sha256 optativo).
   Metodo usado: aliexpress.affiliate.product.query (busqueda por palabras).

   Config: ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET (y opcional session /
   tracking id si el programa lo exige). Base: https://api-sg.aliexpress.com/sync

   Requiere cuenta de desarrollador con la API de afiliado/dropshipping aprobada. */

const crypto = require("crypto");
const { config, aliexpressReady } = require("../config");
const { jsonFetch } = require("../lib/http");

/* AliExpress usa hora GMT+8 para el timestamp. */
function timestamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = function (n) { return (n < 10 ? "0" : "") + n; };
  return (
    d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " +
    p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds())
  );
}

function sign(params, secret, signMethod) {
  const keys = Object.keys(params).sort();
  let base = "";
  keys.forEach(function (k) {
    if (k === "sign") return;
    const v = params[k];
    if (v == null || v === "") return;
    base += k + v;
  });
  if (signMethod === "hmac-sha256" || signMethod === "sha256") {
    return crypto.createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
  }
  return crypto.createHash("md5").update(secret + base + secret, "utf8").digest("hex").toUpperCase();
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

async function call(method, biz, signMethod) {
  const params = Object.assign(
    {
      method: method,
      app_key: config.aliexpress.appKey,
      sign_method: signMethod || "md5",
      timestamp: timestamp(),
      format: "json",
      v: "2.0"
    },
    biz || {}
  );
  if (config.aliexpress.session) params.session = config.aliexpress.session;
  params.sign = sign(params, config.aliexpress.appSecret, params.sign_method);
  const url = config.aliexpress.base + (config.aliexpress.base.indexOf("?") === -1 ? "?" : "&") +
    new URLSearchParams(params).toString();
  return jsonFetch(url, { method: "GET", headers: { Accept: "application/json" } }, 30000);
}

function pickProducts(data, methodName) {
  if (!data || typeof data !== "object") return { error: "respuesta_vacia" };
  const responseKey = methodName.replace(/[.]/g, "_") + "_response";
  const root = data[responseKey] || data;
  if (root.error_response) return { error: root.error_response.msg || root.error_response.code || "ali_error" };
  const rr = root.resp_result || root.result || root;
  const inner = rr.result || rr;
  const prods = inner.products || inner.product || inner.current_record_list || [];
  let arr = prods.product || prods;
  if (!Array.isArray(arr)) arr = arr ? [arr] : [];
  return { products: arr };
}

function mapAe(p) {
  const title = String(p.product_title || p.title || "");
  const price = num(p.target_sale_price) || num(p.sale_price) || num(p.target_original_price) || null;
  const original = num(p.target_original_price) || null;
  const image = p.product_main_image_url || (p.product_small_image_urls && p.product_small_image_urls.string) || "";
  const url = p.promotion_link || p.product_detail_url || (p.product_id ? "https://www.aliexpress.com/item/" + p.product_id + ".html" : "");
  return {
    source: "aliexpress",
    name: title.slice(0, 200),
    brand: "",
    model: "",
    reference: String(p.product_id || ""),
    ean: "",
    price: price,
    oldPrice: original != null && price != null && original > price ? original : null,
    stock: null,
    available: true,
    url: String(url || ""),
    image: String(Array.isArray(image) ? image[0] : image),
    attrs: { description: "", currency: "EUR", platform: "aliexpress" },
    capturedAt: new Date().toISOString()
  };
}

async function search(body) {
  body = body || {};
  if (!aliexpressReady()) {
    return {
      ok: false,
      reason: "aliexpress_not_configured",
      hint: "Configura ALIEXPRESS_APP_KEY y ALIEXPRESS_APP_SECRET (app de desarrollador con la API de afiliado/dropshipping aprobada)."
    };
  }
  const q = String((body && (body.query || body.q)) || "").trim();
  if (!q) return { ok: false, reason: "query_required" };
  const max = Math.min(Math.max(parseInt((body && body.max) || "12", 10) || 12, 1), 50);
  const method = "aliexpress.affiliate.product.query";
  const res = await call(method, {
    keywords: q,
    page_no: 1,
    page_size: max,
    target_currency: "EUR",
    target_language: "ES",
    ship_to_country: "ES",
    sort: "LAST_VOLUME_DESC"
  }, "md5");
  if (!res.ok) return { ok: false, reason: "aliexpress_http_" + res.status, status: res.status, error: res.error };
  const picked = pickProducts(res.data, method);
  if (picked.error) return { ok: false, reason: "aliexpress_error", detail: typeof picked.error === "string" ? picked.error : JSON.stringify(picked.error) };
  const items = (picked.products || []).map(mapAe).filter(function (it) { return it.name; });
  return {
    ok: items.length > 0,
    reason: items.length ? null : "aliexpress_sin_resultados",
    data: { source: "aliexpress", query: q, count: items.length, items: items }
  };
}

const aliexpress = {
  id: "aliexpress",
  label: "AliExpress",
  kind: "marketplace",
  supplier: true,
  actions: {
    ping: async () => ({
      ok: aliexpressReady(),
      configured: aliexpressReady(),
      reason: aliexpressReady() ? null : "aliexpress_not_configured",
      mode: aliexpressReady() ? "open_platform" : "sin_clave",
      note: aliexpressReady() ? "Busqueda de productos por palabra clave (API de afiliado)." : "Sin app_key/app_secret: el proveedor esta apagado."
    }),
    search
  }
};

module.exports = aliexpress;
