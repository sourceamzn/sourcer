"use strict";
/* Compatibilidad: la decision de identidad vive en un unico sitio,
   identity.decideIdentity(). Este modulo solo la expone con el nombre
   historico que usan los adaptadores. */

const identity = require("./identity");

function score(src, offer, ctx) {
  return identity.decideIdentity(src, offer, ctx);
}

module.exports = { score, WEIGHTS: identity.WEIGHTS, BANDS: identity.BANDS };
