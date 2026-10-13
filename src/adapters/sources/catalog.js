/* Perfiles declarativos de las fuentes del PDF (outlets, tiendas y
   mayoristas/fabricantes). Cada perfil se convierte en un adaptador con la
   fabrica de profile.js. Aqui vive el "catalogo completo de fuentes" que pide
   el PDF; ya no se limita a Outlet PC, Lidl e iHerb.

   Particularidades por fuente (segun el PDF): si publica EAN, si el precio es
   neto, limites por cliente o notas de compra. */

const { makeAdapter } = require("../profile");

function prestaSearch(home) {
  return function (q) {
    return home.replace(/\/+$/, "") + "/buscar?controller=search&s=" + encodeURIComponent(q);
  };
}

const PROFILES = [
  {
    id: "selectavision",
    label: "Selecta Visión",
    kind: "scraping",
    home: "https://www.selectavision.com/",
    platform: "jsonld",
    ean: false,
    type: "outlet",
    search: { url: prestaSearch("https://www.selectavision.com/") },
    note: "Cine y coleccionismo. Sin EAN utilizable. Limite de 2 unidades por producto y cliente."
  },
  {
    id: "yesstyle",
    label: "YesStyle",
    kind: "scraping",
    home: "https://www.yesstyle.com/",
    platform: "jsonld",
    ean: false,
    type: "outlet",
    search: { url: "https://www.yesstyle.com/en/search.html?q=" },
    note: "Moda y belleza asiatica. Sin EAN fiable: marca + modelo + variante. Ojo con aduanas e IVA de importacion."
  },
  {
    id: "corteingles",
    label: "El Corte Inglés",
    kind: "scraping",
    home: "https://www.elcorteingles.es/",
    platform: "jsonld",
    ean: false,
    type: "outlet",
    search: { url: "https://www.elcorteingles.es/search-nwx/1/?s=" },
    note: "Grandes almacenes. Referencia interna, no siempre EAN. Revisar stock, envio y pedido minimo."
  },
  {
    id: "zalandoprive",
    label: "Zalando Privé",
    kind: "scraping",
    home: "https://www.zalando-prive.es/",
    platform: "auth",
    ean: false,
    type: "outlet",
    requiresAuth: true,
    authHint: "Zalando Privé exige sesion autenticada (campañas por invitacion); el catalogo no es publico sin login.",
    note: "Outlet por campañas y tiempo limitado. Sin EAN claro: marca + modelo + talla/color (ASIN hijo)."
  },
  {
    id: "gemimarket",
    label: "Gemimarket",
    kind: "scraping",
    home: "https://www.gemimarket.com/",
    platform: "jsonld",
    ean: false,
    type: "outlet",
    search: { url: prestaSearch("https://www.gemimarket.com/") },
    note: "Tienda de ofertas/outlet. Sin EAN fiable: marca + modelo + atributos. Comprobar envio y pedido minimo."
  },
  {
    id: "norica",
    label: "Norica",
    kind: "wholesale",
    home: "https://www.norica.es/",
    platform: "jsonld",
    ean: true,
    type: "mayorista",
    search: { url: "https://www.norica.es/buscar?controller=search&s=" },
    note: "Fabricante. Tarifa PDF/Excel con referencia y precio neto (sin IVA): cruzar cada EAN contra Amazon.es."
  },
  {
    id: "famosa",
    label: "Famosa",
    kind: "wholesale",
    home: "https://www.famosa.com/",
    platform: "jsonld",
    ean: true,
    type: "mayorista",
    search: { url: "https://www.famosa.com/es/buscar?cref=1&s=" },
    note: "Fabricante de juguetes. Tarifa con EAN y precio neto: cruzar contra Amazon.es. Tramos por volumen."
  },
  {
    id: "planafabrega",
    label: "Plana Fàbrega",
    kind: "wholesale",
    home: "https://www.planafabrega.com/",
    platform: "jsonld",
    ean: true,
    type: "mayorista",
    search: { url: prestaSearch("https://www.planafabrega.com/") },
    note: "Mayorista/fabricante. Tarifa con EAN y precio neto: cruzar contra Amazon.es. Guardar pedido minimo y descuentos."
  },
  {
    id: "vallesviasat",
    label: "Vallès Via Sat",
    kind: "wholesale",
    home: "https://www.vallesviasat.com/",
    platform: "jsonld",
    ean: true,
    type: "mayorista",
    search: { url: prestaSearch("https://www.vallesviasat.com/") },
    note: "Distribuidor/mayorista. Tarifa con EAN y precio neto: cruzar contra Amazon.es. Comprobar pedido minimo y tramos."
  }
];

function buildAdapters() {
  const out = {};
  PROFILES.forEach(function (p) {
    out[p.id] = makeAdapter(p);
  });
  return out;
}

module.exports = { PROFILES, buildAdapters };
