// Bearing Bias Bot
// Keeps bias-feed.json fresh from free data sources, matching BIAS-FEED-SPEC.md.
// Pattern mirrors news-bot: a Node collector that writes its JSON file atomically.
//
//   Run continuously:  npm start
//   Run a single pass: npm run once
//
// Every field is optional per-currency — the site falls back to its model for
// anything missing — so each source is wrapped so one failure never blanks the feed.

import fs from "node:fs/promises";
import path from "node:path";

const {
  FRED_API_KEY,
  FEED_OUT_PATH = "./bias-feed.json",
  POLL_SECONDS = "21600", // 6h; bias data changes slowly
  RUN_ONCE,
} = process.env;

const CCYS = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];

// ── 1. Policy rate + lean: HAND-MAINTAINED TABLE ──────────────────────────
// Update `rate` on each central bank's decision day, and `lean` to match the
// guidance (1 hawkish/hiking, 0 on-hold, -1 dovish/cutting). Seeded from the
// sample file — VERIFY these against current policy before you rely on them.
const RATES = {
  USD: { rate: 4.5, lean: 1 },
  EUR: { rate: 2.75, lean: -1 },
  GBP: { rate: 4.25, lean: 0 },
  JPY: { rate: 0.5, lean: 1 },
  AUD: { rate: 3.85, lean: 0 },
  CAD: { rate: 2.75, lean: 0 },
  CHF: { rate: 0.25, lean: -1 },
  NZD: { rate: 3.25, lean: 0 },
};

// ── 2. Yields: FRED 10Y per currency ──────────────────────────────────────
// US uses the daily 10Y (DGS10); others use OECD 10Y series. VERIFY each ID at
// fred.stlouisfed.org — a missing one is just skipped (yield falls back).
const YIELD_SERIES = {
  USD: "DGS10",
  EUR: "IRLTLT01DEM156N",
  GBP: "IRLTLT01GBM156N",
  JPY: "IRLTLT01JPM156N",
  AUD: "IRLTLT01AUM156N",
  CAD: "IRLTLT01CAM156N",
  CHF: "IRLTLT01CHM156N",
  NZD: "IRLTLT01NZM156N",
};

// ── 3. COT: CFTC Legacy Futures-Only (free, no key) ───────────────────────
const COT_MARKETS = {
  USD: "U.S. DOLLAR INDEX",
  EUR: "EURO FX",
  GBP: "BRITISH POUND",
  JPY: "JAPANESE YEN",
  AUD: "AUSTRALIAN DOLLAR",
  CAD: "CANADIAN DOLLAR",
  CHF: "SWISS FRANC",
  NZD: "NEW ZEALAND DOLLAR",
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const writeJsonAtomic = async (p, obj) => {
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, p); // site never reads a half-written file
};

async function fetchYield(seriesId) {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: FRED_API_KEY,
    file_type: "json",
    sort_order: "desc",
    limit: "12",
  });
  const res = await fetch(`https://api.stlouisfed.org/fred/series/observations?${params}`);
  if (!res.ok) throw new Error(`FRED ${res.status}`);
  const j = await res.json();
  const o = (j.observations ?? []).find((x) => x.value && x.value !== ".");
  return o ? Number(o.value) : null;
}

async function fetchCot(substr) {
  const params = new URLSearchParams({
    $where: `market_and_exchange_names like '%${substr}%'`,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: "1",
  });
  const res = await fetch(`https://publicreporting.cftc.gov/resource/6dca-aqww.json?${params}`);
  if (!res.ok) throw new Error(`CFTC ${res.status}`);
  const rows = await res.json();
  const r = rows[0];
  if (!r) return null;
  const net = num(r.noncomm_positions_long_all) - num(r.noncomm_positions_short_all);
  const oi = num(r.open_interest_all);
  if (!oi) return null;
  return clamp(Math.round((net / oi) * 100), -100, 100); // % of open interest
}

// ── 4. Strength: price momentum vs USD from Frankfurter (free, ECB, no key) ─
// Simple 20-day momentum proxy mapped to 0..100 (50 = neutral). Refine later.
async function fetchStrength() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 864e5);
  const iso = (d) => d.toISOString().slice(0, 10);
  const symbols = CCYS.filter((c) => c !== "USD").join(",");
  const res = await fetch(
    `https://api.frankfurter.dev/v1/${iso(start)}..${iso(end)}?base=USD&symbols=${symbols}`
  );
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
  const j = await res.json();
  const dates = Object.keys(j.rates ?? {}).sort();
  if (dates.length < 2) throw new Error("not enough FX history");
  const first = j.rates[dates[0]];
  const last = j.rates[dates[dates.length - 1]];

  const out = {};
  const othersPct = [];
  for (const c of CCYS) {
    if (c === "USD") continue;
    // USD->c: if rate falls, c strengthened vs USD.
    const pct = (first[c] - last[c]) / first[c]; // + = c stronger vs USD
    out[c] = clamp(Math.round(50 + pct * 600), 0, 100);
    othersPct.push(pct);
  }
  // USD strength = inverse of the basket's move vs USD.
  const usdPct = -othersPct.reduce((a, b) => a + b, 0) / othersPct.length;
  out.USD = clamp(Math.round(50 + usdPct * 600), 0, 100);
  return out;
}

// ── 5. Regime: VIX from FRED (low vol = risk-on) ──────────────────────────
async function fetchRegime() {
  const vix = await fetchYield("VIXCLS"); // reuse the FRED observation fetcher
  if (vix == null) return null;
  return vix < 20 ? 1 : -1;
}

async function runOnce() {
  const currencies = {};
  for (const c of CCYS) currencies[c] = { ...RATES[c] }; // rate + lean

  // yields
  if (FRED_API_KEY) {
    for (const c of CCYS) {
      try {
        const y = await fetchYield(YIELD_SERIES[c]);
        if (y != null) currencies[c].yield = y;
      } catch (e) {
        console.warn(`yield ${c}:`, e.message);
      }
    }
  } else {
    console.warn("No FRED_API_KEY — skipping yields (site falls back).");
  }

  // cot
  for (const c of CCYS) {
    try {
      const cot = await fetchCot(COT_MARKETS[c]);
      if (cot != null) currencies[c].cot = cot;
    } catch (e) {
      console.warn(`cot ${c}:`, e.message);
    }
  }

  // strength
  try {
    const s = await fetchStrength();
    for (const c of CCYS) if (s[c] != null) currencies[c].strength = s[c];
  } catch (e) {
    console.warn("strength:", e.message);
  }

  // regime
  let regime = null;
  if (FRED_API_KEY) {
    try {
      regime = await fetchRegime();
    } catch (e) {
      console.warn("regime:", e.message);
    }
  }

  const payload = { updated: new Date().toISOString(), currencies };
  if (regime != null) payload.regime = regime;

  await writeJsonAtomic(path.resolve(FEED_OUT_PATH), payload);
  console.log(`wrote bias-feed.json (regime ${payload.regime ?? "—"})`);
}

async function main() {
  await runOnce();
  if (RUN_ONCE) return;
  setInterval(() => runOnce().catch((e) => console.error("pass failed:", e)), Number(POLL_SECONDS) * 1000);
  console.log(`bias bot polling every ${POLL_SECONDS}s …`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
