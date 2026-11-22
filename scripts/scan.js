const fs = require("fs");
const path = require("path");
const { cheapestRoundTrip, cheapestRoundTripNear, cheapestOneWay, cheapestOneWayInMonth, cheapestRoundTripInMonth, cheapestHotel, getAirlineName } = require("./travelpayouts");
const { sendTelegramMessage } = require("./telegram");
const FlightInfo = require("../flight-info");
const Messages = require("./messages");

const blurbOf = (code) => (destinations.find((d) => d.code === code) || {}).blurb || null;
const nameOf = (code) => (destinations.find((d) => d.code === code) || {}).name || code;

const ROOT = path.join(__dirname, "..");
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "config/settings.json"), "utf8"));
const destinations = JSON.parse(fs.readFileSync(path.join(ROOT, "config/destinations.json"), "utf8"));
const historyPath = path.join(ROOT, "data/history.json");
const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));

// A one-off dashboard search only computes ONE section (e.g. just flights for
// one destination), and must not wipe the other sections (watchlist, budget
// deals, the full results board) that a real scan last populated.
let previousLatest = {};
try {
  previousLatest = JSON.parse(fs.readFileSync(path.join(ROOT, "data/latest.json"), "utf8"));
} catch {
  previousLatest = {};
}

const HISTORY_LIMIT = 60; // keep last N data points per destination

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const today = new Date().toISOString().slice(0, 10);

// ---- rolling default dates: the scheduled scan always looks daysFromNow days
// out for a tripLengthDays-long trip, computed fresh every run, so it never
// goes stale the way a fixed departureDate/returnDate would. ----
if (!settings.departureDate) {
  settings.departureDate = addDays(today, settings.daysFromNow ?? 30);
  settings.returnDate = addDays(settings.departureDate, settings.tripLengthDays ?? 7);
}

// ---- one-off search overrides (set when the dashboard triggers a live search) ----
// These only affect this run's in-memory settings - config/settings.json on disk is never touched.
const isOneOffSearch = !!(process.env.OVERRIDE_DEPARTURE_DATE || process.env.OVERRIDE_DESTINATION);
if (process.env.OVERRIDE_DEPARTURE_DATE) settings.departureDate = process.env.OVERRIDE_DEPARTURE_DATE;
if (process.env.OVERRIDE_RETURN_DATE) settings.returnDate = process.env.OVERRIDE_RETURN_DATE;
if (process.env.OVERRIDE_FLEXIBLE) settings.flexible = process.env.OVERRIDE_FLEXIBLE === "true";
if (process.env.OVERRIDE_FLEX_DAYS) settings.flexDays = parseInt(process.env.OVERRIDE_FLEX_DAYS, 10);
if (process.env.OVERRIDE_ADULTS) settings.hotelAdults = parseInt(process.env.OVERRIDE_ADULTS, 10);

const tripType = process.env.OVERRIDE_TRIP_TYPE === "oneway" ? "oneway" : "roundtrip";
const searchMode = ["flights", "hotels"].includes(process.env.OVERRIDE_SEARCH_MODE) ? process.env.OVERRIDE_SEARCH_MODE : "both";

let destinationsToScan = destinations;
if (process.env.OVERRIDE_DESTINATION) {
  const code = process.env.OVERRIDE_DESTINATION.toUpperCase().trim();
  const match = destinations.find((d) => d.code === code) || { code, name: code, country: "" };
  destinationsToScan = [match];
  console.log(`One-off search: scanning only ${code}`);
}

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Flight details shown next to every price (dashboard + Telegram). All optional:
// the cached API data doesn't always include airline / time / when it was found.
async function flightDetails(best) {
  return {
    airline: best.airline || null,
    airlineName: best.airline ? ((FlightInfo.airlineInfo(best.airline) || {}).name || await getAirlineName(best.airline)) : null,
    airlineLink: best.airlineLink || null,
    flightNumber: best.flightNumber || null,
    departTime: best.departTime || null,
    transfers: typeof best.transfers === "number" ? best.transfers : null,
    foundAt: best.foundAt || null,
  };
}

async function scanDestination(dest) {
  const best = tripType === "oneway"
    ? await cheapestOneWay({
        origin: settings.origin,
        destination: dest.code,
        departureDate: settings.departureDate,
        flexible: settings.flexible,
        flexDays: settings.flexDays,
        currency: settings.currency,
        adults: settings.hotelAdults || 1,
      })
    : await cheapestRoundTrip({
        origin: settings.origin,
        destination: dest.code,
        departureDate: settings.departureDate,
        returnDate: settings.returnDate,
        flexible: settings.flexible,
        flexDays: settings.flexDays,
        currency: settings.currency,
        adults: settings.hotelAdults || 1,
      });
  if (!best) return null;

  const pastPrices = (history[dest.code] || []).map((p) => p.price);
  const hist = median(pastPrices);
  const discountPercent = hist ? Math.round(((hist - best.price) / hist) * 100) : null;

  return {
    code: dest.code,
    name: dest.name,
    country: dest.country,
    tripType,
    departureDate: best.departDate,
    returnDate: best.returnDate,
    approxPrice: Math.round(best.price),
    bookingLink: best.bookingLink || null,
    ...(await flightDetails(best)),
    historyMedian: hist,
    discountPercent,
    historyPoints: pastPrices.length,
  };
}

async function scanHotelOnly(dest) {
  const hotel = await cheapestHotel({
    cityCode: dest.code,
    cityName: dest.name,
    checkIn: settings.departureDate,
    checkOut: settings.returnDate,
    adults: settings.hotelAdults || 2,
    currency: settings.currency,
  });
  if (!hotel) return null;
  return {
    code: dest.code,
    name: dest.name,
    country: dest.country,
    checkIn: settings.departureDate,
    checkOut: settings.returnDate,
    bookingUrl: hotel.bookingUrl,
  };
}

async function scanWatchlistItem(item) {
  // exact dates first, then the cheapest trip within ±3 days (message says the dates differ)
  const best = await cheapestRoundTripNear({
    origin: settings.origin,
    destination: item.destination,
    departureDate: item.departureDate,
    returnDate: item.returnDate,
    flexible: settings.flexible,
    flexDays: settings.flexDays,
    currency: settings.currency,
    adults: settings.hotelAdults || 1,
  });
  if (!best) return null;
  return {
    code: item.destination,
    note: item.note || item.destination,
    departureDate: best.departDate,
    returnDate: best.returnDate,
    requestedDepartureDate: item.departureDate,
    requestedReturnDate: item.returnDate,
    price: Math.round(best.price),
    bookingLink: best.bookingLink || null,
    ...(await flightDetails(best)),
  };
}

function watchKey(item) {
  return `watch:${item.destination}:${item.departureDate}:${item.returnDate}`;
}

function monthsAheadList(n) {
  const months = [];
  const base = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
    months.push(d.toISOString().slice(0, 7)); // YYYY-MM
  }
  return months;
}

// Budget hunt: for one destination, find the single cheapest fare (any date,
// within the configured month window) for both trip types, and flag whichever
// ones beat the configured USD ceiling.
async function scanBudgetDestination(dest, cfg) {
  const months = monthsAheadList(cfg.monthsAhead || 2);
  const found = [];

  if (cfg.maxRoundTripUSD) {
    let bestRT = null;
    for (const ym of months) {
      const r = await cheapestRoundTripInMonth({ origin: settings.origin, destination: dest.code, yearMonth: ym, currency: "USD", maxTripNights: cfg.maxTripNights });
      if (r && (!bestRT || r.price < bestRT.price)) bestRT = r;
    }
    if (bestRT && bestRT.price <= cfg.maxRoundTripUSD) {
      found.push({ ...bestRT, tripType: "roundtrip" });
    }
  }

  if (cfg.maxOneWayUSD) {
    let bestOW = null;
    for (const ym of months) {
      const r = await cheapestOneWayInMonth({ origin: settings.origin, destination: dest.code, yearMonth: ym, currency: "USD" });
      if (r && (!bestOW || r.price < bestOW.price)) bestOW = r;
    }
    if (bestOW && bestOW.price <= cfg.maxOneWayUSD) {
      found.push({ ...bestOW, tripType: "oneway" });
    }
  }

  const out = [];
  for (const f of found) {
    out.push({
      code: dest.code,
      name: dest.name,
      country: dest.country,
      tripType: f.tripType,
      departureDate: f.departDate,
      returnDate: f.returnDate,
      price: Math.round(f.price * 100) / 100,
      currency: "USD",
      bookingLink: f.bookingLink,
      ...(await flightDetails(f)),
    });
  }
  return out;
}

function budgetKey(r) {
  return `budget:${r.code}:${r.tripType}`;
}

async function main() {
  console.log(`Mode: ${searchMode}, tripType: ${tripType}. Scanning ${destinationsToScan.length} destinations from ${settings.origin}...`);

  // ---- hotels-only mode: skip flights entirely ----
  if (searchMode === "hotels") {
    const hotelResults = [];
    for (const dest of destinationsToScan) {
      try {
        const h = await scanHotelOnly(dest);
        if (h) hotelResults.push(h);
      } catch (err) {
        console.log(`HOTEL-DEBUG: Failed hotel scan ${dest.code}: ${err.message}`);
      }
    }
    hotelResults.sort((a, b) => a.name.localeCompare(b.name));

    const latest = {
      lastRun: new Date().toISOString(),
      settings,
      results: previousLatest.results || [],
      hotelOnlyResults: hotelResults,
      watchlistResults: previousLatest.watchlistResults || [],
      budgetResults: previousLatest.budgetResults || [],
    };
    fs.writeFileSync(path.join(ROOT, "data/latest.json"), JSON.stringify(latest, null, 2));
    console.log(`Done. ${hotelResults.length} hotel-only results.`);
    return;
  }

  // ---- flights (with optional hotel add-on for top deals) ----
  const results = [];
  for (const dest of destinationsToScan) {
    try {
      const r = await scanDestination(dest);
      if (r) results.push(r);
    } catch (err) {
      console.log(`Failed scanning ${dest.code}: ${err.message}`);
    }
  }

  results.sort((a, b) => {
    if (a.discountPercent !== null && b.discountPercent !== null) return b.discountPercent - a.discountPercent;
    if (a.discountPercent !== null) return -1;
    if (b.discountPercent !== null) return 1;
    return a.approxPrice - b.approxPrice;
  });

  const wantHotels = searchMode === "both" && tripType === "roundtrip";
  const topN = wantHotels ? results.slice(0, settings.checkHotelsForTopDeals || 5) : [];

  for (const r of topN) {
    const hotel = await cheapestHotel({
      cityCode: r.code,
      cityName: r.name,
      checkIn: r.departureDate,
      checkOut: r.returnDate,
      adults: settings.hotelAdults || 2,
      currency: settings.currency,
    });
    if (hotel) r.hotel = hotel;
  }

  if (!isOneOffSearch) {
    for (const r of results) {
      if (!history[r.code]) history[r.code] = [];
      history[r.code].push({ date: today, price: r.approxPrice });
      history[r.code] = history[r.code].slice(-HISTORY_LIMIT);
    }
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }

  const alerts = topN.filter((r) => {
    const enoughHistory = r.historyPoints >= (settings.minHistoryPointsForDiscountAlert || 3);
    const goodDiscount = enoughHistory && r.discountPercent >= settings.discountThresholdPercent;
    const underCap = !settings.maxPriceILS || r.approxPrice <= settings.maxPriceILS;
    return goodDiscount && underCap;
  });

  for (const r of alerts) {
    await sendTelegramMessage(Messages.dealMessage(r, { origin: settings.origin, currency: settings.currency, blurb: blurbOf(r.code) }));
  }

  if (alerts.length === 0) {
    console.log("No deals crossed the alert threshold this run.");
  }

  // ---- watchlist: only on real scheduled/config-triggered runs, not one-off dashboard searches ----
  const watchlistResults = [];
  if (!isOneOffSearch) {
    const watchlist = settings.watchlist || [];
    for (const item of watchlist) {
      try {
        const w = await scanWatchlistItem(item);
        if (!w) continue;
        watchlistResults.push(w);

        const key = watchKey(item);
        const prevPoints = history[key] || [];
        const lastPrice = prevPoints.length > 0 ? prevPoints[prevPoints.length - 1].price : null;

        if (lastPrice === null || lastPrice !== w.price) {
          const hotel = await cheapestHotel({ cityCode: w.code, cityName: nameOf(w.code), checkIn: w.departureDate, checkOut: w.returnDate, adults: settings.hotelAdults || 2, currency: settings.currency });
          await sendTelegramMessage(Messages.watchMessage(w, {
            origin: settings.origin,
            currency: settings.currency,
            destName: nameOf(w.code),
            lastPrice,
            hotelUrl: hotel && hotel.bookingUrl,
          }));
        }

        history[key] = [...prevPoints, { date: today, price: w.price }].slice(-HISTORY_LIMIT);
      } catch (err) {
        console.log(`Failed scanning watchlist item ${item.destination}: ${err.message}`);
      }
    }
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }

  // ---- budget alerts: hunt every destination for a fare under the configured USD ceiling ----
  const budgetResults = [];
  const budgetCfg = settings.budgetAlerts;
  if (!isOneOffSearch && budgetCfg && budgetCfg.enabled) {
    for (const dest of destinations) {
      try {
        const matches = await scanBudgetDestination(dest, budgetCfg);
        for (const m of matches) {
          budgetResults.push(m);

          const key = budgetKey(m);
          const prevPoints = history[key] || [];
          const lastPrice = prevPoints.length > 0 ? prevPoints[prevPoints.length - 1].price : null;

          if (lastPrice === null || lastPrice !== m.price) {
            const hotel = m.returnDate
              ? await cheapestHotel({ cityCode: m.code, cityName: m.name, checkIn: m.departureDate, checkOut: m.returnDate, adults: settings.hotelAdults || 2, currency: settings.currency })
              : null;
            await sendTelegramMessage(Messages.budgetMessage(m, {
              origin: settings.origin,
              ceiling: m.tripType === "oneway" ? budgetCfg.maxOneWayUSD : budgetCfg.maxRoundTripUSD,
              blurb: blurbOf(m.code),
              hotelUrl: hotel && hotel.bookingUrl,
            }));
          }

          history[key] = [...prevPoints, { date: today, price: m.price }].slice(-HISTORY_LIMIT);
        }
      } catch (err) {
        console.log(`Failed budget scan ${dest.code}: ${err.message}`);
      }
    }
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }

  const latest = {
    lastRun: new Date().toISOString(),
    settings,
    results,
    hotelOnlyResults: isOneOffSearch ? (previousLatest.hotelOnlyResults || []) : [],
    watchlistResults: isOneOffSearch ? (previousLatest.watchlistResults || []) : watchlistResults,
    budgetResults: isOneOffSearch ? (previousLatest.budgetResults || []) : budgetResults,
  };
  fs.writeFileSync(path.join(ROOT, "data/latest.json"), JSON.stringify(latest, null, 2));

  console.log(`Done. ${results.length} destinations scanned, ${alerts.length} alerts sent, ${watchlistResults.length} watchlist items checked, ${budgetResults.length} budget deals found.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
