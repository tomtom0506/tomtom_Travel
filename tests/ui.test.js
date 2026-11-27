// בדיקת דפדפן (Playwright, אם מותקן): התחברות במקום טוקן GitHub. בלי רשת: supabase מזויף, GitHub API מזויף.
// ב-GitHub Actions אין Playwright – הבדיקה מדולגת שם.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }
const skip = !chromium && 'playwright not installed';
const ROOT = path.join(__dirname, '..');
const SB_UMD = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

let server, base, browser;
test.before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html');
    if (!p.startsWith(ROOT)) return res.writeHead(403).end();
    fs.readFile(p, (err, body) => err ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'text/plain' }).end(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open({ session = null, watchCount = 0 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const ghCalls = [];
  await ctx.route(SB_UMD, (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'fixtures/fake-supabase-umd.js')) }));
  await ctx.route(/api\.github\.com/, (r) => { ghCalls.push({ url: r.request().url(), headers: r.request().headers() }); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ workflow_runs: [{ created_at: new Date().toISOString(), status: 'completed', conclusion: 'success' }] }) }); });
  await ctx.route(/autocomplete|travelpayouts|aviasales/, (r) => r.abort());
  await page.addInitScript(([s, c]) => { window.__FAKE_SESSION = s; localStorage.setItem('gh_pat', 'github_pat_OLD'); window.__watchCount = c; }, [session, watchCount]);
  await page.goto(base);
  await page.waitForFunction(() => window.__sb && document.getElementById('loginBtn'));
  await page.waitForTimeout(500);
  await page.evaluate(() => closeBudgetPopup()); // חלון "דיל חדש" שקופץ בפתיחה מכסה את הכפתורים
  return { ctx, page, errors, ghCalls };
}

test('old GitHub token is wiped; search without login asks to log in, and nothing is sent', { skip }, async () => {
  const { ctx, page, errors, ghCalls } = await open();
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('gh_pat')), null);
  assert.strictEqual(await page.textContent('#loginBtn'), '🔑');
  await page.evaluate(() => triggerSearch('flights'));
  assert.ok(await page.isVisible('#loginModal.open'));
  assert.deepStrictEqual(await page.evaluate(() => window.__sb.calls.filter((c) => c.fn)), []);
  assert.strictEqual(ghCalls.length, 0);
  assert.deepStrictEqual(errors, []);
  await ctx.close();
});

test('login imports the old watchlist once, then search goes through the dispatch function (no GitHub token anywhere)', { skip }, async () => {
  const { ctx, page, errors, ghCalls } = await open({ watchCount: 0 });
  await page.click('#loginBtn');
  await page.fill('#loginEmail', 'me@example.com');
  await page.fill('#loginPassword', 'pw');
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => document.getElementById('loginBtn').textContent === '👤');
  await page.waitForFunction(() => window.__sb.calls.some((c) => c.table === 'travel_watchlist' && c.op === 'insert'));
  const ins = await page.evaluate(() => window.__sb.calls.find((c) => c.table === 'travel_watchlist' && c.op === 'insert').payload);
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/latest.json'), 'utf8')).settings.watchlist || [];
  assert.strictEqual(ins.length, expected.length);
  if (ins.length) assert.match(ins[0].destination, /^[A-Z]{3}$/);

  // חיפוש חי
  await page.evaluate(() => { document.getElementById('searchDestCode').value = 'ATH'; document.getElementById('searchDepart').value = '2027-04-20'; document.getElementById('searchReturn').value = '2027-04-30'; });
  await page.evaluate(() => triggerSearch('flights'));
  await page.waitForFunction(() => window.__sb.calls.some((c) => c.fn === 'dispatch'));
  const call = await page.evaluate(() => window.__sb.calls.find((c) => c.fn === 'dispatch'));
  assert.strictEqual(call.body.app, 'travel');
  assert.strictEqual(call.body.inputs.destination, 'ATH');
  assert.strictEqual(call.body.inputs.searchMode, 'flights');
  await page.waitForFunction(() => /הושלם/.test(document.getElementById('searchStatus').textContent), null, { timeout: 20000 });
  for (const g of ghCalls) assert.ok(!g.headers.authorization, 'GitHub status is read without a token');
  assert.deepStrictEqual(errors, []);
  await ctx.close();
});

test('already imported list is not imported again; budget ceiling is saved to Supabase', { skip }, async () => {
  const { ctx, page, errors } = await open({ session: { user: { id: 'u1', email: 'me@example.com' } }, watchCount: 2 });
  await page.waitForFunction(() => document.getElementById('loginBtn').textContent === '👤');
  await page.waitForTimeout(300);
  assert.ok(!(await page.evaluate(() => window.__sb.calls.some((c) => c.table === 'travel_watchlist' && c.op === 'insert'))));
  await page.evaluate(() => { document.getElementById('budgetThreshold').value = '99'; return saveBudgetThreshold(); });
  await page.waitForFunction(() => window.__sb.calls.some((c) => c.op === 'upsert'));
  const up = await page.evaluate(() => window.__sb.calls.find((c) => c.op === 'upsert'));
  assert.strictEqual(up.table, 'travel_settings');
  assert.strictEqual(up.payload.max_round_trip_usd, 99);
  assert.strictEqual(up.payload.user_id, 'u1');
  assert.deepStrictEqual(errors, []);
  await ctx.close();
});

test('index.html has no GitHub token code left', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(!/localStorage\.setItem\(["']gh_pat/.test(html));
  assert.ok(!/Authorization:\s*"Bearer "\s*\+\s*token/.test(html));
  assert.ok(!/\/contents\/config/.test(html), 'no writes to config/ via the Contents API');
});
