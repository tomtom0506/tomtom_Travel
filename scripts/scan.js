const fs = require("fs");
const path = require("path");
const { cheapestRoundTrip, cheapestOneWay, cheapestHotel } = require("./travelpayouts");
const { sendTelegramMessage } = require("./telegram");

const ROOT = path.join(__dirname, "..");
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "config/settings.json"), "utf8"));
const destinations = JSON.parse(fs.readFileSync(path.join(ROOT, "config/destinations.json"), "utf8"));
const historyPath = path.join(ROOT, "data/history.json");
const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));

const HISTORY_LIMIT = 60; // keep last N data points per destination

// ---- one-off search overrides (set when the dashboard triggers a live search) ----
// These only affect this run's in-memory settings - config/settings.json on disk is never touched.
const isOneOffSearch = !!(process.env.OVERRIDE_DEPARTURE_DATE || process.env.OVERRIDE_DESTINATION);
if (process.env.OVERRIDE_DEPARTURE_DATE) settings.departureDate = process.env.OVERRIDE_DEPARTURE_DATE;
if (process.env.OVERRIDE_RETURN_DATE) settings.returnDate = process.env.OVERRIDE_RETURN_DATE;
if (process.env.OVERRIDE_FLEXIBLE) settings.flexible = process.env.OVERRIDE_FLEXIBLE === "true";
if (process.env.OVERRIDE_FLEX_DAYS) settings.flexDays = parseInt(process.env.OVERRIDE_FLEX_DAYS, 10);

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

async function scanDestination(dest) {
  const best = tripType === "oneway"
    ? await cheapestOneWay({
        origin: settings.origin,
        destination: dest.code,
        departureDate: settings.departureDate,
        flexible: settings.flexible,
        flexDays: settings.flexDays,
        currency: settings.currency,
      })
    : await cheapestRoundTrip({
        origin: settings.origin,
        destination: dest.code,
        departureDate: settings.departureDate,
        returnDate: settings.returnDate,
        flexible: settings.flexible,
        flexDays: settings.flexDays,
        currency: settings.currency,
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
    price: Math.round(hotel.price),
    currency: hotel.currency,
    hotelName: hotel.hotelName || null,
  };
}

async function scanWatchlistItem(item) {
  const best = await cheapestRoundTrip({
    origin: settings.origin,
    destination: item.destination,
    departureDate: item.departureDate,
    returnDate: item.returnDate,
    flexible: settings.flexible,
    flexDays: settings.flexDays,
    currency: settings.currency,
  });
  if (!best) return null;
  return {
    code: item.destination,
    note: item.note || item.destination,
    departureDate: best.departDate,
    returnDate: best.returnDate,
    price: Math.round(best.price),
  };
}

function watchKey(item) {
  return `watch:${item.destination}:${item.departureDate}:${item.returnDate}`;
}

async function main() {
  console.log(`Mode: ${searchMode}, tripType: ${tripType}. Scanning ${destinationsToScan.length} destinations from ${settings.origin}...`);
  const today = new Date().toISOString().slice(0, 10);

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
    hotelResults.sort((a, b) => a.price - b.price);

    const latest = {
      lastRun: new Date().toISOString(),
      settings,
      results: [],
      hotelOnlyResults: hotelResults,
      watchlistResults: [],
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
    const lines = [
      `✈️ <b>מחיר טוב נמצא: ${r.name} (${r.code})</b>`,
      `${settings.origin} ⇄ ${r.code}`,
      `${r.departureDate} → ${r.returnDate}`,
      `מחיר: <b>${r.approxPrice} ${settings.currency}</b> (${r.discountPercent}% מתחת לחציון ההיסטורי)`,
    ];
    if (r.hotel) {
      lines.push(`מלון (החל מ-): ${Math.round(r.hotel.price)} ${r.hotel.currency} - ${r.hotel.hotelName || ""}`);
    }
    await sendTelegramMessage(lines.join("\n"));
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
          const changeText = lastPrice === null
            ? "נבדק לראשונה"
            : (w.price < lastPrice ? `ירד מ-${lastPrice} ל-${w.price}` : `עלה מ-${lastPrice} ל-${w.price}`);
          await sendTelegramMessage(
            [
              `👀 <b>עדכון לחיפוש שסימנת: ${w.note}</b>`,
              `${settings.origin} ⇄ ${w.code}`,
              `${w.departureDate} → ${w.returnDate}`,
              `מחיר: <b>${w.price} ${settings.currency}</b> (${changeText})`,
            ].join("\n")
          );
        }

        history[key] = [...prevPoints, { date: today, price: w.price }].slice(-HISTORY_LIMIT);
      } catch (err) {
        console.log(`Failed scanning watchlist item ${item.destination}: ${err.message}`);
      }
    }
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }

  const latest = {
    lastRun: new Date().toISOString(),
    settings,
    results,
    hotelOnlyResults: [],
    watchlistResults,
  };
  fs.writeFileSync(path.join(ROOT, "data/latest.json"), JSON.stringify(latest, null, 2));

  console.log(`Done. ${results.length} destinations scanned, ${alerts.length} alerts sent, ${watchlistResults.length} watchlist items checked.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
