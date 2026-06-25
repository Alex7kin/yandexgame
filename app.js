/* ============================================================
   Game Zone — launcher / host for the mini-games.

   Each game registers itself via GameHost.register(...) and is mounted into the
   shared #stage on demand. Exactly ONE game is the "ranked" game whose scores are
   submitted to the Telegram leaderboard; every other game is fully playable but
   unranked (its score is never sent). To re-point the leaderboard at a different
   game, change the single line below.
   ============================================================ */
(() => {
  "use strict";

  const RANKED_GAME = "stack";   // ← the only line to change to move the rating

  // ---------- DOM ----------
  const menu    = document.getElementById("menu");
  const grid    = document.getElementById("gameGrid");
  const stage   = document.getElementById("stage");
  const canvas  = document.getElementById("game");
  const muteBtn = document.getElementById("mute");
  const backBtn = document.getElementById("back");

  // ---------- Telegram Games integration ----------
  // Launched from the bot, the Worker appends a signed identity token (t) and its
  // own URL (b). Both are absent outside Telegram, so scoring is a no-op there.
  const params     = new URLSearchParams(location.search);
  const TG_TOKEN   = params.get("t");
  const TG_BACKEND = (params.get("b") || "").replace(/\/+$/, "");
  // Report a finished game's score to the Worker, tagged with which game it was.
  // The Worker records every game's best per player centrally, and additionally
  // updates Telegram's native board for the ranked game.
  function postScore(gameId, s) {
    if (!TG_TOKEN || !TG_BACKEND || !(s > 0)) return;
    try {
      fetch(TG_BACKEND + "/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: TG_TOKEN, g: gameId, score: s }),
        keepalive: true, // let it complete even if the webview is closing
      }).catch(() => {});
    } catch (_) { /* never let scoring break a game */ }
  }

  // ---------- Registry ----------
  const games = [];
  window.GameHost = { register: (g) => games.push(g) };

  // ---------- Shared mute (persisted; owned by the host, read by the active game) ----------
  let muted = localStorage.getItem("muted") === "1";
  function updateMuteIcon() { muteBtn.textContent = muted ? "🔇" : "🔊"; }

  // ---------- Mount / unmount ----------
  let current = null;      // active game module
  let currentApi = null;   // the API object handed to it

  function makeApi(game) {
    const ranked = game.id === RANKED_GAME;
    const bestKey = "best_" + game.id;
    return {
      canvas,
      stage,
      ranked,
      get muted() { return muted; },
      getBest() { return parseInt(localStorage.getItem(bestKey) || "0", 10) || 0; },
      setBest(v) { localStorage.setItem(bestKey, String(v | 0)); },
      submitScore(s) { postScore(game.id, s); },   // every game records centrally; Worker gates Telegram's board
      exitToMenu,
      onMuteToggle: null,   // a game may set this to react (e.g. silence a sound) on toggle
    };
  }

  // Fill the shared start / game-over overlays from a game's metadata, so each
  // game shows its own copy without hardcoding it in the HTML.
  function setHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html || ""; }
  function setOverlay(game) {
    const s = game.start || {};
    setHtml("startTitle", s.title || game.title);
    setHtml("startLead",  s.lead);
    setHtml("startHint",  s.hint);
    setHtml("startSub",   s.sub);
    setHtml("overTitle",  (game.over && game.over.title) || "Game Over");
  }

  function launch(game) {
    setOverlay(game);
    menu.classList.add("hidden");
    stage.classList.remove("hidden");
    current = game;
    currentApi = makeApi(game);
    game.mount(currentApi);
  }

  function exitToMenu() {
    if (current && current.unmount) current.unmount();
    current = null;
    currentApi = null;
    stage.classList.add("hidden");
    menu.classList.remove("hidden");
  }

  muteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    muted = !muted;
    localStorage.setItem("muted", muted ? "1" : "0");
    updateMuteIcon();
    if (currentApi && currentApi.onMuteToggle) currentApi.onMuteToggle(muted);
  });
  backBtn.addEventListener("click", (e) => { e.stopPropagation(); exitToMenu(); });

  // ---------- Menu ----------
  function buildMenu() {
    grid.innerHTML = "";
    for (const g of games) {
      const tile = document.createElement("button");
      tile.className = "tile";
      tile.style.setProperty("--accent", g.accent || "#ffcc00");
      tile.innerHTML =
        `<span class="tile-emoji">${g.emoji || "🎮"}</span>` +
        `<span class="tile-title">${g.title}</span>` +
        `<span class="tile-tag">${g.tagline || ""}</span>` +
        (g.id === RANKED_GAME ? `<span class="tile-badge">RANKED</span>` : "");
      tile.addEventListener("click", () => launch(g));
      grid.appendChild(tile);
    }
    // Placeholder so the grid doesn't look bare while there's only one game.
    const soon = document.createElement("div");
    soon.className = "tile tile-soon";
    soon.innerHTML =
      `<span class="tile-emoji">➕</span>` +
      `<span class="tile-title">More soon</span>` +
      `<span class="tile-tag">Coming up</span>`;
    grid.appendChild(soon);
  }

  // ---------- Boot ----------
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    updateMuteIcon();
    buildMenu();
    // Always show the menu first — including when launched from Telegram. Scoring
    // still works: the ranked game submits with the token/backend captured from the
    // URL at load. (?g=<id> is an explicit deep-link straight into one game.)
    const deep = games.find((g) => g.id === params.get("g"));
    if (deep) launch(deep);
  }
  window.addEventListener("DOMContentLoaded", init);
})();
