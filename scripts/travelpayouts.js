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

// Aviasales geo-redirects Israeli IPs to aviasales.ru regardless of URL
// format or locale params - this is server-side geo-detection we can't
// override from a link. Google Flights respects browser/account locale
// properly and needs no API key, so we use that as the booking link instead.
function googleFlightsLink({ origin, destination, departDate, returnDate }) {
  const q = returnDate
    ? `Flights from ${origin} to ${destination} on ${departDate} through ${returnDate}`
    : `Flights from ${origin} to ${destination} on ${departDate}`;
  const url = new URL("https://www.google.com/travel/flights");
  url.searchParams.set("q", q);
  url.searchParams.set("hl", "he");
  url.searchParams.set("gl", "IL");
  url.searchParams.set("curr", "ILS");
  return url.toString();
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
  return {
    departDate: best.depart_date,
    returnDate: best.return_date,
    price: best.value,
    airline: best.airline || null,
    transfers: typeof best.transfers === "number" ? best.transfers : null,
    bookingLink: best.link ? `https://www.aviasales.com${best.link}` : null,
  };
}

async function cheapestRoundTrip({ origin, destination, departureDate, returnDate, flexible, flexDays, currency, adults }) {
  const entries = await weekMatrix({ origin, destination, departDate: departureDate, returnDate, currency });
  const best = pickBest(entries, { exactDepartDate: departureDate, exactReturnDate: returnDate, flexible, flexDays });
  if (!best) return null;
  best.bookingLink = googleFlightsLink({
    origin,
    destination,
    departDate: best.departDate,
    returnDate: best.returnDate,
  });
  return best;
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
    if (!best) return null;
    return {
      departDate: best.departure_at.slice(0, 10),
      returnDate: null,
      price: best.price,
      airline: best.airline || null,
      transfers: typeof best.transfers === "number" ? best.transfers : null,
      bookingLink: googleFlightsLink({
        origin,
        destination,
        departDate: best.departure_at.slice(0, 10),
        returnDate: null,
      }),
    };
  } catch (err) {
    console.log(`  cheapestOneWay ${origin}->${destination}: ${err.message}`);
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

module.exports = { cheapestRoundTrip, cheapestOneWay, cheapestHotel, getAirlineName };
