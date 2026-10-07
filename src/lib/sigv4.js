const crypto = require("crypto");

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalQuery(searchParams) {
  const keys = [];
  searchParams.forEach((v, k) => {
    if (keys.indexOf(k) === -1) keys.push(k);
  });
  return keys
    .sort()
    .map((k) => encodeRfc3986(k) + "=" + encodeRfc3986(searchParams.get(k)))
    .join("&");
}

function signRequest(options) {
  const method = (options.method || "GET").toUpperCase();
  const url = new URL(options.url);
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const amzDate = now;
  const dateStamp = now.slice(0, 8);
  const body = options.body || "";
  const region = options.region;
  const service = options.service || "execute-api";

  const headerMap = { host: url.host, "x-amz-date": amzDate };
  if (options.sessionToken) headerMap["x-amz-security-token"] = options.sessionToken;

  const signedHeaderNames = Object.keys(headerMap).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => h + ":" + String(headerMap[h]).trim() + "\n").join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method,
    url.pathname || "/",
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    sha256(body)
  ].join("\n");

  const scope = [dateStamp, region, service, "aws4_request"].join("/");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  let k = hmac("AWS4" + options.secretAccessKey, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, "aws4_request");
  const signature = crypto.createHmac("sha256", k).update(stringToSign, "utf8").digest("hex");

  const authorization =
    "AWS4-HMAC-SHA256 Credential=" +
    options.accessKeyId +
    "/" +
    scope +
    ", SignedHeaders=" +
    signedHeaders +
    ", Signature=" +
    signature;

  return { host: url.host, amzDate, authorization, sessionToken: options.sessionToken || "" };
}

module.exports = { signRequest };
