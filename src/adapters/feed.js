const { jsonFetch } = require("../lib/http");

function parseCsv(text) {
  const lines = String(text)
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const commas = (lines[0].match(/,/g) || []).length;
  const semis = (lines[0].match(/;/g) || []).length;
  const tabs = (lines[0].match(/\t/g) || []).length;
  const delimiter = semis > commas && semis >= tabs ? ";" : tabs > commas ? "\t" : ",";
  const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] == null ? "" : cells[i];
    });
    return obj;
  });
  return { headers, rows };
}

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return "";
}

function normalize(row, mapping, source) {
  const attrs = {};
  Object.keys(mapping).forEach((field) => {
    attrs[field] = pick(row, mapping[field]);
  });
  return {
    source,
    name: attrs.name || attrs.title || "",
    brand: attrs.brand || "",
    model: attrs.model || "",
    reference: attrs.reference || attrs.sku || "",
    ean: attrs.ean || attrs.upc || "",
    price: attrs.price ? Number(String(attrs.price).replace(",", ".")) : null,
    stock: attrs.stock ? Number(attrs.stock) : null,
    url: attrs.url || "",
    image: attrs.image || "",
    attrs,
    capturedAt: new Date().toISOString()
  };
}

async function fetchFeed(url) {
  const res = await jsonFetch(url, { method: "GET", headers: { Accept: "text/csv, application/json, */*" } }, 30000);
  if (!res.ok) return { ok: false, reason: "feed_http_" + res.status, error: res.error };
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  return { ok: true, text };
}

function feedAction(feedKey, mapping) {
  return async (body) => {
    const { config, feedReady } = require("../config");
    const url = (body && body.feed) || config.feeds[feedKey];
    if (!url) return { ok: false, reason: "feed_not_configured" };
    const fetched = await fetchFeed(url);
    if (!fetched.ok) return fetched;
    const parsed = parseCsv(fetched.text);
    return { ok: true, data: { source: feedKey, count: parsed.rows.length, headers: parsed.headers, items: parsed.rows.map((r) => normalize(r, mapping, feedKey)) } };
  };
}

module.exports = { parseCsv, normalize, fetchFeed, feedAction, feedReady: (k) => require("../config").feedReady(k) };
