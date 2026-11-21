// Flight details: API normalization, merging the two endpoints, price age, airline links.
// The Travelpayouts API is mocked - no network, no token.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const FI = require('../flight-info.js');

const ROOT = path.join(__dirname, '..');

// ---- mocked API ----
// Fixtures follow the documented shapes of both endpoints.
function mockApi(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const handler = routes[u.pathname];
    if (!handler) return { ok: true, json: async () => ({ success: true, data: [] }) };
    const body = handler(u.searchParams);
    if (body instanceof Error) return { ok: false, status: 500, text: async () => body.message };
    return { ok: true, json: async () => ({ success: true, data: body }) };
  };
  return calls;
}
process.env.TRAVELPAYOUTS_TOKEN = 'test-token';
const tp = require('../scripts/travelpayouts.js');
const quiet = () => { const l = console.log; console.log = () => {}; return () => { console.log = l; }; };

const WM = '/v2/prices/week-matrix';
const V3 = '/aviasales/v3/prices_for_dates';
const base = { origin: 'TLV', destination: 'BCN', departureDate: '2026-12-20', returnDate: '2026-12-27', flexible: false, flexDays: 3, currency: 'ILS' };

test('toOffer: week-matrix shape (value, number_of_changes, found_at)', () => {
  const o = tp._internal.toOffer({ value: 650, depart_date: '2026-12-20', return_date: '2026-12-27', number_of_changes: 0, found_at: '2026-11-18T07:43:43' }, 'week-matrix');
  assert.deepStrictEqual(
    [o.departDate, o.returnDate, o.price, o.transfers, o.foundAt, o.airline, o.departTime],
    ['2026-12-20', '2026-12-27', 650, 0, '2026-11-18T07:43:43', null, null]);
});

test('toOffer: v3 shape (price, departure_at with time, airline, flight_number)', () => {
  const o = tp._internal.toOffer({ price: 640, departure_at: '2026-12-20T06:20:00+02:00', return_at: '2026-12-27T22:05:00+01:00', airline: 'W6', flight_number: 2327, transfers: 0 }, 'v3');
  assert.deepStrictEqual(
    [o.departDate, o.returnDate, o.departTime, o.airline, o.flightNumber, o.transfers],
    ['2026-12-20', '2026-12-27', '06:20', 'W6', '2327', 0]);
});

test('toOffer: rejects entries with no price or date', () => {
  assert.strictEqual(tp._internal.toOffer({ value: 0, depart_date: '2026-12-20' }), null);
  assert.strictEqual(tp._internal.toOffer({ price: 100 }), null);
  assert.strictEqual(tp._internal.toOffer(null), null);
});

test('cheapestRoundTrip: merges endpoints - week-matrix price gets airline from v3, v3 price gets found_at', async () => {
  mockApi({
    [WM]: () => [{ value: 650, depart_date: '2026-12-20', return_date: '2026-12-27', number_of_changes: 0, found_at: '2026-11-18T07:43:43' }],
    [V3]: () => [{ price: 655, departure_at: '2026-12-20T06:20:00+02:00', return_at: '2026-12-27T22:05:00+01:00', airline: 'W6', flight_number: 2327, transfers: 0 }],
  });
  const restore = quiet();
  const r = await tp.cheapestRoundTrip(base);
  restore();
  assert.strictEqual(r.price, 650);
  assert.strictEqual(r.airline, 'W6');
  assert.strictEqual(r.flightNumber, '2327');
  assert.strictEqual(r.departTime, '06:20');
  assert.strictEqual(r.foundAt, '2026-11-18T07:43:43');
  assert.strictEqual(r.airlineLink, 'https://wizzair.com/');
  assert.match(r.bookingLink, /^https:\/\/www\.google\.com\/travel\/flights\?/);
});

test('cheapestRoundTrip: does NOT borrow airline from a different-priced or different-date offer', async () => {
  mockApi({
    [WM]: () => [{ value: 500, depart_date: '2026-12-20', return_date: '2026-12-27', found_at: '2026-11-18T07:43:43' }],
    [V3]: () => [
      { price: 900, departure_at: '2026-12-20T06:20:00+02:00', return_at: '2026-12-27T22:05:00+01:00', airline: 'LY' }, // same dates, 80% pricier
      { price: 505, departure_at: '2026-12-21T06:20:00+02:00', return_at: '2026-12-28T22:05:00+01:00', airline: 'FR' }, // close price, other dates
    ],
  });
  const restore = quiet();
  const r = await tp.cheapestRoundTrip(base);
  restore();
  assert.strictEqual(r.price, 500);
  assert.strictEqual(r.airline, null);
  assert.strictEqual(r.airlineLink, null);
});

test('cheapestRoundTrip: exact mode prefers the requested date; drops nonsense trip lengths', async () => {
  mockApi({
    [WM]: () => [
      { value: 100, depart_date: '2026-12-20', return_date: '2027-03-20' }, // 90-day "trip" from mixed cache
      { value: 300, depart_date: '2026-12-21', return_date: '2026-12-28' },
      { value: 400, depart_date: '2026-12-20', return_date: '2026-12-27' },
    ],
    [V3]: () => [],
  });
  const restore = quiet();
  const r = await tp.cheapestRoundTrip(base);
  restore();
  assert.deepStrictEqual([r.departDate, r.price], ['2026-12-20', 400]);
});

test('cheapestRoundTrip: flexible mode stays within ±flexDays of the requested departure', async () => {
  mockApi({
    [WM]: () => [{ value: 400, depart_date: '2026-12-22', return_date: '2026-12-29' }],
    [V3]: () => [
      { price: 150, departure_at: '2026-12-05T06:00:00+02:00', return_at: '2026-12-12T06:00:00+02:00', airline: 'FR' }, // 15 days early
      { price: 380, departure_at: '2026-12-18T06:00:00+02:00', return_at: '2026-12-25T06:00:00+02:00', airline: 'W6' },
    ],
  });
  const restore = quiet();
  const r = await tp.cheapestRoundTrip({ ...base, flexible: true });
  restore();
  assert.deepStrictEqual([r.departDate, r.price, r.airline], ['2026-12-18', 380, 'W6']);
});

test('cheapestRoundTrip: one endpoint failing still returns a price from the other', async () => {
  mockApi({
    [WM]: () => new Error('boom'),
    [V3]: () => [{ price: 700, departure_at: '2026-12-20T09:00:00+02:00', return_at: '2026-12-27T09:00:00+01:00', airline: 'LY', transfers: 0 }],
  });
  const restore = quiet();
  const r = await tp.cheapestRoundTrip(base);
  restore();
  assert.deepStrictEqual([r.price, r.airline, r.foundAt], [700, 'LY', null]);
  assert.strictEqual(r.airlineLink, 'https://www.elal.com/');
});

test('cheapestRoundTrip: requests exact return date from v3 in exact mode, month in flexible mode', async () => {
  const calls = mockApi({});
  const restore = quiet();
  await tp.cheapestRoundTrip(base);
  await tp.cheapestRoundTrip({ ...base, flexible: true });
  restore();
  const v3 = calls.filter((u) => u.pathname === V3);
  assert.strictEqual(v3[0].searchParams.get('departure_at'), '2026-12-20');
  assert.strictEqual(v3[0].searchParams.get('return_at'), '2026-12-27');
  assert.strictEqual(v3[1].searchParams.get('departure_at'), '2026-12');
  assert.strictEqual(v3[1].searchParams.get('return_at'), null);
});

test('one-way and month functions carry flight details and links', async () => {
  mockApi({ [V3]: () => [{ price: 49, departure_at: '2026-12-03T05:45:00+02:00', airline: 'W6', flight_number: '2325', transfers: 0 }] });
  const restore = quiet();
  const ow = await tp.cheapestOneWay({ ...base, flexible: false });
  const owm = await tp.cheapestOneWayInMonth({ origin: 'TLV', destination: 'BCN', yearMonth: '2026-12', currency: 'USD' });
  restore();
  for (const r of [ow, owm]) {
    assert.deepStrictEqual([r.departDate, r.returnDate, r.departTime, r.airline, r.flightNumber, r.airlineLink],
      ['2026-12-03', null, '05:45', 'W6', '2325', 'https://wizzair.com/']);
  }
  mockApi({ [V3]: () => [{ price: 99, departure_at: '2026-12-03T05:45:00+02:00', return_at: '2026-12-10T20:00:00+01:00', airline: 'FR' }] });
  const restore2 = quiet();
  const rt = await tp.cheapestRoundTripInMonth({ origin: 'TLV', destination: 'BCN', yearMonth: '2026-12', currency: 'USD', maxTripNights: 14 });
  restore2();
  assert.deepStrictEqual([rt.returnDate, rt.airlineLink], ['2026-12-10', 'https://www.ryanair.com/']);
});

// ---- flight-info.js ----
const NOW = Date.parse('2026-11-20T12:00:00Z');

test('ageText: hours, yesterday, days; found_at without timezone is UTC', () => {
  assert.strictEqual(FI.ageText('2026-11-20T11:30:00', NOW), 'לפני פחות משעה');
  assert.strictEqual(FI.ageText('2026-11-20T11:00:00', NOW), 'לפני שעה');
  assert.strictEqual(FI.ageText('2026-11-20T07:00:00', NOW), 'לפני 5 שעות');
  assert.strictEqual(FI.ageText('2026-11-19T10:00:00', NOW), 'אתמול');
  assert.strictEqual(FI.ageText('2026-11-18T10:00:00', NOW), 'לפני יומיים');
  assert.strictEqual(FI.ageText('2026-11-15T10:00:00', NOW), 'לפני 5 ימים');
  assert.strictEqual(FI.ageText('2026-11-20T13:00:00+02:00', NOW), 'לפני שעה');
  assert.strictEqual(FI.ageText('2026-11-20 07:00:00', NOW), 'לפני 5 שעות');
  assert.strictEqual(FI.ageText(null, NOW), null);
  assert.strictEqual(FI.ageText('garbage', NOW), null);
  assert.strictEqual(FI.ageText('2026-11-21T12:00:00', NOW), 'לפני פחות משעה', 'clock skew must not show negative age');
});

test('isStale: older than 72 hours', () => {
  assert.strictEqual(FI.isStale('2026-11-17T13:00:00', NOW), false);
  assert.strictEqual(FI.isStale('2026-11-17T11:00:00', NOW), true);
  assert.strictEqual(FI.isStale(null, NOW), false);
});

test('stopsText', () => {
  assert.deepStrictEqual([0, 1, 2, null, NaN].map(FI.stopsText), ['ישירה', 'עצירה אחת', '2 עצירות', null, null]);
});

test('airline map: case-insensitive lookup, every site is https, unknown code -> null', () => {
  assert.strictEqual(FI.airlineInfo('w6').name, 'Wizz Air');
  assert.strictEqual(FI.airlineInfo('ZZ'), null);
  assert.strictEqual(FI.airlineInfo(null), null);
  for (const [code, a] of Object.entries(FI.AIRLINES)) {
    assert.match(a.url, /^https:\/\/[a-z0-9.-]+\/$/, code);
    assert.ok(a.name, code);
  }
});

test('scan.js: all three Telegram messages come from scripts/messages.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/scan.js'), 'utf8');
  for (const fn of ['dealMessage', 'watchMessage', 'budgetMessage']) assert.match(src, new RegExp('Messages\\.' + fn + '\\('), fn);
  assert.doesNotMatch(src, /לפרטים והזמנה/, 'old message wording left behind');
});

test('dashboard loads flight-info.js before the inline script', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<script src="flight-info\.js"><\/script>[\s\S]*<script src="charts\.js"><\/script>[\s\S]*<script>/);
});
