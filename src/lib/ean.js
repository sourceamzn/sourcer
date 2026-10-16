/* Resolucion de codigo de barras -> producto (nombre/marca/categoria).

   Sirve para dos cosas del flujo:
   1) Cuando el usuario arranca la busqueda de proveedores con un EAN, no se
      consulta el buscador solo con el numero: se enriquece con marca + nombre
      para que el resultado sea un proveedor real del producto.
   2) Para etiquetar mejor un candidato que venia solo con el codigo.

   UPCitemdb tiene un endpoint "trial" SIN CLAVE (limite reducido); con
   UPCITEMDB_API_KEY se usa el endpoint de produccion. EAN-Search es la
   alternativa si se prefiere (BARCODE_PROVIDER=ean-search). */

const { config } = require("../config");
const { jsonFetch } = require("./http");

function digits(value) {
  const m = String(value == null ? "" : value).match(/\d+/g);
  return m ? m.join("") : "";
}

function clean(value) {
  return String(value == null ? "" : value).trim();
}

async function upcitemdb(code) {
  const tier = config.barcode.apiKey ? "prod" : "trial";
  const url = "https://api.upcitemdb.com/" + tier + "/lookup?upc=" + encodeURIComponent(code);
  const headers = { "User-Agent": "sourcer/0.6 (+https://bruneagroup.com)", Accept: "application/json" };
  if (config.barcode.apiKey) headers.user_key = config.barcode.apiKey;
  const res = await jsonFetch(url, { method: "GET", headers }, 15000);
  if (!res.ok) return { ok: false, reason: "upcitemdb_http_" + res.status, status: res.status };
  const d = res.data || {};
  const item = (d.items || [])[0];
  if (!item) return { ok: false, reason: "ean_sin_producto" };
  return {
    ok: true,
    data: {
      name: clean(item.title),
      brand: clean(item.brand),
      category: clean(item.category),
      ean: code,
      images: item.images || [],
      via: "upcitemdb"
    }
  };
}

async function eanSearch(code) {
  const url =
    "https://api.ean-search.org/api?op=barcode-lookup&format=json&token=" +
    encodeURIComponent(config.barcode.apiKey) +
    "&ean=" +
    encodeURIComponent(code);
  const res = await jsonFetch(url, { method: "GET", headers: { Accept: "application/json" } }, 15000);
  if (!res.ok || !Array.isArray(res.data)) return { ok: false, reason: "ean_search_fallo", status: res.status };
  const it = res.data[0];
  if (!it) return { ok: false, reason: "ean_sin_producto" };
  return {
    ok: true,
    data: {
      name: clean(it.name),
      brand: clean(it.brand),
      category: clean(it.categoryName),
      ean: code,
      images: [],
      via: "ean-search"
    }
  };
}

async function lookup(ean) {
  const code = digits(ean);
  if (code.length < 8) return { ok: false, reason: "ean_invalido" };
  try {
    if (config.barcode.provider === "ean-search" && config.barcode.apiKey) return await eanSearch(code);
    return await upcitemdb(code);
  } catch (e) {
    return { ok: false, reason: "ean_error", error: String((e && e.message) || e) };
  }
}

module.exports = { lookup, digits };
