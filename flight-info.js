// Shared flight-detail helpers, used by both the dashboard (window.FlightInfo)
// and the scanner / Telegram messages (require('../flight-info')).
// No dependencies, no network.
(function (root) {
  'use strict';

  // Official websites of airlines that commonly fly TLV <-> Europe.
  // Homepages only: airlines don't offer stable public deep-link formats, and a broken
  // deep link is worse than one extra search on the airline's own site.
  const AIRLINES = {
    W6: { name: 'Wizz Air', url: 'https://wizzair.com/' },
    W4: { name: 'Wizz Air Malta', url: 'https://wizzair.com/' },
    W9: { name: 'Wizz Air UK', url: 'https://wizzair.com/' },
    '5W': { name: 'Wizz Air Abu Dhabi', url: 'https://wizzair.com/' },
    FR: { name: 'Ryanair', url: 'https://www.ryanair.com/' },
    RK: { name: 'Ryanair UK', url: 'https://www.ryanair.com/' },
    AL: { name: 'Malta Air (Ryanair)', url: 'https://www.ryanair.com/' },
    U2: { name: 'easyJet', url: 'https://www.easyjet.com/' },
    EC: { name: 'easyJet Europe', url: 'https://www.easyjet.com/' },
    DS: { name: 'easyJet Switzerland', url: 'https://www.easyjet.com/' },
    LY: { name: 'אל על', url: 'https://www.elal.com/' },
    '6H': { name: 'ישראייר', url: 'https://www.israir.co.il/' },
    IZ: { name: 'ארקיע', url: 'https://www.arkia.co.il/' },
    A3: { name: 'Aegean', url: 'https://en.aegeanair.com/' },
    OA: { name: 'Olympic Air', url: 'https://www.olympicair.com/' },
    GQ: { name: 'Sky Express', url: 'https://www.skyexpress.gr/' },
    BZ: { name: 'Blue Bird Airways', url: 'https://www.bluebirdair.com/' },
    QS: { name: 'Smartwings', url: 'https://www.smartwings.com/' },
    OK: { name: 'Czech Airlines', url: 'https://www.smartwings.com/' },
    LH: { name: 'Lufthansa', url: 'https://www.lufthansa.com/' },
    LX: { name: 'SWISS', url: 'https://www.swiss.com/' },
    OS: { name: 'Austrian', url: 'https://www.austrian.com/' },
    SN: { name: 'Brussels Airlines', url: 'https://www.brusselsairlines.com/' },
    EW: { name: 'Eurowings', url: 'https://www.eurowings.com/' },
    AZ: { name: 'ITA Airways', url: 'https://www.ita-airways.com/' },
    AF: { name: 'Air France', url: 'https://wwws.airfrance.co.il/' },
    KL: { name: 'KLM', url: 'https://www.klm.co.il/' },
    HV: { name: 'Transavia', url: 'https://www.transavia.com/' },
    TO: { name: 'Transavia France', url: 'https://www.transavia.com/' },
    BA: { name: 'British Airways', url: 'https://www.britishairways.com/' },
    IB: { name: 'Iberia', url: 'https://www.iberia.com/' },
    VY: { name: 'Vueling', url: 'https://www.vueling.com/' },
    UX: { name: 'Air Europa', url: 'https://www.aireuropa.com/' },
    TP: { name: 'TAP Air Portugal', url: 'https://www.flytap.com/' },
    LO: { name: 'LOT', url: 'https://www.lot.com/' },
    TK: { name: 'Turkish Airlines', url: 'https://www.turkishairlines.com/' },
    PC: { name: 'Pegasus', url: 'https://www.flypgs.com/' },
    AY: { name: 'Finnair', url: 'https://www.finnair.com/' },
    SK: { name: 'SAS', url: 'https://www.flysas.com/' },
    DY: { name: 'Norwegian', url: 'https://www.norwegian.com/' },
    D8: { name: 'Norwegian', url: 'https://www.norwegian.com/' },
    BT: { name: 'airBaltic', url: 'https://www.airbaltic.com/' },
    OU: { name: 'Croatia Airlines', url: 'https://www.croatiaairlines.com/' },
    JU: { name: 'Air Serbia', url: 'https://www.airserbia.com/' },
    FB: { name: 'Bulgaria Air', url: 'https://www.air.bg/' },
    RO: { name: 'TAROM', url: 'https://www.tarom.ro/' },
    CY: { name: 'Cyprus Airways', url: 'https://www.cyprusairways.com/' },
    V7: { name: 'Volotea', url: 'https://www.volotea.com/' },
    LS: { name: 'Jet2', url: 'https://www.jet2.com/' },
    EI: { name: 'Aer Lingus', url: 'https://www.aerlingus.com/' },
    H4: { name: 'HiSky', url: 'https://hisky.aero/' },
    '0B': { name: 'Blue Air', url: 'https://www.flyblue.com/' },
  };

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

  const api = { AIRLINES, airlineInfo, parseFoundAt, ageHours, ageText, isStale, STALE_HOURS, stopsText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlightInfo = api;
})(typeof window !== 'undefined' ? window : this);
