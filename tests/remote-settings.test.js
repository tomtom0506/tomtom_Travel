// הגדרות מ-Supabase לסורק: mocks בלבד, בלי רשת.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../scripts/remote-settings.js');

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [re, resp] of routes) {
      if (re.test(url)) {
        if (resp instanceof Error) throw resp;
        return { ok: resp.status ? resp.status < 400 : true, status: resp.status || 200, json: async () => resp.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}
const ROWS = [{ destination: 'ATH', departure_date: '2027-04-20', return_date: '2027-04-30', note: 'פסח' }];
const OK = (rows = ROWS, settings = [{ max_round_trip_usd: '150.00', max_one_way_usd: null }]) => fakeFetch([
  [/auth\/v1\/token/, { body: { access_token: 'jwt-abc' } }],
  [/travel_watchlist/, { body: rows }],
  [/travel_settings/, { body: settings }],
]);
const base = () => ({ watchlist: [{ destination: 'LIS', departureDate: '2027-04-20', returnDate: '2027-04-30', note: 'old' }], budgetAlerts: { enabled: true, maxRoundTripUSD: 120, maxOneWayUSD: 20, monthsAhead: 2 } });
const quiet = () => {};

test('Supabase list and budget override the file; bot logs in with the fixed email and uses the JWT', async () => {
  const f = OK();
  const s = base();
  const src = await R.applyRemoteSettings(s, { password: 'pw', fetchFn: f, log: quiet });
  assert.strictEqual(src, 'supabase');
  assert.deepStrictEqual(s.watchlist, [{ destination: 'ATH', departureDate: '2027-04-20', returnDate: '2027-04-30', note: 'פסח' }]);
  assert.strictEqual(s.budgetAlerts.maxRoundTripUSD, 150);
  assert.strictEqual(s.budgetAlerts.maxOneWayUSD, 20, 'unset value keeps the file default');
  assert.strictEqual(JSON.parse(f.calls[0].init.body).email, 'tom-bot@example.com');
  assert.strictEqual(f.calls[1].init.headers.Authorization, 'Bearer jwt-abc');
});

test('empty Supabase list (not imported yet) keeps the file list', async () => {
  const s = base();
  await R.applyRemoteSettings(s, { password: 'pw', fetchFn: OK([], []), log: quiet });
  assert.strictEqual(s.watchlist[0].destination, 'LIS');
  assert.strictEqual(s.budgetAlerts.maxRoundTripUSD, 120);
});

test('Supabase down / wrong password / no secret: last known watchlist from latest.json, scan continues', async () => {
  const prev = { watchlistResults: [{ code: 'ROM', note: 'רומא', departureDate: '2027-05-02', returnDate: '2027-05-09', requestedDepartureDate: '2027-05-01', requestedReturnDate: '2027-05-08' }] };
  for (const fetchFn of [fakeFetch([[/auth/, new Error('network')]]), fakeFetch([[/auth/, { status: 400, body: {} }]])]) {
    const s = base();
    const src = await R.applyRemoteSettings(s, { password: 'pw', fetchFn, previousLatest: prev, log: quiet });
    assert.strictEqual(src, 'fallback');
    assert.deepStrictEqual(s.watchlist, [{ destination: 'ROM', departureDate: '2027-05-01', returnDate: '2027-05-08', note: 'רומא' }], 'uses the requested dates');
  }
  const s = base();
  assert.strictEqual(await R.applyRemoteSettings(s, { password: '', fetchFn: OK(), log: quiet }), 'fallback');
  assert.strictEqual(s.watchlist[0].destination, 'LIS', 'no previous results -> file list');
});

test('watchlistFromLatest skips incomplete rows', () => {
  assert.deepStrictEqual(R.watchlistFromLatest({ watchlistResults: [{ code: 'X' }] }), []);
  assert.deepStrictEqual(R.watchlistFromLatest(null), []);
});

test('scan workflow passes only the bot password, and scan.js loads remote settings only for real scans', () => {
  const fs = require('node:fs');
  const wf = fs.readFileSync(require('node:path').join(__dirname, '../.github/workflows/scan.yml'), 'utf8');
  assert.match(wf, /SUPABASE_BOT_PASSWORD: \$\{\{ secrets\.SUPABASE_BOT_PASSWORD \}\}/);
  const scan = fs.readFileSync(require('node:path').join(__dirname, '../scripts/scan.js'), 'utf8');
  assert.match(scan, /if \(!isOneOffSearch\) \{\s*await applyRemoteSettings/);
});
