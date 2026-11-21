// Telegram message texts (parse_mode=HTML). Pure functions: no network, no files -
// everything they need comes in as arguments, so tests can render every message type.
const FlightInfo = require("../flight-info");

const ORIGIN_NAMES = { TLV: "תל אביב" };

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Clickable text instead of a long raw URL (no third-party URL shortener needed).
function link(url, text) {
  return `<a href="${esc(url)}">${esc(text)}</a>`;
}

function money(amount, currency) {
  const n = Math.round(Number(amount) * 100) / 100;
  const v = (Number.isInteger(n) ? n : n.toFixed(2)).toLocaleString("en-US");
  if (currency === "USD") return `$${v}`;
  if (currency === "EUR") return `€${v}`;
  if (currency === "ILS" || !currency) return `₪${v}`;
  return `${v} ${currency}`;
}

function parts(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return { y, m, d };
}

function nights(dep, ret) {
  return Math.round((Date.parse(ret + "T00:00:00Z") - Date.parse(dep + "T00:00:00Z")) / 86400000);
}

function tripLengthText(n) {
  if (n === 7) return "שבוע שלם";
  if (n === 14) return "שבועיים";
  if (n === 1) return "לילה אחד";
  if (n === 2) return "שני לילות";
  return `${n} לילות`;
}

// "14.1 – 21.1.2027 (שבוע שלם)"; across years: "28.12.2026 – 4.1.2027 (שבוע שלם)"; one-way: "14.1.2027"
function datesText(dep, ret) {
  const a = parts(dep);
  if (!ret) return `${a.d}.${a.m}.${a.y}`;
  const b = parts(ret);
  const start = a.y === b.y ? `${a.d}.${a.m}` : `${a.d}.${a.m}.${a.y}`;
  return `${start} – ${b.d}.${b.m}.${b.y} (${tripLengthText(nights(dep, ret))})`;
}

function tripLabel(r) {
  return r.returnDate ? "הלוך-חזור" : "הלוך בלבד";
}

// "📍 תל אביב ⇄ נאפולי, טיסה ישירה (Wizz Air)"
function routeLine(r, origin, destName) {
  const from = ORIGIN_NAMES[origin] || origin;
  const arrow = r.returnDate ? "⇄" : "←";
  let s = `📍 ${esc(from)} ${arrow} ${esc(destName)}`;
  if (r.transfers === 0) s += ", טיסה ישירה";
  else if (r.transfers === 1) s += ", עם עצירה אחת";
  else if (typeof r.transfers === "number" && r.transfers > 1) s += `, עם ${r.transfers} עצירות`;
  if (r.airlineName) s += ` (${esc(r.airlineName)})`;
  return s;
}

// "להזמנת הטיסה" opens the flight itself: the airline's booking page with the flight
// preselected when we have one (Wizz Air), otherwise the Aviasales page for these dates.
function bookingLines(r, destName, hotelUrl) {
  const lines = [];
  if (r.airlineLink) {
    lines.push(`🔗 ${link(r.airlineLink, `להזמנת הטיסה באתר ${r.airlineName || "חברת התעופה"}`)}`);
    if (r.bookingLink) lines.push(`🔎 ${link(r.bookingLink, "כל המחירים לתאריכים האלה ב-Aviasales")}`);
  } else if (r.bookingLink) {
    lines.push(`🔗 ${link(r.bookingLink, "להזמנת הטיסה")}`);
  }
  if (hotelUrl) lines.push(`🏨 ${link(hotelUrl, `מלונות ב${destName} לתאריכים האלה`)}`);
  return lines;
}

function disclaimer(r, now) {
  const age = FlightInfo.ageText(r.foundAt, now);
  if (!age) return "⚠️ המחירים מבוססים על חיפושים אחרונים ועשויים להשתנות.";
  const stale = FlightInfo.isStale(r.foundAt, now);
  return `⚠️ המחיר נמצא ${age} בחיפושים אחרונים ${stale ? "וסביר שכבר השתנה - כדאי לבדוק" : "ועשוי להשתנות"}.`;
}

function assemble(blocks) {
  // blocks: arrays of lines; empty blocks are skipped; one blank line between blocks
  return blocks.filter((b) => b && b.length).map((b) => b.join("\n")).join("\n\n");
}

// Main deal alert (price well below the route's historical median).
function dealMessage(r, { origin, currency, blurb, now }) {
  const price = money(r.approxPrice, currency);
  const direct = r.transfers === 0 ? " בטיסה ישירה" : "";
  const discount = typeof r.discountPercent === "number" && r.discountPercent > 0 ? ` (כ-${r.discountPercent}% מתחת למחיר הרגיל במסלול)` : "";
  return assemble([
    [`✈️ <b>${esc(r.name)}${direct} ב-${price} ${tripLabel(r)}!</b>`],
    [
      routeLine(r, origin, r.name),
      `📅 ${datesText(r.departureDate, r.returnDate)}`,
      `💰 ${tripLabel(r)} מ-${price} בלבד${discount}`,
    ],
    blurb ? [esc(blurb)] : null,
    bookingLines(r, r.name, r.hotel && r.hotel.bookingUrl),
    [disclaimer(r, now)],
  ]);
}

// Watchlist update (price of a trip the user saved changed).
function watchMessage(w, { origin, currency, destName, lastPrice, hotelUrl, now }) {
  const price = money(w.price, currency);
  let head;
  let change = "";
  if (lastPrice == null) {
    head = `${price} ${tripLabel(w)}`;
    change = " (בדיקה ראשונה)";
  } else if (w.price < lastPrice) {
    head = `המחיר ירד ל-${price}!`;
    change = ` (ירד מ-${money(lastPrice, currency)})`;
  } else {
    head = `המחיר עלה ל-${price}`;
    change = ` (עלה מ-${money(lastPrice, currency)})`;
  }
  return assemble([
    [`👀 <b>${esc(w.note && w.note !== w.code ? w.note : destName)}: ${head}</b>`],
    [
      routeLine(w, origin, destName),
      `📅 ${datesText(w.departureDate, w.returnDate)}`,
      `💰 ${tripLabel(w)} ${price}${change}`,
    ],
    bookingLines(w, destName, hotelUrl),
    [disclaimer(w, now)],
  ]);
}

// Budget deal (any date in the coming months under the user's USD ceiling).
function budgetMessage(m, { origin, ceiling, blurb, hotelUrl, now }) {
  const price = money(m.price, m.currency || "USD");
  return assemble([
    [`🔥 <b>דיל תקציב: ${esc(m.name)} ב-${price} ${tripLabel(m)}!</b>`],
    [
      routeLine(m, origin, m.name),
      `📅 ${datesText(m.departureDate, m.returnDate)}`,
      `💰 ${tripLabel(m)} ${price} בלבד${ceiling ? ` (מתחת לתקרה שהגדרת, ${money(ceiling, m.currency || "USD")})` : ""}`,
    ],
    blurb ? [esc(blurb)] : null,
    bookingLines(m, m.name, hotelUrl),
    [disclaimer(m, now)],
  ]);
}

// Fallback when Telegram rejects the HTML: plain text with "text: url" instead of anchors.
function toPlainText(html) {
  return String(html)
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, (_, url, text) => `${text}: ${url}`)
    .replace(/<\/?b>/g, "")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

module.exports = { dealMessage, watchMessage, budgetMessage, toPlainText, datesText, money, esc };
