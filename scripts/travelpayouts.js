// Travelpayouts / Aviasales Data API client
// Free self-serve signup: https://www.travelpayouts.com
// Token: https://app.travelpayouts.com/profile/api-token
// Docs: https://travelpayouts.github.io/slate/#about-api

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

// The week-matrix cache sometimes pairs a depart_date from one cached search
// with a return_date from an unrelated one, producing nonsensical "trips"
// (e.g. returning before departing, or a 90-day trip when 7 was requested).
// We only trust entries whose actual trip length is close to what was asked for.
function pickBest(entries, { exactDepartDate, exactReturnDate, flexible, flexDays }) {
  if (!entries || entries.length === 0) return null;

  const intendedDuration = daysBetween(exactDepartDate, exactReturnDate);
  const tolerance = flexible ? flexDays + 1 : 1;

  const sane = entries.filter((e) => {
    if (!e.depart_date || !e.return_date) return false;
    const duration = daysBetween(e.depart_date, e.return_date);
    return duration > 0 && Math.abs(duration - intendedDuration) <= tolerance;
  });
  if (sane.length === 0) return null; // cache had nothing trustworthy for this route

  const candidates = flexible ? sane : sane.filter((e) => e.depart_date === exactDepartDate);
  const pool = candidates.length > 0 ? candidates : sane; // fallback within the sane set only

  let best = null;
  for (const e of pool) {
    if (!best || e.value < best.value) best = e;
  }
  if (!best) return null;
  return { departDate: best.depart_date, returnDate: best.return_date, price: best.value };
}

async function cheapestRoundTrip({ origin, destination, departureDate, returnDate, flexible, flexDays, currency }) {
  const entries = await weekMatrix({ origin, destination, departDate: departureDate, returnDate, currency });
  return pickBest(entries, { exactDepartDate: departureDate, exactReturnDate: returnDate, flexible, flexDays });
}

// One-way fare for a single date (or nearby, when flexible) using the
// dedicated one-way endpoint - week-matrix always returns round-trip totals
// and can't be reused for accurate one-way pricing.
async function cheapestOneWay({ origin, destination, departureDate, flexible, flexDays, currency }) {
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
    if (!best) return null;
    return { departDate: best.departure_at.slice(0, 10), returnDate: null, price: best.price };
  } catch (err) {
    console.log(`  cheapestOneWay ${origin}->${destination}: ${err.message}`);
    return null;
  }
}

// Hotellook (also a Travelpayouts product, same API token).
// IMPORTANT: your Travelpayouts account must be separately joined to the
// Hotellook partner program (not just Aviasales) or this silently returns
// nothing. Join at: https://www.travelpayouts.com/programs -> Hotellook.
async function fetchHotelCache(location, { checkIn, checkOut, adults, currency }) {
  const url = new URL("https://engine.hotellook.com/api/v2/cache.json");
  url.searchParams.set("location", location);
  url.searchParams.set("checkIn", checkIn);
  url.searchParams.set("checkOut", checkOut);
  url.searchParams.set("currency", currency);
  url.searchParams.set("adults", adults);
  url.searchParams.set("limit", 5);
  url.searchParams.set("token", getToken());

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.log(`HOTEL-DEBUG: network error calling hotellook for "${location}": ${err.message}`);
    return [];
  }

  const bodyText = await res.text();
  if (!res.ok) {
    console.log(`HOTEL-DEBUG: hotellook cache.json (${location}) HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    return [];
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    console.log(`HOTEL-DEBUG: hotellook cache.json (${location}) returned non-JSON: ${bodyText.slice(0, 200)}`);
    return [];
  }
  if (!Array.isArray(data)) {
    console.log(`HOTEL-DEBUG: hotellook cache.json (${location}) unexpected shape: ${bodyText.slice(0, 200)}`);
    return [];
  }
  console.log(`HOTEL-DEBUG: hotellook cache.json (${location}) returned ${data.length} hotel(s)`);
  return data;
}

async function resolveHotelLocationName(query) {
  try {
    const url = new URL("https://engine.hotellook.com/api/v2/lookup.json");
    url.searchParams.set("query", query);
    url.searchParams.set("lang", "en");
    url.searchParams.set("lookFor", "city");
    url.searchParams.set("limit", 1);
    url.searchParams.set("token", getToken());
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`HOTEL-DEBUG: lookup.json for "${query}" HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const loc = data?.results?.locations?.[0];
    console.log(`HOTEL-DEBUG: lookup.json for "${query}" resolved to: ${loc ? (loc.fullName || loc.name) : "nothing"}`);
    return loc ? loc.fullName || loc.name : null;
  } catch (err) {
    console.log(`HOTEL-DEBUG: lookup.json network error for "${query}": ${err.message}`);
    return null;
  }
}

async function cheapestHotel({ cityCode, cityName, checkIn, checkOut, adults, currency }) {
  let data = await fetchHotelCache(cityCode, { checkIn, checkOut, adults, currency });

  if (data.length === 0 && cityName) {
    const resolved = await resolveHotelLocationName(cityName);
    if (resolved && resolved !== cityCode) {
      console.log(`HOTEL-DEBUG: retrying with resolved name "${resolved}" instead of "${cityCode}"`);
      data = await fetchHotelCache(resolved, { checkIn, checkOut, adults, currency });
    }
  }

  if (data.length === 0) {
    console.log(`HOTEL-DEBUG: no hotel prices found for ${cityCode}${cityName ? " (" + cityName + ")" : ""}`);
    return null;
  }

  let cheapest = null;
  for (const h of data) {
    const price = h.priceFrom || h.price;
    if (price && (!cheapest || price < cheapest.price)) {
      cheapest = { price, currency, hotelName: h.hotelName || h.name };
    }
  }
  return cheapest;
}

module.exports = { cheapestRoundTrip, cheapestOneWay, cheapestHotel };
