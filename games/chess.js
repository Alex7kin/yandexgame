/* ============================================================
   Chess — local hot-seat OR online via the ChessMatch Durable Object.

   Rules/validation: chess.js (window.Chess, vendored as games/vendor/chess.js).
   - Local mode (no match id in the URL): two players share one device.
   - Online mode (?m=<match>&b=<worker>): connect a WebSocket to the match's DO;
     the DO is the referee. Your colour is at the bottom; you can only move your
     pieces on your turn. The DO broadcasts every position to both players.

   Packaged as a GameHost module (see games/bikecourier.js for the contract).
   ============================================================ */
(function () {
  "use strict";

  const LIGHT = "#eeeed2", DARK = "#769656", BG = "#302e2c";          // chess.com green board
  const SEL_TINT = "rgba(247,247,105,0.55)", MOVE_TINT = "rgba(247,247,105,0.55)";
  const CHK_TINT = "rgba(230,60,50,0.55)", DOT = "rgba(0,0,0,0.16)";
  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };  // fallback if SVGs fail
  const PROMO = ["q", "r", "b", "n"];

  // Vendored open Staunton piece set (cburnett, from lichess) — loaded as images.
  const PIECE_IMG = {};
  (function () {
    for (const k of ["wK","wQ","wR","wB","wN","wP","bK","bQ","bR","bB","bN","bP"]) {
      const img = new Image();
      img.onload = () => { img._ok = true; };
      img.src = "games/vendor/pieces/" + k + ".svg";
      PIECE_IMG[k] = img;
    }
  })();
  const pieceKey = (p) => (p.color === "w" ? "w" : "b") + p.type.toUpperCase();
  const READY = 0, PLAYING = 1, GAMEOVER = 2;

  const portraitLock = window.matchMedia("(orientation: landscape) and (pointer: coarse)");
  const PORTRAIT_RATIO = 0.5;

  const PIECE_FONT = '"Segoe UI Symbol","Noto Sans Symbols2","Apple Symbols","Arial Unicode MS",sans-serif';

  function create() {
    let host = null, canvas = null, ctx = null, stage = null;
    let elScore, elBest, startScreen, gameOverScreen;

    let W = 0, H = 0, DPR = 1;
    let boardX = 0, boardY = 0, boardSize = 0, sq = 0;

    let game = null;                  // chess.js instance (current position)
    let state = READY, resultText = "";
    let selected = null, legal = [], targets = [];
    let lastMove = null, pendingPromo = null, promoCells = [];
    let flipped = false;

    // online
    let online = false, ws = null, conn = "idle", myColor = null, players = { white: null, black: null };
    let matchId = null, backend = null, token = null, curFen = null, retryTimer = 0;
    let serverDraw = null, rematchSent = false, confirmResign = false, uiButtons = [];

    let audioCtx = null, raf = null;
    const listeners = [];
    function on(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push([t, ty, fn, opts]); }

    // ---------- board <-> screen (flip-aware) ----------
    const bsq = (r, c) => String.fromCharCode(97 + c) + (8 - r);          // board indices -> "e4"
    const sqRC = (s) => ({ r: 8 - Number(s[1]), c: s.charCodeAt(0) - 97 });
    const b2s = (r, c) => (flipped ? { sr: 7 - r, sc: 7 - c } : { sr: r, sc: c });
    function screenToSq(x, y) {
      let sc = Math.floor((x - boardX) / sq), sr = Math.floor((y - boardY) / sq);
      if (sc < 0 || sc > 7 || sr < 0 || sr > 7) return null;
      const r = flipped ? 7 - sr : sr, c = flipped ? 7 - sc : sc;
      return bsq(r, c);
    }
    const myTurnColor = () => (game.turn() === "w" ? "white" : "black");

    // ============================================================
    //  Sizing
    // ============================================================
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const winW = window.innerWidth || document.documentElement.clientWidth || 800;
      const winH = window.innerHeight || document.documentElement.clientHeight || 600;
      if (window.matchMedia("(pointer: coarse)").matches) { W = winW; H = winH; }
      else if (winW / winH > PORTRAIT_RATIO) { H = winH; W = Math.round(winH * PORTRAIT_RATIO); }
      else { W = winW; H = Math.round(winW / PORTRAIT_RATIO); }

      stage.style.width = W + "px";
      stage.style.height = H + "px";
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

      boardSize = Math.min(W * 0.94, H * 0.70);
      boardSize -= boardSize % 8;
      sq = boardSize / 8;
      boardX = (W - boardSize) / 2;
      boardY = (H - boardSize) / 2 + H * 0.03;
    }

    // ============================================================
    //  Audio
    // ============================================================
    function resumeAudio() {
      if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    }
    function beep(freq, dur, type, vol, slideTo) {
      if (!host || host.muted || !audioCtx) return;
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || "sine";
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(vol || 0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + dur);
    }
    const sndMove = () => beep(220, 0.06, "sine", 0.04, 180);
    const sndCapture = () => beep(150, 0.08, "triangle", 0.05, 90);
    const sndCheck = () => beep(660, 0.12, "square", 0.05, 880);
    const sndEnd = () => { beep(523, 0.14, "triangle", 0.06); beep(784, 0.18, "triangle", 0.05); };
    function feedback(mv) { if (game.isCheck()) sndCheck(); else if (mv && mv.captured) sndCapture(); else sndMove(); }

    // ============================================================
    //  Online (WebSocket to the match's Durable Object)
    // ============================================================
    function guestId() {
      let g = sessionStorage.getItem("chessGuest");
      if (!g) { g = Math.random().toString(36).slice(2); sessionStorage.setItem("chessGuest", g); }
      return g;
    }
    function connect() {
      conn = "connecting";
      const wsBase = backend.replace(/^http/, "ws");
      const q = "?m=" + encodeURIComponent(matchId) + (token ? "&t=" + encodeURIComponent(token) : "") + "&guest=" + guestId();
      try { ws = new WebSocket(wsBase + "/chess/ws" + q); } catch (_) { conn = "closed"; return; }
      ws.onopen = () => { conn = "open"; };
      ws.onmessage = (e) => onServer(e.data);
      ws.onclose = () => { conn = "closed"; scheduleRetry(); };
      ws.onerror = () => {};
    }
    function scheduleRetry() {
      if (!online || !host) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { if (online && host) connect(); }, 2000);
    }
    function onServer(data) {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.type !== "state") return;
      myColor = m.youAre; flipped = myColor === "black";
      players = m.players || { white: null, black: null };
      if (m.fen !== curFen) {                       // position changed -> reload + clear selection
        const had = curFen;
        curFen = m.fen;
        game = new window.Chess(m.fen);
        lastMove = m.lastMove || null;
        clearSelection(); pendingPromo = null;
        if (had !== null) feedback(null);           // a real move arrived (not the first snapshot)
      }
      serverDraw = m.draw || null;
      confirmResign = false;
      if (!m.over) rematchSent = false;
      resultText = m.result || "";
      state = m.over ? GAMEOVER : PLAYING;
      updateHUD();
    }
    function wsSend(obj) { if (ws && conn === "open") ws.send(JSON.stringify(obj)); }
    function sendMove(from, to, promotion) { wsSend({ type: "move", from, to, promotion: promotion || null }); }
    function doButton(a) {
      if (a === "resign_ask") confirmResign = true;
      else if (a === "resign_cancel") confirmResign = false;
      else if (a === "resign") { confirmResign = false; wsSend({ type: "resign" }); }
      else if (a === "draw_offer") wsSend({ type: "draw_offer" });
      else if (a === "draw_accept") wsSend({ type: "draw_accept" });
      else if (a === "draw_decline") wsSend({ type: "draw_decline" });
      else if (a === "rematch") { rematchSent = true; wsSend({ type: "rematch" }); }
    }

    // ============================================================
    //  Game flow (local mode)
    // ============================================================
    function newGame() {
      if (!window.Chess) return;
      game = new window.Chess();
      state = PLAYING; flipped = false;
      selected = null; legal = []; targets = []; lastMove = null; pendingPromo = null; promoCells = [];
      resultText = "";
      startScreen.classList.add("hidden");
      gameOverScreen.classList.add("hidden");
      updateHUD();
    }

    function selectSquare(s) { selected = s; legal = game.moves({ square: s, verbose: true }); targets = [...new Set(legal.map((m) => m.to))]; }
    function clearSelection() { selected = null; legal = []; targets = []; }

    function localMove(from, to, promotion) {
      let mv; try { mv = game.move(promotion ? { from, to, promotion } : { from, to }); } catch (_) { mv = null; }
      if (!mv) { clearSelection(); return; }
      lastMove = { from, to }; clearSelection(); pendingPromo = null; promoCells = [];
      feedback(mv); checkEndLocal(); updateHUD();
    }
    function checkEndLocal() {
      if (!game.isGameOver()) return;
      resultText = endText(game); state = GAMEOVER; sndEnd();
    }

    // online optimistic move: apply locally for snappiness, server confirms
    function onlineMove(from, to, promotion) {
      let mv; try { mv = game.move(promotion ? { from, to, promotion } : { from, to }); } catch (_) { mv = null; }
      if (!mv) { clearSelection(); return; }
      curFen = game.fen(); lastMove = { from, to }; clearSelection(); pendingPromo = null; promoCells = [];
      feedback(mv); updateHUD();
      sendMove(from, to, promotion);
    }

    function updateHUD() {
      if (online) {
        elScore.textContent = myColor === "white" ? "WHITE" : myColor === "black" ? "BLACK" : "WATCH";
        const opp = myColor === "white" ? players.black : players.white;
        elBest.textContent = opp ? ("VS " + String(opp).toUpperCase()).slice(0, 14) : "WAITING";
        return;
      }
      if (!game) { elScore.textContent = ""; elBest.textContent = ""; return; }
      elScore.textContent = game.turn() === "w" ? "WHITE" : "BLACK";
      elBest.textContent = "MOVE " + (Math.floor(game.history().length / 2) + 1);
    }

    // ============================================================
    //  Input
    // ============================================================
    function canInteract() {
      if (state !== PLAYING || !game) return false;
      if (!online) return true;
      if (myColor !== "white" && myColor !== "black") return false;     // spectator
      if (!players.white || !players.black) return false;               // waiting for opponent
      return myTurnColor() === myColor;
    }

    function onPointerDown(e) {
      if (e.target.closest && e.target.closest(".btn")) return;
      e.preventDefault();
      if (portraitLock.matches) return;
      resumeAudio();

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;

      if (online) {
        for (const b of uiButtons) {
          if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { doButton(b.a); return; }
        }
        if (conn !== "open") return;
      } else if (state === READY || state === GAMEOVER) {
        newGame(); return;
      }

      if (pendingPromo) {
        for (const c of promoCells) {
          if (x >= c.x && x <= c.x + sq && y >= c.y && y <= c.y + sq) {
            (online ? onlineMove : localMove)(pendingPromo.from, pendingPromo.to, c.piece);
            return;
          }
        }
        pendingPromo = null; promoCells = [];
        return;
      }

      if (!canInteract()) { clearSelection(); return; }

      const s = screenToSq(x, y);
      if (!s) { clearSelection(); return; }
      const piece = game.get(s);

      if (selected) {
        const moves = legal.filter((m) => m.to === s);
        if (moves.length) {
          if (moves.some((m) => m.promotion)) { pendingPromo = { from: selected, to: s }; clearSelection(); return; }
          (online ? onlineMove : localMove)(selected, s);
          return;
        }
        if (piece && piece.color === game.turn()) selectSquare(s);
        else clearSelection();
      } else if (piece && piece.color === game.turn()) {
        selectSquare(s);
      }
    }

    // ============================================================
    //  Render
    // ============================================================
    function loop() { draw(); raf = requestAnimationFrame(loop); }

    function draw() {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";

      if (!game) {
        ctx.fillStyle = "#ccc";
        ctx.font = `600 ${Math.round(H * 0.022)}px system-ui,sans-serif`;
        ctx.fillText(window.Chess ? "" : "Loading chess…", W / 2, H / 2);
        return;
      }

      const board = game.board();
      const inCheck = game.isCheck(), turn = game.turn();

      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const { sr, sc } = b2s(r, c);
        const x = boardX + sc * sq, y = boardY + sr * sq, s = bsq(r, c), isLight = (r + c) % 2 === 0;
        ctx.fillStyle = isLight ? LIGHT : DARK;
        ctx.fillRect(x, y, sq, sq);
        if (lastMove && (s === lastMove.from || s === lastMove.to)) { ctx.fillStyle = MOVE_TINT; ctx.fillRect(x, y, sq, sq); }
        if (s === selected) { ctx.fillStyle = SEL_TINT; ctx.fillRect(x, y, sq, sq); }
        if (inCheck && board[r][c] && board[r][c].type === "k" && board[r][c].color === turn) { ctx.fillStyle = CHK_TINT; ctx.fillRect(x, y, sq, sq); }
        // coordinates: rank number on the left edge, file letter on the bottom edge
        ctx.fillStyle = isLight ? DARK : LIGHT;
        ctx.font = `700 ${Math.round(sq * 0.22)}px system-ui,sans-serif`;
        if (sc === 0) { ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(String(8 - r), x + sq * 0.07, y + sq * 0.06); }
        if (sr === 7) { ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText(String.fromCharCode(97 + c), x + sq * 0.94, y + sq * 0.95); }
      }

      // pieces
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = board[r][c]; if (!p) continue;
        const { sr, sc } = b2s(r, c);
        drawPiece(p, boardX + sc * sq, boardY + sr * sq);
      }

      // legal-move hints
      for (const t of targets) {
        const { r, c } = sqRC(t), { sr, sc } = b2s(r, c);
        const cx = boardX + (sc + 0.5) * sq, cy = boardY + (sr + 0.5) * sq;
        if (game.get(t)) { ctx.strokeStyle = DOT; ctx.lineWidth = sq * 0.08; ctx.beginPath(); ctx.arc(cx, cy, sq * 0.42, 0, Math.PI * 2); ctx.stroke(); }
        else { ctx.fillStyle = DOT; ctx.beginPath(); ctx.arc(cx, cy, sq * 0.16, 0, Math.PI * 2); ctx.fill(); }
      }

      // status line
      ctx.fillStyle = inCheck ? "#ff7b6b" : "#e8e8e8";
      ctx.font = `700 ${Math.round(sq * 0.32)}px system-ui,"Segoe UI",sans-serif`;
      ctx.fillText(statusText(turn, inCheck), W / 2, boardY - sq * 0.42);

      if (pendingPromo) drawPromo();
      if (state === GAMEOVER) drawResult();
      drawControls();
    }

    function statusText(turn, inCheck) {
      if (state === GAMEOVER) return resultText;
      if (online) {
        if (conn !== "open") return conn === "connecting" ? "Connecting…" : "Reconnecting…";
        if (myColor === "spectator") return "Spectating";
        if (!players.white || !players.black) return "Waiting for opponent…";
        const mine = myTurnColor() === myColor;
        return (mine ? "Your move" : "Opponent's move") + (inCheck ? " — Check!" : "");
      }
      return (turn === "w" ? "White" : "Black") + " to move" + (inCheck ? " — Check!" : "");
    }

    function drawPiece(p, x, y) {
      const img = PIECE_IMG[pieceKey(p)];
      if (img && img._ok) { ctx.drawImage(img, x, y, sq, sq); return; }
      ctx.font = `${Math.round(sq * 0.78)}px ${PIECE_FONT}`;          // fallback glyph
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.lineWidth = sq * 0.04;
      if (p.color === "w") { ctx.fillStyle = "#fafafa"; ctx.strokeStyle = "rgba(0,0,0,0.7)"; }
      else { ctx.fillStyle = "#2a2a2a"; ctx.strokeStyle = "rgba(255,255,255,0.5)"; }
      ctx.strokeText(GLYPH[p.type], x + sq / 2, y + sq * 0.52);
      ctx.fillText(GLYPH[p.type], x + sq / 2, y + sq * 0.52);
    }

    function drawPromo() {
      const { r, c } = sqRC(pendingPromo.to), { sr, sc } = b2s(r, c);
      const color = game.turn();
      const dir = sr < 4 ? 1 : -1;               // grow toward the board centre (works flipped too)
      promoCells = [];
      for (let i = 0; i < 4; i++) {
        const x = boardX + sc * sq, y = boardY + (sr + dir * i) * sq;
        ctx.fillStyle = "#2b2b2b"; ctx.fillRect(x, y, sq, sq);
        ctx.strokeStyle = "#f0c040"; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, sq - 2, sq - 2);
        drawPiece({ type: PROMO[i], color }, x, y);
        promoCells.push({ x, y, piece: PROMO[i] });
      }
    }

    function drawResult() {
      ctx.fillStyle = "rgba(20,18,16,0.6)";
      ctx.fillRect(boardX, boardY + boardSize / 2 - sq, boardSize, sq * 2);
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${Math.round(sq * 0.38)}px system-ui,"Segoe UI",sans-serif`;
      ctx.fillText(resultText, W / 2, boardY + boardSize / 2 - sq * 0.25);
      ctx.font = `600 ${Math.round(sq * 0.26)}px system-ui,"Segoe UI",sans-serif`;
      ctx.fillStyle = "#ddd";
      ctx.fillText(online ? "Rematch below ↓" : "Tap to play again", W / 2, boardY + boardSize / 2 + sq * 0.45);
    }

    // Online control strip below the board: resign / draw / rematch.
    function drawControls() {
      uiButtons = [];
      if (!online || (myColor !== "white" && myColor !== "black")) return;
      const defs = [];
      if (state === GAMEOVER) {
        defs.push(rematchSent ? { t: "Waiting for rematch…", a: null } : { t: "Rematch ↻", a: "rematch", ok: true });
      } else if (state === PLAYING && players.white && players.black) {
        const opp = myColor === "white" ? "black" : "white";
        if (serverDraw === opp) {
          defs.push({ t: "Accept draw ½", a: "draw_accept", ok: true });
          defs.push({ t: "Decline", a: "draw_decline" });
        } else if (confirmResign) {
          defs.push({ t: "Confirm resign?", a: "resign", danger: true });
          defs.push({ t: "Cancel", a: "resign_cancel" });
        } else {
          defs.push({ t: "Resign", a: "resign_ask" });
          defs.push(serverDraw === myColor ? { t: "Draw offered", a: null } : { t: "Offer draw ½", a: "draw_offer" });
        }
      }
      if (!defs.length) return;
      const gap = sq * 0.18, bh = Math.min(sq * 0.8, H * 0.052);
      const bw = (boardSize - gap * (defs.length - 1)) / defs.length;
      const y = boardY + boardSize + sq * 0.4;
      defs.forEach((d, i) => {
        const x = boardX + i * (bw + gap);
        drawButton(x, y, bw, bh, d);
        if (d.a) uiButtons.push({ x, y, w: bw, h: bh, a: d.a });
      });
    }

    function drawButton(x, y, w, h, d) {
      const r = h * 0.24;
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
      ctx.fillStyle = d.danger ? "#b33b32" : d.ok ? "#5b8a3a" : d.a ? "#4a4947" : "#3a3a39";
      ctx.fill();
      ctx.fillStyle = d.a ? "#fff" : "#aaa";
      ctx.font = `700 ${Math.round(h * 0.42)}px system-ui,"Segoe UI",sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(d.t, x + w / 2, y + h / 2);
    }

    function endText(g) {
      if (g.isCheckmate()) return (g.turn() === "w" ? "Black" : "White") + " wins by checkmate";
      if (g.isStalemate()) return "Draw — stalemate";
      if (g.isThreefoldRepetition()) return "Draw — repetition";
      if (g.isInsufficientMaterial()) return "Draw — insufficient material";
      return "Draw";
    }

    // ============================================================
    //  Mount / unmount
    // ============================================================
    function mount(h) {
      host = h;
      canvas = h.canvas;
      ctx = canvas.getContext("2d");
      stage = h.stage;

      elScore = document.getElementById("score");
      elBest = document.getElementById("best");
      startScreen = document.getElementById("startScreen");
      gameOverScreen = document.getElementById("gameOver");

      const p = new URLSearchParams(location.search);
      matchId = p.get("m");
      token = p.get("t");
      backend = (p.get("b") || "").replace(/\/+$/, "");
      online = !!(matchId && backend);

      selected = null; legal = []; targets = []; lastMove = null; pendingPromo = null; promoCells = [];
      flipped = false; resultText = ""; curFen = null;
      serverDraw = null; rematchSent = false; confirmResign = false; uiButtons = [];
      host.onMuteToggle = null;

      gameOverScreen.classList.add("hidden");
      if (online) {
        startScreen.classList.add("hidden");      // online is live on connect
        game = window.Chess ? new window.Chess() : null;
        myColor = null; players = { white: null, black: null }; conn = "idle";
        state = PLAYING;
        connect();
      } else {
        game = window.Chess ? new window.Chess() : null;   // opening position behind the start card
        state = READY;
        startScreen.classList.remove("hidden");
      }

      on(window, "resize", resize);
      on(window, "orientationchange", resize);
      on(portraitLock, "change", resize);
      on(window, "pointerdown", onPointerDown, { passive: false });
      on(window, "contextmenu", (e) => e.preventDefault());

      resize();
      updateHUD();
      raf = requestAnimationFrame(loop);
    }

    function unmount() {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      clearTimeout(retryTimer);
      online = false;
      if (ws) { try { ws.close(); } catch (_) {} ws = null; }
      for (const [t, ty, fn, opts] of listeners) t.removeEventListener(ty, fn, opts);
      listeners.length = 0;
      if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
      if (host) host.onMuteToggle = null;
      host = null; game = null;
    }

    return {
      id: "chess",
      title: "Chess",
      tagline: "Play a friend",
      emoji: "♟️",
      accent: "#b58863",
      start: {
        title: "Chess",
        lead: "Local 2-player — tap a piece, then a square",
        hint: "White moves first",
        sub: "Tap to start",
      },
      over: { title: "Game Over" },
      mount,
      unmount,
    };
  }

  window.GameHost.register(create());
})();
