// Bearing/Macrobias — combined runner (flat, no-subfolders layout)
// Runs the three collectors on schedule and serves the three feeds over HTTP.
//
//   node runner.js
//
// Env (set in your host's dashboard):
//   SITE_DIR  folder holding/serving the feeds (default "." = this folder)
//   SERVE=1   serve the feeds over HTTP (host sets PORT automatically)
//   FEED_ALLOW_ORIGIN  your site's domain, or "*"
//   ANTHROPIC_API_KEY / FRED_API_KEY  passed to the bots
//   PUBLISH_MODE=auto  NEWS_EVERY_SECONDS=120  SLOW_EVERY_SECONDS=21600

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const SITE_DIR = path.resolve(process.env.SITE_DIR || ".");
const NEWS_EVERY = Number(process.env.NEWS_EVERY_SECONDS || 120) * 1000;
const SLOW_EVERY = Number(process.env.SLOW_EVERY_SECONDS || 21600) * 1000;
const SCORES_EVERY = Number(process.env.SCORES_EVERY_SECONDS || 600) * 1000; // cheap/local, no API

const JOBS = [
  { name: "news", script: "news-bot.js", feed: "news-feed.json", every: NEWS_EVERY },
  { name: "bias", script: "bias-bot.js", feed: "bias-feed.json", every: SLOW_EVERY },
  { name: "calendar", script: "calendar-bot.js", feed: "calendar-feed.json", every: SLOW_EVERY },
  { name: "scores", script: "score-bot.js", feed: "pair-scores.json", every: SCORES_EVERY },
];

function runJob(job) {
  const child = spawn("node", [job.script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RUN_ONCE: "1",
      FEED_OUT_PATH: path.join(SITE_DIR, job.feed),
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code !== 0) console.error(`[${job.name}] pass exited with ${code}`);
  });
  child.on("error", (e) => console.error(`[${job.name}] failed to start:`, e.message));
}

for (const job of JOBS) {
  runJob(job);
  setInterval(() => runJob(job), job.every);
  console.log(`[${job.name}] scheduled every ${job.every / 1000}s -> ${job.feed}`);
}

if (process.env.SERVE === "1") {
  const PORT = Number(process.env.PORT || 8080);
  const ALLOW_ORIGIN = process.env.FEED_ALLOW_ORIGIN || "*";
  const TYPES = { ".json": "application/json", ".js": "text/javascript", ".html": "text/html" };

  http
    .createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/") urlPath = "/index.html";
      const filePath = path.join(SITE_DIR, urlPath);
      if (!filePath.startsWith(SITE_DIR)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end("Not found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const headers = { "content-type": TYPES[ext] || "application/octet-stream" };
        if (/(-feed|pair-scores)\.json$/.test(urlPath)) {
          headers["cache-control"] = "no-store";
          headers["access-control-allow-origin"] = ALLOW_ORIGIN;
        }
        res.writeHead(200, headers).end(data);
      });
    })
    .listen(PORT, () => console.log(`serving ${SITE_DIR} on :${PORT}`));
}
