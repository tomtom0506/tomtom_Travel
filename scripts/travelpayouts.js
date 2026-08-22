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
    console.warn(`  weekMatrix ${origin}->${destination}: ${err.message}`);
    return [];
  }
}

function pickBest(entries, { exactDepartDate, flexible }) {
  if (!entries || entries.length === 0) return null;
  const candidates = flexible
    ? entries
    : entries.filter((e) => e.depart_date === exactDepartDate);
  const pool = candidates.length > 0 ? candidates : entries; // fallback if exact date missing from cache
  let best = null;
  for (const e of pool) {
    if (!best || e.value < best.value) best = e;
  }
  if (!best) return null;
  return { departDate: best.depart_date, returnDate: best.return_date, price: best.value };
}

async function cheapestRoundTrip({ origin, destination, departureDate, returnDate, flexible, currency }) {
  const entries = await weekMatrix({ origin, destination, departDate: departureDate, returnDate, currency });
  return pickBest(entries, { exactDepartDate: departureDate, flexible });
}

// Hotellook (also a Travelpayouts product, same API token) - best-effort.
// If your account isn't yet linked to the Hotellook program this may return
// empty results; the flight alerts are the core feature and work regardless.
async function cheapestHotel({ cityCode, checkIn, checkOut, adults, currency }) {
  try {
    const url = new URL("https://engine.hotellook.com/api/v2/cache.json");
    url.searchParams.set("location", cityCode);
    url.searchParams.set("checkIn", checkIn);
    url.searchParams.set("checkOut", checkOut);
    url.searchParams.set("currency", currency);
    url.searchParams.set("adults", adults);
    url.searchParams.set("limit", 5);
    url.searchParams.set("token", getToken());

    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    let cheapest = null;
    for (const h of data) {
      const price = h.priceFrom || h.price;
      if (price && (!cheapest || price < cheapest.price)) {
        cheapest = { price, currency, hotelName: h.hotelName || h.name };
      }
    }
    return cheapest;
  } catch (err) {
    console.warn(`  cheapestHotel ${cityCode}: ${err.message}`);
    return null;
  }
}

module.exports = { cheapestRoundTrip, cheapestHotel };
