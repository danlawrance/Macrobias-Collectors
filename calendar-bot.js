// Bearing Calendar Bot
// Keeps calendar-feed.json fresh, matching CALENDAR-FEED-SPEC.md.
//
//   Run continuously:  npm start
//   Run a single pass: npm run once
//
// ─────────────────────────────────────────────────────────────────────────
// IMPORTANT — about the data source (read before going live commercially):
//
// This uses Forex Factory's free weekly calendar JSON. It is the only FREE
// source that includes consensus FORECASTS. BUT:
//   • The data is © Fair Economy (Forex Factory) — redistributing it on a
//     PAID product is a copyright/terms grey area. Verify their terms, or
//     swap `fetchSource()` for a licensed paid API (TradingEconomics / Finnhub
//     / FMP, ~£30–80/mo) — that's the clean long-term answer.
//   • It is rate-limited (~2 requests / 5 min). We poll every 6h, well under.
//   • It only covers the CURRENT week, which suits the Today/Tomorrow/weekday view.
//
// To switch sources later, replace ONLY fetchSource() — the rest is generic.
// ─────────────────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";

const {
  FEED_OUT_PATH = "./calendar-feed.json",
  POLL_SECONDS = "21600", // 6h
  RUN_ONCE,
} = process.env;

const CCYS = new Set(["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]);
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

const writeJsonAtomic = async (p, obj) => {
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, p);
};

// London-timezone helpers (the site displays GMT/London).
const londonParts = (d) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  }).formatToParts(d).reduce((o, p) => ((o[p.type] = p.value), o), {});

const dateKey = (d) => {
  const p = londonParts(d);
  return `${p.year}-${p.month}-${p.day}`;
};

function dayBucket(eventDate, now) {
  const a = dateKey(eventDate);
  const today = dateKey(now);
  const tomorrow = dateKey(new Date(now.getTime() + 864e5));
  if (a === today) return "Today";
  if (a === tomorrow) return "Tomorrow";
  return londonParts(eventDate).weekday; // Mon..Sun
}

const parseNum = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/k/i.test(s)) n *= 1e3;
  if (/m/i.test(s)) n *= 1e6;
  if (/b/i.test(s)) n *= 1e9;
  return n;
};

// Light heuristic for `lean`: forecast vs prior, signed by event type.
// Higher inflation/jobs/growth/rates = bullish; higher unemployment = bearish.
function computeLean(title, fcst, prior) {
  const f = parseNum(fcst), p = parseNum(prior);
  if (f == null || p == null || f === p) return 0;
  const bearishWhenUp = /unemploy|jobless/i.test(title);
  const dir = f > p ? 1 : -1;
  return bearishWhenUp ? -dir : dir;
}

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// ── The only source-specific function. Swap this to change providers. ──
async function fetchSource() {
  const res = await fetch(FF_URL, { headers: { "user-agent": "bearing-calendar-bot" } });
  if (!res.ok) throw new Error(`ForexFactory ${res.status}`);
  const items = await res.json();
  return items.map((it) => ({
    ccy: it.country,
    title: it.title,
    impact: it.impact, // High | Medium | Low | Holiday
    date: it.date, // ISO 8601 with offset
    fcst: it.forecast,
    prior: it.previous,
  }));
}

async function runOnce() {
  const now = new Date();
  let raw;
  try {
    raw = await fetchSource();
  } catch (e) {
    console.error("source fetch failed:", e.message);
    return; // leave existing file; site falls back if empty
  }

  const seen = new Set();
  const events = [];
  for (const r of raw) {
    if (!CCYS.has(r.ccy)) continue;
    const impact = r.impact === "Medium" ? "Med" : r.impact;
    if (impact !== "High" && impact !== "Med") continue; // High/Med only

    const d = new Date(r.date);
    if (isNaN(d)) continue;
    const id = `${r.ccy}-${slug(r.title)}-${dateKey(d)}`.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);

    const p = londonParts(d);
    events.push({
      id,
      day: dayBucket(d, now),
      time: `${p.hour}:${p.minute}`,
      ccy: r.ccy,
      title: r.title,
      impact,
      fcst: r.fcst ? String(r.fcst) : "—",
      prior: r.prior ? String(r.prior) : "—",
      lean: computeLean(r.title, r.fcst, r.prior),
    });
  }

  await writeJsonAtomic(path.resolve(FEED_OUT_PATH), {
    updated: now.toISOString(),
    events,
  });
  console.log(`wrote calendar-feed.json (${events.length} events)`);
}

async function main() {
  await runOnce();
  if (RUN_ONCE) return;
  setInterval(() => runOnce().catch((e) => console.error("pass failed:", e)), Number(POLL_SECONDS) * 1000);
  console.log(`calendar bot polling every ${POLL_SECONDS}s …`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
