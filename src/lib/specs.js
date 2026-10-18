"use strict";

const ALIASES = {
  material: ["material", "materiales", "composition", "composicion", "fabric", "tejido"],
  capacity: ["capacidad", "capacity", "volumen", "volume", "contenido", "content", "capacidad de almacenamiento", "storage"],
  weight: ["peso", "weight", "peso neto", "net weight", "peso del producto", "item weight"],
  power: ["potencia", "power", "wattage", "vatios"],
  voltage: ["voltaje", "voltage", "tension", "voltios"],
  battery: ["bateria", "battery", "pilas", "power source", "alimentacion", "tipo de bateria"],
  connectivity: ["conectividad", "connectivity", "conexion", "conexion inalambrica", "wireless", "bluetooth", "wifi"],
  compatibility: ["compatible con", "compatibility", "compatibilidad"],
  dimensions: ["dimensiones", "dimensions", "medidas", "tamano", "tamaño", "size"],
  finish: ["acabado", "finish"],
  style: ["estilo", "style", "diseno", "design"],
  energy: ["clase energetica", "energy class", "eficiencia energetica"]
};

const STRICT = { capacity: 1, power: 1, voltage: 1 };
const KEY_BY_ALIAS = {};
Object.keys(ALIASES).forEach(function (key) {
  ALIASES[key].forEach(function (alias) { KEY_BY_ALIAS[alias] = key; });
});

const UNITS = {
  ml: { kind: "volume", factor: 1 },
  cl: { kind: "volume", factor: 10 },
  l: { kind: "volume", factor: 1000 },
  litro: { kind: "volume", factor: 1000 },
  litros: { kind: "volume", factor: 1000 },
  g: { kind: "mass", factor: 1 },
  gr: { kind: "mass", factor: 1 },
  kg: { kind: "mass", factor: 1000 },
  mg: { kind: "mass", factor: 0.001 },
  w: { kind: "power", factor: 1 },
  vatio: { kind: "power", factor: 1 },
  vatios: { kind: "power", factor: 1 },
  v: { kind: "voltage", factor: 1 },
  voltio: { kind: "voltage", factor: 1 },
  voltios: { kind: "voltage", factor: 1 },
  mah: { kind: "charge", factor: 1 },
  mm: { kind: "length", factor: 1 },
  cm: { kind: "length", factor: 10 },
  m: { kind: "length", factor: 1000 }
};

function norm(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9.,x+\- ]+/g, " ").replace(/\s+/g, " ").trim();
}

function canonKey(name) {
  const n = norm(name).replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (KEY_BY_ALIAS[n]) return KEY_BY_ALIAS[n];
  const hit = Object.keys(KEY_BY_ALIAS).find(function (alias) {
    return n === alias || n.indexOf(alias + " ") === 0 || n.indexOf(" " + alias) !== -1;
  });
  return hit ? KEY_BY_ALIAS[hit] : "";
}

function valueOf(raw) {
  const text = norm(raw).replace(/(\d),(\d)/g, "$1.$2").replace(/\b(aprox|approx|aproximadamente|alrededor de)\b/g, "").trim();
  if (!text) return null;
  const dim = text.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?\s*(mm|cm|m)\b/);
  if (dim) {
    const f = UNITS[dim[4]] ? UNITS[dim[4]].factor : 1;
    return { text: [dim[1], dim[2], dim[3]].filter(Boolean).map(function (n) { return String(parseFloat(n) * f); }).join("x") + "mm", dims: true };
  }
  const m = text.match(/(\d+(?:\.\d+)?)\s*(ml|cl|l|litros?|mg|kg|gr|g|mah|vatios?|w|voltios?|v|mm|cm|m)\b/);
  if (m) {
    const unit = m[2].replace(/s$/, "");
    const u = UNITS[unit] || UNITS[m[2]];
    if (u) {
      const n = parseFloat(m[1]) * u.factor;
      return { n: Math.round(n * 1000) / 1000, unit: u.kind, rawUnit: m[2], text: norm(m[1] + m[2]) };
    }
  }
  return { text: text };
}

function sameValue(a, b) {
  if (!a || !b) return false;
  if (a.n != null && b.n != null && a.unit && a.unit === b.unit) {
    const tolerance = a.unit === "mass" || a.unit === "power" || a.unit === "voltage" ? 0.03 : 0;
    return Math.abs(a.n - b.n) <= Math.max(tolerance * Math.max(a.n, b.n), 0);
  }
  if (a.text && b.text) {
    if (a.text === b.text) return true;
    return a.text.length >= 4 && b.text.length >= 4 && (a.text.indexOf(b.text) !== -1 || b.text.indexOf(a.text) !== -1);
  }
  return false;
}

function addSpec(out, name, value) {
  const key = canonKey(name);
  const v = valueOf(value);
  if (!key || !v) return;
  if (key === "weight" && v.unit && v.unit !== "mass") return;
  if (key === "capacity" && v.unit && v.unit !== "volume") return;
  if (key === "power" && v.unit && v.unit !== "power") return;
  if (key === "voltage" && v.unit && v.unit !== "voltage") return;
  if (!out[key]) out[key] = { label: String(name || key).trim(), value: v };
}

function pairsFromText(text) {
  const out = [];
  String(text || "").split(/[\n;|•]+|\.\s+(?=[A-ZÁÉÍÓÚÜÑ])/).forEach(function (line) {
    const m = String(line).match(/^\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ /()]{2,40})\s*[:\-]\s*(.{1,80}?)\s*$/);
    if (m) out.push({ name: m[1].trim(), value: m[2].trim() });
  });
  return out;
}

function fromSource(src) {
  src = src || {};
  const out = {};
  const containers = [src, src.attrs || {}, src.enriched || {}, src.ficha || {}];
  containers.forEach(function (c) {
    if (!c || typeof c !== "object") return;
    [c.additionalProperty, c.additionalProperties, c.hasAdditionalProperty].forEach(function (list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (p) {
        if (p && p.name != null && p.value != null) addSpec(out, p.name, p.value);
      });
    });
    if (Array.isArray(c.specs)) {
      c.specs.forEach(function (p) {
        if (p && p.name != null && p.value != null) addSpec(out, p.name, p.value);
        else if (typeof p === "string") pairsFromText(p).forEach(function (x) { addSpec(out, x.name, x.value); });
      });
    } else if (c.specs && typeof c.specs === "object") {
      Object.keys(c.specs).forEach(function (k) { addSpec(out, k, c.specs[k]); });
    }
    if (Array.isArray(c.features)) c.features.forEach(function (f) { pairsFromText(f).forEach(function (x) { addSpec(out, x.name, x.value); }); });
    pairsFromText(c.description || "").forEach(function (x) { addSpec(out, x.name, x.value); });
    Object.keys(ALIASES).forEach(function (key) {
      ALIASES[key].forEach(function (alias) {
        const camel = alias.replace(/ (.)/g, function (_, ch) { return ch.toUpperCase(); });
        if (c[alias] != null) addSpec(out, key, c[alias]);
        if (c[camel] != null) addSpec(out, key, c[camel]);
      });
    });
  });
  return out;
}

function compare(a, b) {
  a = a || {}; b = b || {};
  const checks = [];
  const conflicts = [];
  let okCount = 0;
  Object.keys(a).forEach(function (key) {
    const x = a[key], y = b[key];
    if (!x) return;
    const label = x.label || key;
    if (!y) {
      checks.push({ key: "spec_" + key, label: label, source: x.value.text, offer: "", state: "na" });
      return;
    }
    const same = sameValue(x.value, y.value);
    checks.push({ key: "spec_" + key, label: label, source: x.value.text, offer: y.value.text, state: same ? "ok" : "na" });
    if (same) okCount++;
    else if (x.value.n != null && y.value.n != null && x.value.unit && x.value.unit === y.value.unit) {
      if (STRICT[key]) {
        checks[checks.length - 1].state = "fail";
        conflicts.push({ key: key, label: label, source: x.value.text, offer: y.value.text });
      } else {
        checks[checks.length - 1].state = "na";
      }
    }
  });
  return { checks: checks, conflicts: conflicts, okCount: okCount };
}

module.exports = { fromSource, compare, canonKey, valueOf, sameValue, norm };
