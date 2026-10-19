"use strict";
/* GET /product/:ean -> ficha + proveedores + ofertas en una sola respuesta.

   Es la vista que convierte las fuentes en producto: un EAN de entrada, la
   identidad resuelta por Icecat, el coste de BigBuy y las ofertas de tienda de
   Google Shopping por EAN. Cada fuente informa de su estado por separado. */

const { adapters } = require("../adapters");
const { createResolver } = require("../lib/product");

const resolveProduct = createResolver({
  identity: adapters.icecat.actions,
  supplier: adapters.bigbuy.actions,
  offers: adapters.gshopping_ean.actions
});

async function productByEan(req, res) {
  const out = await resolveProduct(req.params.ean, { max: req.query && req.query.max });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
}

module.exports = { productByEan };
