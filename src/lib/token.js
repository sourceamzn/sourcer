'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { config } = require('./config');
const { AppError } = require('./errors');

function sign(claims) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...claims, jti }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
  const decoded = jwt.decode(token);
  return { token, jti, expiresAt: new Date(decoded.exp * 1000) };
}

function verify(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (err) {
    throw AppError.unauthorized('Token invalido o expirado');
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: sha256(raw) };
}

module.exports = { sign, verify, sha256, randomToken };
