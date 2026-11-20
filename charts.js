// Price charts for the dashboard: deal map (all destinations vs. their median)
// and a per-destination price-history line chart.
// Pure string-building functions, no dependencies. Works in the browser
// (window.TravelCharts) and in Node for tests (module.exports).
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Same definition as scripts/scan.js, so the chart's median line matches the "מהחציון" column.
  function median(nums) {
    const arr = (nums || []).filter((n) => typeof n === 'number' && isFinite(n)).sort((a, b) => a - b);
    if (arr.length === 0) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  // history points [{date:'YYYY-MM-DD', price}] (several per day) -> one point per day:
  // the cheapest price seen that day, sorted by date.
  function dailySeries(points) {
    const byDay = {};
    (points || []).forEach((p) => {
      if (!p || !p.date || typeof p.price !== 'number' || !isFinite(p.price)) return;
      const day = String(p.date).slice(0, 10);
      if (!byDay[day]) byDay[day] = { date: day, price: p.price, max: p.price, n: 0 };
      byDay[day].price = Math.min(byDay[day].price, p.price);
      byDay[day].max = Math.max(byDay[day].max, p.price);
      byDay[day].n++;
    });
    return Object.keys(byDay).sort().map((d) => byDay[d]);
  }

  function priceStats(points) {
    const prices = (points || []).map((p) => p && p.price).filter((n) => typeof n === 'number' && isFinite(n));
    if (prices.length === 0) return null;
    return {
      min: Math.min.apply(null, prices),
      max: Math.max.apply(null, prices),
      median: median(prices),
      count: prices.length,
    };
  }

  // "Nice" round axis ticks covering [min, max].
  function niceTicks(min, max, count) {
    count = count || 4;
    if (!(isFinite(min) && isFinite(max))) return [];
    if (min === max) { min = min - 1; max = max + 1; }
    const rawStep = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return ticks;
  }

  function fmtDay(iso) {
    const parts = String(iso).split('-');
    return parts.length === 3 ? parts[2] + '/' + parts[1] : String(iso);
  }

  function fmtPrice(n, currency) {
    const v = Math.round(n).toLocaleString('en-US');
    return currency === 'USD' ? '$' + v : v + ' ' + (currency === 'ILS' ? '₪' : (currency || ''));
  }

  // Line chart of daily-cheapest price with a dashed median line.
  // Returns an SVG string. Time runs left→right (standard reading of time axes, also in Hebrew UIs).
  function lineChartSVG(series, opts) {
    opts = opts || {};
    const W = opts.width || 520, H = opts.height || 220;
    const pad = { top: 14, right: 12, bottom: 26, left: 52 };
    if (!series || series.length === 0) return '';
    const med = opts.median;
    const values = series.map((p) => p.price).concat(med != null ? [med] : []);
    const ticks = niceTicks(Math.min.apply(null, values), Math.max.apply(null, values), 4);
    const yMin = ticks[0], yMax = ticks[ticks.length - 1];
    const iw = W - pad.left - pad.right, ih = H - pad.top - pad.bottom;
    // x is proportional to real time (days with no scan are not squeezed out)
    const t = series.map((p) => Date.parse(p.date + 'T00:00:00Z'));
    const tSpan = t[t.length - 1] - t[0];
    const x = (i) => pad.left + (series.length === 1 || !(tSpan > 0) ? (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw) : ((t[i] - t[0]) / tSpan) * iw);
    const y = (v) => pad.top + ih - ((v - yMin) / (yMax - yMin || 1)) * ih;

    let svg = '<svg class="pc-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' +
      esc(opts.label || 'גרף היסטוריית מחיר') + '" direction="ltr" style="direction:ltr">';

    // grid + y labels
    ticks.forEach((t) => {
      const ty = y(t).toFixed(1);
      svg += '<line class="pc-grid" x1="' + pad.left + '" x2="' + (W - pad.right) + '" y1="' + ty + '" y2="' + ty + '"/>';
      svg += '<text class="pc-axis" x="' + (pad.left - 8) + '" y="' + ty + '" text-anchor="end" dominant-baseline="middle">' +
        esc(Math.round(t).toLocaleString('en-US')) + '</text>';
    });

    // x labels: first, middle, last (no collisions)
    const xIdx = series.length <= 2 ? series.map((_, i) => i) : [0, Math.floor((series.length - 1) / 2), series.length - 1];
    xIdx.forEach((i, k) => {
      const anchor = series.length === 1 ? 'middle' : (k === 0 ? 'start' : (k === xIdx.length - 1 ? 'end' : 'middle'));
      svg += '<text class="pc-axis" x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anchor + '">' + esc(fmtDay(series[i].date)) + '</text>';
    });

    // median line
    if (med != null) {
      const my = y(med).toFixed(1);
      svg += '<line class="pc-median" x1="' + pad.left + '" x2="' + (W - pad.right) + '" y1="' + my + '" y2="' + my + '"/>';
      svg += '<text class="pc-median-label" x="' + (W - pad.right) + '" y="' + (Number(my) - 5) + '" text-anchor="end">חציון</text>';
    }

    // area + line
    const linePts = series.map((p, i) => x(i).toFixed(1) + ',' + y(p.price).toFixed(1));
    if (series.length > 1) {
      const base = (pad.top + ih).toFixed(1);
      svg += '<path class="pc-area" d="M' + x(0).toFixed(1) + ',' + base + ' L' + linePts.join(' L') + ' L' + x(series.length - 1).toFixed(1) + ',' + base + ' Z"/>';
      svg += '<path class="pc-line" d="M' + linePts.join(' L') + '"/>';
    }

    // lowest point marker + last point marker
    let lowI = 0;
    series.forEach((p, i) => { if (p.price < series[lowI].price) lowI = i; });
    svg += '<circle class="pc-low" cx="' + x(lowI).toFixed(1) + '" cy="' + y(series[lowI].price).toFixed(1) + '" r="4"/>';
    const last = series.length - 1;
    svg += '<circle class="pc-last" cx="' + x(last).toFixed(1) + '" cy="' + y(series[last].price).toFixed(1) + '" r="4.5"/>';

    // hover layer: crosshair + dot (moved by JS), and one hit column per point
    svg += '<line class="pc-cross" x1="0" x2="0" y1="' + pad.top + '" y2="' + (pad.top + ih) + '" style="display:none"/>';
    svg += '<circle class="pc-hover-dot" r="5" cx="0" cy="0" style="display:none"/>';
    // hit columns span halfway to each neighbour, so the whole plot width is hoverable
    series.forEach((p, i) => {
      const left = i === 0 ? pad.left : (x(i - 1) + x(i)) / 2;
      const right = i === series.length - 1 ? W - pad.right : (x(i) + x(i + 1)) / 2;
      svg += '<rect class="pc-hit" x="' + left.toFixed(1) + '" y="' + pad.top + '" width="' + Math.max(1, right - left).toFixed(1) +
        '" height="' + ih + '" data-i="' + i + '" data-x="' + x(i).toFixed(1) + '" data-y="' + y(p.price).toFixed(1) +
        '" data-date="' + esc(p.date) + '" data-price="' + p.price + '" data-n="' + p.n + '"/>';
    });

    svg += '</svg>';
    return svg;
  }

  // Destinations that have a median comparison, cheapest-vs-median first.
  function dealBars(results) {
    return (results || [])
      .filter((r) => r && typeof r.discountPercent === 'number' && isFinite(r.discountPercent))
      .map((r) => ({
        code: r.code,
        name: r.name,
        pct: r.discountPercent, // >0 = cheaper than median
        price: r.confirmedPrice || r.approxPrice,
        median: r.historyMedian,
      }))
      .sort((a, b) => b.pct - a.pct);
  }

  // Diverging bars (HTML). Cheaper than median grows toward the "זול" side, pricier toward "יקר".
  function dealBarsHTML(bars, opts) {
    opts = opts || {};
    if (!bars || bars.length === 0) return '';
    const limit = opts.limit || bars.length;
    const shown = bars.slice(0, limit);
    const maxAbs = Math.max.apply(null, bars.map((b) => Math.abs(b.pct)).concat([10]));
    const threshold = opts.threshold;
    return shown.map((b) => {
      const w = (Math.abs(b.pct) / maxAbs) * 50;
      const cheap = b.pct > 0;
      const isDeal = threshold != null && b.pct >= threshold;
      const pctText = b.pct === 0 ? '0%' : (cheap ? '↓' : '↑') + Math.abs(b.pct) + '%';
      return '<button type="button" class="db-row' + (isDeal ? ' is-deal' : '') + '" data-code="' + esc(b.code) + '"' +
        ' title="' + esc(b.name) + ': ' + esc(fmtPrice(b.price, opts.currency)) + ' (חציון ' + esc(fmtPrice(b.median || 0, opts.currency)) + ')">' +
        '<span class="db-name">' + (isDeal ? '🔥 ' : '') + esc(b.name) + '</span>' +
        '<span class="db-track"><span class="db-zero"></span>' +
          '<span class="db-bar ' + (cheap ? 'cheap' : 'pricey') + '" style="width:' + w.toFixed(1) + '%"></span></span>' +
        '<span class="db-pct ' + (cheap ? 'cheap' : 'pricey') + '">' + pctText + '</span>' +
      '</button>';
    }).join('');
  }

  const api = { esc, median, dailySeries, priceStats, niceTicks, fmtDay, fmtPrice, lineChartSVG, dealBars, dealBarsHTML };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TravelCharts = api;
})(typeof window !== 'undefined' ? window : this);
