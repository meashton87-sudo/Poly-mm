"""Self-contained HTML report for a backtest result (no external files or libraries)."""

from __future__ import annotations

import json
from pathlib import Path


def _downsample(curve: list, n: int = 600) -> list:
    if len(curve) <= n:
        return curve
    step = len(curve) / n
    out = [curve[int(i * step)] for i in range(n)]
    out[-1] = curve[-1]
    return out


def write_html(r: dict, path: str | Path) -> None:
    data = {
        "label": r.get("data_label", ""),
        "start": r["test_start"], "end": r["test_end"],
        "flat": {k: v for k, v in r["flat"].items()},
        "benchmark": r["benchmark"],
        "bankroll": {k: v for k, v in r["bankroll"].items() if k != "curve"},
        "flat_curve": _downsample(r["flat_curve"]),
        "bank_curve": _downsample(r["bankroll"]["curve"]),
        "by_category": r["by_category"], "by_price": r["by_price"], "by_month": r["by_month"],
        "config": r["config"],
    }
    blob = json.dumps(data, default=str).replace("</", "<\\/")
    Path(path).write_text(_PAGE.replace("__DATA__", blob), encoding="utf-8")


_PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backtest Report</title>
<style>
:root {
  color-scheme: light;
  --bg: #f6f7f9; --surface-1: #fcfcfb; --line: #e6e5e0; --grid: #ecebe6;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #6f6e69;
  --series-1: #2a78d6; --warn-bg: #fff3d6; --warn-ink: #7a4f00;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --bg: #111110; --surface-1: #1a1a19; --line: #2e2e2c; --grid: #262624;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #9a998f;
    --series-1: #3987e5; --warn-bg: #33280f; --warn-ink: #f2c25b;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #111110; --surface-1: #1a1a19; --line: #2e2e2c; --grid: #262624;
  --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #9a998f;
  --series-1: #3987e5; --warn-bg: #33280f; --warn-ink: #f2c25b;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text-primary);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 28px 0 10px; }
.sub { color: var(--text-secondary); font-size: 13px; }
.banner { background: var(--warn-bg); color: var(--warn-ink); border-radius: 10px; padding: 10px 14px;
  margin: 14px 0; font-size: 14px; }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 16px 0; }
.tile { background: var(--surface-1); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.tile b { display: block; font-size: 24px; font-variant-numeric: tabular-nums; line-height: 1.2; }
.tile span { font-size: 12px; color: var(--text-secondary); }
.tile small { display: block; font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.card { background: var(--surface-1); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.chart { position: relative; }
.chart svg { display: block; overflow: visible; }
.axis text { fill: var(--text-muted); font-size: 11px; }
.grid line { stroke: var(--grid); stroke-width: 1; }
.zero { stroke: var(--text-muted); stroke-width: 1; }
.series { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.cross { stroke: var(--text-muted); stroke-width: 1; }
.dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
.endlabel { fill: var(--text-primary); font-size: 12px; font-weight: 600; paint-order: stroke;
  stroke: var(--surface-1); stroke-width: 4px; stroke-linejoin: round; }
.tip { position: absolute; pointer-events: none; background: var(--surface-1); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 9px; font-size: 12px; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.12);
  display: none; }
.tip b { display: block; font-size: 14px; color: var(--text-primary); }
.tip span { color: var(--text-secondary); }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th:first-child, td:first-child { text-align: left; }
th { color: var(--text-secondary); font-weight: 600; }
.note { color: var(--text-secondary); font-size: 13px; }
details summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; margin-top: 8px; }
.scroll { overflow-x: auto; }
@media (max-width: 640px) { .tiles { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>
<div class="wrap">
  <h1>Historical edge: backtest</h1>
  <div class="sub" id="sub"></div>
  <div class="banner" id="banner"></div>

  <div class="tiles" id="tiles"></div>

  <h2>Profit over time, $<span id="stake"></span> per bet</h2>
  <div class="card chart" id="c1"></div>
  <p class="note">Each bet is booked when its market resolves. Flat stakes, so this shows the edge itself without compounding.</p>

  <h2>A $<span id="bank0"></span> bankroll at eighth-Kelly</h2>
  <div class="card chart" id="c2"></div>
  <p class="note" id="banknote"></p>

  <h2>By category</h2>
  <div class="card scroll"><table id="t-cat"></table></div>
  <h2>By price paid</h2>
  <div class="card scroll"><table id="t-price"></table></div>
  <p class="note">"Predicted" is what the historical table said these bets would win at the time. If "won" is far
    below "predicted", the past bias didn't carry forward.</p>
  <h2>By month</h2>
  <div class="card scroll"><table id="t-month"></table></div>

  <h2>How this was tested</h2>
  <div class="note" id="method"></div>
</div>

<script type="application/json" id="data">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById("data").textContent);
const $ = id => document.getElementById(id);
const money = x => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 0 });
const smoney = x => (x >= 0 ? "+" : "") + money(x);
const pct = (x, d = 1) => (x >= 0 ? "+" : "") + (x * 100).toFixed(d) + "%";
const upct = (x, d = 1) => (x * 100).toFixed(d) + "%";
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

$("sub").textContent = `Kalshi, ${D.start} to ${D.end} · walk-forward, no look-ahead`;
$("banner").textContent = D.label;
if (!/SYNTHETIC/.test(D.label)) $("banner").style.display = "none";
$("stake").textContent = D.flat.stake;
$("bank0").textContent = D.bankroll.start.toLocaleString();

const f = D.flat, bm = D.benchmark, br = D.bankroll;
const tiles = [
  [pct(f.roi, 2), "Return per $ staked", f.roi_ci95 ? `95% range ${pct(f.roi_ci95[0])} to ${pct(f.roi_ci95[1])}` : "too few events for a range"],
  [smoney(f.pnl), "Total profit, flat stakes", `${f.bets.toLocaleString()} bets · ${money(f.cost)} staked`],
  [pct(bm.roi, 2), "Benchmark: buy everything", `${bm.bets.toLocaleString()} bets, same price range`],
  [money(br.final), "Bankroll after compounding", `from ${money(br.start)} · worst drawdown ${upct(br.max_drawdown)}`],
];
for (const [v, label, small] of tiles) {
  const t = el("div", null, "tile"); t.append(el("b", v), el("span", label), el("small", small)); $("tiles").append(t);
}
$("banknote").textContent = `${br.placed.toLocaleString()} bets placed; ${br.skipped_too_small.toLocaleString()} skipped because `
  + `eighth-Kelly sized them below one contract or cash was tied up in open bets.`;

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => span / s <= n) || 10 * mag;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function lineChart(host, points, fmtY, zero) {
  if (!points.length) { host.append(el("p", "No bets in this period.", "note")); return; }
  host.replaceChildren();
  const NS = "http://www.w3.org/2000/svg", W = Math.max(300, host.clientWidth - 32), H = 260, L = 64, R = 16, T = 12, B = 28;
  const xs = points.map(p => Date.parse(p[0])), ys = points.map(p => p[1]);
  let y0 = Math.min(...ys, zero ?? Infinity), y1 = Math.max(...ys, zero ?? -Infinity);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const ticks = niceTicks(y0, y1); y0 = Math.min(y0, ticks[0]); y1 = Math.max(y1, ticks[ticks.length - 1]);
  const x0 = xs[0], x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];
  const X = t => L + (t - x0) / (x1 - x0) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", W); svg.setAttribute("height", H);
  svg.setAttribute("role", "img");
  const mk = (tag, attrs, parent = svg) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.append(e); return e; };
  const grid = mk("g", { class: "grid" }), axis = mk("g", { class: "axis" });
  for (const t of ticks) {
    mk("line", { x1: L, x2: W - R, y1: Y(t), y2: Y(t) }, grid);
    const tx = mk("text", { x: L - 8, y: Y(t) + 4, "text-anchor": "end" }, axis); tx.textContent = fmtY(t);
  }
  const years = new Set(), months = [];
  for (let d = new Date(x0); d.getTime() <= x1; d.setUTCMonth(d.getUTCMonth() + 1, 1)) months.push(new Date(d));
  const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(W / 110))));
  months.forEach((d, i) => {
    if (i % every) return;
    const tx = mk("text", { x: X(d.getTime()), y: H - 8, "text-anchor": "middle" }, axis);
    const label = d.toLocaleString(undefined, { month: "short", timeZone: "UTC" });
    tx.textContent = years.has(d.getUTCFullYear()) ? label : label + " " + d.getUTCFullYear();
    years.add(d.getUTCFullYear());
  });
  if (zero != null && zero > y0 && zero < y1) mk("line", { class: "zero", x1: L, x2: W - R, y1: Y(zero), y2: Y(zero) });
  mk("path", { class: "series", d: points.map((p, i) => (i ? "L" : "M") + X(xs[i]).toFixed(1) + "," + Y(ys[i]).toFixed(1)).join("") });
  const cross = mk("line", { class: "cross", y1: T, y2: H - B, visibility: "hidden" });
  const dot = mk("circle", { class: "dot", r: 5, visibility: "hidden" });
  const tip = el("div", null, "tip"), tv = el("b"), tl = el("span"); tip.append(tv, tl);
  host.append(svg, tip);
  // Last value labelled at the line end, haloed so the line never cuts through it.
  const ey = Y(ys[ys.length - 1]);
  const end = mk("text", { class: "endlabel", x: X(xs[xs.length - 1]) - 6,
                           y: ey - 10 < T + 12 ? ey + 20 : ey - 10, "text-anchor": "end" });
  end.textContent = fmtY(ys[ys.length - 1]);

  function show(clientX) {
    const r = svg.getBoundingClientRect(), vx = clientX - r.left;
    const t = x0 + (vx - L) / (W - L - R) * (x1 - x0);
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; xs[m] < t ? lo = m : hi = m; }
    const i = Math.abs(xs[lo] - t) < Math.abs(xs[hi] - t) ? lo : hi;
    cross.setAttribute("x1", X(xs[i])); cross.setAttribute("x2", X(xs[i])); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", X(xs[i])); dot.setAttribute("cy", Y(ys[i])); dot.setAttribute("visibility", "visible");
    tv.textContent = fmtY(ys[i]);
    tl.textContent = new Date(xs[i]).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    tip.style.display = "block";
    const px = X(xs[i]) + 16, py = Y(ys[i]) + 14;  // 16/14: card padding + border
    tip.style.left = Math.min(px + 12, W - tip.offsetWidth + 16) + "px";
    tip.style.top = Math.max(py - 44, 0) + "px";
  }
  function hide() { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.style.display = "none"; }
  svg.addEventListener("pointermove", e => show(e.clientX));
  svg.addEventListener("pointerleave", hide);
  svg.tabIndex = 0;
  svg.addEventListener("focus", () => { const r = svg.getBoundingClientRect(); show(r.right - 1); });
  svg.addEventListener("blur", hide);
}

const drawCharts = () => {
  lineChart($("c1"), D.flat_curve, v => smoney(v), 0);
  lineChart($("c2"), D.bank_curve, v => money(v), D.bankroll.start);
};
drawCharts();
let lastW = document.body.clientWidth;
addEventListener("resize", () => { if (document.body.clientWidth !== lastW) { lastW = document.body.clientWidth; drawCharts(); } });

function table(id, rows, first) {
  const t = $(id), head = el("tr");
  for (const h of [first, "Bets", "Staked", "Profit", "Return", "Won", "Predicted"]) head.append(el("th", h));
  t.append(head);
  for (const [k, v] of Object.entries(rows)) {
    const tr = el("tr");
    for (const c of [k, v.bets.toLocaleString(), money(v.cost), smoney(v.pnl), pct(v.roi, 2), upct(v.win_rate), upct(v.predicted_win_rate)])
      tr.append(el("td", c));
    t.append(tr);
  }
}
table("t-cat", D.by_category, "Category");
table("t-price", D.by_price, "Price paid");
table("t-month", D.by_month, "Month bet");

const c = D.config;
$("method").textContent = `For each month, the win-rate table was rebuilt from markets that closed before that month only. `
  + `A past taker trade at a price counts as proof that price was available. The strategy takes the first trade it would have `
  + `liked in each market and side, at most as many contracts as that trade had. Rules match the live scanner: edge after Kalshi's `
  + `${(c.fee_rate * 100).toFixed(0)}% fee formula of at least ${(c.min_edge * 100).toFixed(1)}¢ and ${c.sigma_mult} standard errors, prices `
  + `${c.min_price}–${c.max_price}¢, markets resolving within ${c.max_days} days. The benchmark buys the first trade of every market `
  + `in the same window with no filter. The 95% range resamples whole events, because bets in one event are linked. `
  + `Not modelled: competing for the same fills, price impact, and markets still unresolved when the data was collected.`;
</script>
</body>
</html>
"""
