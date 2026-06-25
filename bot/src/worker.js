/* ============================================================
   Bike Courier — Telegram Games backend (Cloudflare Worker)

   Responsibilities
   - /webhook : receive Telegram updates (commands, Play taps, inline).
   - /score   : receive a finished game's score from the browser. Records the best
                per (game, player) in D1, and updates Telegram's native board for
                the ranked game.
   - /scores  : secret-gated HTML dashboard of every player's best in every game.
   - /init    : one-time helper to register the webhook (guarded by a secret).

   Storage: a D1 table `scores` holds the central best-per-player-per-game; Telegram
   still keeps the native high-score table for the one ranked game.
   No secrets in code: BOT_TOKEN / SIGNING_SECRET / WEBHOOK_SECRET come from
   Worker secrets (`wrangler secret put ...`).
   ============================================================ */

import { ChessMatch } from "./chess-match.js";
export { ChessMatch };   // the Durable Object class must be exported from the entry module

// Pretty names for the dashboard; falls back to the raw id.
const GAME_TITLES = { bikecourier: "Bike Courier", stack: "Stack", "2048": "2048", chess: "Chess" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- CORS preflight for the browser score POST ---
    if (request.method === "OPTIONS" && path === "/score") {
      return cors(env, new Response(null, { status: 204 }));
    }

    // --- Score submission from the game (browser) ---
    if (path === "/score" && request.method === "POST") {
      return handleScore(request, env);
    }

    // --- Chess: WebSocket into a match's Durable Object ---
    if (path === "/chess/ws") {
      return handleChessWs(request, env, url);
    }

    // --- Telegram webhook ---
    if (path === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      try { await handleUpdate(update, env, url.origin); } catch (e) { /* never fail the webhook */ }
      return new Response("ok");
    }

    // --- Admin dashboard of central scores: GET /scores?key=WEBHOOK_SECRET ---
    if (path === "/scores" && request.method === "GET") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      return scoresPage(env);
    }

    // --- One-time webhook registration: GET /init?key=WEBHOOK_SECRET ---
    if (path === "/init" && request.method === "GET") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const hookUrl = `${url.origin}/webhook`;
      const r = await tg(env, "setWebhook", {
        url: hookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query", "inline_query"],
      });
      return json({ hookUrl, setWebhook: r });
    }

    if (path === "/") return new Response("Bike Courier bot worker is running.");
    return new Response("not found", { status: 404 });
  },
};

// ============================================================
//  Telegram update handling
// ============================================================
async function handleUpdate(update, env, selfOrigin) {
  if (update.callback_query) return onCallback(update.callback_query, env, selfOrigin);
  if (update.inline_query)   return onInline(update.inline_query, env);
  if (update.message)        return onMessage(update.message, env);
}

async function onMessage(msg, env) {
  const text = (msg.text || "").trim();

  // Owner-only leaderboard reset (gated by user id, not chat-admin status).
  if (/^\/reset(@\w+)?(\s|$)/.test(text)) {
    return onReset(msg, env);
  }

  // Only /play or /start (optionally addressed as /play@botname) launches the game.
  if (/^\/(start|play)(@\w+)?(\s|$)/.test(text)) {
    return tg(env, "sendGame", { chat_id: msg.chat.id, game_short_name: env.GAME_SHORT_NAME });
  }

  // Stay silent on everything else (replies, group chatter, mentions). Offer help
  // only in a private 1:1 chat so the bot never spams a group.
  if (msg.chat.type === "private") {
    const uname = env.BOT_USERNAME ? "@" + env.BOT_USERNAME : "this bot";
    return tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      text:
        "🚴 Bike Courier\n\n" +
        "Send /play to play and set your high score.\n" +
        "Type " + uname + " in any chat to challenge your friends — everyone who plays " +
        "from the same message shares one leaderboard.\n\n"
    });
  }
}

// Owner-only: clear a game's leaderboard. The owner REPLIES to the game message
// with /reset; every player on that board is force-set back to 0. Telegram has no
// "wipe board" call and refuses to lower a score unless force:true is passed.
async function onReset(msg, env) {
  // Strict identity gate — anyone who isn't the owner gets no response at all,
  // so the command is effectively invisible to the rest of the chat.
  if (!env.OWNER_ID || !msg.from || String(msg.from.id) !== String(env.OWNER_ID)) {
    return;
  }

  const reply = msg.reply_to_message;
  if (!reply) {
    return tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      reply_to_message_id: msg.message_id,
      text: "Reply to the game message with /reset to clear that leaderboard.",
    });
  }

  const chat_id = msg.chat.id;
  const message_id = reply.message_id;

  // Ask Telegram who's on this board (the requester + their neighbours — enough
  // to cover a friends-sized chat). Then drive every score to 0.
  const hs = await tg(env, "getGameHighScores", { user_id: msg.from.id, chat_id, message_id });
  const scores = hs && hs.ok && Array.isArray(hs.result) ? hs.result : [];

  let cleared = 0;
  for (const row of scores) {
    const r = await tg(env, "setGameScore", {
      user_id: row.user.id, score: 0, force: true, chat_id, message_id,
    });
    if (r.ok) cleared++;
  }

  return tg(env, "sendMessage", {
    chat_id,
    reply_to_message_id: msg.message_id,
    text: cleared
      ? `✅ Leaderboard reset (${cleared} player${cleared === 1 ? "" : "s"} zeroed).`
      : "Nothing to reset on that message — make sure you replied to the game post.",
  });
}

// Play button tapped -> answer with the game URL (carrying a signed identity token
// and the backend's own URL so the game knows where to POST its score).
async function onCallback(cq, env, selfOrigin) {
  if (!cq.game_short_name) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }
  // Carry the player's display name in the signed token so the dashboard can show
  // names, not just numeric ids. HMAC-signed, so it can't be tampered with.
  const payload = { u: cq.from.id, n: (cq.from.first_name || cq.from.username || "Player").slice(0, 40) };
  if (cq.message) { payload.c = cq.message.chat.id; payload.m = cq.message.message_id; }
  else if (cq.inline_message_id) { payload.i = cq.inline_message_id; }

  const token = await signToken(env, payload);
  const sep = env.GAME_URL.includes("?") ? "&" : "?";
  const gameUrl = `${env.GAME_URL}${sep}t=${encodeURIComponent(token)}&b=${encodeURIComponent(selfOrigin)}`;
  return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, url: gameUrl });
}

// Inline mode: let users drop the game into any chat.
async function onInline(iq, env) {
  return tg(env, "answerInlineQuery", {
    inline_query_id: iq.id,
    cache_time: 1,
    results: [{ type: "game", id: "bikecourier", game_short_name: env.GAME_SHORT_NAME }],
  });
}

// ============================================================
//  Score submission (from the game running in the browser)
// ============================================================
async function handleScore(request, env) {
  let body;
  try { body = await request.json(); } catch { return cors(env, json({ ok: false, error: "bad json" }, 400)); }

  const token = body && body.t;
  // Default a missing game id to the ranked game, so an older frontend (which only
  // ever posted the ranked game's score, without `g`) keeps working before redeploy.
  const gameId = String((body && body.g) || env.RANKED_GAME || "").trim();
  let score = Math.floor(Number(body && body.score));
  if (typeof token !== "string") return cors(env, json({ ok: false, error: "missing token" }, 400));
  if (!/^[a-z0-9_-]{1,32}$/i.test(gameId)) return cors(env, json({ ok: false, error: "bad game" }, 400));
  if (!Number.isFinite(score) || score < 0 || score > 10_000_000) {
    return cors(env, json({ ok: false, error: "bad score" }, 400));
  }

  const payload = await verifyToken(env, token);
  if (!payload || !payload.u) return cors(env, json({ ok: false, error: "bad token" }, 403));

  // Central store: keep the best per (game, player) for every game.
  await recordScore(env, gameId, payload.u, payload.n, score);

  // Telegram's native board only exists for the ranked game's message, so only
  // forward there for that game (the Worker decides — a client can't fake it).
  if (gameId === env.RANKED_GAME) {
    const params = { user_id: payload.u, score };
    if (payload.i) params.inline_message_id = payload.i;
    else { params.chat_id = payload.c; params.message_id = payload.m; }
    if (params.inline_message_id || (params.chat_id && params.message_id)) {
      const r = await tg(env, "setGameScore", params);
      // setGameScore errors when the new score isn't higher than the stored one — that's fine.
      const notHigher = r.description && /not.*modified/i.test(r.description);
      if (!r.ok && !notHigher) {
        return cors(env, json({ ok: false, error: r.description || "telegram error" }));
      }
    }
  }
  return cors(env, json({ ok: true, score }));
}

// Chess: verify identity, then proxy the WebSocket upgrade to the match's DO.
async function handleChessWs(request, env, url) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const matchId = (url.searchParams.get("m") || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(matchId)) return new Response("bad match id", { status: 400 });

  // Identity: a signed token (real Telegram user) if present, else a guest id the
  // client keeps per tab — enough to seat two distinct players for testing.
  let uid = null, name = "Player";
  const token = url.searchParams.get("t");
  if (token) {
    const p = await verifyToken(env, token);
    if (p && p.u) { uid = "u" + p.u; name = p.n || "Player"; }
  }
  if (!uid) {
    const g = (url.searchParams.get("guest") || "").slice(0, 40);
    uid = "g" + (g || crypto.randomUUID());
    name = "Guest";
  }

  const stub = env.CHESS.get(env.CHESS.idFromName(matchId));
  const doUrl = new URL("https://chess-do/ws");
  doUrl.searchParams.set("uid", uid);
  doUrl.searchParams.set("name", name);
  return stub.fetch(new Request(doUrl, request));   // carries the Upgrade header
}

// Upsert the best score for a (game, player) into D1. No-op until D1 is bound,
// so scoring keeps working before the database is set up.
async function recordScore(env, gameId, userId, name, score) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO scores (game_id, user_id, name, best, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(game_id, user_id) DO UPDATE SET
         best       = MAX(scores.best, excluded.best),
         name       = excluded.name,
         updated_at = excluded.updated_at`
    ).bind(gameId, userId, name || null, score, Date.now()).run();
  } catch (_) { /* never let storage break scoring */ }
}

// Secret-gated HTML table of every player's best in every game.
async function scoresPage(env) {
  if (!env.DB) return new Response("D1 not configured yet (bind 'DB' in wrangler.toml).", { status: 500 });
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT game_id, name, user_id, best, updated_at
         FROM scores ORDER BY game_id ASC, best DESC, updated_at ASC`
    ).all();
    rows = res.results || [];
  } catch (e) {
    return new Response("query failed: " + (e && e.message), { status: 500 });
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const byGame = {};
  for (const row of rows) { (byGame[row.game_id] = byGame[row.game_id] || []).push(row); }

  let sections = "";
  for (const g of Object.keys(byGame).sort()) {
    const title = GAME_TITLES[g] || g;
    const ranked = g === env.RANKED_GAME ? ' <span class="rk">RANKED</span>' : "";
    let trs = "";
    byGame[g].forEach((row, i) => {
      const when = new Date(row.updated_at || 0).toISOString().slice(0, 10);
      trs += `<tr><td>${i + 1}</td><td>${esc(row.name || row.user_id)}</td><td>${row.best}</td><td>${when}</td></tr>`;
    });
    sections += `<h2>${esc(title)}${ranked}</h2><table><tr><th>#</th><th>Player</th><th>Best</th><th>Updated</th></tr>${trs}</table>`;
  }
  if (!sections) sections = "<p>No scores yet — play a game from Telegram.</p>";

  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Game Zone — scores</title>` +
    `<style>body{font-family:system-ui,"Segoe UI",Arial,sans-serif;background:#14141a;color:#eee;margin:0;padding:24px}` +
    `h1{margin:0 0 4px;font-size:22px}.sub{color:#888;margin:0 0 18px;font-size:13px}` +
    `h2{margin:26px 0 8px;font-size:17px}.rk{font-size:11px;background:#edc22e;color:#1a1a1a;padding:2px 7px;border-radius:99px;vertical-align:middle}` +
    `table{border-collapse:collapse;width:100%;max-width:520px;background:#20202a;border-radius:10px;overflow:hidden;margin-bottom:8px}` +
    `th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #2c2c36;font-variant-numeric:tabular-nums}` +
    `tr:last-child td{border-bottom:none}th{background:#262631;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#9a9aa6}` +
    `td:nth-child(3){font-weight:700;color:#ffd34d}td:nth-child(1){color:#888;width:1%}</style></head><body>` +
    `<h1>🏆 Game Zone — best scores</h1><p class="sub">Best per player, per game.</p>${sections}</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ============================================================
//  Helpers
// ============================================================
async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return res.json();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function cors(env, res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN || "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}

// --- HMAC-signed identity token (stateless; binds a play session to a user) ---
function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}
function b64urlEncode(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function signToken(env, payloadObj) {
  const key = await hmacKey(env.SIGNING_SECRET);
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return payloadB64 + "." + b64urlEncode(sig);
}
async function verifyToken(env, token) {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const key = await hmacKey(env.SIGNING_SECRET);
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sigB64), new TextEncoder().encode(payloadB64)); }
  catch { return null; }
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))); }
  catch { return null; }
}
