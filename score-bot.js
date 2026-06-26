// score-bot.js — turns bias-feed.json (raw per-currency inputs) into per-pair
// fundamental scores, written as pair-scores.json. Pure local computation,
// NO external API calls (so it's free to run often). This mirrors the website's
// scoring model EXACTLY, so the in-chart indicator and the site always agree.
//
// Contract (set by runner.js): reads bias-feed.json from the same folder as
// FEED_OUT_PATH, and writes pair-scores.json to FEED_OUT_PATH.

import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.env.FEED_OUT_PATH || "./pair-scores.json");
const IN  = path.join(path.dirname(OUT), "bias-feed.json");

const ORDER = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];

// Per-currency baselines — used when the live feed omits a field.
// NOTE: `risk` (+1 risk-on beneficiary / -1 haven) is NOT in the feed, so it
// always comes from here, exactly as the website does it.
const fundBase = {
  USD: { rate: 4.50, lean: +1, yield: 4.30, cot: +30, risk: -1 },
  EUR: { rate: 2.75, lean: -1, yield: 2.48, cot: +62, risk: 0  },
  GBP: { rate: 4.25, lean: 0,  yield: 4.05, cot: +38, risk: 0  },
  JPY: { rate: 0.50, lean: +1, yield: 1.10, cot: -71, risk: -1 },
  AUD: { rate: 3.85, lean: 0,  yield: 4.20, cot: +12, risk: +1 },
  CAD: { rate: 2.75, lean: 0,  yield: 3.30, cot: -8,  risk: +1 },
  CHF: { rate: 0.25, lean: -1, yield: 0.60, cot: -22, risk: -1 },
  NZD: { rate: 3.25, lean: 0,  yield: 4.40, cot: +5,  risk: +1 },
};
const STRENGTH_DEFAULT = 50; // neutral
const clamp = (x) => Math.max(-1, Math.min(1, x));

function readFeed() {
  try { return JSON.parse(fs.readFileSync(IN, "utf8")); }
  catch { return {}; }
}

function build() {
  const bf = readFeed();
  const liveC = bf && bf.currencies ? bf.currencies : {};
  const REGIME = bf && typeof bf.regime === "number" ? bf.regime : +1;

  const fund = {}, st = {};
  for (const c of ORDER) {
    const base = fundBase[c], L = liveC[c] || {};
    fund[c] = {
      rate:  L.rate  ?? base.rate,
      lean:  L.lean  ?? base.lean,
      yield: L.yield ?? base.yield,
      cot:   L.cot   ?? base.cot,
      risk:  L.risk  ?? base.risk,
    };
    st[c] = typeof L.strength === "number" ? L.strength : STRENGTH_DEFAULT;
  }

  // factor weights — must match the website
  const WEIGHTS = [14, 12, 11, 12, 8, 9];
  const MAX = WEIGHTS.reduce((a, b) => a + b, 0); // 66

  function pairScore(b, q) {
    const B = fund[b], Q = fund[q];
    const contribs = [
      14 * clamp((B.rate  - Q.rate)  / 3),   // rate differential
      12 * clamp((B.lean  - Q.lean)  / 2),   // CB trajectory
      11 * clamp((B.yield - Q.yield) / 3),   // 10Y yield spread
      12 * clamp((st[b]   - st[q])   / 30),  // data momentum
      8  * clamp((B.cot   - Q.cot)   / 60),  // COT positioning
      9  * clamp(((B.risk - Q.risk) * REGIME) / 2), // risk sentiment
    ];
    return contribs.reduce((a, c) => a + c, 0);
  }

  const pairs = {};
  for (const b of ORDER) for (const q of ORDER) {
    if (b === q) continue;
    const total = pairScore(b, q);
    const bias = total >= 8 ? "Bullish" : total <= -8 ? "Bearish" : "Neutral";
    pairs[b + q] = { score: Math.round(total), bias, max: MAX };
  }

  return { updated: new Date().toISOString(), regime: REGIME, max: MAX, pairs };
}

const out = build();
const tmp = OUT + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(out));
fs.renameSync(tmp, OUT);
console.log(`wrote ${path.basename(OUT)} (${Object.keys(out.pairs).length} pairs, regime ${out.regime})`);
