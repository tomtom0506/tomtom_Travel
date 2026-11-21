// Travelpayouts / Aviasales Data API client
// Free self-serve signup: https://www.travelpayouts.com
// Token: https://app.travelpayouts.com/profile/api-token
// Docs: https://travelpayouts.github.io/slate/#about-api

const { aviasalesLink, airlineBookingLink } = require("../flight-info");

const BASE_URL = "https://api.travelpayouts.com";

function getToken() {
  const token = process.env.TRAVELPAYOUTS_TOKEN;
  if (!token) throw new Error("Missing TRAVELPAYOUTS_TOKEN env var");
  return token;
}

async function tpGet(path, params) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  url.searchParams.set("token", getToken());

  const res = await fetch(url, { headers: { "Accept-Encoding": "gzip, deflate" } });
  if (!res.ok) {
    throw new Error(`Travelpayouts GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (data.success === false) {
    throw new Error(`Travelpayouts GET ${path} returned success=false: ${JSON.stringify(data)}`);
  }
  return data;
}

// One call returns a week-wide window of cached round-trip prices
// (3 days before -> 4 days after each given date). Used for both the
// "exact date" and "flexible ± days" modes: for exact mode we look for the
// matching date in the results; for flexible mode we just take the min.
async function weekMatrix({ origin, destination, departDate, returnDate, currency }) {
  try {
    const data = await tpGet("/v2/prices/week-matrix", {
      origin,
      destination,
      depart_date: departDate,
      return_date: returnDate,
      currency,
      show_to_affiliates: true,
    });
    return data.data || [];
  } catch (err) {
    console.log(`  weekMatrix ${origin}->${destination}: ${err.message}`);
    return [];
  }
}

function daysBetween(a, b) {
  const d1 = new Date(a + "T00:00:00Z");
  const d2 = new Date(b + "T00:00:00Z");
  return Math.round((d2 - d1) / 86400000);
}

// ---- normalizing API entries ----
// The two endpoints return different shapes:
//   /v2/prices/week-matrix          -> value, depart_date, return_date, number_of_changes, found_at (no airline)
//   /aviasales/v3/prices_for_dates  -> price, departure_at, return_at, airline, flight_number, transfers
// toOffer() maps both to one shape so selection/enrichment logic doesn't care where a price came from.
function num(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function toOffer(e, source) {
  if (!e) return null;
  const dep = e.departure_at || e.depart_date || null;
  const ret = e.return_at || e.return_date || null;
  const price = num(e.price) != null ? e.price : num(e.value);
  if (!dep || price == null || price <= 0) return null;
  const depStr = String(dep);
  return {
    departDate: depStr.slice(0, 10),
    returnDate: ret ? String(ret).slice(0, 10) : null,
    // departure_at is local airport time with offset ("2026-12-20T06:20:00+02:00") - keep the clock time as shown on the ticket
    departTime: depStr.length >= 16 && depStr[10] === "T" ? depStr.slice(11, 16) : null,
    price,
    airline: e.airline || null,
    flightNumber: e.flight_number != null && e.flight_number !== "" ? String(e.flight_number) : null,
    transfers: num(e.transfers) != null ? e.transfers : num(e.number_of_changes),
    returnTransfers: num(e.return_transfers),
    foundAt: e.found_at || null,
    link: typeof e.link === "string" ? e.link : null, // Aviasales ticket path (v3 only)
    originAirport: e.origin_airport || null,
    destinationAirport: e.destination_airport || null,
    source,
  };
}

// Fill missing details (airline, flight number, found_at...) of the chosen offer from an
// offer for the SAME dates at (almost) the same price from the other endpoint.
const ENRICH_FIELDS = ["airline", "flightNumber", "departTime", "transfers", "returnTransfers", "foundAt", "link", "originAirport", "destinationAirport"];
function enrichOffer(best, offers) {
  if (!best) return best;
  const out = { ...best };
  for (const o of offers) {
    if (!o || o === best) continue;
    if (o.departDate !== best.departDate || o.returnDate !== best.returnDate) continue;
    if (Math.abs(o.price - best.price) > best.price * 0.03) continue;
    for (const f of ENRICH_FIELDS) if (out[f] == null && o[f] != null) out[f] = o[f];
  }
  return out;
}

// Log which fields each endpoint actually returns, once per run, so a real run's
// Actions log shows whether airline / found_at are available (no secrets in it).
const loggedFields = new Set();
function logFieldsOnce(label, entry) {
  if (!entry || loggedFields.has(label)) return;
  loggedFields.add(label);
  console.log(`[api-fields] ${label}: ${Object.keys(entry).sort().join(",")}`);
}

function daysBetween(a, b) {
  const d1 = new Date(a + "T00:00:00Z");
  const d2 = new Date(b + "T00:00:00Z");
  return Math.round((d2 - d1) / 86400000);
}

// The cache sometimes pairs a depart date from one cached search with a return
// date from an unrelated one, producing nonsensical "trips" (e.g. returning before
// departing, or a 90-day trip when 7 was requested). We only trust offers whose
// actual trip length is close to what was asked for.
function pickBest(offers, { exactDepartDate, exactReturnDate, flexible, flexDays }) {
  if (!offers || offers.length === 0) return null;

  const intendedDuration = daysBetween(exactDepartDate, exactReturnDate);
  const tolerance = flexible ? flexDays + 1 : 1;

  const sane = offers.filter((o) => {
    if (!o || !o.departDate || !o.returnDate) return false;
    const duration = daysBetween(o.departDate, o.returnDate);
    if (!(duration > 0 && Math.abs(duration - intendedDuration) <= tolerance)) return false;
    // flexible mode: departure must stay within ±flexDays of the requested date
    if (flexible && Math.abs(daysBetween(exactDepartDate, o.departDate)) > flexDays) return false;
    return true;
  });
  if (sane.length === 0) return null; // cache had nothing trustworthy for this route

  const candidates = flexible ? sane : sane.filter((o) => o.departDate === exactDepartDate);
  const pool = candidates.length > 0 ? candidates : sane; // fallback within the sane set only

  let best = null;
  for (const o of pool) {
    if (!best || o.price < best.price) best = o;
  }
  return best;
}

// Round-trip prices with flight details (airline, flight number, departure time).
async function roundTripForDates({ origin, destination, departDate, returnDate, flexible, currency }) {
  try {
    const data = await tpGet("/aviasales/v3/prices_for_dates", {
      origin,
      destination,
      departure_at: flexible ? departDate.slice(0, 7) : departDate,
      return_at: flexible ? undefined : returnDate,
      one_way: false,
      direct: false,
      sorting: "price",
      limit: 30,
      currency,
    });
    return data.data || [];
  } catch (err) {
    console.log(`  roundTripForDates ${origin}->${destination}: ${err.message}`);
    return [];
  }
}

// Booking links added to every offer the scanner returns:
//   bookingLink - Aviasales page for this route/dates (same price source as ours)
//   airlineLink - the airline's own booking page with the flight preselected (Wizz Air only, verified format)
function withLinks(offer, { origin, destination }) {
  const dates = { departDate: offer.departDate, returnDate: offer.returnDate };
  return {
    ...offer,
    bookingLink: aviasalesLink({ origin, destination, ...dates, path: offer.link }),
    airlineLink: airlineBookingLink({
      airline: offer.airline,
      origin: offer.originAirport || origin,
      destination: offer.destinationAirport || destination,
      ...dates,
    }),
  };
}

async function cheapestRoundTrip({ origin, destination, departureDate, returnDate, flexible, flexDays, currency, adults }) {
  const [wm, v3] = await Promise.all([
    weekMatrix({ origin, destination, departDate: departureDate, returnDate, currency }),
    roundTripForDates({ origin, destination, departDate: departureDate, returnDate, flexible, currency }),
  ]);
  logFieldsOnce("week-matrix", wm[0]);
  logFieldsOnce("prices_for_dates (round-trip)", v3[0]);
  const offers = [...wm.map((e) => toOffer(e, "week-matrix")), ...v3.map((e) => toOffer(e, "prices_for_dates"))].filter(Boolean);
  const best = pickBest(offers, { exactDepartDate: departureDate, exactReturnDate: returnDate, flexible, flexDays });
  if (!best) return null;
  return withLinks(enrichOffer(best, offers), { origin, destination });
}

// One-way fare for a single date (or nearby, when flexible) using the
// dedicated one-way endpoint - week-matrix always returns round-trip totals
// and can't be reused for accurate one-way pricing.
async function cheapestOneWay({ origin, destination, departureDate, flexible, flexDays, currency, adults }) {
  try {
    const departAt = flexible ? departureDate.slice(0, 7) : departureDate; // YYYY-MM lets the API scan the whole month when flexible
    const data = await tpGet("/aviasales/v3/prices_for_dates", {
      origin,
      destination,
      departure_at: departAt,
      one_way: true,
      direct: false,
      sorting: "price",
      limit: flexible ? 30 : 1,
      currency,
    });
    const entries = data.data || [];
    if (entries.length === 0) return null;

    let pool = entries;
    if (flexible) {
      const target = new Date(departureDate + "T00:00:00Z").getTime();
      pool = entries.filter((e) => {
        const d = new Date(e.departure_at).getTime();
        return Math.abs(d - target) / 86400000 <= flexDays;
      });
      if (pool.length === 0) pool = entries; // fall back to cheapest in the month if nothing in range
    }

    let best = null;
    for (const e of pool) {
      if (!best || e.price < best.price) best = e;
    }
    logFieldsOnce("prices_for_dates (one-way)", best);
    const offer = toOffer({ ...best, return_at: null }, "prices_for_dates");
    return offer ? withLinks(offer, { origin, destination }) : null;
  } catch (err) {
    console.log(`  cheapestOneWay ${origin}->${destination}: ${err.message}`);
    return null;
  }
}

// ---- budget alerts: scan a whole month for the single cheapest fare, with no
// specific trip in mind - used to hunt for "anything under $X" deals. ----

async function cheapestOneWayInMonth({ origin, destination, yearMonth, currency }) {
  try {
    const data = await tpGet("/aviasales/v3/prices_for_dates", {
      origin,
      destination,
      departure_at: yearMonth,
      one_way: true,
      direct: false,
      sorting: "price",
      limit: 1,
      currency,
    });
    const best = (data.data || [])[0];
    if (!best) return null;
    const offer = toOffer({ ...best, return_at: null }, "prices_for_dates");
    return offer ? withLinks(offer, { origin, destination }) : null;
  } catch (err) {
    console.log(`  cheapestOneWayInMonth ${origin}->${destination} ${yearMonth}: ${err.message}`);
    return null;
  }
}

async function cheapestRoundTripInMonth({ origin, destination, yearMonth, currency, maxTripNights }) {
  try {
    const data = await tpGet("/aviasales/v3/prices_for_dates", {
      origin,
      destination,
      departure_at: yearMonth,
      one_way: false,
      direct: false,
      sorting: "price",
      limit: 30,
      currency,
    });
    const entries = data.data || [];
    const sane = entries.filter((e) => {
      if (!e.departure_at || !e.return_at) return false;
      const nights = Math.round((new Date(e.return_at) - new Date(e.departure_at)) / 86400000);
      return nights > 0 && nights <= (maxTripNights || 21);
    });
    const pool = sane.length > 0 ? sane : entries.filter((e) => e.return_at);
    let best = null;
    for (const e of pool) {
      if (!best || e.price < best.price) best = e;
    }
    if (!best) return null;
    const offer = toOffer(best, "prices_for_dates");
    return offer ? withLinks(offer, { origin, destination }) : null;
  } catch (err) {
    console.log(`  cheapestRoundTripInMonth ${origin}->${destination} ${yearMonth}: ${err.message}`);
    return null;
  }
}

// Hotellook shut down completely in October 2025 (confirmed: the whole
// engine.hotellook.com API now returns 404). There is no equivalent free
// hotel-price API to replace it with, so instead of a price we generate a
// direct Booking.com search link, pre-filled with the destination and exact
// dates - one tap shows real live prices there.
function bookingComLink({ cityName, checkIn, checkOut, adults }) {
  const url = new URL("https://www.booking.com/searchresults.html");
  url.searchParams.set("ss", cityName);
  url.searchParams.set("checkin", checkIn);
  url.searchParams.set("checkout", checkOut);
  url.searchParams.set("group_adults", adults || 2);
  url.searchParams.set("no_rooms", 1);
  return url.toString();
}

async function cheapestHotel({ cityCode, cityName, checkIn, checkOut, adults, currency }) {
  return {
    price: null,
    currency,
    hotelName: null,
    bookingUrl: bookingComLink({ cityName: cityName || cityCode, checkIn, checkOut, adults }),
  };
}

let airlinesCache = null;
async function getAirlineName(code) {
  if (!code) return null;
  if (!airlinesCache) {
    try {
      const res = await fetch("https://api.travelpayouts.com/data/en/airlines.json");
      const list = await res.json();
      airlinesCache = {};
      for (const a of list) airlinesCache[a.code] = a.name;
    } catch {
      airlinesCache = {};
    }
  }
  return airlinesCache[code] || code;
}

module.exports = {
  // exported for tests
  _internal: { toOffer, enrichOffer, pickBest },
  cheapestRoundTrip,
  cheapestOneWay,
  cheapestOneWayInMonth,
  cheapestRoundTripInMonth,
  cheapestHotel,
  getAirlineName,
};
