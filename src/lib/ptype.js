/* Tipo de producto: conceptos multi-idioma (es/en) para que una oferta solo
   pase si es el MISMO tipo de producto que el origen. Resuelve ambiguedades
   como cuaderno<->notebook (que tambien es portatil) y rechaza accesorios
   (funda, case, soporte...) cuando el origen no es un accesorio. */

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\u3400-\u9fff ]+/g, " ").replace(/\s+/g, " ").trim();
}
function words(s) { return norm(s).split(" ").filter(Boolean); }
function stem(w) { return w.length > 4 ? w.replace(/(es|s)$/, "") : w; }

/* Conceptos "positivos": que ES el producto. */
const CONCEPTS = {
  cuaderno: ["cuaderno", "libreta", "bloc", "agenda", "exercise book", "notebook paper", "paper notebook", "writing notebook", "journal", "jotter", "notepad", "note pad", "sketchbook", "cahier", "libro de ejercicios", "spiral notebook", "composition book"],
  portatil: ["portatil", "laptop", "ordenador", "computer", "chromebook", "macbook", "ultrabook", "notebook pc", "netbook"],
  tablet: ["tablet", "ipad"],
  movil: ["movil", "smartphone", "telefono", "iphone", "mobile phone", "cell phone"],
  teclado: ["teclado", "keyboard"],
  raton: ["raton", "mouse"],
  auricular: ["auricular", "auriculares", "cascos", "headphone", "headphones", "earphone", "earbuds", "headset"],
  cargador: ["cargador", "charger", "adaptador de corriente", "power adapter"],
  cable: ["cable"],
  boligrafo: ["boligrafo", "bolígrafo", "pen", "ballpoint", "rotulador", "marker", "lapiz", "pencil"],
  mochila: ["mochila", "backpack", "rucksack"],
  botella: ["botella", "bottle", "termo", "flask"],
  lampara: ["lampara", "lamp", "luz", "light", "led"],
  zapatilla: ["zapatilla", "zapatillas", "sneaker", "sneakers", "shoe", "shoes", "zapato"]
};
/* Palabras que, en una oferta, delatan un producto de OTRO tipo cuando el origen
   no es de ese tipo. */
const ACCESSORY = ["funda", "fundas", "case", "cases", "cover", "covers", "sleeve", "carcasa", "protector", "protectores", "soporte", "stand", "holder", "bolsa", "bag", "skin", "pegatina", "sticker", "cargador", "charger", "repuesto", "replacement", "pantalla", "screen", "bateria", "battery", "teclado", "keyboard", "adaptador", "adapter", "dock", "hub"];
const COMPUTER_HINTS = ["laptop", "portatil", "ordenador", "computer", "intel", "core", "ryzen", "ssd", "ram", "windows", "cpu", "gb", "tb", "celeron", "i3", "i5", "i7", "i9", "chromebook", "macbook", "pulgadas", "inch", "fhd", "gaming", "processor"];

function hasPhrase(txt, phrase) {
  const p = norm(phrase);
  if (!p) return false;
  return (" " + txt + " ").indexOf(" " + p + " ") !== -1 || (" " + txt + " ").indexOf(" " + p + "s ") !== -1 || (" " + txt + " ").indexOf(" " + p + "es ") !== -1;
}
function computerish(txt) {
  const w = words(txt).map(stem);
  const hits = COMPUTER_HINTS.filter(function (h) { return w.indexOf(stem(h)) !== -1; }).length;
  return hits >= 1 || /\b\d{2}(\.\d)?\s?(\"|inch|pulgadas)/.test(txt);
}
/* Conceptos presentes en un texto. "notebook" a secas es ambiguo: cuaderno si no
   hay pistas de ordenador, portatil si las hay. */
function conceptsOf(text) {
  const txt = norm(text);
  const out = [];
  Object.keys(CONCEPTS).forEach(function (id) {
    if (CONCEPTS[id].some(function (ph) { return hasPhrase(txt, ph); })) out.push(id);
  });
  if (hasPhrase(txt, "notebook") || hasPhrase(txt, "notebooks")) {
    const id = computerish(txt) ? "portatil" : "cuaderno";
    if (out.indexOf(id) === -1) out.push(id);
  }
  return out;
}
function accessoryWords(text) {
  const w = words(text);
  return ACCESSORY.filter(function (a) { return w.indexOf(a) !== -1; });
}

/* Decide si la oferta es del mismo tipo que el origen.
   Devuelve {ok, reason}. Si el origen no encaja en ningun concepto conocido,
   ok=true y se deja a los demas filtros (pero los accesorios si se frenan). */
function sameType(sourceText, offerText) {
  const src = conceptsOf(sourceText);
  const off = conceptsOf(offerText);
  const srcAcc = accessoryWords(sourceText);
  const offAcc = accessoryWords(offerText);
  /* Accesorio en la oferta y no en el origen: otro producto (funda de cuaderno...). */
  const newAcc = offAcc.filter(function (a) { return srcAcc.indexOf(a) === -1; });
  if (newAcc.length) {
    return { ok: false, reason: "Es un accesorio (" + newAcc[0] + "), no el producto." };
  }
  if (!src.length) return { ok: true, reason: "" };
  if (!off.length) return { ok: false, reason: "La oferta no indica el mismo tipo de producto (" + src[0] + ")." };
  const shared = src.filter(function (c) { return off.indexOf(c) !== -1; });
  if (!shared.length) return { ok: false, reason: "Tipo distinto: origen " + src.join("/") + ", oferta " + off.join("/") + "." };
  /* Conflicto: la oferta ademas es de un concepto que el origen no tiene (cuaderno con funda de portatil). */
  const extra = off.filter(function (c) { return src.indexOf(c) === -1 && (c === "portatil" || c === "tablet" || c === "movil"); });
  if (extra.length) return { ok: false, reason: "Mezcla otro tipo de producto (" + extra[0] + ")." };
  return { ok: true, reason: "" };
}

/* Sustituye terminos ambiguos del origen por frases inequivocas antes de
   traducir/buscar (cuaderno -> "paper exercise book", nunca "notebook"). */
const DISAMBIG_EN = [
  [/\bcuadernos?\b/gi, "paper exercise book"],
  [/\blibretas?\b/gi, "paper notebook exercise book"],
  [/\bportatil(es)?\b/gi, "laptop computer"],
  [/\bagendas?\b/gi, "planner diary"]
];
function disambiguate(text) {
  let t = String(text || "");
  DISAMBIG_EN.forEach(function (r) { t = t.replace(r[0], r[1]); });
  return t;
}
function hasAmbiguousTerm(text) { return /\b(cuadernos?|libretas?|portatil(es)?|agendas?)\b/i.test(norm(text)); }

module.exports = { conceptsOf, sameType, disambiguate, hasAmbiguousTerm, norm };
