/* CJ DROPSHIPPING como PROVEEDOR con API.

   API v2.0: primero se obtiene un access token a partir del API key, y luego se
   consulta el catalogo. Devuelve precio (en USD), imagen y SKU. La busqueda por
   palabra clave es directa (POST /product/query con keyWord), asi que no hace
   falta snapshot.

   Auth:  POST /authentication/getAccessToken  { apiKey }  -> data.accessToken
   Uso:   POST /product/query   header  CJ-Access-Token: <token>
   Base:  https://developers.cjdropshipping.com/api2.0/v1 */

const { config, cjReady } = require("../config");
const { jsonFetch } = require("../lib/http");

let token = { value: null, exp: 0 };

function base() {
  return config.cj.base.replace(/\/+$/, "");
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

async function accessToken() {
  if (token.value && Date.now() < token.exp) return { ok: true, token: token.value };
  if (!cjReady()) return { ok: false, reason: "cj_not_configured", hint: "Configura CJ_API_KEY (CJdropshipping)." };
  const res = await jsonFetch(
    base() + "/authentication/getAccessToken",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: config.cj.apiKey }) },
    20000
  );
  const d = res.data || {};
  if (!res.ok || (d.code != null && Number(d.code) !== 200) || !d.data || !d.data.accessToken) {
    return { ok: false, reason: "cj_auth_fallo", status: res.status, detail: (d && d.message) || res.error || "" };
  }
  const expiresIn = Number(d.data.expiresIn);
  token = {
    value: d.data.accessToken,
    exp: Date.now() + (isFinite(expiresIn) && expiresIn > 0 ? Math.max(60, expiresIn - 300) * 1000 : 50 * 60 * 1000)
  };
  return { ok: true, token: token.value };
}

function mapCj(p) {
  const price = num(p.sellPrice) || num(p.nowPrice) || num(p.price) || null;
  const pid = String(p.pid || p.productId || p.id || "");
  return {
    source: "cjdropshipping",
    name: String(p.productNameEn || p.productName || p.nameEn || p.name || "").slice(0, 200),
    brand: "",
    model: "",
    reference: String(p.productSku || p.sku || ""),
    ean: "",
    price: price,
    oldPrice: null,
    stock: null,
    available: true,
    url: pid ? "https://www.cjdropshipping.com/product/" + encodeURIComponent(pid) + ".html" : "https://www.cjdropshipping.com/",
    image: String(p.productImage || p.bigImage || p.image || (p.productImageSet && p.productImageSet[0]) || ""),
    attrs: { description: "", currency: "USD", platform: "cj" },
    capturedAt: new Date().toISOString()
  };
}

async function cjGet(url, token) {
  const res = await jsonFetch(url, { method: "GET", headers: { "CJ-Access-Token": token } }, 30000);
  const d = res.data || {};
  const ok = res.ok && (d.code == null || Number(d.code) === 200) && d.result !== false;
  const dd = (d && d.data) || {};
  const list = !ok ? [] : (Array.isArray(dd) ? dd : (dd.productList || dd.list || dd.content || dd.products || []));
  return { ok: ok, status: res.status || 0, message: d.message || res.error || "", data: dd, list: list };
}

async function search(body) {
  body = body || {};
  const q = String((body && (body.query || body.q)) || "").trim();
  if (!q) return { ok: false, reason: "query_required" };
  const auth = await accessToken();
  if (!auth.ok) return { ok: false, reason: auth.reason, status: auth.status, detail: auth.detail, hint: auth.hint };
  const max = Math.min(Math.max(parseInt((body && body.max) || "12", 10) || 12, 1), 50);
  const v2 = await cjGet(
    base() + "/product/listV2?" + new URLSearchParams({ page: "1", size: String(max), keyWord: q }).toString(),
    auth.token
  );
  if (!v2.ok) {
    return { ok: false, reason: "cj_http_" + (v2.status || 0), status: v2.status, detail: v2.message };
  }
  let items = v2.list.map(mapCj).filter(function (it) { return it.name || it.reference; });
  if (items.length) return { ok: true, reason: null, data: { source: "cjdropshipping", query: q, count: items.length, items: items } };

  const legacy = await cjGet(
    base() + "/product/list?" + new URLSearchParams({ pageNum: "1", pageSize: String(max), productNameEn: q }).toString(),
    auth.token
  );
  items = legacy.list.map(mapCj).filter(function (it) { return it.name || it.reference; });
  if (items.length) return { ok: true, reason: null, data: { source: "cjdropshipping", query: q, count: items.length, items: items } };

  const first = v2.list[0] ? Object.keys(v2.list[0]).slice(0, 20).join("|") : (legacy.list[0] ? Object.keys(legacy.list[0]).slice(0, 20).join("|") : "-");
  return {
    ok: false,
    reason: "cj_sin_resultados",
    detail: "v2 total=" + (v2.data.totalRecords != null ? v2.data.totalRecords : (v2.data.total != null ? v2.data.total : "?")) +
      " keys=" + Object.keys(v2.data).join(",") + " first=" + first +
      " | list ok=" + legacy.ok + " total=" + (legacy.data.total != null ? legacy.data.total : "?") +
      " keys=" + Object.keys(legacy.data).join(","),
    data: { source: "cjdropshipping", query: q, count: 0, items: [] }
  };
}

const cjdropshipping = {
  id: "cjdropshipping",
  label: "CJdropshipping",
  kind: "wholesale",
  supplier: true,
  actions: {
    ping: async () => ({
      ok: cjReady(),
      configured: cjReady(),
      reason: cjReady() ? null : "cj_not_configured",
      mode: cjReady() ? "api_dropshipping" : "sin_clave",
      note: cjReady() ? "Catalogo mayorista con busqueda por palabra clave (precio en USD)." : "Sin CJ_API_KEY: el proveedor esta apagado."
    }),
    search
  }
};

module.exports = cjdropshipping;
