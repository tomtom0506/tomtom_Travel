const fs = require("fs");
const path = require("path");
const { cheapestRoundTrip, cheapestHotel } = require("./travelpayouts");
const { sendTelegramMessage } = require("./telegram");

const ROOT = path.join(__dirname, "..");
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "config/settings.json"), "utf8"));
const destinations = JSON.parse(fs.readFileSync(path.join(ROOT, "config/destinations.json"), "utf8"));
const historyPath = path.join(ROOT, "data/history.json");
const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));

const HISTORY_LIMIT = 60; // keep last N data points per destination

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function scanDestination(dest) {
  const best = await cheapestRoundTrip({
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
    departureDate: best.departDate,
    returnDate: best.returnDate,
    approxPrice: Math.round(best.price),
    historyMedian: hist,
    discountPercent,
    historyPoints: pastPrices.length,
  };
}

async function main() {
  console.log(`Scanning ${destinations.length} destinations from ${settings.origin}...`);
  const results = [];

  for (const dest of destinations) {
    try {
      const r = await scanDestination(dest);
      if (r) results.push(r);
    } catch (err) {
      console.warn(`Failed scanning ${dest.code}: ${err.message}`);
    }
  }

  results.sort((a, b) => {
    if (a.discountPercent !== null && b.discountPercent !== null) return b.discountPercent - a.discountPercent;
    if (a.discountPercent !== null) return -1;
    if (b.discountPercent !== null) return 1;
    return a.approxPrice - b.approxPrice;
  });

  const topN = results.slice(0, settings.checkHotelsForTopDeals || 5);

  for (const r of topN) {
    const hotel = await cheapestHotel({
      cityCode: r.code,
      checkIn: r.departureDate,
      checkOut: r.returnDate,
      adults: settings.hotelAdults || 2,
      currency: settings.currency,
    });
    if (hotel) r.hotel = hotel;
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const r of results) {
    if (!history[r.code]) history[r.code] = [];
    history[r.code].push({ date: today, price: r.approxPrice });
    history[r.code] = history[r.code].slice(-HISTORY_LIMIT);
  }
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

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

  const latest = {
    lastRun: new Date().toISOString(),
    settings,
    results,
  };
  fs.writeFileSync(path.join(ROOT, "data/latest.json"), JSON.stringify(latest, null, 2));

  console.log(`Done. ${results.length} destinations scanned, ${alerts.length} alerts sent.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
