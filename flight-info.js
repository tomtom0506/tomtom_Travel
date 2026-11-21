// Shared flight-detail helpers, used by both the dashboard (window.FlightInfo)
// and the scanner / Telegram messages (require('../flight-info')).
// No dependencies, no network.
(function (root) {
  'use strict';

  // Airline display names (IATA code -> name). Hebrew for Israeli carriers.
  const AIRLINES = {
    W6: { name: 'Wizz Air' },
    W4: { name: 'Wizz Air Malta' },
    W9: { name: 'Wizz Air UK' },
    '5W': { name: 'Wizz Air Abu Dhabi' },
    FR: { name: 'Ryanair' },
    RK: { name: 'Ryanair UK' },
    AL: { name: 'Malta Air (Ryanair)' },
    U2: { name: 'easyJet' },
    EC: { name: 'easyJet Europe' },
    DS: { name: 'easyJet Switzerland' },
    LY: { name: 'אל על' },
    '6H': { name: 'ישראייר' },
    IZ: { name: 'ארקיע' },
    A3: { name: 'Aegean' },
    OA: { name: 'Olympic Air' },
    GQ: { name: 'Sky Express' },
    BZ: { name: 'Blue Bird Airways' },
    QS: { name: 'Smartwings' },
    OK: { name: 'Czech Airlines' },
    LH: { name: 'Lufthansa' },
    LX: { name: 'SWISS' },
    OS: { name: 'Austrian' },
    SN: { name: 'Brussels Airlines' },
    EW: { name: 'Eurowings' },
    AZ: { name: 'ITA Airways' },
    AF: { name: 'Air France' },
    KL: { name: 'KLM' },
    HV: { name: 'Transavia' },
    TO: { name: 'Transavia France' },
    BA: { name: 'British Airways' },
    IB: { name: 'Iberia' },
    VY: { name: 'Vueling' },
    UX: { name: 'Air Europa' },
    TP: { name: 'TAP Air Portugal' },
    LO: { name: 'LOT' },
    TK: { name: 'Turkish Airlines' },
    PC: { name: 'Pegasus' },
    AY: { name: 'Finnair' },
    SK: { name: 'SAS' },
    DY: { name: 'Norwegian' },
    D8: { name: 'Norwegian' },
    BT: { name: 'airBaltic' },
    OU: { name: 'Croatia Airlines' },
    JU: { name: 'Air Serbia' },
    FB: { name: 'Bulgaria Air' },
    RO: { name: 'TAROM' },
    CY: { name: 'Cyprus Airways' },
    V7: { name: 'Volotea' },
    LS: { name: 'Jet2' },
    EI: { name: 'Aer Lingus' },
    H4: { name: 'HiSky' },
    '0B': { name: 'Blue Air' },
  };

  const WIZZ = new Set(['W6', 'W4', 'W9', '5W']);

  // ---- booking links ----
  // Both formats were checked by hand from an Israeli phone (21.11.2026): they open
  // the exact route + dates, and aviasales.com is NOT redirected to .ru anymore.

  function ddmm(iso) {
    const [, m, d] = String(iso).split('-');
    return d + m;
  }

  // Aviasales search page for the route/dates - the same source our prices come from.
  // `path` is the ticket link the API returns ("/search/TLV2112SOF28121?t=..."), which
  // also highlights that exact ticket; otherwise the plain search URL is built.
  function aviasalesLink({ origin, destination, departDate, returnDate, path }) {
    if (path && /^\/search\/[A-Z]{3}\d{4}[A-Z]{3}/.test(path)) return 'https://www.aviasales.com' + path;
    if (!origin || !destination || !departDate) return null;
    return 'https://www.aviasales.com/search/' + origin + ddmm(departDate) + destination + (returnDate ? ddmm(returnDate) : '') + '1';
  }

  // Airline's own booking page with the flight already selected (route + dates).
  // Only airlines whose format was verified: Wizz Air.
  function airlineBookingLink({ airline, origin, destination, departDate, returnDate }) {
    if (!airline || !WIZZ.has(String(airline).toUpperCase())) return null;
    if (!/^[A-Z]{3}$/.test(origin || '') || !/^[A-Z]{3}$/.test(destination || '') || !departDate) return null;
    return 'https://wizzair.com/he-il/booking/select-flight/' + origin + '/' + destination + '/' + departDate + '/' + (returnDate || 'null') + '/1/0/0/null';
  }

  function airlineInfo(code) {
    if (!code) return null;
    return AIRLINES[String(code).toUpperCase()] || null;
  }

  // "found_at" from the Data API has no timezone ("2026-11-18T07:43:43") and is UTC.
  function parseFoundAt(foundAt) {
    if (!foundAt) return null;
    let s = String(foundAt).trim().replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
    const t = Date.parse(s);
    return isFinite(t) ? t : null;
  }

  function ageHours(foundAt, now) {
    const t = parseFoundAt(foundAt);
    if (t == null) return null;
    return Math.max(0, ((now == null ? Date.now() : now) - t) / 3600000);
  }

  // Human Hebrew age of a cached price: "לפני 5 שעות", "אתמול", "לפני 3 ימים".
  function ageText(foundAt, now) {
    const h = ageHours(foundAt, now);
    if (h == null) return null;
    if (h < 1) return 'לפני פחות משעה';
    if (h < 24) { const n = Math.floor(h); return n === 1 ? 'לפני שעה' : 'לפני ' + n + ' שעות'; }
    const d = Math.floor(h / 24);
    if (d === 1) return 'אתמול';
    if (d === 2) return 'לפני יומיים';
    return 'לפני ' + d + ' ימים';
  }

  // Older than this, the cached price is likely to have changed - the UI flags it.
  const STALE_HOURS = 72;
  function isStale(foundAt, now) {
    const h = ageHours(foundAt, now);
    return h != null && h > STALE_HOURS;
  }

  function stopsText(transfers) {
    if (typeof transfers !== 'number' || !isFinite(transfers)) return null;
    if (transfers === 0) return 'ישירה';
    if (transfers === 1) return 'עצירה אחת';
    return transfers + ' עצירות';
  }

  const api = { AIRLINES, airlineInfo, aviasalesLink, airlineBookingLink, parseFoundAt, ageHours, ageText, isStale, STALE_HOURS, stopsText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlightInfo = api;
})(typeof window !== 'undefined' ? window : this);
