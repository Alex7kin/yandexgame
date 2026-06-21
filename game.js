/* ============================================================
   Bike Courier — an endless runner (Google Dino-style)
   A Yandex Eda courier rides a smooth road and jumps potholes.
   ============================================================ */

(() => {
  "use strict";

  // ---------- Canvas ----------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, DPR = 1;

  // ---------- DOM ----------
  const elScore = document.getElementById("score");
  const elBest = document.getElementById("best");
  const startScreen = document.getElementById("startScreen");
  const gameOverScreen = document.getElementById("gameOver");
  const elFinalScore = document.getElementById("finalScore");
  const elFinalBest = document.getElementById("finalBest");
  const muteBtn = document.getElementById("mute");

  // ---------- Sprite sheet ----------
  // Pre-processed transparent sheet (background colour-keyed out).
  // Tight per-frame content rectangles, measured from the asset, so the
  // wheels sit exactly on the road regardless of per-frame padding.
  const sheet = new Image();
  let sheetReady = false;
  const FRAMES = [
    { sx: 120, sy: 70,  sw: 495, sh: 522 }, // frame 0 (top-left)
    { sx: 686, sy: 70,  sw: 493, sh: 522 }, // frame 1 (top-right)
    { sx: 120, sy: 644, sw: 495, sh: 520 }, // frame 2 (bottom-left)
    { sx: 686, sy: 644, sw: 493, sh: 520 }, // frame 3 (bottom-right)
  ];
  const PEDAL_ORDER = [0, 1, 2, 3]; // cycle order for a smooth pedalling loop

  // ---------- Tunable design constants (units relative to canvas height H) ----------
  const GROUND_FRAC      = 0.80;  // road surface (wheel contact line)
  const COURIER_FRAC     = 0.22;  // courier display height

  // Jump physics (per-second values multiplied by H so the feel is resolution-independent)
  const JUMP_V0          = 1.30;  // initial upward take-off speed
  const GRAVITY          = 5.0;   // normal gravity (falling / not holding)
  const GRAVITY_HOLD     = 2.1;   // reduced gravity while rising and holding
  const JUMP_CUT         = 0.80;  // velocity ceiling applied on early release (short hops)
  const MAX_HOLD         = 0.26;  // max seconds the low-gravity assist lasts (caps height)

  // World speed & difficulty
  const BASE_SPEED       = 0.62;  // starting scroll speed (H units / sec)
  const SPEED_RAMP       = 0.020; // speed added per second of play
  const MAX_SPEED_BONUS  = 1.15;  // cap on the difficulty multiplier (1 + this)

  // Potholes
  const POTHOLE_MIN_W    = 0.07;  // min width (H units)
  const POTHOLE_MAX_W    = 0.14;  // max width (H units)
  const CRASH_CLEARANCE  = 0.02;  // wheels must be lifted this far to clear a hole (H units)

  // Animation
  const FRAME_TIME       = 0.10;  // base seconds per pedal frame (scaled by speed)

  // ---------- State ----------
  const READY = 0, PLAYING = 1, GAMEOVER = 2;
  let state = READY;

  let groundY = 0, courierX = 0, courierH = 0, courierW = 0;
  let speed = 0, distance = 0, scoreFloat = 0, score = 0;
  let best = parseInt(localStorage.getItem("courier_best") || "0", 10) || 0;
  let nextPointAt = 100;
  let restartAllowedAt = 0;

  const courier = { y: 0, vy: 0, grounded: true, holding: false, jumpTime: 0 };
  let frame = 0, animAcc = 0;

  let potholes = [];
  let spawnTimer = 0;

  // Parallax offsets (in px, ever-decreasing; wrapped at draw time)
  let cloudX = 0, bldX = 0, roadX = 0;

  // ============================================================
  //  Sizing / responsiveness
  // ============================================================
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth || document.documentElement.clientWidth || 800;
    H = window.innerHeight || document.documentElement.clientHeight || 600;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    groundY = H * GROUND_FRAC;
    courierH = H * COURIER_FRAC;
    courierW = courierH * 0.95;
    courierX = Math.max(W * 0.18, 78);

    if (courier.grounded) courier.y = groundY;
    else courier.y = Math.min(courier.y, groundY);
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  window.addEventListener("load", resize);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) last = 0; });

  // ============================================================
  //  Audio (Web Audio — generated beeps, no asset files)
  // ============================================================
  let audioCtx = null;
  let muted = localStorage.getItem("courier_muted") === "1";

  function resumeAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }

  function beep(freq, dur, type, vol, slideTo) {
    if (muted || !audioCtx) return;
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type || "square";
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol || 0.07, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur);
  }

  const playJump  = () => beep(300, 0.18, "square", 0.06, 660);
  const playPoint = () => beep(880, 0.08, "square", 0.05);
  const playCrash = () => { beep(220, 0.35, "sawtooth", 0.09, 70); beep(110, 0.4, "square", 0.06, 50); };

  function updateMuteIcon() { muteBtn.textContent = muted ? "🔇" : "🔊"; }
  muteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    muted = !muted;
    localStorage.setItem("courier_muted", muted ? "1" : "0");
    updateMuteIcon();
    resumeAudio();
  });

  // ============================================================
  //  Input — unified for keyboard, mouse, touch & pen
  // ============================================================
  function pressJump() {
    resumeAudio();

    if (state === READY) { startGame(); /* fall through so the first press also hops */ }
    else if (state === GAMEOVER) {
      if (performance.now() >= restartAllowedAt) startGame();
      return;
    }

    if (state === PLAYING && courier.grounded) {
      courier.vy = -JUMP_V0 * H;
      courier.grounded = false;
      courier.holding = true;
      courier.jumpTime = 0;
      playJump();
    }
  }

  function releaseJump() {
    courier.holding = false;
    // Early release => trim upward velocity for a shorter hop (capped max height stays via MAX_HOLD).
    if (!courier.grounded && courier.vy < -JUMP_CUT * H) courier.vy = -JUMP_CUT * H;
  }

  // Keyboard (desktop)
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp" || e.key === " ") {
      e.preventDefault();
      if (!e.repeat) pressJump();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp" || e.key === " ") {
      e.preventDefault();
      releaseJump();
    }
  });

  // Pointer (covers mouse click-hold, touch tap-hold and pen)
  window.addEventListener("pointerdown", (e) => {
    if (e.target.closest && e.target.closest(".btn")) return; // let the mute button work
    e.preventDefault();
    pressJump();
  }, { passive: false });
  window.addEventListener("pointerup", () => releaseJump());
  window.addEventListener("pointercancel", () => releaseJump());
  // Stop iOS Safari double-tap zoom / long-press menu.
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  // ============================================================
  //  Game flow
  // ============================================================
  function startGame() {
    state = PLAYING;
    speed = BASE_SPEED * H;
    distance = 0;
    scoreFloat = 0;
    score = 0;
    nextPointAt = 100;
    potholes = [];
    spawnTimer = 0.6; // brief grace before the first pothole
    courier.y = groundY;
    courier.vy = 0;
    courier.grounded = true;
    courier.holding = false;
    startScreen.classList.add("hidden");
    gameOverScreen.classList.add("hidden");
    updateHUD();
  }

  function gameOver() {
    state = GAMEOVER;
    playCrash();
    if (score > best) {
      best = score;
      localStorage.setItem("courier_best", String(best));
    }
    elFinalScore.textContent = score;
    elFinalBest.textContent = best;
    updateHUD();
    gameOverScreen.classList.remove("hidden");
    restartAllowedAt = performance.now() + 450; // debounce so the crashing press doesn't instantly restart
  }

  function updateHUD() {
    elScore.textContent = score;
    elBest.textContent = "BEST " + best;
  }

  // ============================================================
  //  Potholes
  // ============================================================
  function spawnPothole() {
    const w = (POTHOLE_MIN_W + Math.random() * (POTHOLE_MAX_W - POTHOLE_MIN_W)) * H;
    potholes.push({ x: W + 40, w: w, h: w * 0.18 });
  }

  function nextSpawnInterval() {
    // Constant *spatial* gap (scaled by current speed) => always clearable, harder as speed rises.
    const base = (2.0 + Math.random() * 1.4) * (BASE_SPEED * H);
    return base / speed;
  }

  // ============================================================
  //  Pseudo-random helper for deterministic, seamless scenery
  // ============================================================
  function rnd(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }

  // ============================================================
  //  Update
  // ============================================================
  function update(dt) {
    const playing = state === PLAYING;

    if (playing) {
      distance += dt;
      speed = BASE_SPEED * H * (1 + Math.min(MAX_SPEED_BONUS, distance * SPEED_RAMP));
    }

    // Visual scroll speed (gentle drift on the menu so the scene feels alive)
    const vis = playing ? speed : BASE_SPEED * H * 0.5;

    // Parallax + road scroll
    cloudX -= vis * 0.12 * dt;
    bldX   -= vis * 0.45 * dt;
    roadX  -= vis * dt;

    // Pedal animation (cadence rises with speed)
    animAcc += dt * (vis / (BASE_SPEED * H));
    if (animAcc >= FRAME_TIME) { animAcc -= FRAME_TIME; frame = (frame + 1) % PEDAL_ORDER.length; }

    if (!playing) return;

    // Courier physics — variable-height jump
    if (!courier.grounded) {
      const rising = courier.vy < 0;
      const g = (courier.holding && rising && courier.jumpTime < MAX_HOLD) ? GRAVITY_HOLD : GRAVITY;
      courier.vy += g * H * dt;
      courier.y += courier.vy * dt;
      courier.jumpTime += dt;
      if (courier.y >= groundY) {
        courier.y = groundY;
        courier.vy = 0;
        courier.grounded = true;
        courier.holding = false;
      }
    }

    // Potholes: spawn, move, cull
    spawnTimer -= dt;
    if (spawnTimer <= 0) { spawnPothole(); spawnTimer = nextSpawnInterval(); }
    for (let i = potholes.length - 1; i >= 0; i--) {
      potholes[i].x -= speed * dt;
      if (potholes[i].x + potholes[i].w < -60) potholes.splice(i, 1);
    }

    // Collision: crash if the footprint overlaps a hole while the wheels are not lifted enough.
    const lifted = groundY - courier.y;
    if (lifted < CRASH_CLEARANCE * H) {
      const footL = courierX - courierW * 0.24;
      const footR = courierX + courierW * 0.30;
      for (const p of potholes) {
        if (footR > p.x && footL < p.x + p.w) { gameOver(); break; }
      }
    }

    // Score
    scoreFloat += dt * (speed / (BASE_SPEED * H)) * 10;
    const newScore = Math.floor(scoreFloat);
    if (newScore !== score) { score = newScore; updateHUD(); }
    if (score >= nextPointAt) { nextPointAt += 100; playPoint(); }
  }

  // ============================================================
  //  Rendering
  // ============================================================
  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawSky();
    drawClouds();
    drawBuildings();
    drawRoad();
    for (const p of potholes) drawPothole(p);
    drawCourier();
  }

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, groundY);
    g.addColorStop(0, "#9ad9ff");
    g.addColorStop(0.7, "#cdeeff");
    g.addColorStop(1, "#fdf3cf");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, groundY);

    // Sun
    const sr = H * 0.07;
    ctx.fillStyle = "rgba(255, 214, 92, 0.95)";
    ctx.beginPath();
    ctx.arc(W * 0.80, H * 0.18, sr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 235, 160, 0.35)";
    ctx.beginPath();
    ctx.arc(W * 0.80, H * 0.18, sr * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawClouds() {
    const tile = Math.max(260, W * 0.5);
    const start = (cloudX % tile);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    for (let x = start - tile; x < W + tile; x += tile) {
      const i = Math.round((x - cloudX) / tile);
      const cy = (0.10 + 0.10 * rnd(i)) * H;
      const cx = x + rnd(i + 7) * tile * 0.5;
      const s = (0.5 + rnd(i + 3) * 0.7) * H * 0.05;
      puff(cx, cy, s);
    }
  }
  function puff(x, y, s) {
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.arc(x + s, y + s * 0.2, s * 0.85, 0, Math.PI * 2);
    ctx.arc(x - s, y + s * 0.2, s * 0.8, 0, Math.PI * 2);
    ctx.arc(x + s * 0.4, y - s * 0.5, s * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBuildings() {
    const tile = Math.max(120, W * 0.16);
    const start = (bldX % tile);
    const palette = ["#cdb9e6", "#bfa9dd", "#d6c4ec", "#b59fd6"];
    for (let x = start - tile; x < W + tile; x += tile) {
      const i = Math.round((x - bldX) / tile);
      const h = (0.16 + 0.18 * rnd(i)) * H;
      const gap = tile * 0.10;
      const bx = x + gap, bw = tile - gap * 2, by = groundY - h;
      ctx.fillStyle = palette[((i % palette.length) + palette.length) % palette.length];
      ctx.fillRect(bx, by, bw, h);
      // windows
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      const cols = 3, rows = Math.max(2, Math.floor(h / (H * 0.07)));
      const ww = bw / (cols * 2.2), wh = ww * 1.3;
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          if (rnd(i * 31 + c * 7 + r * 13) > 0.35) {
            ctx.fillRect(bx + bw * 0.18 + c * (bw * 0.30), by + wh + r * (wh * 1.8), ww, wh);
          }
        }
      }
    }
  }

  function drawRoad() {
    // Asphalt
    const g = ctx.createLinearGradient(0, groundY, 0, H);
    g.addColorStop(0, "#4c4c55");
    g.addColorStop(1, "#2c2c32");
    ctx.fillStyle = g;
    ctx.fillRect(0, groundY, W, H - groundY);

    // Road-surface highlight
    ctx.fillStyle = "#60606b";
    ctx.fillRect(0, groundY, W, Math.max(2, H * 0.006));

    // Centre dashed line (scrolls at full speed)
    const dashY = groundY + (H - groundY) * 0.55;
    const dash = Math.max(26, W * 0.05);
    const gapd = dash * 0.8;
    ctx.fillStyle = "#f4d44d";
    let x = (roadX % (dash + gapd));
    for (; x < W; x += dash + gapd) ctx.fillRect(x, dashY, dash, Math.max(3, H * 0.008));
  }

  function drawPothole(p) {
    const cx = p.x + p.w / 2;
    const cy = groundY + p.h;      // top edge of the hole flush with the road surface
    const rx = p.w / 2;
    // Hole
    ctx.fillStyle = "#141418";
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, p.h, 0, 0, Math.PI * 2);
    ctx.fill();
    // Inner depth
    ctx.fillStyle = "#020203";
    ctx.beginPath();
    ctx.ellipse(cx, cy + p.h * 0.25, rx * 0.78, p.h * 0.78, 0, 0, Math.PI * 2);
    ctx.fill();
    // Rim highlight (top arc)
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = Math.max(1.5, H * 0.004);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, p.h, 0, Math.PI, Math.PI * 2);
    ctx.stroke();
  }

  function drawCourier() {
    if (!sheetReady) return;
    const f = FRAMES[PEDAL_ORDER[frame]];
    const scale = courierH / f.sh;
    const dw = f.sw * scale;
    const dh = courierH;
    const dx = courierX - dw / 2;
    const dy = courier.y - dh; // content bottom (wheels) sits on courier.y

    // Soft shadow on the road (shrinks as the courier rises)
    const lift = (groundY - courier.y) / (H * 0.30);
    const shA = Math.max(0.06, 0.28 - lift * 0.22);
    const shW = dw * (0.5 - lift * 0.12);
    ctx.fillStyle = "rgba(0,0,0," + shA + ")";
    ctx.beginPath();
    ctx.ellipse(courierX, groundY + H * 0.012, Math.max(8, shW), Math.max(4, H * 0.014), 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.drawImage(sheet, f.sx, f.sy, f.sw, f.sh, dx, dy, dw, dh);
  }

  // ============================================================
  //  Main loop (delta-timed)
  // ============================================================
  let last = 0;
  function loop(now) {
    if (!last) last = now;
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.05) dt = 0.05; // clamp after tab switches / stalls
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  // ============================================================
  //  Boot
  // ============================================================
  function boot() {
    resize();
    updateMuteIcon();
    updateHUD();
    courier.y = groundY;
    requestAnimationFrame(loop);
  }

  sheet.onload = () => { sheetReady = true; };
  sheet.onerror = () => { console.error("Failed to load sprite sheet images/courier.png"); };
  sheet.src = "images/courier.png";

  boot();
})();
