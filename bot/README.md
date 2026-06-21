# Bike Courier — Telegram Games backend

A tiny Cloudflare Worker that turns the [Bike Courier](https://alex7kin.github.io/yandexgame/)
HTML5 game into a Telegram game with a **native leaderboard**. Telegram stores the
high scores for you (via `setGameScore` / `getGameHighScores`), so there's no database.

```
Player taps "Play"  ─▶  Telegram asks the Worker for a URL
Worker  ─▶  game URL + signed identity token (?t=…&b=<worker>)
Game over  ─▶  browser POSTs {t, score} to  <worker>/score
Worker  ─▶  setGameScore  ─▶  Telegram updates the leaderboard message
```

## What you do once (in @BotFather)

1. Open **@BotFather → /newgame**, pick your bot, then set:
   - **title** (e.g. `Bike Courier`), **description**, and a **photo** (the preview image).
   - **short name**: `bikecourier`  ← must match `GAME_SHORT_NAME` in `wrangler.toml`.
2. (Inline sharing is already enabled on your bot. If not: **/setinline** → a placeholder.)

You do **not** set the game URL in BotFather — the Worker supplies it at Play time.

## Deploy the Worker

Requires Node + a free Cloudflare account.

```bash
cd bot
npm install
npx wrangler login

# Secrets (never commit these):
npx wrangler secret put BOT_TOKEN        # the @BotFather token
npx wrangler secret put SIGNING_SECRET   # any long random string
npx wrangler secret put WEBHOOK_SECRET   # any long random string

npx wrangler deploy                      # prints your URL, e.g. https://yandexgame-bot.<you>.workers.dev
```

Generate random secrets with: `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`

## Register the webhook (once)

Open in a browser (replace the host and key):

```
https://yandexgame-bot.<you>.workers.dev/init?key=<WEBHOOK_SECRET>
```

You should see `{"setWebhook":{"ok":true,...}}`. The Worker only accepts updates that
carry the matching secret header, so the webhook is locked to Telegram.

## Try it

In Telegram, open your bot and send **/play** → tap **Play** → finish a run → your score
appears on the message's leaderboard. Type `@yandexGame0_0bot` in any chat to share it.

## Config (`wrangler.toml` → `[vars]`)

| var               | meaning                                            |
|-------------------|----------------------------------------------------|
| `GAME_SHORT_NAME` | must equal the short name from BotFather           |
| `GAME_URL`        | where the game is hosted (gh-pages)                |
| `ALLOWED_ORIGIN`  | the game's origin, for CORS on `/score`            |
| `BOT_USERNAME`    | used only in the help text                         |

## Note on score trust

Scores are reported by the browser, so a determined player could submit an inflated score
for **their own** session. The signed token prevents setting scores for *other* users or
forging sessions, which is enough for a casual leaderboard. True anti-cheat would require
simulating the run server-side — out of scope here.
