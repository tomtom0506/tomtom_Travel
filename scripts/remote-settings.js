// הגדרות אישיות מ-Supabase (במקום טוקן GitHub בדפדפן): רשימת מעקב ותקרות מחיר לציד דילים.
// הבוט מתחבר כמשתמש קריאה-בלבד (tom-bot@example.com). הסיסמה רק ב-GitHub Secrets (SUPABASE_BOT_PASSWORD).
// אם Supabase לא זמין – ממשיכים עם מה שהיה (רשימת המעקב מהריצה הקודמת, תקרות מ-config/settings.json).

const SUPABASE_URL = "https://ipllrhdsinqdwfsvzjdk.supabase.co";
// מפתח ציבורי (anon) – מיועד להיות גלוי. ההגנה היא התחברות + RLS.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwbGxyaGRzaW5xZHdmc3Z6amRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU3MjAxOTQsImV4cCI6MjExMTI5NjE5NH0.PHDPpmTItNL7WX20pRPl_OEKQ6XcAn4dYJpdjCXRpM0";
const BOT_EMAIL = "tom-bot@example.com";
const TIMEOUT_MS = 15000;

async function getJson(fetchFn, url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** מחזיר { watchlist: [...], budget: {maxRoundTripUSD, maxOneWayUSD} | null } או זורק שגיאה */
/** מסיר רווחים בקצוות ותווים נסתרים שנכנסים בהעתקה מהאייפון (סימני כיוון RTL ודומיהם) */
function cleanSecret(v) {
  return String(v || "").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").trim();
}

async function fetchRemoteSettings({ password, fetchFn = fetch, url = SUPABASE_URL, anonKey = SUPABASE_ANON_KEY } = {}) {
  password = cleanSecret(password);
  if (!password) throw new Error("SUPABASE_BOT_PASSWORD not set");
  const auth = await getJson(fetchFn, `${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: BOT_EMAIL, password }),
  });
  if (!auth || !auth.access_token) throw new Error("login failed");
  const headers = { apikey: anonKey, Authorization: `Bearer ${auth.access_token}` };
  const rows = await getJson(fetchFn, `${url}/rest/v1/travel_watchlist?select=destination,departure_date,return_date,note&order=departure_date`, { headers });
  const settingsRows = await getJson(fetchFn, `${url}/rest/v1/travel_settings?select=max_round_trip_usd,max_one_way_usd,updated_at&order=updated_at.desc&limit=1`, { headers });
  const watchlist = (Array.isArray(rows) ? rows : []).map((r) => ({
    destination: r.destination,
    departureDate: r.departure_date,
    returnDate: r.return_date,
    note: r.note || r.destination,
  }));
  const s = Array.isArray(settingsRows) && settingsRows[0];
  const budget = s ? {
    maxRoundTripUSD: s.max_round_trip_usd != null ? Number(s.max_round_trip_usd) : null,
    maxOneWayUSD: s.max_one_way_usd != null ? Number(s.max_one_way_usd) : null,
  } : null;
  return { watchlist, budget };
}

/** רשימת מעקב לגיבוי: מתוצאות הריצה הקודמת (data/latest.json) */
function watchlistFromLatest(previousLatest) {
  return ((previousLatest && previousLatest.watchlistResults) || []).map((w) => ({
    destination: w.code,
    departureDate: w.requestedDepartureDate || w.departureDate,
    returnDate: w.requestedReturnDate || w.returnDate,
    note: w.note || w.code,
  })).filter((w) => w.destination && w.departureDate && w.returnDate);
}

/**
 * ממזג הגדרות מ-Supabase לתוך settings (בזיכרון בלבד). מחזיר מקור: "supabase" / "fallback".
 * - Supabase הצליח ויש רשימה → היא קובעת.
 * - Supabase הצליח והרשימה ריקה → עד שהרשימה הישנה תיובא מהאתר, משתמשים ב-config/settings.json.
 * - Supabase נכשל → הרשימה מהריצה הקודמת; אם אין – config/settings.json.
 */
async function applyRemoteSettings(settings, { previousLatest, password, fetchFn, log = console.log } = {}) {
  try {
    const remote = await fetchRemoteSettings({ password, fetchFn });
    if (remote.watchlist.length > 0) settings.watchlist = remote.watchlist;
    if (remote.budget) {
      settings.budgetAlerts = { ...(settings.budgetAlerts || { enabled: true, monthsAhead: 2, maxTripNights: 14 }) };
      settings.budgetAlerts.enabled = true;
      if (remote.budget.maxRoundTripUSD) settings.budgetAlerts.maxRoundTripUSD = remote.budget.maxRoundTripUSD;
      if (remote.budget.maxOneWayUSD) settings.budgetAlerts.maxOneWayUSD = remote.budget.maxOneWayUSD;
    }
    log(`Settings from Supabase: ${remote.watchlist.length} watchlist items, budget ${remote.budget ? "set" : "default"}.`);
    return "supabase";
  } catch (err) {
    const prev = watchlistFromLatest(previousLatest);
    if (prev.length > 0) settings.watchlist = prev;
    log(`WARNING: Supabase settings unavailable (${err.message}) – using the last known watchlist (${(settings.watchlist || []).length} items).`);
    return "fallback";
  }
}

module.exports = { cleanSecret, fetchRemoteSettings, applyRemoteSettings, watchlistFromLatest, SUPABASE_URL, SUPABASE_ANON_KEY, BOT_EMAIL };
