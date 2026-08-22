// QA check for config/*.json — run before every scan.
// Fails loudly (non-zero exit + clear message) if something is broken,
// instead of letting a bad edit silently crash or corrupt the scan later.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const errors = [];

function fail(msg) {
  errors.push(msg);
}

function readJson(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    fail(`קובץ חסר: ${relPath}`);
    return null;
  }
  const raw = fs.readFileSync(full, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${relPath} אינו JSON תקין: ${err.message}`);
    return null;
  }
}

function isValidDate(str) {
  return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(str + "T00:00:00Z").getTime());
}

// ---- settings.json ----
const settings = readJson("config/settings.json");
if (settings) {
  if (typeof settings.origin !== "string" || settings.origin.length < 2) {
    fail('settings.json: "origin" חייב להיות קוד עיר (למשל "TLV")');
  }
  if (typeof settings.currency !== "string" || settings.currency.length !== 3) {
    fail('settings.json: "currency" חייב להיות קוד בן 3 אותיות (למשל "ILS")');
  }
  if (!isValidDate(settings.departureDate)) {
    fail('settings.json: "departureDate" חייב להיות בפורמט YYYY-MM-DD (למשל "2026-09-15")');
  }
  if (!isValidDate(settings.returnDate)) {
    fail('settings.json: "returnDate" חייב להיות בפורמט YYYY-MM-DD (למשל "2026-09-22")');
  }
  if (isValidDate(settings.departureDate) && isValidDate(settings.returnDate)) {
    const dep = new Date(settings.departureDate + "T00:00:00Z");
    const ret = new Date(settings.returnDate + "T00:00:00Z");
    if (ret <= dep) {
      fail('settings.json: "returnDate" חייב להיות אחרי "departureDate" (עכשיו החזרה יוצאת לפני/באותו יום כמו היציאה)');
    }
    const today = new Date();
    if (dep < today) {
      fail('settings.json: "departureDate" הוא תאריך שכבר עבר — עדכנו לתאריך עתידי');
    }
  }
  if (typeof settings.flexible !== "boolean") {
    fail('settings.json: "flexible" חייב להיות true או false (בלי מרכאות)');
  }
  if (typeof settings.flexDays !== "number" || settings.flexDays < 0 || settings.flexDays > 14) {
    fail('settings.json: "flexDays" חייב להיות מספר בין 0 ל-14');
  }
  if (typeof settings.discountThresholdPercent !== "number" || settings.discountThresholdPercent < 0 || settings.discountThresholdPercent > 100) {
    fail('settings.json: "discountThresholdPercent" חייב להיות מספר בין 0 ל-100');
  }
  if (settings.maxPriceILS !== undefined && settings.maxPriceILS !== null && typeof settings.maxPriceILS !== "number") {
    fail('settings.json: "maxPriceILS" חייב להיות מספר (או null אם אין תקרה)');
  }
  if (typeof settings.checkHotelsForTopDeals !== "number" || settings.checkHotelsForTopDeals < 0) {
    fail('settings.json: "checkHotelsForTopDeals" חייב להיות מספר 0 ומעלה');
  }
  if (settings.watchlist !== undefined) {
    if (!Array.isArray(settings.watchlist)) {
      fail('settings.json: "watchlist" חייב להיות מערך (אפשר ריק: [])');
    } else {
      settings.watchlist.forEach((item, i) => {
        if (!item.destination || !/^[A-Z]{2,4}$/.test(item.destination)) {
          fail(`settings.json: watchlist #${i + 1} - "destination" חייב להיות קוד יעד 2-4 אותיות גדולות (למשל "BCN")`);
        }
        if (!isValidDate(item.departureDate)) {
          fail(`settings.json: watchlist #${i + 1} - "departureDate" חייב להיות בפורמט YYYY-MM-DD`);
        }
        if (!isValidDate(item.returnDate)) {
          fail(`settings.json: watchlist #${i + 1} - "returnDate" חייב להיות בפורמט YYYY-MM-DD`);
        }
        if (isValidDate(item.departureDate) && isValidDate(item.returnDate)) {
          const dep = new Date(item.departureDate + "T00:00:00Z");
          const ret = new Date(item.returnDate + "T00:00:00Z");
          if (ret <= dep) {
            fail(`settings.json: watchlist #${i + 1} - "returnDate" חייב להיות אחרי "departureDate"`);
          }
        }
      });
    }
  }
}

// ---- destinations.json ----
const destinations = readJson("config/destinations.json");
if (destinations) {
  if (!Array.isArray(destinations) || destinations.length === 0) {
    fail("destinations.json: חייב להיות מערך לא-ריק של יעדים");
  } else {
    const seen = new Set();
    destinations.forEach((d, i) => {
      if (!d.code || !/^[A-Z]{2,4}$/.test(d.code)) {
        fail(`destinations.json: יעד #${i + 1} - "code" חייב להיות 2-4 אותיות גדולות (למשל "LON")`);
      }
      if (!d.name || typeof d.name !== "string") {
        fail(`destinations.json: יעד #${i + 1} - חסר "name"`);
      }
      if (!d.country || typeof d.country !== "string") {
        fail(`destinations.json: יעד #${i + 1} - חסר "country"`);
      }
      if (d.code) {
        if (seen.has(d.code)) fail(`destinations.json: קוד היעד "${d.code}" מופיע יותר מפעם אחת`);
        seen.add(d.code);
      }
    });
  }
}

if (errors.length > 0) {
  console.error("\n❌ בדיקת QA נכשלה - נמצאו הבעיות הבאות:\n");
  errors.forEach((e) => console.error("  • " + e));
  console.error("\nתקנו את זה בקבצי config/ ונסו שוב.\n");
  process.exit(1);
}

console.log("✅ בדיקת QA עברה - כל קבצי הקונפיגורציה תקינים.");
