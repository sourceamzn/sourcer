const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function clean(value) {
  return value == null ? "" : String(value).trim();
}

const config = {
  env: clean(process.env.NODE_ENV) || "development",
  port: parseInt(clean(process.env.PORT) || "3000", 10),
  market: clean(process.env.MARKETPLACE_ID) || "A1RKKUPIHCS9HS",
  region: clean(process.env.SPAPI_REGION) || "eu-west-1",
  allowedOrigins: clean(process.env.ALLOWED_ORIGINS) || "*",
  vaultKey: clean(process.env.VAULT_KEY),
  amazon: {
    clientId: clean(process.env.LWA_CLIENT_ID),
    clientSecret: clean(process.env.LWA_CLIENT_SECRET),
    refreshToken: clean(process.env.SPAPI_REFRESH_TOKEN),
    sellerId: clean(process.env.SPAPI_SELLER_ID),
    accessKeyId: clean(process.env.AWS_ACCESS_KEY_ID),
    secretAccessKey: clean(process.env.AWS_SECRET_ACCESS_KEY),
    roleArn: clean(process.env.SPAPI_ROLE_ARN)
  },
  keepa: {
    apiKey: clean(process.env.KEEPA_API_KEY),
    domain: parseInt(clean(process.env.KEEPA_DOMAIN) || "9", 10)
  },
  feeds: {
    outletpc: clean(process.env.FEED_OUTLETPC),
    lidl: clean(process.env.FEED_LIDL),
    iherb: clean(process.env.FEED_IHERB)
  },
  scraping: {
    provider: clean(process.env.SCRAPER_PROVIDER) || "none",
    apiKey: clean(process.env.SCRAPER_API_KEY)
  }
};

function amazonReady() {
  return Boolean(
    config.amazon.clientId &&
      config.amazon.clientSecret &&
      config.amazon.refreshToken &&
      config.amazon.accessKeyId &&
      config.amazon.secretAccessKey
  );
}

function keepaReady() {
  return Boolean(config.keepa.apiKey);
}

function feedReady(source) {
  return Boolean(config.feeds[source]);
}

function scrapingReady() {
  return config.scraping.provider !== "none" && Boolean(config.scraping.apiKey);
}

module.exports = { config, amazonReady, keepaReady, feedReady, scrapingReady };
