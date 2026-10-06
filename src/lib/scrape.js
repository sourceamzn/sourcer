const { config } = require("../config");

function providerReady() {
  return config.scraping.provider !== "none" && Boolean(config.scraping.apiKey);
}

function providerUrl(target) {
  const provider = config.scraping.provider;
  const key = encodeURIComponent(config.scraping.apiKey);
  const url = encodeURIComponent(target);
  switch (provider) {
    case "scraperapi":
      return "https://api.scraperapi.com/?api_key=" + key + "&url=" + url;
    case "scrapingbee":
      return "https://app.scrapingbee.com/api/v1/?api_key=" + key + "&url=" + url;
    case "scrapfly":
      return "https://api.scrapfly.io/scrape?key=" + key + "&url=" + url + "&render_js=false";
    case "scrapingant":
      return "https://api.scrapingant.com/v2/general?x-api-key=" + key + "&url=" + url;
    case "zenrows":
      return "https://api.zenrows.com/v1/?apikey=" + key + "&url=" + url;
    default:
      return null;
  }
}

module.exports = { providerReady, providerUrl };
