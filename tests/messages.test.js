// Telegram message format (scripts/messages.js) + the HTML->plain-text fallback.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../scripts/messages.js');

const NOW = Date.parse('2027-01-01T12:00:00Z');
const naples = {
  code: 'NAP', name: 'נאפולי', departureDate: '2027-01-14', returnDate: '2027-01-21', approxPrice: 305,
  discountPercent: 40, transfers: 0, airline: 'W6', airlineName: 'Wizz Air', airlineLink: 'https://wizzair.com/',
  bookingLink: 'https://www.google.com/travel/flights?q=Flights+from+TLV+to+NAP&hl=he&gl=IL&curr=ILS',
  foundAt: '2026-12-31T12:00:00', hotel: { bookingUrl: 'https://www.booking.com/searchresults.html?ss=x&checkin=2027-01-14' },
};
const ctx = { origin: 'TLV', currency: 'ILS', blurb: 'פיצה נפוליטנית אמיתית, נוף לווזוב.', now: NOW };

test('deal message matches the requested layout', () => {
  const msg = M.dealMessage(naples, ctx);
  const lines = msg.split('\n');
  assert.strictEqual(lines[0], '✈️ <b>נאפולי בטיסה ישירה ב-₪305 הלוך-חזור!</b>');
  assert.strictEqual(lines[1], '');
  assert.strictEqual(lines[2], '📍 תל אביב ⇄ נאפולי, טיסה ישירה (Wizz Air)');
  assert.strictEqual(lines[3], '📅 14.1 – 21.1.2027 (שבוע שלם)');
  assert.strictEqual(lines[4], '💰 הלוך-חזור מ-₪305 בלבד (כ-40% מתחת למחיר הרגיל במסלול)');
  assert.strictEqual(lines[6], 'פיצה נפוליטנית אמיתית, נוף לווזוב.');
  assert.strictEqual(lines[8], '🔗 <a href="https://wizzair.com/">להזמנת הטיסה באתר Wizz Air</a>');
  assert.match(lines[9], /^🔎 <a href="https:\/\/www\.google\.com\/travel\/flights\?q=Flights\+from\+TLV\+to\+NAP&amp;hl=he&amp;gl=IL&amp;curr=ILS">השוואת מחירים ב-Google Flights<\/a>$/);
  assert.match(lines[10], /^🏨 <a href="[^"]+">מלונות בנאפולי לתאריכים האלה<\/a>$/);
  assert.strictEqual(lines[12], '⚠️ המחיר נמצא אתמול בחיפושים אחרונים ועשוי להשתנות.');
});

test('deal message: no airline -> Google is the booking link; stops; no blurb; stale price', () => {
  const r = { ...naples, transfers: 1, airline: null, airlineName: null, airlineLink: null, foundAt: '2026-12-25T00:00:00' };
  const msg = M.dealMessage(r, { ...ctx, blurb: null });
  assert.match(msg, /^✈️ <b>נאפולי ב-₪305 הלוך-חזור!<\/b>/);
  assert.match(msg, /📍 תל אביב ⇄ נאפולי, עם עצירה אחת\n/);
  assert.match(msg, /🔗 <a href="https:\/\/www\.google\.com[^"]+">להזמנת הטיסה<\/a>/);
  assert.doesNotMatch(msg, /השוואת מחירים/);
  assert.doesNotMatch(msg, /\n\n\n/, 'no empty block left where the blurb would be');
  assert.match(msg, /לפני 7 ימים בחיפושים אחרונים וסביר שכבר השתנה/);
});

test('deal message: no found_at -> generic disclaimer; unknown stops -> no stops text', () => {
  const r = { ...naples, foundAt: null, transfers: null };
  const msg = M.dealMessage(r, ctx);
  assert.match(msg, /⚠️ המחירים מבוססים על חיפושים אחרונים ועשויים להשתנות\.$/);
  assert.match(msg, /📍 תל אביב ⇄ נאפולי \(Wizz Air\)\n/);
});

test('dates: trip lengths, year boundary, one-way', () => {
  assert.strictEqual(M.datesText('2027-01-14', '2027-01-21'), '14.1 – 21.1.2027 (שבוע שלם)');
  assert.strictEqual(M.datesText('2026-12-28', '2027-01-04'), '28.12.2026 – 4.1.2027 (שבוע שלם)');
  assert.strictEqual(M.datesText('2027-03-01', '2027-03-05'), '1.3 – 5.3.2027 (4 לילות)');
  assert.strictEqual(M.datesText('2027-03-01', '2027-03-15'), '1.3 – 15.3.2027 (שבועיים)');
  assert.strictEqual(M.datesText('2027-03-01', '2027-03-02'), '1.3 – 2.3.2027 (לילה אחד)');
  assert.strictEqual(M.datesText('2027-03-01', null), '1.3.2027');
});

test('money: shekel / dollar / thousands / cents', () => {
  assert.strictEqual(M.money(305, 'ILS'), '₪305');
  assert.strictEqual(M.money(1834, 'ILS'), '₪1,834');
  assert.strictEqual(M.money(90, 'USD'), '$90');
  assert.strictEqual(M.money(49.5, 'USD'), '$49.50');
});

test('watchlist message: first check, price down, price up', () => {
  const w = { code: 'LIS', note: 'טיול לפסח', departureDate: '2027-04-22', returnDate: '2027-05-02', price: 1834, transfers: 0, airlineName: 'TAP Air Portugal', airlineLink: 'https://www.flytap.com/', bookingLink: 'https://g.example/x' };
  const base = { origin: 'TLV', currency: 'ILS', destName: 'ליסבון', hotelUrl: 'https://www.booking.com/x', now: NOW };
  assert.match(M.watchMessage(w, { ...base, lastPrice: null }), /^👀 <b>טיול לפסח: ₪1,834 הלוך-חזור<\/b>[\s\S]*💰 הלוך-חזור ₪1,834 \(בדיקה ראשונה\)/);
  assert.match(M.watchMessage(w, { ...base, lastPrice: 1900 }), /^👀 <b>טיול לפסח: המחיר ירד ל-₪1,834!<\/b>[\s\S]*\(ירד מ-₪1,900\)/);
  assert.match(M.watchMessage(w, { ...base, lastPrice: 1700 }), /^👀 <b>טיול לפסח: המחיר עלה ל-₪1,834<\/b>[\s\S]*\(עלה מ-₪1,700\)/);
  assert.match(M.watchMessage(w, { ...base, lastPrice: null }), /📍 תל אביב ⇄ ליסבון, טיסה ישירה \(TAP Air Portugal\)[\s\S]*🏨 <a href="https:\/\/www\.booking\.com\/x">מלונות בליסבון לתאריכים האלה<\/a>/);
});

test('watchlist message: item without a note shows the city name, not the code', () => {
  const w = { code: 'ATH', note: 'ATH', departureDate: '2027-04-20', returnDate: '2027-04-30', price: 521 };
  assert.match(M.watchMessage(w, { origin: 'TLV', currency: 'ILS', destName: 'אתונה', lastPrice: null, now: NOW }), /^👀 <b>אתונה: /);
});

test('budget message: round-trip with ceiling; one-way without hotel', () => {
  const m = { code: 'PMI', name: 'פלמה דה מיורקה', tripType: 'roundtrip', departureDate: '2026-11-15', returnDate: '2026-11-22', price: 90, currency: 'USD', transfers: 0, airlineName: 'Wizz Air', airlineLink: 'https://wizzair.com/', bookingLink: 'https://g.example/x' };
  const rt = M.budgetMessage(m, { origin: 'TLV', ceiling: 120, blurb: 'מפרצים.', hotelUrl: 'https://www.booking.com/x', now: NOW });
  assert.match(rt, /^🔥 <b>דיל תקציב: פלמה דה מיורקה ב-\$90 הלוך-חזור!<\/b>/);
  assert.match(rt, /💰 הלוך-חזור \$90 בלבד \(מתחת לתקרה שהגדרת, \$120\)/);
  const ow = M.budgetMessage({ ...m, tripType: 'oneway', returnDate: null, price: 49 }, { origin: 'TLV', ceiling: 60, now: NOW });
  assert.match(ow, /^🔥 <b>דיל תקציב: פלמה דה מיורקה ב-\$49 הלוך בלבד!<\/b>/);
  assert.match(ow, /📍 תל אביב ← פלמה דה מיורקה, טיסה ישירה/);
  assert.match(ow, /📅 15\.11\.2026\n/);
  assert.doesNotMatch(ow, /🏨/);
});

test('HTML safety: API text cannot inject markup; only <b> and <a> tags are produced', () => {
  const evil = { ...naples, name: 'A<b>&', airlineName: 'X & <i>Y</i>' };
  const msg = M.dealMessage(evil, { ...ctx, blurb: 'a < b & c' });
  const tags = [...msg.matchAll(/<\/?([a-z]+)[\s>]/g)].map((m) => m[1]);
  assert.ok(tags.every((t) => t === 'b' || t === 'a'), 'unexpected tags: ' + tags);
  assert.match(msg, /A&lt;b&gt;&amp;/);
  assert.match(msg, /X &amp; &lt;i&gt;Y&lt;\/i&gt;/);
});

test('toPlainText: anchors become "text: url", entities decoded', () => {
  const plain = M.toPlainText(M.dealMessage(naples, ctx));
  assert.doesNotMatch(plain, /<\/?(a|b)[ >]/);
  assert.match(plain, /🔗 להזמנת הטיסה באתר Wizz Air: https:\/\/wizzair\.com\/\n/);
  assert.match(plain, /curr=ILS/);
  assert.match(plain, /&hl=he/);
});

test('telegram.js resends as plain text when Telegram rejects the HTML (400)', async () => {
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    return body.parse_mode === 'HTML'
      ? { ok: false, status: 400, text: async () => "Bad Request: can't parse entities" }
      : { ok: true, status: 200, text: async () => '' };
  };
  process.env.TELEGRAM_BOT_TOKEN = 't'; process.env.TELEGRAM_CHAT_ID = '1';
  const { sendTelegramMessage } = require('../scripts/telegram.js');
  const err = console.error, log = console.log; console.error = () => {}; console.log = () => {};
  await sendTelegramMessage(M.dealMessage(naples, ctx));
  console.error = err; console.log = log;
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].parse_mode, undefined);
  assert.match(sent[1].text, /להזמנת הטיסה באתר Wizz Air: https:\/\/wizzair\.com\//);
});

test('every destination has a short Hebrew blurb with no stray characters', () => {
  const dests = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config/destinations.json'), 'utf8'));
  for (const d of dests) {
    assert.ok(d.blurb && d.blurb.length >= 20 && d.blurb.length <= 140, d.code + ' blurb length');
    assert.doesNotMatch(d.blurb, /[^֐-׿A-Za-z0-9 ,.'\-]/, d.code + ' blurb has unexpected characters');
  }
});
