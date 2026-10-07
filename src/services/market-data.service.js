'use strict';

/* Fuente de precios en vivo del robot.
 *
 * El robot es la ÚNICA fuente de verdad del precio. Este módulo trae los precios
 * REALES (cotización y velas) para que la valoración (resultado flotante,
 * patrimonio y margen) y las gráficas se calculen con el mismo número en todas
 * las apps (Terminal, Manager, Área de cliente).
 *
 *   - Cripto  -> Binance (bid/ask reales), con respaldo en Yahoo Finance.
 *   - Índices, acciones, forex intradía, metales y materias primas -> Yahoo
 *     Finance (sin clave, cobertura amplia y sin el límite de 8/min de Twelve).
 *   - Twelve Data queda como proveedor OPCIONAL: solo se usa si se define
 *     TWELVE_API_KEY (plan de pago). Con el plan gratuito no cubre índices y
 *     agota la cuota, así que por defecto NO se usa.
 *   - Tipos de cambio (para pasar el P/L a la divisa de la cuenta) -> Frankfurter
 *     (tipos del BCE), con respaldo en Yahoo Finance.
 *
 * Reglas de oro:
 *   - Nunca se inventa un precio. Si una fuente no responde, ese símbolo queda
 *     «sin precio» (no se rellena con un valor simulado).
 *   - Se cachea cada cotización y cada serie de velas para no castigar a las
 *     fuentes ni agotar cuotas.
 */

function int(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const BINANCE_BASE = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
const YAHOO_BASE = process.env.YAHOO_BASE_URL || 'https://query1.finance.yahoo.com';
const TWELVE_BASE = process.env.TWELVE_BASE_URL || 'https://api.twelvedata.com';
const FRANKFURTER_BASE = process.env.FRANKFURTER_BASE_URL || 'https://api.frankfurter.app';

/* Twelve Data es OPCIONAL: solo se activa si hay clave en el entorno. La clave
   integrada (plan gratuito) NO cubre índices y limita a 8 créditos/min, que es
   justo lo que dejaba las gráficas sin velas y el P/L a 0. Por defecto se usa
   Yahoo Finance, que no necesita clave. */
const TWELVE_KEY = process.env.TWELVE_API_KEY || '';
const USE_TWELVE = Boolean(TWELVE_KEY);

const HTTP_TIMEOUT_MS = int(process.env.MARKET_TIMEOUT_MS, 8000);
/* La cripto (Binance) es instantánea. El resto va por Yahoo Finance: se cachea
   unos segundos para dar sensación de vivo sin castigar la fuente. */
const QUOTE_TTL_MS = int(process.env.MARKET_QUOTE_TTL_MS, 20000);
const SLOW_QUOTE_TTL_MS = int(process.env.MARKET_SLOW_QUOTE_TTL_MS, 20000);
const CANDLE_TTL_MS = int(process.env.MARKET_CANDLE_TTL_MS, 60000);
const STALE_TTL_MS = int(process.env.MARKET_STALE_TTL_MS, 180000);
const RATES_TTL_MS = int(process.env.MARKET_RATES_TTL_MS, 6 * 60 * 60 * 1000);
const TWELVE_MIN_GAP_MS = int(process.env.TWELVE_MIN_GAP_MS, 8000);
const TWELVE_MAX_BACKOFF_MS = int(process.env.TWELVE_MAX_BACKOFF_MS, 5 * 60 * 1000);

const YAHOO_UA = process.env.YAHOO_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CRYPTO = new Set([
  'BTCUSD', 'ETHUSD', 'BNBUSD', 'SOLUSD', 'XRPUSD', 'ADAUSD',
  'DOGEUSD', 'LTCUSD', 'AVAXUSD', 'LINKUSD', 'DOTUSD', 'TRXUSD',
]);

const FX = new Set([
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD',
  'EURJPY', 'NZDUSD', 'EURGBP', 'GBPJPY', 'EURCHF', 'CADJPY',
]);

/* Símbolo del robot -> ticker de Yahoo Finance (sin clave). */
const YAHOO_MAP = {
  NAS100: '^NDX',
  US500: '^GSPC',
  US30: '^DJI',
  GER40: '^GDAXI',
  UK100: '^FTSE',
  JP225: '^N225',
  FRA40: '^FCHI',
  ESP35: '^IBEX',
  HK50: '^HSI',
  XAUUSD: 'GC=F',
  XAGUSD: 'SI=F',
  XPTUSD: 'PL=F',
  XCUUSD: 'HG=F',
  USOIL: 'CL=F',
  UKOIL: 'BZ=F',
  NATGAS: 'NG=F',
};

/* Símbolo del robot -> símbolo de Twelve Data (solo si hay clave de pago). */
const TWELVE_MAP = {
  NAS100: 'NDX',
  US500: 'SPX',
  US30: 'DJIA',
  GER40: 'DAX',
  UK100: 'FTSE',
  JP225: 'N225',
  FRA40: 'CAC',
  ESP35: 'IBEX',
  HK50: 'HSI',
  XAUUSD: 'XAU/USD',
  XAGUSD: 'XAG/USD',
  XPTUSD: 'XPT/USD',
  XCUUSD: 'HG1',
  USOIL: 'WTI/USD',
  UKOIL: 'XBR/USD',
  NATGAS: 'NG',
};

/* Tabla de respaldo (EUR por 1 unidad) por si Frankfurter no responde. Solo es
   un último recurso para no dejar la valoración a ciegas. */
const FX_FALLBACK = { EUR: 1, USD: 0.926, GBP: 1.18, JPY: 0.0062, CHF: 1.03, CAD: 0.68, AUD: 0.6, NZD: 0.55 };

const quoteCache = new Map();
const candleCache = new Map();
let ratesCache = { ts: 0, rates: {} };
let ratesInFlight = null;

let twelveLastCall = 0;
let twelveChain = Promise.resolve();
let twelveBlockedUntil = 0;
let lastError = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: Object.assign({
        accept: 'application/json',
        'user-agent': YAHOO_UA,
      }, headers || {}),
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Cola de Twelve Data (solo con clave de pago): serializa y espacia peticiones. */
function withTwelveGate(task) {
  const run = twelveChain.then(async () => {
    const blocked = twelveBlockedUntil - Date.now();
    if (blocked > 0) await sleep(blocked);
    const gap = TWELVE_MIN_GAP_MS - (Date.now() - twelveLastCall);
    if (gap > 0) await sleep(gap);
    twelveLastCall = Date.now();
    return task();
  });
  twelveChain = run.then(() => undefined, () => undefined);
  return run;
}

function twelveBackoff(status) {
  const current = twelveBlockedUntil > Date.now() ? twelveBlockedUntil - Date.now() : 0;
  const next = Math.min(TWELVE_MAX_BACKOFF_MS, Math.max(QUOTE_TTL_MS, current * 2 || TWELVE_MIN_GAP_MS * 4));
  twelveBlockedUntil = Date.now() + next;
  lastError = `Twelve Data ${status || 'sin respuesta'}: reintento en ${Math.round(next / 1000)}s`;
}

/* Símbolo del robot -> ticker de Yahoo Finance. */
function yahooSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (YAHOO_MAP[s]) return YAHOO_MAP[s];
  if (CRYPTO.has(s)) return `${s.replace(/(USD|USDT)$/, '')}-USD`;
  if (FX.has(s)) return `${s}=X`;
  if (/^[A-Z]{6}$/.test(s)) return `${s}=X`;
  return s;
}

/* Compatibilidad con consumidores antiguos: nombre del proveedor por símbolo. */
function providerFor(symbol, assetClass) {
  const s = String(symbol || '').toUpperCase();
  const cls = String(assetClass || '');
  if (CRYPTO.has(s)) {
    const base = s.replace(/(USD|USDT)$/, '');
    return { binance: `${base}USDT`, yahoo: `${base}-USD`, twelve: `${base}/USD` };
  }
  if (FX.has(s)) return { yahoo: `${s}=X`, twelve: `${s.slice(0, 3)}/${s.slice(3)}` };
  if (TWELVE_MAP[s]) return { yahoo: YAHOO_MAP[s], twelve: TWELVE_MAP[s] };
  if (/Acciones/i.test(cls) || !cls) return { yahoo: s, twelve: s };
  return {};
}

/* Tiempo de vida de una cotización según su familia. */
function ttlFor(symbol) {
  return CRYPTO.has(symbol) ? QUOTE_TTL_MS : SLOW_QUOTE_TTL_MS;
}

function setQuote(symbol, bid, ask, source, midOverride) {
  const b = num(bid);
  const a = num(ask);
  const forced = num(midOverride);
  const mid = b != null && a != null ? (b + a) / 2 : (b != null ? b : (a != null ? a : forced));
  if (mid == null) return;
  quoteCache.set(symbol, {
    bid: b != null ? b : mid,
    ask: a != null ? a : mid,
    mid,
    source: source || '',
    ts: Date.now(),
  });
}

/* Limita la concurrencia de peticiones (Yahoo agradece no recibir ráfagas). */
async function boundedMap(list, limit, worker) {
  const items = list.slice();
  const runners = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i += 1) {
    runners.push((async () => {
      while (items.length) {
        const item = items.shift();
        try { await worker(item); } catch (err) { lastError = String((err && err.message) || err); }
      }
    })());
  }
  await Promise.all(runners);
}

async function refreshBinance(symbols) {
  const map = new Map();
  symbols.forEach((s) => { map.set(providerFor(s).binance, s); });
  const list = Array.from(map.keys());
  if (!list.length) return;
  const url = `${BINANCE_BASE}/api/v3/ticker/bookTicker?symbols=${encodeURIComponent(JSON.stringify(list))}`;
  const data = await fetchJson(url);
  const rows = Array.isArray(data) ? data : [data];
  rows.forEach((row) => {
    const symbol = map.get(String(row.symbol || '').toUpperCase());
    if (!symbol) return;
    setQuote(symbol, row.bidPrice, row.askPrice, 'Binance');
  });
}

/* Cotizaciones por Yahoo Finance: el endpoint chart devuelve, en `meta`, el
   último precio y (cuando aplica) el bid/ask. Sin clave y sin el límite de
   Twelve Data. */
async function refreshYahoo(symbols) {
  const list = symbols.filter((s) => yahooSymbol(s));
  if (!list.length) return;
  await boundedMap(list, 4, async (symbol) => {
    const ticker = yahooSymbol(symbol);
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
    const data = await fetchJson(url);
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    const meta = result && result.meta;
    if (!meta) return;
    setQuote(symbol, meta.bid, meta.ask, 'Yahoo Finance',
      meta.regularMarketPrice != null ? meta.regularMarketPrice : meta.previousClose);
  });
}

async function refreshTwelve(symbols) {
  if (!USE_TWELVE || !symbols.length) return;
  const reverse = new Map();
  symbols.forEach((s) => {
    const provider = providerFor(s);
    if (provider.twelve) reverse.set(provider.twelve, s);
  });
  const list = Array.from(reverse.keys());
  if (!list.length) return;

  const url = `${TWELVE_BASE}/quote?symbol=${encodeURIComponent(list.join(','))}&apikey=${encodeURIComponent(TWELVE_KEY)}`;
  const data = await withTwelveGate(() => fetchJson(url));

  let entries;
  if (data && data.symbol) entries = { [data.symbol]: data };
  else if (data && typeof data === 'object') entries = data;
  else return;

  if (entries.code && entries.status === 'error' && !entries.symbol) {
    if (entries.code === 429) twelveBackoff(429);
    else lastError = `Twelve Data ${entries.code}: ${entries.message || ''}`;
    return;
  }

  Object.keys(entries).forEach((key) => {
    if (key === 'code' || key === 'status' || key === 'message') return;
    const row = entries[key];
    const symbol = reverse.get(key);
    if (!symbol || !row || typeof row !== 'object') return;
    if (row.status === 'error' || row.code) {
      if (row.code === 429) twelveBackoff(429);
      else lastError = `Twelve Data ${row.code}: ${row.message || ''}`;
      return;
    }
    const close = num(row.close != null ? row.close : row.price);
    setQuote(symbol, row.bid != null ? row.bid : close, row.ask != null ? row.ask : close, 'Twelve Data');
  });
}

async function refresh(symbols) {
  if (!symbols.length) return;
  const crypto = symbols.filter((s) => CRYPTO.has(s));
  const rest = symbols.filter((s) => !CRYPTO.has(s));
  const jobs = [];
  if (crypto.length) {
    jobs.push(refreshBinance(crypto).catch(() => refreshYahoo(crypto).catch(() => {})));
  }
  if (rest.length) {
    jobs.push(refreshYahoo(rest).catch((err) => {
      lastError = `Yahoo Finance: ${err && err.message ? err.message : err}`;
    }));
  }
  await Promise.all(jobs);

  /* Respaldo opcional: si hay clave de Twelve, se consulta lo que Yahoo no dio. */
  if (USE_TWELVE) {
    const missing = symbols.filter((s) => !quoteCache.has(s));
    if (missing.length) await refreshTwelve(missing).catch(() => {});
  }
}

/* Cotizaciones de una lista de símbolos. Devuelve un mapa símbolo -> cotización.
   Un símbolo sin cotización no aparece en el mapa (equivale a «sin precio»). */
async function getQuotes(entries) {
  const symbols = Array.from(new Set(entries.map((e) => String(e.symbol || '').toUpperCase()).filter(Boolean)));
  const now = Date.now();
  const stale = symbols.filter((s) => !quoteCache.has(s) || now - quoteCache.get(s).ts > ttlFor(s));
  if (stale.length) {
    try {
      await refresh(stale);
    } catch (err) {
      lastError = String((err && err.message) || err);
    }
  }
  const out = {};
  symbols.forEach((s) => {
    const quote = quoteCache.get(s);
    if (!quote) return;
    const age = now - quote.ts;
    const ttl = ttlFor(s);
    out[s] = {
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      source: quote.source,
      ts: new Date(quote.ts).toISOString(),
      status: age <= ttl ? 'live' : age <= STALE_TTL_MS ? 'cached' : 'stale',
    };
  });
  return out;
}

/* ------------------------------- Velas (OHLC) ------------------------------- */
/* Las apps no llaman al proveedor por su cuenta: piden las velas al robot, que
   las cachea. Así todas ven las mismas velas y no se agota ninguna cuota. */
const YAHOO_IV = { M1: '1m', M5: '5m', M15: '15m', M30: '30m', H1: '1h', H4: '1h', D1: '1d', W1: '1wk', MN1: '1mo' };
const YAHOO_RANGE = { M1: '5d', M5: '1mo', M15: '1mo', M30: '1mo', H1: '6mo', H4: '1y', D1: '5y', W1: '10y', MN1: '5y' };

function normTf(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
  const map = {
    '1M': 'M1', 'M1': 'M1', '1MIN': 'M1', '1': 'M1',
    '5M': 'M5', 'M5': 'M5', '5': 'M5',
    '15M': 'M15', 'M15': 'M15', '15': 'M15',
    '30M': 'M30', 'M30': 'M30', '30': 'M30',
    '1H': 'H1', 'H1': 'H1', '60': 'H1',
    '4H': 'H4', 'H4': 'H4', '240': 'H4',
    '1D': 'D1', 'D1': 'D1', '1DAY': 'D1', '1440': 'D1',
    '1W': 'W1', 'W1': 'W1', '1WK': 'W1', 'WEEK': 'W1',
    '1MO': 'MN1', 'MN1': 'MN1', 'MONTH': 'MN1',
  };
  return map[s] || 'H1';
}

function aggregate(candles, group) {
  if (group <= 1) return candles;
  const out = [];
  for (let i = 0; i < candles.length; i += group) {
    const chunk = candles.slice(i, i + group).filter(Boolean);
    if (!chunk.length) continue;
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max.apply(null, chunk.map((c) => c.h)),
      l: Math.min.apply(null, chunk.map((c) => c.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((s, c) => s + (c.v || 0), 0),
    });
  }
  return out;
}

async function fetchYahooChart(ticker, interval, range) {
  const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
  const data = await fetchJson(url);
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !Array.isArray(result.timestamp) || !result.indicators) return null;
  const q = (result.indicators.quote && result.indicators.quote[0]) || {};
  const closes = q.close || [];
  const out = [];
  for (let i = 0; i < result.timestamp.length; i += 1) {
    const c = num(closes[i]);
    if (c == null) continue;
    const o = num(q.open ? q.open[i] : null);
    const h = num(q.high ? q.high[i] : null);
    const l = num(q.low ? q.low[i] : null);
    out.push({
      t: result.timestamp[i] * 1000,
      o: o != null ? o : c,
      h: h != null ? h : Math.max(o != null ? o : c, c),
      l: l != null ? l : Math.min(o != null ? o : c, c),
      c,
      v: num(q.volume ? q.volume[i] : null) || 0,
    });
  }
  return { meta: result.meta || {}, candles: out };
}

/* Velas normalizadas del símbolo e intervalo pedidos, o `null` si no hay.
   { symbol, interval, candles:[{t,o,h,l,c,v}], source, price, generatedAt } */
async function getCandles(symbol, interval, outputsize) {
  const s = String(symbol || '').toUpperCase();
  if (!s) return null;
  const tf = normTf(interval);
  const n = Math.max(2, Math.min(int(outputsize, 500) || 500, 5000));
  const key = `${s}|${tf}|${n}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.ts < CANDLE_TTL_MS) return hit.data;

  const ticker = yahooSymbol(s);
  const res = await fetchYahooChart(ticker, YAHOO_IV[tf] || '1h', YAHOO_RANGE[tf] || '6mo');
  if (!res || res.candles.length < 2) return null;

  let candles = tf === 'H4' ? aggregate(res.candles, 4) : res.candles;
  candles = candles.slice(-n);

  const price = num(res.meta.regularMarketPrice);
  if (price != null) setQuote(s, res.meta.bid, res.meta.ask, 'Yahoo Finance', price);

  const out = {
    symbol: s,
    interval: tf,
    candles,
    source: 'Yahoo Finance',
    currency: res.meta.currency || null,
    price,
    generatedAt: new Date().toISOString(),
  };
  candleCache.set(key, { ts: Date.now(), data: out });
  return out;
}

async function loadRates() {
  if (Date.now() - ratesCache.ts < RATES_TTL_MS && Object.keys(ratesCache.rates).length) return ratesCache.rates;
  if (ratesInFlight) return ratesInFlight;
  ratesInFlight = fetchJson(`${FRANKFURTER_BASE}/latest?from=EUR`)
    .then((data) => {
      if (data && data.rates) {
        ratesCache = { ts: Date.now(), rates: Object.assign({ EUR: 1 }, data.rates) };
      }
      return ratesCache.rates;
    })
    .catch(() => ratesCache.rates)
    .finally(() => { ratesInFlight = null; });
  return ratesInFlight;
}

/* Factor de conversión síncrono una vez cargados los tipos. Usa el tipo en vivo
   (Frankfurter, base EUR) y, si falta, la tabla de respaldo. */
function factor(fromCcy, toCcy) {
  const from = String(fromCcy || '').toUpperCase();
  const to = String(toCcy || '').toUpperCase();
  if (!from || !to) return 1;
  if (from === to) return 1;
  const rates = ratesCache.rates || {};
  if (rates[from] && rates[to]) return rates[to] / rates[from];
  const fbFrom = FX_FALLBACK[from];
  const fbTo = FX_FALLBACK[to];
  if (fbFrom && fbTo) return fbFrom / fbTo;
  return null;
}

async function ensureRates() {
  await loadRates();
}

function convert(amount, fromCcy, toCcy) {
  const f = factor(fromCcy, toCcy);
  if (f == null) return null;
  return (Number(amount) || 0) * f;
}

function diagnostics() {
  return {
    provider: USE_TWELVE ? 'Yahoo Finance + Twelve Data (clave)' : 'Yahoo Finance',
    twelveKey: Boolean(TWELVE_KEY),
    quotes: quoteCache.size,
    candles: candleCache.size,
    ratesAsOf: ratesCache.ts ? new Date(ratesCache.ts).toISOString() : null,
    lastError,
  };
}

module.exports = {
  getQuotes,
  getCandles,
  ensureRates,
  convert,
  factor,
  providerFor,
  yahooSymbol,
  diagnostics,
};
