// Run: npm test  (node --test, no dependencies)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../charts.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('median: odd, even, empty, ignores junk', () => {
  assert.strictEqual(C.median([3, 1, 2]), 2);
  assert.strictEqual(C.median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(C.median([]), null);
  assert.strictEqual(C.median([5, null, 'x', NaN, 1]), 3);
});

test('median matches scripts/scan.js (chart median line = "מהחציון" column)', () => {
  const src = read('scripts/scan.js');
  const m = src.match(/function median\(nums\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'median() not found in scan.js');
  const scanMedian = new Function(m[0] + '; return median;')();
  for (const arr of [[1], [1, 2], [5, 3, 9, 1], [433, 455, 373, 373, 385, 497]]) {
    assert.strictEqual(C.median(arr), scanMedian(arr));
  }
});

test('dailySeries: one point per day = cheapest price, sorted by date', () => {
  const s = C.dailySeries([
    { date: '2026-11-02', price: 455 },
    { date: '2026-11-01', price: 497 },
    { date: '2026-11-01', price: 400 },
    { date: '2026-11-02', price: 300 },
    { date: '2026-11-03', price: null },
    null,
  ]);
  assert.deepStrictEqual(s.map((p) => [p.date, p.price, p.n]), [['2026-11-01', 400, 2], ['2026-11-02', 300, 2]]);
});

test('niceTicks covers the range with round steps', () => {
  const t = C.niceTicks(161, 1004, 4);
  assert.ok(t[0] <= 161 && t[t.length - 1] >= 1004);
  const step = t[1] - t[0];
  t.forEach((v, i) => i && assert.strictEqual(v - t[i - 1], step));
  assert.ok(C.niceTicks(500, 500).length >= 2, 'flat series must still get an axis');
});

test('lineChartSVG: well-formed, one hit target per point, median line present', () => {
  const series = C.dailySeries([
    { date: '2026-11-01', price: 400 }, { date: '2026-11-02', price: 300 }, { date: '2026-11-03', price: 350 },
  ]);
  const svg = C.lineChartSVG(series, { median: 350 });
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
  assert.strictEqual((svg.match(/class="pc-hit"/g) || []).length, 3);
  assert.match(svg, /class="pc-median"/);
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
});

test('lineChartSVG: x spacing follows real dates, hit columns tile the plot', () => {
  const series = C.dailySeries([
    { date: '2026-11-01', price: 400 }, { date: '2026-11-02', price: 300 }, { date: '2026-11-11', price: 350 },
  ]);
  const svg = C.lineChartSVG(series, { width: 520 });
  const xs = [...svg.matchAll(/data-x="([\d.]+)"/g)].map((m) => Number(m[1]));
  // 1 day vs 9 days apart -> second gap is ~9x the first
  assert.ok(Math.abs((xs[2] - xs[1]) / (xs[1] - xs[0]) - 9) < 0.1, 'gaps: ' + xs);
  const rects = [...svg.matchAll(/class="pc-hit" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  for (let i = 1; i < rects.length; i++) assert.ok(Math.abs(rects[i - 1][0] + rects[i - 1][1] - rects[i][0]) < 0.2, 'gap between hit columns');
});

test('lineChartSVG: flat series (all same price) does not produce NaN', () => {
  const series = C.dailySeries([{ date: '2026-11-01', price: 500 }, { date: '2026-11-02', price: 500 }]);
  assert.doesNotMatch(C.lineChartSVG(series, { median: 500 }), /NaN|Infinity/);
});

test('dealBars: only rows with a median comparison, best deal first', () => {
  const bars = C.dealBars([
    { code: 'A', name: 'a', approxPrice: 100, discountPercent: -10, historyMedian: 90 },
    { code: 'B', name: 'b', approxPrice: 100, discountPercent: 40, historyMedian: 170 },
    { code: 'C', name: 'c', approxPrice: 100, discountPercent: null },
  ]);
  assert.deepStrictEqual(bars.map((b) => b.code), ['B', 'A']);
});

test('dealBarsHTML: limit, deal marker, direction classes, escaping', () => {
  const bars = C.dealBars([
    { code: 'B', name: '<b>x</b>', approxPrice: 100, discountPercent: 40, historyMedian: 170 },
    { code: 'A', name: 'a', approxPrice: 100, discountPercent: -10, historyMedian: 90 },
  ]);
  const html = C.dealBarsHTML(bars, { threshold: 20, limit: 1 });
  assert.strictEqual((html.match(/class="db-row/g) || []).length, 1);
  assert.match(html, /is-deal/);
  assert.match(html, /db-bar cheap/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  const both = C.dealBarsHTML(bars, {});
  assert.match(both, /db-bar pricey/);
});

// Code-only check (must NOT depend on data/*.json: this suite runs before every scheduled scan,
// and data legitimately has results without history, e.g. after a one-off search to a new city).
test('history keys: dashboard builds the same keys as scripts/scan.js', () => {
  const scan = read('scripts/scan.js');
  const html = read('index.html');
  const fn = (src, name) => {
    const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
    assert.ok(m, name + '() not found');
    return new Function(m[0] + '; return ' + name + ';')();
  };
  const watchKey = fn(scan, 'watchKey');
  const budgetKey = fn(scan, 'budgetKey');
  const watchHistoryKey = fn(html, 'watchHistoryKey');

  // scan.js keys watchlist history by the REQUESTED dates; the result carries the dates actually found.
  const item = { destination: 'LIS', departureDate: '2027-04-20', returnDate: '2027-04-30' };
  const result = { code: 'LIS', departureDate: '2027-04-22', returnDate: '2027-05-02', requestedDepartureDate: '2027-04-20', requestedReturnDate: '2027-04-30' };
  assert.strictEqual(watchHistoryKey(result), watchKey(item));

  for (const tripType of ['roundtrip', 'oneway']) {
    const b = { code: 'ROM', tripType };
    const dashboardKey = 'budget:' + b.code + ':' + (b.tripType === 'oneway' ? 'oneway' : 'roundtrip');
    assert.strictEqual(dashboardKey, budgetKey(b));
  }
  assert.ok(html.includes("data-chart-key=\"budget:' + b.code + ':' + (b.tripType === 'oneway' ? 'oneway' : 'roundtrip')"),
    'dashboard budget key expression changed - update this test');
});

test('test suite does not read live data files (would block scheduled scans)', () => {
  const self = fs.readFileSync(__filename, 'utf8').replace(/test\('test suite does not read[\s\S]*$/, '');
  assert.doesNotMatch(self, /read\('data\//);
});

test('version: APP_VERSION matches the newest changelog entry', () => {
  const html = read('index.html');
  const v = html.match(/const APP_VERSION = "([^"]+)"/)[1];
  const changelog = JSON.parse(read('changelog.json'));
  assert.strictEqual(changelog[0].version, v);
  assert.match(changelog[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('index.html: balanced tags and inline script parses', () => {
  const html = read('index.html');
  const body = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  for (const tag of ['div', 'button', 'select', 'span', 'label', 'details', 'table', 'ol', 'h2', 'h3', 'p']) {
    const open = (body.match(new RegExp('<' + tag + '[\\s>]', 'g')) || []).length;
    const close = (body.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    assert.strictEqual(open, close, 'unbalanced <' + tag + '>: ' + open + ' open vs ' + close + ' close');
  }
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  scripts.forEach((s) => new Function(s)); // throws on syntax error
  assert.match(html, /<script src="charts\.js"><\/script>[\s\S]*<script>/, 'charts.js must load before the inline script');
});

test('scripts: every local require() resolves, and there is no stale root copy of travelpayouts.js', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts')).filter((n) => n.endsWith('.js'))) {
    const src = read('scripts/' + f);
    for (const m of src.matchAll(/require\("(\.[^"]+)"\)/g)) {
      assert.doesNotThrow(() => require.resolve(path.join(ROOT, 'scripts', m[1])), f + ' requires missing ' + m[1]);
    }
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'travelpayouts.js')), 'stale root travelpayouts.js is back');
});
