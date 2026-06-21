/* ============================================================
   Bike Courier — Telegram Games backend (Cloudflare Worker)

   Responsibilities
   - /webhook : receive Telegram updates (commands, Play taps, inline).
   - /score   : receive a finished game's score from the browser and record
                it with setGameScore (Telegram stores & shows the leaderboard).
   - /init    : one-time helper to register the webhook (guarded by a secret).

   No database: Telegram keeps the high-score table per game for us.
   No secrets in code: BOT_TOKEN / SIGNING_SECRET / WEBHOOK_SECRET come from
   Worker secrets (`wrangler secret put ...`).
   ============================================================ */

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
  if (/^\/(start|play)\b/.test(text)) {
    return tg(env, "sendGame", { chat_id: msg.chat.id, game_short_name: env.GAME_SHORT_NAME });
  }
  const uname = env.BOT_USERNAME ? "@" + env.BOT_USERNAME : "this bot";
  return tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text:
      "🚴 Bike Courier\n\n" +
      "Send /play to play and set your high score.\n" +
      "Type " + uname + " in any chat to challenge your friends — everyone who plays " +
      "from the same message shares one leaderboard.",
  });
}

// Play button tapped -> answer with the game URL (carrying a signed identity token
// and the backend's own URL so the game knows where to POST its score).
async function onCallback(cq, env, selfOrigin) {
  if (!cq.game_short_name) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }
  const payload = { u: cq.from.id };
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
  let score = Math.floor(Number(body && body.score));
  if (typeof token !== "string") return cors(env, json({ ok: false, error: "missing token" }, 400));
  if (!Number.isFinite(score) || score < 0 || score > 10_000_000) {
    return cors(env, json({ ok: false, error: "bad score" }, 400));
  }

  const payload = await verifyToken(env, token);
  if (!payload || !payload.u) return cors(env, json({ ok: false, error: "bad token" }, 403));

  const params = { user_id: payload.u, score };
  if (payload.i) params.inline_message_id = payload.i;
  else { params.chat_id = payload.c; params.message_id = payload.m; }

  const r = await tg(env, "setGameScore", params);
  // setGameScore errors when the new score isn't higher than the stored one — that's fine.
  const notHigher = r.description && /not.*modified/i.test(r.description);
  if (!r.ok && !notHigher) {
    return cors(env, json({ ok: false, error: r.description || "telegram error" }));
  }
  return cors(env, json({ ok: true, score }));
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
