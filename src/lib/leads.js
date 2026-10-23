"use strict";
/* FABRICANTE / DISTRIBUIDOR / MAYORISTA a partir del EAN (funciones puras).

   Replica la busqueda manual que hace el equipo:
     Google -> "<EAN> mayorista" / "<EAN> distribuidor" / "<EAN> al por mayor"
     y despues "<marca> distribuidor oficial" / "<marca> mayorista".
   Lo que se busca NO es una oferta con precio (eso ya lo hace la cascada de
   ofertas) sino QUIEN suministra el producto: la web del fabricante, su
   distribuidor oficial o mayoristas que lo trabajan. Esas webs casi nunca
   publican precio ni ficha schema.org (son B2B, con precio tras registro),
   por eso el motor de ofertas las descartaba o las escondia en "no
   verificados" y solo quedaban tiendas minoristas al mismo precio o mas caro.

   Aqui cada resultado del buscador se agrupa por dominio y se clasifica por
   su papel (fabricante, distribuidor oficial, mayorista/distribuidor,
   marketplace B2B, base de datos de EAN, minorista). Los minoristas se
   apartan: no son proveedores. Sin red: el adaptador `fabricantes` hace las
   llamadas y usa estas funciones para decidir. */

const gtin = require("./gtin");

function fold(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function slug(s) {
  return fold(s).replace(/[^a-z0-9]+/g, "");
}
function clean(s) {
  return String(s == null ? "" : s).replace(/[()\[\]{},;:|\\"*®™]+/g, " ").replace(/\s+/g, " ").trim();
}

function hostOf(url) {
  try { return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\d?\./, ""); } catch (e) { return ""; }
}
/* Etiqueta principal del dominio: "tienda.acme-iberia.es" -> "acme-iberia".
   Suficiente para comparar con la marca sin una lista de sufijos publicos. */
const SLD = { com: 1, co: 1, org: 1, net: 1, gob: 1, edu: 1, ac: 1 };
function mainLabel(host) {
  const parts = String(host || "").split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] || "";
  let i = parts.length - 2;
  if (SLD[parts[i]] && parts.length >= 3 && parts[parts.length - 1].length === 2) i -= 1;
  return parts[i] || "";
}
function hostMatches(host, list) {
  return list.some(function (d) { return host === d || host.endsWith("." + d); });
}

/* No son proveedores ni aportan nada: buscadores, redes, video, wikis. */
const BLOCKED = [
  "amazon.es", "amazon.com", "amazon.de", "amazon.fr", "amazon.it", "amazon.co.uk", "amzn.to", "amzn.eu",
  "google.com", "google.es", "youtube.com", "facebook.com", "instagram.com", "pinterest.com", "pinterest.es",
  "wikipedia.org", "tiktok.com", "twitter.com", "x.com", "linkedin.com", "reddit.com", "quora.com",
  "keepa.com", "camelcamelcamel.com", "helium10.com", "junglescout.com", "sellerapp.com"
];
/* Comparadores y agregadores de precio: muestran tiendas, no proveedores. */
const COMPARATORS = [
  "idealo.es", "idealo.de", "kelkoo.es", "ciao.es", "preciomania.com", "kimovil.com", "versus.com",
  "chollometro.com", "pricerunner.com", "pricespy.co.uk", "trovaprezzi.it", "shopalike.es", "hotukdeals.com",
  "mydealz.de", "dealabs.com", "tiendeo.com", "ofertia.com", "geizhals.de", "billiger.de", "kieskeurig.nl",
  "tweakers.net", "pccomparador.com", "comparaiso.es", "rastreator.com", "vercel.app"
];
/* Minoristas B2C conocidos (Espana/UE). Venden al consumidor al PVP: no son
   la fuente de compra de un arbitraje. La heuristica de senales cubre el resto. */
const RETAILERS = [
  "elcorteingles.es", "carrefour.es", "mediamarkt.es", "fnac.es", "pccomponentes.com", "worten.es", "alcampo.es",
  "eroski.es", "hipercor.es", "decathlon.es", "leroymerlin.es", "bricodepot.es", "bricomart.es", "ikea.com",
  "conforama.es", "manomano.es", "miravia.es", "temu.com", "shein.com", "ebay.es", "ebay.com", "ebay.de",
  "aliexpress.com", "aliexpress.es", "wish.com", "joom.com", "cdiscount.com", "lidl.es", "aldi.es", "dia.es",
  "mercadona.es", "druni.es", "primor.eu", "notino.es", "perfumesclub.com", "sephora.es", "douglas.es",
  "promofarma.com", "atida.com", "mifarma.es", "dosfarma.com", "farmaciasdirect.com", "arenalperfumerias.com",
  "tiendanimal.es", "kiwoko.com", "zooplus.es", "juguettos.com", "toysrus.es", "imaginarium.es", "jugueteria.es",
  "sprinter.es", "zalando.es", "privalia.com", "showroomprive.es", "veepee.es", "bulevip.com",
  "mediamarkt.de", "saturn.de", "otto.de", "fnac.com", "darty.com", "boulanger.com", "unieuro.it",
  "currys.co.uk", "argos.co.uk", "bol.com", "coolblue.nl", "allegro.pl", "emag.ro",
  "electrocosto.com", "tuimeilibre.com", "appinformatica.com", "coolmod.com", "redcoon.es", "beep.es",
  "outletpc.com", "backmarket.es", "milanuncios.com", "wallapop.com", "vinted.es", "carrefour.fr",
  "costco.es", "makro.es", "bauhaus.es", "obramat.es", "brico-depot.es", "ferreteria.es", "todohogar.com",
  "casadellibro.com", "fnac.pt", "worten.pt", "elcorteingles.pt", "pccomponentes.pt", "tradeinn.com",
  "mascotaplanet.com", "nutritienda.com", "myprotein.es", "hsnstore.com"
];
/* Mercados / directorios B2B: ahi estan fabricantes y mayoristas, pero hay
   que filtrar a mano (MOQ, verificacion). */
const B2B_MARKETS = [
  "alibaba.com", "1688.com", "made-in-china.com", "globalsources.com", "dhgate.com", "europages.es",
  "europages.com", "europages.co.uk", "kompass.com", "ankorstore.com", "faire.com", "bigbuy.eu", "dropshipping.es",
  "indiamart.com", "tradekey.com", "ec21.com", "thomasnet.com", "directindustry.es", "directindustry.com",
  "wholesaledeals.co.uk", "merkandi.es", "merkandi.com", "b2b-center.com", "tradeindia.com", "joor.com",
  "orderchamp.com", "creoate.com", "tundra.com", "qogita.com", "brandsdistribution.com", "efashion-paris.com",
  "salesbeat.es", "wholesale-it.es", "cdiscountpro.com", "mayoristas.es", "importadores.es", "kompass.es",
  "einforma.com", "infoempresa.com", "empresite.eleconomista.es", "axesor.es", "librebor.me"
];
/* Bases de datos de codigos de barras: no venden, pero dicen QUIEN es el
   fabricante/titular del EAN (dato clave para contactar). */
const EAN_DBS = [
  "ean-search.org", "upcitemdb.com", "barcodelookup.com", "go-upc.com", "eandata.com", "codigos-ean.com",
  "buycott.com", "openfoodfacts.org", "world.openfoodfacts.org", "es.openfoodfacts.org", "gs1.org", "gs1es.org",
  "barcode-list.com", "ean13.info", "upcdatabase.org", "eanlist.org", "barcodespider.com", "icecat.biz",
  "icecat.es", "verified.gs1.org", "gepir.gs1.org", "productz.com", "upczilla.com"
];

/* Senales en titulo/snippet/URL/pagina. Pesos simples y explicables. */
const B2B_SIGNALS = [
  { re: /distribuidor(?:a)?\s+oficial|official\s+distributor|importador\s+oficial|distribuidor\s+exclusivo|exclusive\s+distributor|authori[sz]ed\s+distributor/i, key: "distribuidor_oficial", w: 5 },
  { re: /\bmayorist(?:a|as)\b|\bal\s+por\s+mayor\b|\bpor\s+mayor\b|\bventa\s+mayorista\b/i, key: "mayorista", w: 4 },
  { re: /\bwholesale(?:r|rs)?\b|\bgro(?:ss)?handel\b|\bgrossiste\b|\bingrosso\b|\bgrossista\b/i, key: "wholesale", w: 4 },
  { re: /\bdistribuidor(?:es|a)?\b|\bdistribuci[oó]n\b|\bdistributor\b|\bdistribution\b|\bdistributeur\b|\bdistributore\b/i, key: "distribuidor", w: 3 },
  { re: /\bb2b\b|venta\s+(?:a|solo\s+a)\s+profesionales|solo\s+profesionales|[aá]rea\s+(?:de\s+)?profesional(?:es)?|acceso\s+profesional|cliente\s+profesional|trade\s+(?:account|only)|reseller|revendedor(?:es)?|para\s+tiendas/i, key: "b2b", w: 4 },
  { re: /\bdropshipping\b|\bdropshipper\b/i, key: "dropshipping", w: 3 },
  { re: /\bimportador(?:es|a)?\b|\bimporter\b|\bimportaci[oó]n\b/i, key: "importador", w: 3 },
  { re: /pedido\s+m[ií]nimo|\bmoq\b|minimum\s+order|cantidad\s+m[ií]nima/i, key: "pedido_minimo", w: 3 },
  { re: /cash\s*(?:&|and|y)\s*carry|\balmac[eé]n\s+(?:de\s+)?distribuci[oó]n/i, key: "cash_carry", w: 3 },
  { re: /tarifa(?:s)?\s+(?:de\s+)?precios|lista\s+de\s+precios|price\s*list|cat[aá]logo\s+(?:profesional|mayorista|b2b)/i, key: "tarifa", w: 2 },
  { re: /\bproveedor(?:es)?\b|\bsupplier(?:s)?\b|\bfabricante(?:s)?\b|\bmanufacturer(?:s)?\b|\bfactory\b/i, key: "proveedor", w: 1 },
  { re: /hazte\s+distribuidor|become\s+a\s+(?:distributor|dealer|reseller|stockist)|darse\s+de\s+alta\s+como\s+(?:cliente|distribuidor)|registro\s+(?:de\s+)?(?:profesional|distribuidor|empresa)/i, key: "alta_distribuidor", w: 4 }
];
const RETAIL_SIGNALS = [
  { re: /a[nñ]adir\s+al\s+carrito|a[nñ]adir\s+a\s+la\s+cesta|add\s+to\s+(?:cart|basket)|comprar\s+ahora|buy\s+now/i, key: "carrito", w: 3 },
  { re: /env[ií]o\s+gratis|env[ií]o\s+en\s+24|free\s+shipping|entrega\s+(?:en|ma[nñ]ana)/i, key: "envio_consumidor", w: 2 },
  { re: /\bopiniones\b|\bvaloraciones\b|\breviews?\b|\brese[nñ]as\b/i, key: "opiniones", w: 1 },
  { re: /mejor\s+precio|al\s+mejor\s+precio|\bchollo\b|\bofertas?\b|\brebajas\b|\bdescuento\b/i, key: "oferta", w: 1 },
  { re: /\d{1,4}[.,]\d{2}\s?(?:€|eur\b)|€\s?\d{1,4}[.,]\d{2}/i, key: "precio_pvp", w: 1 }
];

function signalsOf(text, list) {
  const t = String(text || "");
  const out = [];
  let w = 0;
  list.forEach(function (s) {
    if (s.re.test(t)) { out.push(s.key); w += s.w; }
  });
  return { keys: out, weight: w };
}

/* Codigos a buscar en un texto: el EAN tal cual, sin ceros de relleno y el
   UPC-A de 12 si el EAN empieza por 0. */
function eanForms(eans) {
  const out = [];
  gtin.normalizeAll(eans || []).forEach(function (e) {
    [e, e.replace(/^0+/, ""), e.length === 13 && e[0] === "0" ? e.slice(1) : ""].forEach(function (v) {
      if (v && v.length >= 8 && out.indexOf(v) === -1) out.push(v);
    });
  });
  return out;
}
function textHasEan(text, forms) {
  if (!forms.length) return false;
  /* Se compara sobre digitos contiguos (un EAN puede salir "8 412345 678905"). */
  const raw = String(text || "");
  const compact = raw.replace(/(\d)[\s.\-](?=\d)/g, "$1");
  return forms.some(function (f) {
    const re = new RegExp("(^|\\D)" + f + "(\\D|$)");
    return re.test(raw) || re.test(compact);
  });
}

/* Tokens de marca/fabricante utiles para reconocer el dominio propio. */
const CORP = /\b(s\.?l\.?u?|s\.?a\.?u?|gmbh|ltd|limited|inc|corp|co|llc|srl|spa|bv|ag|sas|sarl|company|group|grupo|international|iberia|espana|spain|europe|eu)\b/g;
function brandSlugs(brand, manufacturer) {
  const out = [];
  [brand, manufacturer].forEach(function (b) {
    const base = fold(b).replace(CORP, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!base) return;
    const full = base.replace(/ /g, "");
    if (full.length >= 2 && out.indexOf(full) === -1) out.push(full);
    /* "Philips Domestic Appliances" -> tambien "philips". */
    const first = base.split(" ")[0];
    if (first.length >= 4 && out.indexOf(first) === -1) out.push(first);
  });
  return out;
}
function brandInHost(host, slugs) {
  const label = mainLabel(host).replace(/[^a-z0-9]/g, "");
  if (!label) return false;
  return slugs.some(function (s) {
    if (label === s) return true;
    /* "acmeiberia", "acme-store", "shopacme": la marca debe ser una parte
       grande de la etiqueta para no confundir "lg" con "blog". */
    return s.length >= 4 && label.indexOf(s) !== -1 && s.length / label.length >= 0.35;
  });
}

/* ---------- consultas ---------- */
/* body: { ean, eans[], brand, manufacturer, model, partNumber, name }
   Devuelve [{ q, group, intent }]. El EAN entre comillas obliga al buscador a
   devolver paginas que contienen ese codigo exacto (como en la busqueda manual). */
function buildLeadQueries(body, opts) {
  body = body || {};
  opts = opts || {};
  const max = Math.max(2, Math.min(opts.max || 10, 14));
  const out = [];
  const seen = {};
  function add(q, group, intent) {
    q = String(q || "").replace(/\s+/g, " ").trim();
    if (!q) return;
    const k = fold(q);
    if (seen[k]) return;
    seen[k] = 1;
    out.push({ q: q, group: group, intent: intent });
  }
  const eans = gtin.normalizeAll([].concat(body.ean || [], body.eans || []));
  const rawEan = gtin.digitsOnly(body.ean);
  const ean = rawEan.length >= 8 ? rawEan : (eans[0] ? eans[0].replace(/^0+(?=\d{12,})/, "") : "");
  const brand = clean(body.brand);
  const manufacturer = clean(body.manufacturer);
  const model = clean(body.model || body.partNumber || body.mpn);
  const lang = String(opts.lang || "es").toLowerCase();

  /* 1. EAN (lo que se hace a mano). */
  if (ean) {
    add('"' + ean + '" mayorista', "ean", "mayorista");
    add('"' + ean + '" distribuidor', "ean", "distribuidor");
    add('"' + ean + '" al por mayor', "ean", "mayorista");
    add('"' + ean + '"', "ean", "identidad");
    add('"' + ean + '" wholesale', "ean", "mayorista");
  }
  /* 2. Marca / fabricante: quien distribuye la marca en Espana. */
  const who = brand || manufacturer;
  if (who) {
    add('"' + who + '" distribuidor oficial ' + (lang === "es" ? "España" : ""), "marca", "distribuidor_oficial");
    add('"' + who + '" mayorista', "marca", "mayorista");
    add('"' + who + '" distribuidores profesionales', "marca", "alta_distribuidor");
  }
  if (manufacturer && brand && slug(manufacturer) !== slug(brand) && slug(manufacturer).indexOf(slug(brand)) === -1) {
    add('"' + manufacturer + '" contacto distribuidores', "marca", "fabricante");
  }
  if (who) add('"' + who + '" official website', "marca", "fabricante");
  /* 3. Marca + modelo (si el EAN no esta indexado). */
  if (who && model && model.length >= 3 && slug(model) !== slug(who)) {
    add('"' + who + '" "' + model + '" mayorista', "modelo", "mayorista");
    add('"' + who + '" "' + model + '" wholesale', "modelo", "mayorista");
  }
  return out.slice(0, max);
}

/* Enlaces de Google para repetir a mano exactamente las mismas busquedas. */
function googleLinks(queries) {
  return (queries || []).map(function (x) {
    return { q: x.q, group: x.group, url: "https://www.google.es/search?hl=es&gl=es&q=" + encodeURIComponent(x.q) };
  });
}

/* ---------- clasificacion ---------- */
const ROLE_WEIGHT = {
  fabricante: 100, distribuidor_oficial: 95, mayorista: 85, marketplace_b2b: 60,
  info_ean: 35, sin_clasificar: 40, minorista_probable: 12, minorista: 5
};
const ROLE_LABEL = {
  fabricante: "Fabricante / marca", distribuidor_oficial: "Distribuidor oficial", mayorista: "Mayorista / distribuidor",
  marketplace_b2b: "Marketplace / directorio B2B", info_ean: "Base de datos de EAN (identifica al titular)",
  sin_clasificar: "Sin clasificar (revisar)", minorista_probable: "Tienda minorista (probable)", minorista: "Tienda minorista"
};

/* results: [{ url, title, description, query, group, position }]
   ctx: { eans[], brand, manufacturer }
   Devuelve { leads[], retailers[], dropped } agrupado por dominio. */
function rankLeads(results, ctx) {
  ctx = ctx || {};
  const forms = eanForms([].concat(ctx.eans || [], ctx.ean || []));
  const slugs = brandSlugs(ctx.brand, ctx.manufacturer);
  const byHost = {};
  let dropped = 0;
  (results || []).forEach(function (r) {
    const host = hostOf(r && r.url);
    if (!host || hostMatches(host, BLOCKED) || /(^|\.)amazon\./.test(host)) { dropped++; return; }
    let d = byHost[host];
    if (!d) {
      d = byHost[host] = {
        host: host, url: r.url, title: "", snippet: "", hits: [], queries: [], groups: [],
        eanHit: false, bestPos: 99, texts: []
      };
    }
    const text = [r.title, r.description, r.url].join(" ");
    d.texts.push(text);
    if (!d.title && r.title) { d.title = String(r.title).slice(0, 160); d.url = r.url; d.snippet = String(r.description || "").slice(0, 280); }
    if (r.query && d.queries.indexOf(r.query) === -1) d.queries.push(r.query);
    if (r.group && d.groups.indexOf(r.group) === -1) d.groups.push(r.group);
    const pos = Number(r.position) || 50;
    if (pos < d.bestPos) d.bestPos = pos;
    if (textHasEan(text, forms)) {
      d.eanHit = true;
      /* La pagina que muestra el EAN es la mas util: se prefiere como enlace. */
      if (!d.eanUrl) { d.eanUrl = r.url; d.eanTitle = String(r.title || "").slice(0, 160); }
    }
  });

  const leads = [], retailers = [];
  Object.keys(byHost).forEach(function (h) {
    const d = byHost[h];
    const all = d.texts.join(" \n ");
    const b2b = signalsOf(all, B2B_SIGNALS);
    const retail = signalsOf(all, RETAIL_SIGNALS);
    let role;
    if (hostMatches(h, COMPARATORS)) role = "minorista";
    else if (hostMatches(h, EAN_DBS)) role = "info_ean";
    else if (hostMatches(h, B2B_MARKETS)) role = "marketplace_b2b";
    else if (slugs.length && brandInHost(h, slugs)) role = "fabricante";
    else if (hostMatches(h, RETAILERS)) role = "minorista";
    else if (b2b.keys.indexOf("distribuidor_oficial") !== -1) role = "distribuidor_oficial";
    else if (b2b.weight >= 3 && b2b.weight >= retail.weight) role = "mayorista";
    else if (retail.weight >= 2 && b2b.weight < 3) role = "minorista_probable";
    else role = "sin_clasificar";
    /* "proveedor/fabricante" en el snippet sin mas senales no basta para
       llamar mayorista a una tienda. */
    const score = Math.round(
      ROLE_WEIGHT[role] +
      (d.eanHit ? 25 : 0) +
      Math.min(15, d.queries.length * 5) +
      (d.groups.indexOf("ean") !== -1 ? 8 : 0) +
      Math.min(10, b2b.weight * 2) -
      Math.min(10, Math.max(0, d.bestPos - 1))
    );
    const lead = {
      host: h, url: d.eanUrl || d.url, title: d.eanTitle || d.title, snippet: d.snippet,
      role: role, roleLabel: ROLE_LABEL[role], score: score,
      eanOnSerp: d.eanHit, signals: b2b.keys, retailSignals: retail.keys,
      queries: d.queries.slice(0, 6), groups: d.groups, bestPosition: d.bestPos === 99 ? null : d.bestPos,
      contact: null, page: null
    };
    if (role === "minorista" || role === "minorista_probable") retailers.push(lead);
    else leads.push(lead);
  });
  leads.sort(compareLeads);
  retailers.sort(compareLeads);
  return { leads: leads, retailers: retailers, dropped: dropped };
}

/* Orden: primero el papel (fabricante > distribuidor oficial > mayorista >
   sin clasificar con el EAN visible > marketplace B2B > resto) y dentro de
   cada papel, la puntuacion. */
function tierOf(l) {
  const ean = l.eanOnSerp || (l.page && l.page.eanOnPage);
  switch (l.role) {
    case "fabricante": return 0;
    case "distribuidor_oficial": return 1;
    case "mayorista": return 2;
    case "sin_clasificar": return ean ? 3 : 5;
    case "marketplace_b2b": return 4;
    case "info_ean": return 6;
    default: return 9;
  }
}
function compareLeads(a, b) {
  return tierOf(a) - tierOf(b) || b.score - a.score || (a.bestPosition || 99) - (b.bestPosition || 99);
}

/* ---------- lectura de la pagina del candidato ---------- */
const DIST_LINK = /(distribuidor|distribuidores|donde[-_ ]?comprar|where[-_ ]?to[-_ ]?buy|dealers?|puntos[-_ ]?de[-_ ]?venta|stockists?|resellers?|profesional(?:es)?|b2b|wholesale|mayorist|hazte|partners?|trade)/i;
function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}
function pageSignals(html, ctx, baseUrl) {
  ctx = ctx || {};
  const raw = String(html || "").slice(0, 900000);
  const text = stripTags(raw);
  const forms = eanForms([].concat(ctx.eans || [], ctx.ean || []));
  const b2b = signalsOf(text, B2B_SIGNALS);
  const retail = signalsOf(text, RETAIL_SIGNALS);
  const emails = [];
  (raw.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []).forEach(function (e) {
    e = e.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(e) || /sentry|wixpress|example\.|@2x|domain\.com/.test(e)) return;
    if (emails.indexOf(e) === -1 && emails.length < 4) emails.push(e);
  });
  const phones = [];
  (text.match(/(?:\+34[\s.]?)?[6789]\d{2}[\s.]?\d{2,3}[\s.]?\d{2,3}[\s.]?\d{0,3}/g) || []).forEach(function (p) {
    const d = p.replace(/\D/g, "");
    if ((d.length === 9 || (d.length === 11 && d.indexOf("34") === 0)) && phones.indexOf(p.trim()) === -1 && phones.length < 3) phones.push(p.trim());
  });
  /* Enlace a "distribuidores / donde comprar / area profesional" en la propia web. */
  let distLink = "";
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while (!distLink && (m = re.exec(raw))) {
    const href = m[1], label = stripTags(m[2]);
    if (DIST_LINK.test(href) || DIST_LINK.test(label)) {
      try { distLink = new URL(href, baseUrl || undefined).href; } catch (e) { /* relativo sin base */ }
    }
  }
  const loginWall = /(inicia\s+sesi[oó]n|reg[ií]strate|log\s?in|sign\s?in)[^.]{0,60}(ver|para ver|to see|to view)\s+(?:los\s+)?prec/i.test(text) ||
    /precios?\s+(?:solo\s+)?(?:para|a)\s+(?:clientes\s+)?(?:registrados|profesionales)/i.test(text);
  return {
    eanOnPage: textHasEan(text, forms) || textHasEan(raw, forms),
    signals: b2b.keys, b2bWeight: b2b.weight, retailSignals: retail.keys, retailWeight: retail.weight,
    loginWall: loginWall, emails: emails, phones: phones, distributorLink: distLink
  };
}

/* Re-clasifica con lo leido en la pagina (mas fiable que el snippet). */
function applyPage(lead, ps) {
  if (!lead || !ps) return lead;
  lead.page = { eanOnPage: ps.eanOnPage, loginWall: ps.loginWall, signals: ps.signals, distributorLink: ps.distributorLink || "" };
  if (ps.emails.length || ps.phones.length) lead.contact = { emails: ps.emails, phones: ps.phones };
  ps.signals.forEach(function (s) { if (lead.signals.indexOf(s) === -1) lead.signals.push(s); });
  if (lead.role === "sin_clasificar") {
    if (ps.signals.indexOf("distribuidor_oficial") !== -1) lead.role = "distribuidor_oficial";
    else if (ps.b2bWeight >= 4 || ps.loginWall) lead.role = "mayorista";
    else if (ps.retailWeight >= 4 && ps.b2bWeight < 3) lead.role = "minorista_probable";
  } else if (lead.role === "mayorista" && ps.retailWeight >= 5 && ps.b2bWeight < 3 && !ps.loginWall) {
    /* El snippet decia "mayorista" pero la pagina es una tienda al consumidor. */
    lead.role = "minorista_probable";
  }
  lead.roleLabel = ROLE_LABEL[lead.role];
  lead.score = Math.round(
    ROLE_WEIGHT[lead.role] + (lead.eanOnSerp || ps.eanOnPage ? 25 : 0) + (ps.eanOnPage ? 5 : 0) +
    Math.min(15, (lead.queries || []).length * 5) + (ps.loginWall ? 8 : 0) + (lead.contact ? 4 : 0) +
    Math.min(10, ps.b2bWeight * 2) - Math.min(10, Math.max(0, (lead.bestPosition || 1) - 1))
  );
  return lead;
}

module.exports = {
  buildLeadQueries, googleLinks, rankLeads, compareLeads, pageSignals, applyPage,
  eanForms, textHasEan, brandSlugs, brandInHost, hostOf, mainLabel,
  ROLE_LABEL, ROLE_WEIGHT, lists: { BLOCKED, COMPARATORS, RETAILERS, B2B_MARKETS, EAN_DBS }
};
