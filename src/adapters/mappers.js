function stripHtml(value) {
  return String(value == null ? "" : value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/\s+/g, " ")
    .trim();
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function trimBrand(name) {
  return String(name == null ? "" : name).replace(/[®™]/g, "").trim();
}

function mapOutletProduct(node) {
  const variants = [];
  const edges = (node && node.variants && node.variants.edges) || [];
  edges.forEach(function (edge) {
    const v = edge && edge.node;
    if (!v) return;
    variants.push({
      title: v.title || "",
      sku: v.sku || "",
      ean: v.barcode || "",
      price: v.price ? num(v.price.amount) : null,
      currency: v.price ? v.price.currencyCode : null,
      compareAtPrice: v.compareAtPrice ? num(v.compareAtPrice.amount) : null,
      available: Boolean(v.availableForSale)
    });
  });
  const first = variants[0] || {};
  const min = node && node.priceRange && node.priceRange.minVariantPrice;
  const max = node && node.priceRange && node.priceRange.maxVariantPrice;
  const ean = variants.find(function (v) {
    return v.ean;
  });
  const sku = variants.find(function (v) {
    return v.sku;
  });
  return {
    source: "outletpc",
    name: node.title || "",
    brand: node.vendor || "",
    model: "",
    reference: sku ? sku.sku : "",
    ean: ean ? ean.ean : "",
    price: min && min.amount != null ? num(min.amount) : first.price || null,
    maxPrice: max && max.amount != null ? num(max.amount) : null,
    oldPrice: first.compareAtPrice || null,
    stock: node.totalInventory == null ? null : Number(node.totalInventory),
    available: Boolean(node.availableForSale),
    url: node.handle ? "https://outlet-pc.es/products/" + node.handle : "",
    image: node.featuredImage ? node.featuredImage.url : "",
    variants,
    attrs: {
      productType: node.productType || "",
      tags: node.tags || [],
      currency: min ? min.currencyCode : "EUR"
    },
    capturedAt: new Date().toISOString()
  };
}

function mapLidlItem(item) {
  const g = (item && item.gridbox && item.gridbox.data) || item || {};
  const price = g.price || {};
  const stock = g.stockAvailability || {};
  const brand = g.brand && g.brand.name ? trimBrand(g.brand.name) : "";
  const url = g.canonicalUrl ? "https://www.lidl.es" + g.canonicalUrl : "";
  const description = g.keyfacts ? stripHtml(g.keyfacts.description || "") : "";
  return {
    source: "lidl",
    name: g.fullTitle || g.title || "",
    brand,
    model: "",
    reference: g.erpNumber ? String(g.erpNumber) : "",
    ean: "",
    price: num(price.price),
    oldPrice: num(price.oldPrice),
    stock: stock.onlineAvailable ? 1 : 0,
    available: Boolean(stock.onlineAvailable),
    url,
    image: g.image || "",
    attrs: {
      description,
      specs: g.keyfacts ? stripHtml(g.keyfacts.supplementalDescription || "") : "",
      category: g.keyfacts ? g.keyfacts.analyticsCategory || "" : "",
      productId: g.productId || null,
      ians: g.ians || [],
      tax: price.tax || ""
    },
    capturedAt: new Date().toISOString()
  };
}

function mapIherbProduct(raw) {
  if (!raw) return null;
  return {
    source: "iherb",
    name: raw.name || "",
    brand: raw.brand || "",
    model: "",
    reference: raw.id ? String(raw.id) : "",
    ean: raw.upc || raw.ean || "",
    price: num(raw.price),
    oldPrice: num(raw.listPrice),
    stock: raw.available === false ? 0 : 1,
    available: raw.available !== false,
    url: raw.url || (raw.id ? "https://www.iherb.com/pr/x/" + raw.id : ""),
    image: raw.image || "",
    attrs: { size: raw.size || "", rating: raw.rating || null },
    capturedAt: new Date().toISOString()
  };
}

module.exports = { stripHtml, num, trimBrand, mapOutletProduct, mapLidlItem, mapIherbProduct };
