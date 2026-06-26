// Polaris News Bot
// Polls free RSS sources, classifies each new item with Claude (currency, bias,
// impact, pairs, a rewritten headline + a "Polaris take" blurb), de-dupes, and
// writes news-feed.json in the shape the Polaris News Hub expects.
//
// Run continuously:   npm start
// Run a single pass:  npm run once
//
// See NEWS-BOT-SPEC.md for the full design. Copy .env.example -> .env first.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';

// ---------- config ----------
const {
  ANTHROPIC_API_KEY,
  FEED_OUT_PATH = './news-feed.json',
  POLL_SECONDS = '120',
  MAX_PER_CCY = '20',
  PUBLISH_MODE = 'auto',
  MIN_AUTO_IMPACT = 'Low',
  RUN_ONCE,
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY — copy .env.example to .env and set it.');
  process.exit(1);
}

const CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];
const IMPACT_RANK = { Low: 0, Med: 1, High: 2 };
const SEEN_PATH = './seen.json';
const QUEUE_PATH = './pending-queue.json';

// Free RSS sources — add/remove freely. More sources = more stories.
const SOURCES = [
  { source: 'Reuters Markets',   url: 'https://www.reutersagency.com/feed/?best-topics=markets&post_type=best' },
  { source: 'FXStreet',          url: 'https://www.fxstreet.com/rss/news' },
  { source: 'Investing.com',     url: 'https://www.investing.com/rss/news_1.rss' },
  { source: 'DailyFX',           url: 'https://www.dailyfx.com/feeds/market-news' },
  { source: 'Federal Reserve',   url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { source: 'ECB',               url: 'https://www.ecb.europa.eu/rss/press.html' },
  { source: 'Bank of England',   url: 'https://www.bankofengland.co.uk/rss/news' },
  { source: 'Bank of Canada',    url: 'https://www.bankofcanada.ca/content_type/press-releases/feed/' },
  // Add: RBA, BoJ, SNB, RBNZ, BLS, ONS, Eurostat, etc. (see spec)
];

const parser = new Parser({ timeout: 15000 });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------- helpers ----------
const readJson = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
};
const writeJsonAtomic = async (p, obj) => {
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, p); // atomic: site never reads a half-written file
};
const idFor = (source, link, title) =>
  crypto.createHash('sha1').update((source || '') + '|' + (link || title || '')).digest('hex').slice(0, 16);

// ---------- LLM classification ----------
const CLASSIFY_PROMPT = (item) => `You are a forex fundamentals analyst for "Polaris". Given a news item, classify it for our bias engine. Return ONLY valid JSON, no prose.

Input:
  headline: ${JSON.stringify(item.title || '')}
  summary:  ${JSON.stringify(item.summary || '')}
  source:   ${JSON.stringify(item.source || '')}
  url:      ${JSON.stringify(item.link || '')}
  time:     ${JSON.stringify(item.isoDate || '')}

Output JSON shape:
{
  "relevant": true,
  "ccy": "USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD",
  "dir": "up|down|flat",
  "impact": "High|Med|Low",
  "pairs": ["EUR/USD","USD/JPY"],
  "title": "<concise original rewrite of the headline, under 90 chars>",
  "blurb": "<1-2 sentences in your own words: what happened + why it's bull/bear for ccy. Never copy source text.>"
}

Rules:
- "relevant" is false if the item is not about FX or a major economy's macro/policy.
- "dir" is from the perspective of ccy: hawkish CB / strong data / rising yields = "up"; dovish / weak data / falling yields = "down"; mixed or minor = "flat".
- If multiple currencies feature, pick the one the story is MOST about as ccy.
- Use standard FX quote order for pairs (EUR>GBP>AUD>NZD>USD>CAD>CHF>JPY).`;

async function classify(item) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', // higher-quality rewrites (swap back to 'claude-3-5-haiku-latest' for cheaper/faster)
    max_tokens: 400,
    messages: [{ role: 'user', content: CLASSIFY_PROMPT(item) }],
  });
  const text = msg.content?.[0]?.type === 'text' ? msg.content[0].text : '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let out;
  try { out = JSON.parse(m[0]); } catch { return null; }
  if (!out.relevant || !CCYS.includes(out.ccy)) return null;
  if (!['up', 'down', 'flat'].includes(out.dir)) out.dir = 'flat';
  if (!['High', 'Med', 'Low'].includes(out.impact)) out.impact = 'Low';
  return out;
}

// ---------- one ingest pass ----------
async function runOnce() {
  const seen = await readJson(SEEN_PATH, {});           // { id: true }
  const feed = await readJson(FEED_OUT_PATH, { stories: [] });
  const queue = await readJson(QUEUE_PATH, { stories: [] });
  const existing = (PUBLISH_MODE === 'review' ? queue.stories : feed.stories) || [];

  // 1. collect
  const raw = [];
  for (const src of SOURCES) {
    try {
      const f = await parser.parseURL(src.url);
      for (const it of f.items.slice(0, 25)) {
        raw.push({
          source: src.source,
          title: it.title,
          summary: (it.contentSnippet || it.content || '').slice(0, 500),
          link: it.link,
          isoDate: it.isoDate || new Date().toISOString(),
        });
      }
    } catch (e) {
      console.warn('source failed:', src.source, e.message);
    }
  }

  // 2. dedupe + classify new items
  const fresh = [];
  for (const item of raw) {
    const id = idFor(item.source, item.link, item.title);
    if (seen[id]) continue;
    seen[id] = true;
    const tag = await classify(item);
    if (!tag) continue;
    if (PUBLISH_MODE === 'auto' && IMPACT_RANK[tag.impact] < IMPACT_RANK[MIN_AUTO_IMPACT]) continue;
    fresh.push({
      id,
      ccy: tag.ccy,
      dir: tag.dir,
      impact: tag.impact,
      source: item.source,
      url: item.link,
      publishedAt: item.isoDate,
      title: tag.title || item.title,
      blurb: tag.blurb || '',
      pairs: Array.isArray(tag.pairs) ? tag.pairs.slice(0, 3) : [],
    });
  }
  console.log(`fetched ${raw.length}, new classified ${fresh.length}`);

  // 3. merge, cap per currency, write
  const merged = [...fresh, ...existing];
  const byCcy = {};
  for (const s of merged) (byCcy[s.ccy] ||= []).push(s);
  const kept = [];
  for (const c of CCYS) {
    (byCcy[c] || [])
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, Number(MAX_PER_CCY))
      .forEach((s) => kept.push(s));
  }
  kept.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const payload = { updated: new Date().toISOString(), stories: kept };
  if (PUBLISH_MODE === 'review') {
    await writeJsonAtomic(QUEUE_PATH, payload);
    console.log(`wrote ${kept.length} stories to ${QUEUE_PATH} (awaiting approval)`);
  } else {
    await writeJsonAtomic(path.resolve(FEED_OUT_PATH), payload);
    console.log(`wrote ${kept.length} stories to ${FEED_OUT_PATH}`);
  }
  await writeJsonAtomic(SEEN_PATH, seen);
}

// ---------- loop ----------
async function main() {
  await runOnce();
  if (RUN_ONCE) return;
  const ms = Number(POLL_SECONDS) * 1000;
  setInterval(() => runOnce().catch((e) => console.error('pass failed:', e)), ms);
  console.log(`polling every ${POLL_SECONDS}s …`);
}
main().catch((e) => { console.error(e); process.exit(1); });
