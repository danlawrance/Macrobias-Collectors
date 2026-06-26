# macrobias-collectors (flat layout)

Always-on Node service: runs the news, bias and calendar collectors and serves
the three feeds over HTTP. No subfolders — every file sits at the top level so it
uploads cleanly to GitHub from any device (including iPad).

## Deploy on Render (free Hobby workspace + Starter instance, ~$7/mo)
- Build Command: `npm install`
- Start Command: `node runner.js`
- Instance: Starter (always-on)
- Env vars: SITE_DIR=.  SERVE=1  FEED_ALLOW_ORIGIN=https://macrobias.com
  ANTHROPIC_API_KEY  FRED_API_KEY  PUBLISH_MODE=auto  NEWS_EVERY_SECONDS=120
- Feeds are then served at  https://YOUR-SERVICE.onrender.com/news-feed.json  etc.

## Before "real" data
- Set real central-bank policy rates in `bias-bot.js` (the RATES table).
- Keys go in Render's dashboard, never committed (.gitignore covers .env).
