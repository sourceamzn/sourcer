"use strict";
/* Calendario de envios del Plan de contacto:
   - dias LABORABLES (sin fines de semana ni festivos nacionales del pais),
   - solo martes a jueves, entre las 9:00 y las 11:00 en la hora del destinatario,
   - si el dia que toca cae en festivo o fuera de martes-jueves, el siguiente valido.
   Todo puro y sin dependencias (zonas horarias con Intl). */

/* Pais e idioma a partir del dominio del proveedor (y del lang de su web). */
const TLD = {
  es: ["ES", "es", "Europe/Madrid"], pt: ["PT", "pt", "Europe/Lisbon"], fr: ["FR", "fr", "Europe/Paris"],
  de: ["DE", "de", "Europe/Berlin"], it: ["IT", "it", "Europe/Rome"], nl: ["NL", "nl", "Europe/Amsterdam"],
  be: ["BE", "fr", "Europe/Brussels"], uk: ["GB", "en", "Europe/London"], ie: ["IE", "en", "Europe/Dublin"],
  pl: ["PL", "pl", "Europe/Warsaw"], at: ["AT", "de", "Europe/Vienna"], ch: ["CH", "de", "Europe/Zurich"],
  se: ["SE", "sv", "Europe/Stockholm"], dk: ["DK", "da", "Europe/Copenhagen"], cz: ["CZ", "cs", "Europe/Prague"],
  fi: ["FI", "fi", "Europe/Helsinki"], no: ["NO", "no", "Europe/Oslo"], gr: ["GR", "el", "Europe/Athens"],
  ro: ["RO", "ro", "Europe/Bucharest"], hu: ["HU", "hu", "Europe/Budapest"], cat: ["ES", "es", "Europe/Madrid"],
  eus: ["ES", "es", "Europe/Madrid"], gal: ["ES", "es", "Europe/Madrid"], us: ["US", "en", "America/New_York"]
};
const LANG_TZ = { es: "Europe/Madrid", pt: "Europe/Lisbon", fr: "Europe/Paris", de: "Europe/Berlin", it: "Europe/Rome", nl: "Europe/Amsterdam", en: "Europe/London", pl: "Europe/Warsaw" };
const LANG_COUNTRY = { es: "ES", pt: "PT", fr: "FR", de: "DE", it: "IT", nl: "NL", en: "GB", pl: "PL" };

function localeOf(host, pageLang) {
  const h = String(host || "").toLowerCase();
  let tld = h.split(".").pop();
  if (/\.co\.uk$/.test(h)) tld = "uk";
  const pl = String(pageLang || "").toLowerCase().slice(0, 2);
  if (TLD[tld]) return { country: TLD[tld][0], lang: TLD[tld][1], tz: TLD[tld][2], source: "dominio" };
  if (pl && LANG_TZ[pl]) return { country: LANG_COUNTRY[pl], lang: pl, tz: LANG_TZ[pl], source: "web" };
  return { country: "ES", lang: "es", tz: "Europe/Madrid", source: "por_defecto" };
}

/* Pascua (algoritmo anonimo gregoriano) para Viernes Santo. */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDaysYmd(s, n) { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
/* Festivos nacionales (los autonomicos/locales no se pueden saber por dominio). */
function holidays(country, y) {
  const fixed = {
    ES: ["01-01", "01-06", "05-01", "08-15", "10-12", "11-01", "12-06", "12-08", "12-25"],
    PT: ["01-01", "04-25", "05-01", "06-10", "08-15", "10-05", "11-01", "12-01", "12-08", "12-25"],
    FR: ["01-01", "05-01", "05-08", "07-14", "08-15", "11-01", "11-11", "12-25"],
    DE: ["01-01", "05-01", "10-03", "12-25", "12-26"],
    IT: ["01-01", "01-06", "04-25", "05-01", "06-02", "08-15", "11-01", "12-08", "12-25", "12-26"],
    GB: ["01-01", "12-25", "12-26"], NL: ["01-01", "04-27", "12-25", "12-26"]
  }[country] || ["01-01", "12-25"];
  const out = fixed.map(function (md) { return y + "-" + md; });
  const e = easter(y);
  const gf = new Date(e); gf.setUTCDate(gf.getUTCDate() - 2); out.push(ymd(gf));                 /* Viernes Santo */
  if (["FR", "DE", "IT", "NL", "GB", "PT"].indexOf(country) !== -1) { const em = new Date(e); em.setUTCDate(em.getUTCDate() + 1); out.push(ymd(em)); } /* Lunes de Pascua */
  return out;
}
function weekday(s) { const w = new Date(s + "T12:00:00Z").getUTCDay(); return w === 0 ? 7 : w; }
function isWorking(s, country) {
  const w = weekday(s);
  if (w >= 6) return false;
  return holidays(country, Number(s.slice(0, 4))).indexOf(s) === -1;
}
function addWorkingDays(s, n, country) {
  let d = s, left = n;
  while (left > 0) { d = addDaysYmd(d, 1); if (isWorking(d, country)) left--; }
  return d;
}
function range(spec, def) {
  const m = String(spec || def).match(/^(\d+)\s*-\s*(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : def.split("-").map(Number);
}
function allowedDay(s, country, weekdays) {
  const w = range(weekdays, "2-4"), wd = weekday(s);
  return isWorking(s, country) && wd >= w[0] && wd <= w[1];
}
/* Fecha local (yyyy-mm-dd) y hora local en una zona -> instante UTC. */
function localParts(d, tz) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = {};
  f.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  return { ymd: p.year + "-" + p.month + "-" + p.day, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
function zoned(s, hour, minute, tz) {
  const target = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)), hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const lp = localParts(new Date(guess), tz);
    const asUtc = Date.UTC(Number(lp.ymd.slice(0, 4)), Number(lp.ymd.slice(5, 7)) - 1, Number(lp.ymd.slice(8, 10)), lp.hour, lp.minute);
    guess += target - asUtc;
  }
  return new Date(guess);
}
/* Instante aleatorio dentro de la ventana de un dia valido a partir de `fromYmd`.
   Si `notBefore` cae dentro de la ventana de ese dia, se respeta. */
function slotOn(fromYmd, loc, opts, rnd, notBefore) {
  opts = opts || {}; rnd = rnd || Math.random;
  const h = range(opts.hours, "9-11");
  let d = fromYmd;
  for (let i = 0; i < 40; i++) {
    if (allowedDay(d, loc.country, opts.weekdays)) {
      const start = zoned(d, h[0], 0, loc.tz).getTime(), end = zoned(d, h[1], 0, loc.tz).getTime() - 5 * 60000;
      const from = notBefore ? Math.max(start, notBefore.getTime()) : start;
      if (from < end) return new Date(from + Math.floor(rnd() * Math.max(1, end - from)));
    }
    d = addDaysYmd(d, 1);
  }
  return null;
}
/* Momento del envio numero k (0 = correo 1) de una secuencia que empezo el dia `day0`. */
function dueAt(day0, offset, loc, opts, rnd) {
  const target = offset > 0 ? addWorkingDays(day0, offset, loc.country) : day0;
  return slotOn(target, loc, opts, rnd, null);
}
function todayIn(tz) { return localParts(new Date(), tz).ymd; }

module.exports = { localeOf, holidays, isWorking, addWorkingDays, allowedDay, zoned, slotOn, dueAt, localParts, todayIn, addDaysYmd, weekday };
