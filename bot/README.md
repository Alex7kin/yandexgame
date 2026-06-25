# Bike Courier — Telegram Games backend

A Cloudflare Worker behind the [Game Zone](https://alex7kin.github.io/yandexgame/)
mini-games. It gives the **ranked** game a Telegram **native leaderboard** (via
`setGameScore`), and records the **best score per player per game** for *every*
game in a **D1** database — viewable on a secret-gated dashboard.

```text
Player taps "Play"  ─▶  Telegram asks the Worker for a URL
Worker  ─▶  game URL + signed identity token (?t=…&b=<worker>)   (token carries user id + name)
Game over  ─▶  browser POSTs {t, g, score} to  <worker>/score
Worker  ─▶  D1 upsert  (best per game+player, all games)
        └▶  setGameScore  ─▶  Telegram board   (ranked game only)
Owner   ─▶  <worker>/scores?key=<WEBHOOK_SECRET>   (dashboard of all bests)
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

## Central scores database (D1, once)

Creates the SQLite DB that holds every player's best in every game.

```bash
cd bot
npx wrangler d1 create gamezone           # prints a database_id — paste it into wrangler.toml
npx wrangler d1 execute gamezone --remote --file=schema.sql   # create the table
npx wrangler deploy                        # redeploy with the DB bound
```

Until the `database_id` is filled in, the Worker still runs — it just skips the
central store (Telegram scoring keeps working).

**View the dashboard:** open `https://yandexgame-bot.<you>.workers.dev/scores?key=<WEBHOOK_SECRET>`
— a table of each player's best per game.

## Register the webhook (once)

Open in a browser (replace the host and key):

```text
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

Also: **`RANKED_GAME`** — id of the game that updates Telegram's native board
(**must match `RANKED_GAME` in `app.js`**); and **`OWNER_ID`** — your Telegram user
id, the only one allowed to run `/reset`.

## Note on score trust

Scores are reported by the browser, so a determined player could submit an inflated score
for **their own** session. The signed token prevents setting scores for *other* users or
forging sessions, which is enough for a casual leaderboard. True anti-cheat would require
simulating the run server-side — out of scope here.
