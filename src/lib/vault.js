const crypto = require("crypto");
const { config } = require("../config");

let key = null;
if (config.vaultKey) {
  key = crypto.createHash("sha256").update(config.vaultKey, "utf8").digest();
}

function available() {
  return key !== null;
}

function encrypt(payload) {
  if (!key) throw new Error("VAULT_KEY no configurada");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64");
}

function decrypt(token) {
  if (!key) throw new Error("VAULT_KEY no configurada");
  const raw = Buffer.from(String(token), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(out.toString("utf8"));
}

module.exports = { available, encrypt, decrypt };
