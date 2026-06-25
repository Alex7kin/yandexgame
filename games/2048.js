/* ============================================================
   2048 — slide-and-merge tile puzzle on a 4x4 grid.

   Swipe or use the arrow keys to slide every tile one direction; equal tiles
   that collide merge into their sum. A new 2 (or occasionally 4) appears after
   each move. Reach 2048 to win — keep going until the board jams.

   Logic commits immediately to `grid`; the slide/merge animation is a purely
   visual overlay, so gameplay stays correct even if a frame is dropped.
   Packaged as a GameHost module (see games/bikecourier.js for the contract).
   ============================================================ */
(function () {
  "use strict";

  const N = 4;
  const SPAWN4_PROB = 0.1;
  const SLIDE_DUR = 0.09;   // tile slide time (s)
  const POP_DUR   = 0.08;   // merge / spawn pop time (s)
  const SWIPE_MIN = 24;     // px before a drag counts as a swipe (else it's a tap)
  const BG = "#faf8ef";

  const READY = 0, PLAYING = 1, GAMEOVER = 2;

  const TILE = {
    2: ["#eee4da", "#776e65"], 4: ["#ede0c8", "#776e65"], 8: ["#f2b179", "#f9f6f2"],
    16: ["#f59563", "#f9f6f2"], 32: ["#f67c5f", "#f9f6f2"], 64: ["#f65e3b", "#f9f6f2"],
    128: ["#edcf72", "#f9f6f2"], 256: ["#edcc61", "#f9f6f2"], 512: ["#edc850", "#f9f6f2"],
    1024: ["#edc53f", "#f9f6f2"], 2048: ["#edc22e", "#f9f6f2"],
  };
  const tileStyle = (v) => TILE[v] || ["#3c3a32", "#f9f6f2"];

  const portraitLock = window.matchMedia("(orientation: landscape) and (pointer: coarse)");
  const PORTRAIT_RATIO = 0.5;

  function create() {
    let host = null, canvas = null, ctx = null, stage = null;
    let elScore, elBest, startScreen, gameOverScreen, elFinalScore, elFinalBest;

    let W = 0, H = 0, DPR = 1;
    let boardX = 0, boardY = 0, boardSize = 0, cell = 0, gap = 0;

    let grid = emptyGrid();
    let score = 0, best = 0, state = READY, restartAllowedAt = 0;
    let anim = null;             // { moves, merged:[[r,c]], spawn:[r,c], maxMerge, t }
    let pendingOver = false, won = false, winFlash = 0;
    let last = 0, raf = null;

    let audioCtx = null;
    let pStartX = null, pStartY = 0;   // pointer-down position for swipe detection
    const listeners = [];
    function on(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push([t, ty, fn, opts]); }

    function emptyGrid() { return [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]; }
    function cloneGrid(g) { return g.map((row) => row.slice()); }
    function sameGrid(a, b) { for (let r=0;r<N;r++) for (let c=0;c<N;c++) if (a[r][c]!==b[r][c]) return false; return true; }

    // ============================================================
    //  Sizing
    // ============================================================
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const winW = window.innerWidth || document.documentElement.clientWidth || 800;
      const winH = window.innerHeight || document.documentElement.clientHeight || 600;

      if (window.matchMedia("(pointer: coarse)").matches) {
        W = winW; H = winH;
      } else if (winW / winH > PORTRAIT_RATIO) {
        H = winH; W = Math.round(winH * PORTRAIT_RATIO);
      } else {
        W = winW; H = Math.round(winW / PORTRAIT_RATIO);
      }

      stage.style.width = W + "px";
      stage.style.height = H + "px";
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

      boardSize = Math.min(W * 0.9, H * 0.56);
      gap = boardSize * 0.028;
      cell = (boardSize - gap * (N + 1)) / N;
      boardX = (W - boardSize) / 2;
      boardY = (H - boardSize) / 2;
    }
    function onPortraitChange() { resize(); last = 0; }
    function onVisibility() { if (!document.hidden) last = 0; }
    const cellX = (c) => boardX + gap + c * (cell + gap);
    const cellY = (r) => boardY + gap + r * (cell + gap);

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
    const playMove  = () => beep(180, 0.05, "sine", 0.03);
    const playMerge = (v) => beep(260 + Math.min(9, Math.log2(v)) * 40, 0.12, "triangle", 0.06, 520);
    const playOver  = () => { beep(200, 0.4, "sawtooth", 0.06, 60); beep(96, 0.45, "square", 0.05, 48); };

    // ============================================================
    //  Game flow
    // ============================================================
    function startGame() {
      grid = emptyGrid();
      score = 0; won = false; winFlash = 0; pendingOver = false; anim = null;
      spawnTile(); spawnTile();
      state = PLAYING;
      startScreen.classList.add("hidden");
      gameOverScreen.classList.add("hidden");
      updateHUD();
    }

    function spawnTile() {
      const empties = [];
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!grid[r][c]) empties.push([r, c]);
      if (!empties.length) return null;
      const [r, c] = empties[(Math.random() * empties.length) | 0];
      grid[r][c] = Math.random() < SPAWN4_PROB ? 4 : 2;
      return [r, c];
    }

    // Lines of cell coords in travel order (index 0 = the edge tiles slide toward).
    function buildLines(dir) {
      const lines = [];
      for (let i = 0; i < N; i++) {
        const line = [];
        for (let j = 0; j < N; j++) {
          if (dir === "L") line.push([i, j]);
          else if (dir === "R") line.push([i, N - 1 - j]);
          else if (dir === "U") line.push([j, i]);
          else line.push([N - 1 - j, i]); // D
        }
        lines.push(line);
      }
      return lines;
    }

    function applyMove(dir) {
      const lines = buildLines(dir);
      const ng = emptyGrid();
      const moves = [], merged = [];
      let gained = 0, maxMerge = 0;

      for (const line of lines) {
        const tiles = [];
        for (const [r, c] of line) if (grid[r][c]) tiles.push({ v: grid[r][c], r, c });
        const res = [];
        for (const t of tiles) {
          const li = res.length - 1;
          if (li >= 0 && !res[li].mg && res[li].v === t.v) {     // merge into the last placed tile
            res[li].v *= 2; res[li].mg = true;
            gained += res[li].v; maxMerge = Math.max(maxMerge, res[li].v);
            moves.push({ v: t.v, from: [t.r, t.c], to: line[li] });
          } else {
            res.push({ v: t.v, mg: false });
            moves.push({ v: t.v, from: [t.r, t.c], to: line[res.length - 1] });
          }
        }
        for (let i = 0; i < res.length; i++) {
          const [r, c] = line[i];
          ng[r][c] = res[i].v;
          if (res[i].mg) merged.push([r, c]);
        }
      }

      if (sameGrid(grid, ng)) return false;         // nothing moved -> not a valid move
      grid = ng;
      score += gained;
      const spawn = spawnTile();
      anim = { moves, merged, spawn, t: 0 };
      if (maxMerge) playMerge(maxMerge); else playMove();
      return true;
    }

    function move(dir) {
      if (state !== PLAYING || anim) return;
      if (!applyMove(dir)) return;
      updateHUD();
      if (!won && hasValue(2048)) { won = true; winFlash = 2.2; }
      if (!canMove()) pendingOver = true;          // fire game-over once the animation finishes
    }

    function hasValue(v) { for (let r=0;r<N;r++) for (let c=0;c<N;c++) if (grid[r][c]===v) return true; return false; }
    function canMove() {
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (!grid[r][c]) return true;
        if (c < N - 1 && grid[r][c] === grid[r][c + 1]) return true;
        if (r < N - 1 && grid[r][c] === grid[r + 1][c]) return true;
      }
      return false;
    }

    function gameOver() {
      state = GAMEOVER;
      playOver();
      if (score > best) { best = score; host.setBest(best); }
      elFinalScore.textContent = score;
      elFinalBest.textContent = best;
      updateHUD();
      host.submitScore(score);
      gameOverScreen.classList.remove("hidden");
      restartAllowedAt = performance.now() + 450;
    }

    function updateHUD() {
      elScore.textContent = score;
      elBest.textContent = "BEST " + best;
    }

    // ============================================================
    //  Input (arrow keys / WASD + swipe)
    // ============================================================
    function dirFromKey(k) {
      if (k === "ArrowLeft" || k === "a" || k === "A") return "L";
      if (k === "ArrowRight" || k === "d" || k === "D") return "R";
      if (k === "ArrowUp" || k === "w" || k === "W") return "U";
      if (k === "ArrowDown" || k === "s" || k === "S") return "D";
      return null;
    }
    function onKeyDown(e) {
      const dir = dirFromKey(e.key);
      if (dir || e.key === " " || e.key === "Enter") e.preventDefault();
      if (portraitLock.matches || e.repeat) return;
      if (state === READY) { resumeAudio(); startGame(); return; }
      if (state === GAMEOVER) { if (performance.now() >= restartAllowedAt) { resumeAudio(); startGame(); } return; }
      if (dir) { resumeAudio(); move(dir); }
    }
    function onPointerDown(e) {
      if (e.target.closest && e.target.closest(".btn")) return;
      pStartX = e.clientX; pStartY = e.clientY;
      e.preventDefault();
    }
    function onPointerUp(e) {
      if (pStartX == null) return;
      const dx = e.clientX - pStartX, dy = e.clientY - pStartY;
      pStartX = null;
      if (portraitLock.matches) return;
      resumeAudio();
      if (state === READY) { startGame(); return; }
      if (state === GAMEOVER) { if (performance.now() >= restartAllowedAt) startGame(); return; }
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN) return;   // a tap, not a swipe
      move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "R" : "L") : (dy > 0 ? "D" : "U"));
    }
    function onPointerCancel() { pStartX = null; }
    function onContextMenu(e) { e.preventDefault(); }

    // ============================================================
    //  Update
    // ============================================================
    function update(dt) {
      if (portraitLock.matches) return;
      if (winFlash > 0) winFlash = Math.max(0, winFlash - dt);
      if (anim) {
        anim.t += dt;
        if (anim.t >= SLIDE_DUR + POP_DUR) {
          anim = null;
          if (pendingOver) { pendingOver = false; gameOver(); }
        }
      }
    }

    // ============================================================
    //  Render
    // ============================================================
    const easeOut = (p) => 1 - (1 - p) * (1 - p);

    function draw() {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      // Board + empty cells
      roundRect(boardX, boardY, boardSize, boardSize, gap);
      ctx.fillStyle = "#bbada0";
      ctx.fill();
      ctx.fillStyle = "rgba(238,228,218,0.35)";
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        roundRect(cellX(c), cellY(r), cell, cell, cell * 0.06);
        ctx.fill();
      }

      if (state === READY) return;   // start card covers the empty board

      if (anim && anim.t < SLIDE_DUR) {
        const p = easeOut(anim.t / SLIDE_DUR);
        for (const m of anim.moves) {
          const ax = cellX(m.from[1]), ay = cellY(m.from[0]);
          const bx = cellX(m.to[1]),   by = cellY(m.to[0]);
          drawTile(ax + (bx - ax) * p, ay + (by - ay) * p, m.v, 1);
        }
      } else {
        const popP = anim ? Math.min(1, (anim.t - SLIDE_DUR) / POP_DUR) : 1;
        for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
          if (!grid[r][c]) continue;
          let scale = 1;
          if (anim) {
            if (anim.spawn && anim.spawn[0] === r && anim.spawn[1] === c) scale = popP * (2 - popP);
            else if (isMerged(r, c)) scale = 1 + 0.18 * Math.sin(Math.PI * popP);
          }
          drawTile(cellX(c), cellY(r), grid[r][c], scale);
        }
      }

      if (winFlash > 0) {
        ctx.globalAlpha = Math.min(1, winFlash);
        ctx.fillStyle = "#edc22e";
        ctx.font = `800 ${Math.round(boardSize * 0.12)}px "Segoe UI",system-ui,Arial,sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("2048! 🎉", W / 2, boardY - boardSize * 0.08);
        ctx.globalAlpha = 1;
      }
    }

    function isMerged(r, c) {
      const m = anim.merged;
      for (let i = 0; i < m.length; i++) if (m[i][0] === r && m[i][1] === c) return true;
      return false;
    }

    function drawTile(x, y, v, scale) {
      const [bg, fg] = tileStyle(v);
      ctx.save();
      ctx.translate(x + cell / 2, y + cell / 2);
      if (scale !== 1) ctx.scale(scale, scale);
      roundRect(-cell / 2, -cell / 2, cell, cell, cell * 0.06);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.fillStyle = fg;
      const fs = v < 100 ? cell * 0.46 : v < 1000 ? cell * 0.38 : cell * 0.30;
      ctx.font = `700 ${fs}px "Segoe UI",system-ui,Arial,sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(v), 0, cell * 0.02);
      ctx.restore();
    }

    function roundRect(x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y,     x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x,     y + h, r);
      ctx.arcTo(x,     y + h, x,     y,     r);
      ctx.arcTo(x,     y,     x + w, y,     r);
      ctx.closePath();
    }

    // ============================================================
    //  Loop
    // ============================================================
    function loop(now) {
      if (!last) last = now;
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.05) dt = 0.05;
      update(dt);
      draw();
      raf = requestAnimationFrame(loop);
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
      elFinalScore = document.getElementById("finalScore");
      elFinalBest = document.getElementById("finalBest");

      state = READY;
      best = host.getBest();
      grid = emptyGrid();
      score = 0; anim = null; pendingOver = false; won = false; winFlash = 0;
      pStartX = null; last = 0;
      host.onMuteToggle = null;

      startScreen.classList.remove("hidden");
      gameOverScreen.classList.add("hidden");

      on(window, "resize", resize);
      on(window, "orientationchange", resize);
      on(portraitLock, "change", onPortraitChange);
      on(document, "visibilitychange", onVisibility);
      on(window, "keydown", onKeyDown);
      on(window, "pointerdown", onPointerDown, { passive: false });
      on(window, "pointerup", onPointerUp);
      on(window, "pointercancel", onPointerCancel);
      on(window, "contextmenu", onContextMenu);

      resize();
      updateHUD();
      raf = requestAnimationFrame(loop);
    }

    function unmount() {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      for (const [t, ty, fn, opts] of listeners) t.removeEventListener(ty, fn, opts);
      listeners.length = 0;
      if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
      if (host) host.onMuteToggle = null;
      host = null;
    }

    return {
      id: "2048",
      title: "2048",
      tagline: "Merge tiles to 2048",
      emoji: "🔢",
      accent: "#edc22e",
      start: {
        title: "2048",
        lead: "Merge tiles to reach 2048!",
        hint: "<b>Swipe</b> / <b>Arrow keys</b> to move",
        sub: "Equal numbers merge into one",
      },
      over: { title: "Game Over" },
      mount,
      unmount,
    };
  }

  window.GameHost.register(create());
})();
