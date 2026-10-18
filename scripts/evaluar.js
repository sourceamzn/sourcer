#!/usr/bin/env node
/* Evaluador de aceptacion (Fase F).
   Lanza el backend desplegado como caja negra contra un CSV con productos
   conocidos y mide: cobertura de fuentes, ofertas verificadas, EAN exacto,
   proveedor esperado encontrado, precio y motivos de descarte.

   El CSV es un EXAMEN, no un entrenamiento: el motor no lo lee ni aprende de
   el. Los datos de control (proveedor/url/precio esperados) NO se envian a la
   busqueda; solo se usan despues para comparar.

   Uso:
     node scripts/evaluar.js --csv scripts/evaluar.plantilla.csv --dry-run
     node scripts/evaluar.js --csv mi-lista.csv --base https://mi-backend --api-key XXX
     node scripts/evaluar.js --csv mi-lista.csv --base ... --out informe.json

   Columnas del CSV (cabeceras en espanol o ingles):
     asin, ean, marca, modelo, nombre,
     proveedor_esperado, url_esperada, precio_esperado, precio_max, notas

   Requiere Node >= 18 (fetch nativo). No usa dependencias externas. */

"use strict";

const fs = require("fs");
const path = require("path");
const identityLib = require("../src/lib/identity");

const DEFAULT_BASE = process.env.EVAL_BASE || "http://localhost:3000";
const DEFAULT_IDENTITY_FIXTURE = path.join(__dirname, "..", "test", "fixtures", "identidad.json");
const USAGE = [
  "Evaluador de aceptacion del buscador de proveedores.",
  "",
  "  node scripts/evaluar.js --csv <fichero.csv> [opciones]",
  "",
  "Opciones:",
  "  --base <url>        Backend a probar (def. " + DEFAULT_BASE + ")",
  "  --api-key <clave>   Clave X-API-Key (def. variable API_KEY)",
  "  --out <fichero>     Guarda el informe completo en JSON",
  "  --limit <n>         Solo las n primeras filas",
  "  --identidad [json]  Evalua la tabla de identidad sin backend",
  "                      (def. test/fixtures/identidad.json, >= 20 pares)",
  "  --price-max <n>     Precio maximo si la fila no lo trae (def. 0 = sin tope)",
  "  --timeout <seg>     Espera maxima por producto (def. 180)",
  "  --poll <seg>        Cada cuanto consulta el job (def. 2)",
  "  --max <n>           Resultados por fuente (def. 12)",
  "  --dry-run           Valida el CSV sin llamar al backend",
  "  -h, --help          Esta ayuda",
  "",
  "Ejemplo de cabecera:",
  "  asin,ean,marca,modelo,nombre,proveedor_esperado,url_esperada,precio_esperado,precio_max,notas"
].join("\n");

/* ---------------- utilidades puras (probadas en test/evaluar.test.js) ---------------- */

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let s = String(value == null ? "" : value).replace(/[^\d.,-]/g, "");
  if (!s) return 0;
  if (s.indexOf(",") !== -1 && s.indexOf(".") !== -1) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (s.indexOf(",") !== -1) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function headerKey(value) {
  return String(value == null ? "" : value)
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function detectDelimiter(text) {
  const line = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)
    .find(function (l) { return l.trim() && l.trim().charAt(0) !== "#"; }) || "";
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = 0;
  candidates.forEach(function (d) {
    const count = line.split(d).length - 1;
    if (count > bestCount) { best = d; bestCount = count; }
  });
  return best;
}

/* Parser CSV minimo con comillas, comas dentro de comillas, CRLF, BOM y
   lineas de comentario que empiezan por # (utiles en la plantilla). */
function parseCsv(text, delimiter) {
  const source = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const delim = delimiter || detectDelimiter(source);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (source.charAt(i + 1) === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(function (r) {
    const first = String((r && r[0]) || "").trim();
    return r.some(function (c) { return String(c).trim() !== ""; }) && first.charAt(0) !== "#";
  });
}

function readCsv(text, delimiter) {
  const table = parseCsv(text, delimiter);
  if (!table.length) return { rows: [], headers: [] };
  const headers = table[0].map(headerKey);
  const rows = table.slice(1).map(function (cells) {
    const obj = {};
    headers.forEach(function (h, i) {
      if (h) obj[h] = cells[i] == null ? "" : String(cells[i]).trim();
    });
    return obj;
  });
  return { rows: rows, headers: headers };
}

const ALIASES = {
  asin: ["asin"],
  ean: ["ean", "upc", "gtin", "codigo_barras"],
  brand: ["marca", "brand", "fabricante"],
  model: ["modelo", "model", "mpn", "referencia"],
  name: ["nombre", "name", "titulo", "descripcion"],
  supplier: ["proveedor_esperado", "proveedor", "supplier", "tienda_esperada"],
  url: ["url_esperada", "url", "enlace"],
  expectedPrice: ["precio_esperado", "expected_price"],
  priceMax: ["precio_max", "pricemax", "max", "precio_maximo"],
  notes: ["notas", "notes"]
};

function normalizeRow(raw) {
  const source = raw || {};
  const row = {};
  Object.keys(ALIASES).forEach(function (key) {
    row[key] = "";
    for (let i = 0; i < ALIASES[key].length; i++) {
      const alias = ALIASES[key][i];
      if (source[alias] != null && String(source[alias]).trim() !== "") {
        row[key] = String(source[alias]).trim();
        break;
      }
    }
  });
  row.asin = row.asin.toUpperCase();
  row.ean = row.ean.replace(/\D/g, "");
  row.expectedPrice = toNumber(row.expectedPrice);
  row.priceMax = toNumber(row.priceMax);
  return row;
}

function validateRow(row) {
  const errors = [];
  if (row.asin && !/^[A-Z0-9]{10}$/.test(row.asin)) errors.push("ASIN debe tener 10 caracteres");
  if (row.ean && (row.ean.length < 8 || row.ean.length > 14)) errors.push("EAN/UPC debe tener 8-14 digitos");
  if (!row.asin && !row.ean && !row.brand && !row.model) {
    errors.push("sin identidad: falta ASIN, EAN, marca o modelo");
  }
  return errors;
}

function identityStrength(row) {
  if (row.ean) return "alta";
  if (row.brand && row.model) return "media";
  if (row.brand || row.model) return "baja";
  return "muy_baja";
}

function normText(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (e) {
    return "";
  }
}

function supplierMatches(expected, offer) {
  const wanted = normText(expected);
  if (!wanted || !offer) return false;
  const haystack = [
    offer.sourceLabel, offer.source, offer.supplier, hostOf(offer.url)
  ].map(normText).join(" ");
  return haystack.indexOf(wanted) !== -1;
}

function isVerified(offer) {
  return Boolean(offer && (offer.matchBand === "verificado" || offer.state === "verificado"));
}

function isReview(offer) {
  return Boolean(offer && !isVerified(offer) && (offer.matchBand === "revisar" || offer.state === "candidato" || offer.review));
}

function pickBest(matches) {
  const live = (matches || []).filter(function (m) {
    return m && !m.over && Number(m.price) > 0;
  });
  const byPrice = function (a, b) { return Number(a.price) - Number(b.price); };
  const verifiedAll = live.filter(isVerified).sort(byPrice);
  const reviewAll = live.filter(isReview).sort(byPrice);
  return {
    live: live,
    verified: verifiedAll[0] || null,
    verifiedAll: verifiedAll,
    review: reviewAll[0] || null
  };
}

function brief(offer) {
  if (!offer) return null;
  return {
    name: String(offer.name || "").slice(0, 90),
    price: offer.price == null ? null : Number(offer.price),
    supplier: offer.supplier || "",
    source: offer.sourceLabel || offer.source || "",
    url: offer.url || "",
    ean: offer.ean || "",
    match: offer.match || "",
    band: offer.matchBand || offer.state || "",
    score: offer.matchScore == null ? null : offer.matchScore,
    reasons: (offer.matchReasons || []).slice(0, 2)
  };
}

function reasonBucket(entry) {
  const kind = String((entry && entry.kind) || "").toLowerCase();
  const text = String((entry && entry.reason) || "").toLowerCase();
  if (kind === "identidad" || kind === "variante" || kind === "modelo" || kind === "marca" ||
      /ean|identidad|modelo|marca|color|variante/.test(text)) return "identidad";
  if (kind === "tipo" || /tipo de producto|mismo tipo/.test(text)) return "tipo";
  if (kind === "menu" || kind === "junk" || /menu|pagina legal|página legal/.test(text)) return "no_producto";
  return "otro";
}

function topReasons(list, limit) {
  const counts = new Map();
  const samples = new Map();
  (Array.isArray(list) ? list : []).forEach(function (entry) {
    const key = reasonBucket(entry);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!samples.has(key) && entry && entry.reason) {
      samples.set(key, String(entry.reason).slice(0, 140));
    }
  });
  return Array.from(counts.entries())
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, limit || 3)
    .map(function (pair) {
      return { kind: pair[0], count: pair[1], sample: samples.get(pair[0]) || "" };
    });
}

/* Convierte la respuesta del job en un registro de evaluacion. */
function evaluateRow(row, job) {
  const result = (job && job.result) || {};
  const matches = Array.isArray(result.matches)
    ? result.matches
    : (Array.isArray(job && job.partial) ? job.partial : []);
  const coverage = result.coverage || (job && job.coverage) || null;
  const best = pickBest(matches);
  const chosen = best.verified || best.review || null;
  const price = chosen && Number(chosen.price) > 0 ? Number(chosen.price) : 0;
  const expected = row.expectedPrice > 0 ? row.expectedPrice : 0;
  const strength = (coverage && coverage.identity && coverage.identity.strength) || identityStrength(row);
  const weak = strength === "baja" || strength === "muy_baja";

  const supplierVerified = row.supplier ? best.verifiedAll.some(function (m) {
    return supplierMatches(row.supplier, m);
  }) : null;
  const supplierAny = row.supplier ? best.live.some(function (m) {
    return supplierMatches(row.supplier, m);
  }) : null;

  let verdict = "no_encontrado";
  if (job && job.state === "error") verdict = "error";
  else if (job && job.state === "timeout" && !chosen) verdict = "timeout";
  else if (best.verified) verdict = "verificado";
  else if (best.review) verdict = "solo_revisar";

  return {
    asin: row.asin,
    ean: row.ean,
    brand: row.brand,
    model: row.model,
    name: row.name,
    expectedSupplier: row.supplier,
    expectedPrice: expected || null,
    priceMax: row.priceMax || null,
    state: (job && job.state) || "unknown",
    error: (job && job.error) || null,
    verdict: verdict,
    identityStrength: strength,
    coveragePct: coverage && coverage.sources ? coverage.sources.coveragePct : null,
    found: best.live.length,
    verifiedCount: best.verifiedAll.length,
    eanExact: Boolean(best.verified && best.verified.match === "exacto"),
    weakVerified: Boolean(best.verified && weak),
    supplierVerified: supplierVerified,
    supplierAny: supplierAny,
    price: price || null,
    priceDeltaPct: expected > 0 && price > 0
      ? Math.round(((price - expected) / expected) * 1000) / 10
      : null,
    underMax: row.priceMax > 0 && price > 0 ? price <= row.priceMax : null,
    best: brief(chosen),
    sample: best.verifiedAll.slice(0, 3).map(brief),
    rejectedTop: topReasons(result.rejected, 3)
  };
}

function summarize(results) {
  const summary = {
    total: results.length,
    verificado: 0,
    soloRevisar: 0,
    noEncontrado: 0,
    timeout: 0,
    errores: 0,
    eanExact: 0,
    weakVerified: 0,
    supplierExpected: 0,
    supplierHit: 0,
    supplierMiss: 0,
    avgCoverage: null,
    verifiedStrongPct: null,
    supplierRecall: null,
    topRejected: []
  };
  let coverage = 0;
  let coverageCount = 0;
  const rejected = new Map();

  results.forEach(function (r) {
    if (r.verdict === "verificado") summary.verificado++;
    else if (r.verdict === "solo_revisar") summary.soloRevisar++;
    else if (r.verdict === "no_encontrado") summary.noEncontrado++;
    else if (r.verdict === "timeout") summary.timeout++;
    else summary.errores++;

    if (r.eanExact) summary.eanExact++;
    if (r.weakVerified) summary.weakVerified++;
    if (r.expectedSupplier) {
      summary.supplierExpected++;
      if (r.supplierVerified) summary.supplierHit++;
      else summary.supplierMiss++;
    }
    if (typeof r.coveragePct === "number") {
      coverage += r.coveragePct;
      coverageCount++;
    }
    (r.rejectedTop || []).forEach(function (entry) {
      const current = rejected.get(entry.kind) || { kind: entry.kind, count: 0, sample: entry.sample };
      current.count += entry.count;
      rejected.set(entry.kind, current);
    });
  });

  summary.avgCoverage = coverageCount ? Math.round((coverage / coverageCount) * 10) / 10 : null;
  summary.verifiedStrongPct = summary.verificado
    ? Math.round(((summary.verificado - summary.weakVerified) / summary.verificado) * 1000) / 10
    : null;
  summary.supplierRecall = summary.supplierExpected
    ? Math.round((summary.supplierHit / summary.supplierExpected) * 1000) / 10
    : null;
  summary.topRejected = Array.from(rejected.values())
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 5);
  return summary;
}

/* ---------------- tabla de identidad (offline, sin backend) ---------------- */

function loadIdentityCases(file) {
  const target = !file || file === "default" ? DEFAULT_IDENTITY_FIXTURE : path.resolve(file);
  const data = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!Array.isArray(data)) throw new Error("El fixture de identidad debe ser un array de pares.");
  return data;
}

function evaluateIdentityCase(c, index) {
  const cse = c || {};
  const src = identityLib.identityOf(cse.src || {});
  const result = identityLib.decideIdentity(src, cse.offer || {}, cse.ctx || {});
  const expect = cse.expect || {};
  const fails = [];
  if (expect.verdict && result.verdict !== expect.verdict) {
    fails.push("veredicto " + result.verdict + " != " + expect.verdict);
  }
  if (expect.notVerdict && result.verdict === expect.notVerdict) {
    fails.push("no debia ser " + expect.notVerdict);
  }
  if (expect.eanOk != null && result.eanOk !== expect.eanOk) fails.push("eanOk");
  if (expect.strongConflict != null && result.strongConflict !== expect.strongConflict) fails.push("strongConflict");
  if (expect.noTextMatch != null && result.noTextMatch !== expect.noTextMatch) fails.push("noTextMatch");
  (expect.conflicts || []).forEach(function (key) {
    if (result.conflicts.indexOf(key) === -1) fails.push("falta el conflicto " + key);
  });
  if (expect.conflicts && !expect.conflicts.length && result.conflicts.length) {
    fails.push("conflictos inesperados: " + result.conflicts.join(", "));
  }
  return {
    index: index + 1,
    name: cse.name || ("caso " + (index + 1)),
    expected: expect.verdict || "",
    actual: result.verdict,
    score: result.score,
    conflicts: result.conflicts,
    reasons: result.reasons,
    pass: fails.length === 0,
    fails: fails
  };
}

function evaluateIdentityCases(cases) {
  return (Array.isArray(cases) ? cases : []).map(evaluateIdentityCase);
}

function summarizeIdentity(results) {
  const summary = {
    total: results.length,
    aciertos: 0,
    fallos: 0,
    verificado: 0,
    revisar: 0,
    descartar: 0,
    accuracyPct: null,
    fallosList: []
  };
  results.forEach(function (r) {
    if (r.pass) summary.aciertos++;
    else {
      summary.fallos++;
      summary.fallosList.push({ name: r.name, fails: r.fails });
    }
    if (summary[r.actual] != null) summary[r.actual]++;
  });
  summary.accuracyPct = summary.total ? Math.round((summary.aciertos / summary.total) * 1000) / 10 : null;
  return summary;
}

function printIdentityTable(summary) {
  console.log("\n== Identidad (tabla offline)");
  console.log("pares: " + summary.total +
    " | verificado: " + summary.verificado +
    " | revisar: " + summary.revisar +
    " | descartar: " + summary.descartar);
  console.log("aciertos: " + summary.aciertos + "/" + summary.total +
    (summary.accuracyPct == null ? "" : " (" + summary.accuracyPct + " %)"));
  summary.fallosList.slice(0, 20).forEach(function (f) {
    console.log("- " + f.name + ": " + f.fails.join("; "));
  });
  console.log("Regla: la foto no verifica sola; sin clave de vision queda 'sin confirmar visualmente'.");
}

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const opts = {
    csv: "",
    base: DEFAULT_BASE,
    apiKey: process.env.API_KEY || "",
    out: "",
    limit: 0,
    identity: "",
    priceMax: 0,
    timeoutMs: 180000,
    pollMs: 2000,
    max: 12,
    dryRun: false,
    help: false
  };
  const args = argv || [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = function () { i++; return args[i]; };
    if (arg === "--csv") opts.csv = next() || "";
    else if (arg === "--base") opts.base = next() || "";
    else if (arg === "--api-key") opts.apiKey = next() || "";
    else if (arg === "--out") opts.out = next() || "";
    else if (arg === "--limit") opts.limit = parseInt(next(), 10) || 0;
    else if (arg === "--identidad") {
      const fixture = args[i + 1];
      if (fixture && !fixture.startsWith("-")) { opts.identity = fixture; i++; }
      else opts.identity = "default";
    }
    else if (arg === "--price-max") opts.priceMax = toNumber(next());
    else if (arg === "--timeout") opts.timeoutMs = Math.max(10000, (parseInt(next(), 10) || 180) * 1000);
    else if (arg === "--poll") opts.pollMs = Math.max(500, (parseInt(next(), 10) || 2) * 1000);
    else if (arg === "--max") opts.max = Math.max(1, parseInt(next(), 10) || 12);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-") && !opts.csv) opts.csv = arg;
  }
  opts.base = String(opts.base || "").replace(/\/+$/, "");
  return opts;
}

function authHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  return headers;
}

async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 30000);
  try {
    const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    let body = null;
    try { body = await response.json(); } catch (e) {}
    return { status: response.status, ok: response.ok, body: body };
  } catch (error) {
    return { status: 0, ok: false, body: null, error: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }
}

async function runJob(row, opts) {
  const body = {
    priceMax: row.priceMax || opts.priceMax || 0,
    max: opts.max,
    market: "amazon.es"
  };
  if (row.asin) body.asin = row.asin;
  if (row.ean) body.ean = row.ean;
  if (row.brand) body.brand = row.brand;
  if (row.model) body.model = row.model;
  if (row.name) body.name = row.name;
  /* Nunca se envian proveedor/url/precio esperados: son el control del examen. */

  const start = await requestJson(opts.base + "/suppliers/start", {
    method: "POST",
    headers: authHeaders(opts.apiKey),
    body: JSON.stringify(body)
  }, 30000);

  if (!start.ok || !start.body || !start.body.jobId) {
    return {
      state: "error",
      error: (start.body && (start.body.reason || start.body.hint)) ||
        start.error || ("HTTP " + start.status)
    };
  }

  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < opts.timeoutMs) {
    await sleep(opts.pollMs);
    const poll = await requestJson(opts.base + "/suppliers/status/" + start.body.jobId, {
      headers: authHeaders(opts.apiKey)
    }, 30000);
    if (!poll.ok || !poll.body || !poll.body.job) {
      return {
        state: "error",
        error: (poll.body && (poll.body.reason || poll.body.hint)) ||
          poll.error || ("HTTP " + poll.status)
      };
    }
    const job = poll.body.job;
    if (job.state !== "running") return job;
    last = job;
  }
  return {
    state: "timeout",
    error: "tiempo agotado (" + Math.round(opts.timeoutMs / 1000) + " s)",
    partial: (last && last.partial) || []
  };
}

function printRow(index, total, row, evaluation) {
  const id = row.asin || row.ean || [row.brand, row.model].filter(Boolean).join(" ") || "(sin id)";
  const price = evaluation.price ? evaluation.price.toFixed(2).replace(".", ",") + " EUR" : "-";
  const flags = [];
  if (evaluation.eanExact) flags.push("EAN exacto");
  if (evaluation.weakVerified) flags.push("IDENTIDAD DEBIL");
  if (evaluation.supplierVerified) flags.push("proveedor OK");
  if (evaluation.supplierVerified === false) flags.push("proveedor NO");
  if (evaluation.underMax === false) flags.push("> precio max");
  console.log(
    "[" + (index + 1) + "/" + total + "] " + id +
    " | " + evaluation.verdict +
    " | " + price +
    " | fuentes " + (evaluation.coveragePct == null ? "-" : evaluation.coveragePct + " %") +
    (flags.length ? " | " + flags.join(", ") : "")
  );
}

function printSummary(summary, results) {
  console.log("\n== Resumen");
  console.log("filas evaluadas: " + summary.total);
  console.log("verificadas: " + summary.verificado +
    " | solo a revisar: " + summary.soloRevisar +
    " | no encontradas: " + summary.noEncontrado +
    " | timeout: " + summary.timeout +
    " | errores: " + summary.errores);
  console.log("EAN exacto: " + summary.eanExact +
    " | verificadas con identidad debil (revisar): " + summary.weakVerified +
    (summary.verifiedStrongPct == null ? "" : " | verificadas con identidad suficiente: " + summary.verifiedStrongPct + " %"));
  if (summary.supplierExpected) {
    console.log("proveedor esperado: " + summary.supplierExpected +
      " | encontrado verificado: " + summary.supplierHit +
      " (" + summary.supplierRecall + " %)" +
      " | no encontrado: " + summary.supplierMiss);
  }
  console.log("cobertura media de fuentes: " +
    (summary.avgCoverage == null ? "-" : summary.avgCoverage + " %"));
  if (summary.topRejected.length) {
    console.log("motivos de descarte: " + summary.topRejected.map(function (r) {
      return r.kind + " (" + r.count + ")";
    }).join(", "));
  }

  const review = results.filter(function (r) {
    return r.weakVerified || r.verdict === "solo_revisar" || r.verdict === "timeout" || r.verdict === "error" ||
      (r.expectedSupplier && r.supplierVerified === false);
  });
  if (review.length) {
    console.log("\n== Casos a revisar (" + review.length + ")");
    review.slice(0, 40).forEach(function (r) {
      const id = r.asin || r.ean || [r.brand, r.model].filter(Boolean).join(" ") || "(sin id)";
      const why = r.weakVerified ? "verificado con identidad debil"
        : r.verdict === "solo_revisar" ? "solo candidato"
        : r.verdict === "timeout" ? "timeout"
        : r.verdict === "error" ? ("error: " + r.error)
        : "proveedor esperado no encontrado";
      console.log("- " + id + " | " + why + (r.best && r.best.url ? " | " + r.best.url : ""));
    });
  }
  console.log("\nNota: el CSV es un examen, no un entrenamiento. El motor no lo lee.");
  console.log("Un 'verificado' con identidad debil es un posible falso positivo: compara foto y EAN a mano.");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  if (opts.identity) {
    let cases;
    try { cases = loadIdentityCases(opts.identity); }
    catch (error) {
      console.error("No se puede leer el fixture de identidad: " + opts.identity + " (" + error.message + ")");
      process.exitCode = 1;
      return;
    }
    const results = evaluateIdentityCases(cases);
    const summary = summarizeIdentity(results);
    printIdentityTable(summary);
    if (opts.out) {
      const outPath = path.resolve(opts.out);
      fs.writeFileSync(outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        fixture: opts.identity === "default" ? DEFAULT_IDENTITY_FIXTURE : path.resolve(opts.identity),
        summary: summary,
        results: results
      }, null, 2), "utf8");
      console.log("\nInforme JSON: " + outPath);
    }
    if (summary.fallos) process.exitCode = 1;
    return;
  }
  if (!opts.csv) { console.log(USAGE); process.exitCode = 1; return; }

  const csvPath = path.resolve(opts.csv);
  let text;
  try {
    text = fs.readFileSync(csvPath, "utf8");
  } catch (error) {
    console.error("No se puede leer el CSV: " + csvPath + " (" + error.message + ")");
    process.exitCode = 1;
    return;
  }

  const parsed = readCsv(text);
  let rows = parsed.rows.map(normalizeRow);
  if (opts.limit > 0) rows = rows.slice(0, opts.limit);

  const valid = [];
  const skipped = [];
  rows.forEach(function (row, i) {
    const errors = validateRow(row);
    if (errors.length) skipped.push({ row: i + 2, asin: row.asin, ean: row.ean, errors: errors });
    else valid.push(row);
  });

  console.log("CSV: " + csvPath);
  console.log("filas: " + rows.length + " | validas: " + valid.length + " | omitidas: " + skipped.length);
  skipped.forEach(function (s) {
    console.log("  omitida fila ~" + s.row + " (" + (s.asin || s.ean || "sin id") + "): " + s.errors.join("; "));
  });

  if (opts.dryRun) {
    valid.forEach(function (row, i) {
      console.log("  OK " + (i + 1) + ": " + (row.asin || row.ean || [row.brand, row.model].join(" ")) +
        " | identidad " + identityStrength(row) +
        " | proveedor esperado: " + (row.supplier || "-"));
    });
    console.log("\nDry-run: no se ha llamado al backend.");
    return;
  }

  if (!valid.length) {
    console.error("No hay filas validas que evaluar.");
    process.exitCode = 1;
    return;
  }

  const health = await requestJson(opts.base + "/health", {}, 15000);
  if (!health.ok || !health.body) {
    console.error("Backend no disponible en " + opts.base + " (" + (health.error || ("HTTP " + health.status)) + ")");
    process.exitCode = 1;
    return;
  }
  console.log("Backend: " + opts.base + " | version " + (health.body.version || "?") +
    " | keepa " + (health.body.sources && health.body.sources.keepa) +
    " | apify " + (health.body.sources && health.body.sources.apify));

  const results = [];
  for (let i = 0; i < valid.length; i++) {
    const row = valid[i];
    const job = await runJob(row, opts);
    const evaluation = evaluateRow(row, job);
    results.push(evaluation);
    printRow(i, valid.length, row, evaluation);
  }

  const summary = summarize(results);
  printSummary(summary, results);

  const report = {
    generatedAt: new Date().toISOString(),
    backend: opts.base,
    backendVersion: health.body.version || null,
    csv: csvPath,
    options: {
      priceMax: opts.priceMax,
      timeoutSec: Math.round(opts.timeoutMs / 1000),
      max: opts.max
    },
    summary: summary,
    skipped: skipped,
    results: results
  };

  if (opts.out) {
    const outPath = path.resolve(opts.out);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log("\nInforme JSON: " + outPath);
  }
}

module.exports = {
  toNumber,
  headerKey,
  detectDelimiter,
  parseCsv,
  readCsv,
  normalizeRow,
  validateRow,
  identityStrength,
  normText,
  hostOf,
  supplierMatches,
  pickBest,
  brief,
  reasonBucket,
  topReasons,
  evaluateRow,
  summarize,
  loadIdentityCases,
  evaluateIdentityCase,
  evaluateIdentityCases,
  summarizeIdentity,
  parseArgs
};

if (require.main === module) {
  main().catch(function (error) {
    console.error("Error: " + String((error && error.message) || error));
    process.exitCode = 1;
  });
}
