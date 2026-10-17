/* Perfil de tipo de producto SIN listas de productos.
   Se obtiene de dos cosas que existen para cualquier articulo:
     1) la categoria de Amazon que da Keepa (la hoja, p. ej. "Batidoras de mano"),
     2) las primeras palabras utiles del titulo (el sustantivo principal va delante).
   Ambas se traducen (en/zh) con el traductor generico para poder comparar con
   ofertas en ingles o chino. Nada aqui nombra productos concretos. */

const NOISE = {
  negro: 1, blanco: 1, rojo: 1, azul: 1, verde: 1, gris: 1, rosa: 1, black: 1, white: 1, red: 1, blue: 1, green: 1,
  nuevo: 1, nueva: 1, original: 1, oferta: 1, envio: 1, gratis: 1, new: 1, free: 1, shipping: 1,
  pack: 1, set: 1, para: 1, compatible: 1, incluye: 1, with: 1, from: 1, premium: 1, profesional: 1, professional: 1,
  pieza: 1, piezas: 1, unidades: 1, unidad: 1, color: 1, colores: 1, tamano: 1, size: 1
};

function fold(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function toks(s) {
  return fold(s).replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}
/* Palabras "de tipo": 4+ letras, sin cifras, sin ruido, sin la marca. */
function headTokens(text, brand, limit) {
  const b = toks(brand);
  const out = [];
  toks(text).forEach(function (t) {
    if (t.length < 4 || /\d/.test(t) || NOISE[t] || b.indexOf(t) !== -1) return;
    if (out.indexOf(t) === -1) out.push(t);
  });
  return out.slice(0, limit || 6);
}
/* Mismo termino ignorando plural simple y coincidiendo por raiz de 5 letras. */
function sameWord(a, b) {
  if (a === b) return true;
  const sa = a.length > 4 ? a.replace(/(es|s)$/, "") : a;
  const sb = b.length > 4 ? b.replace(/(es|s)$/, "") : b;
  if (sa === sb) return true;
  return sa.length >= 5 && sb.length >= 5 && sa.slice(0, 5) === sb.slice(0, 5);
}
function leafNames(tree) {
  const arr = Array.isArray(tree) ? tree : [];
  const names = arr.map(function (c) { return c && c.name ? String(c.name) : ""; }).filter(Boolean);
  return names.slice(-1); /* solo la hoja: es la mas especifica */
}

/* tr = { en: async (txt)=>txt, zh: async (txt)=>txt }  (inyectable para pruebas) */
async function buildProfile(src, tr) {
  src = src || {};
  const leaf = leafNames(src.categoryTree).join(" ");
  const titleHead = headTokens(src.name || src.title || "", src.brand, 5).join(" ");
  const es = headTokens((leaf ? leaf + " " : "") + titleHead, src.brand, 10);
  const prof = { es: es, en: [], zh: [], leaf: leaf, head: titleHead };
  if (!tr) return prof;
  const phrase = ((leaf ? leaf + " " : "") + titleHead).trim();
  if (!phrase) return prof;
  const res = await Promise.all([
    Promise.resolve().then(function () { return tr.en(phrase); }).catch(function () { return ""; }),
    Promise.resolve().then(function () { return tr.zh(phrase); }).catch(function () { return ""; })
  ]);
  prof.en = headTokens(res[0], "", 12).filter(function (t) { return es.indexOf(t) === -1; });
  const zh = String(res[1] || "").replace(/[^\u3400-\u9fff]+/g, " ").trim().split(" ").filter(Boolean);
  const grams = [];
  zh.forEach(function (run) { for (let i = 0; i + 2 <= run.length; i++) { const g = run.slice(i, i + 2); if (grams.indexOf(g) === -1) grams.push(g); } });
  prof.zh = grams.slice(0, 24);
  return prof;
}

/* Cuantas palabras del perfil (es + en) aparecen en el nombre de la oferta. */
function hits(prof, offerName) {
  const have = toks(offerName);
  const all = (prof.es || []).concat(prof.en || []);
  return all.filter(function (t) { return have.some(function (w) { return sameWord(w, t); }); });
}
function typeOk(prof, offerName) {
  if (!prof || !((prof.es || []).length + (prof.en || []).length)) return true; /* sin datos: no se decide aqui */
  return hits(prof, offerName).length >= 1;
}
function zhOk(prof, offerName) {
  const g = (prof && prof.zh) || [];
  if (!g.length) return false;
  const t = String(offerName || "");
  return g.some(function (x) { return t.indexOf(x) !== -1; });
}
/* Enlaces de menu o paginas legales: sin precio ni foto no son un producto. */
function isJunk(it, opts) {
  const p = Number(it && it.price);
  const noPrice = !(p > 0);
  const noImg = !/^https?:\/\//i.test(String((it && it.image) || ""));
  const nm = String((it && it.name) || "").trim();
  /* Texto de menu / pagina legal / carrito: nunca es un producto, tenga o no precio. */
  const menu = /^(garant[ií]a|pol[ií]tica|aviso legal|cookies?|ver (la )?cesta|mi cuenta|iniciar sesi[oó]n|contacto|ayuda|env[ií]os?|devoluciones|finalizar compra|facebook|instagram|twitter|youtube|newsletter|suscr[ií]b)/i.test(nm) || nm.length < 4;
  if (menu) return true;
  /* Proveedor/fabricante/distribuidor: sin precio publicado es normal (hay que contactar). Solo se descarta si no parece un producto. */
  if (opts && opts.open) return false;
  return noPrice && noImg;
}
module.exports = { buildProfile, headTokens, typeOk, zhOk, hits, isJunk, sameWord, leafNames };
