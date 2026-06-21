/* ============================================================
   Bike Courier — an endless runner (Google Dino-style)
   A Yandex Eda courier rides a smooth road and jumps barriers.
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

  // ---------- Telegram Games integration ----------
  // When launched from the bot, the Worker appends a signed identity token (t)
  // and its own URL (b). Outside Telegram these are absent and scoring is skipped.
  const tgParams  = new URLSearchParams(location.search);
  const TG_TOKEN  = tgParams.get("t");
  const TG_BACKEND = (tgParams.get("b") || "").replace(/\/+$/, "");
  function submitScore(s) {
    if (!TG_TOKEN || !TG_BACKEND || !(s > 0)) return;
    try {
      fetch(TG_BACKEND + "/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: TG_TOKEN, score: s }),
        keepalive: true, // let it complete even if the webview is closing
      }).catch(() => {});
    } catch (_) { /* never let scoring break the game */ }
  }

  // The courier is drawn entirely in code (see drawCourier) — no image asset.

  // ---------- Tunable design constants (units relative to canvas height H) ----------
  const GROUND_FRAC      = 0.80;  // road surface (wheel contact line)
  const COURIER_FRAC     = 0.22;  // courier display height (landscape reference)

  // Aspect-aware shrink — sprites & obstacles are sized in H units, which makes
  // them oversized on tall portrait phones (small W, large H) so you can barely
  // see the road ahead. On narrow screens we scale the courier, barriers and the
  // jump down together (keeping the same feel) so more of the road is visible.
  const MOBILE_SCALE     = 0.55;  // actor scale on a tall phone (portrait)
  const PORTRAIT_ASPECT  = 0.50;  // W/H at/below which the full shrink applies
  const LANDSCAPE_ASPECT = 0.90;  // W/H at/above which no shrink (desktop) applies

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

  // Barriers (road blocks the courier must jump over)
  const BARRIER_MIN_W    = 0.060; // min width (H units)
  const BARRIER_MAX_W    = 0.090; // max width (H units)
  const BARRIER_MIN_H    = 0.070; // min height (H units)
  const BARRIER_MAX_H    = 0.115; // max height — kept well under the max jump so it's clearable

  // Animation
  const PEDAL_CADENCE    = 7.5;   // crank radians per second at base speed

  // ---------- State ----------
  const READY = 0, PLAYING = 1, GAMEOVER = 2;
  let state = READY;

  let groundY = 0, courierX = 0, courierH = 0, courierW = 0;
  let actorScale = 1;       // 0..1 multiplier applied to courier, barriers & jump
  let speed = 0, distance = 0, scoreFloat = 0, score = 0;
  let best = parseInt(localStorage.getItem("courier_best") || "0", 10) || 0;
  let nextPointAt = 100;
  let restartAllowedAt = 0;

  const courier = { y: 0, vy: 0, grounded: true, holding: false, jumpTime: 0 };
  let pedalPhase = 0;       // radians; drives leg pedaling + wheel spin

  let barriers = [];
  let spawnTimer = 0;

  // Parallax offsets (in px, ever-decreasing; wrapped at draw time)
  let cloudX = 0, bldX = 0, roadX = 0;

  // ============================================================
  //  Sizing / responsiveness
  // ============================================================
  // Full size on landscape; smoothly down to MOBILE_SCALE on a tall phone.
  function computeActorScale() {
    const aspect = W / H;
    const t = Math.min(1, Math.max(0, (aspect - PORTRAIT_ASPECT) / (LANDSCAPE_ASPECT - PORTRAIT_ASPECT)));
    return MOBILE_SCALE + (1 - MOBILE_SCALE) * t;
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth || document.documentElement.clientWidth || 800;
    H = window.innerHeight || document.documentElement.clientHeight || 600;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    actorScale = computeActorScale();
    groundY = H * GROUND_FRAC;
    courierH = H * COURIER_FRAC * actorScale;
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
      courier.vy = -JUMP_V0 * H * actorScale;
      courier.grounded = false;
      courier.holding = true;
      courier.jumpTime = 0;
      playJump();
    }
  }

  function releaseJump() {
    courier.holding = false;
    // Early release => trim upward velocity for a shorter hop (capped max height stays via MAX_HOLD).
    if (!courier.grounded && courier.vy < -JUMP_CUT * H * actorScale) courier.vy = -JUMP_CUT * H * actorScale;
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
    barriers = [];
    spawnTimer = 0.6; // brief grace before the first barrier
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
    submitScore(score); // record on Telegram's leaderboard (no-op outside the bot)
    gameOverScreen.classList.remove("hidden");
    restartAllowedAt = performance.now() + 450; // debounce so the crashing press doesn't instantly restart
  }

  function updateHUD() {
    elScore.textContent = score;
    elBest.textContent = "BEST " + best;
  }

  // ============================================================
  //  Barriers
  // ============================================================
  function spawnBarrier() {
    const w = (BARRIER_MIN_W + Math.random() * (BARRIER_MAX_W - BARRIER_MIN_W)) * H * actorScale;
    const h = (BARRIER_MIN_H + Math.random() * (BARRIER_MAX_H - BARRIER_MIN_H)) * H * actorScale;
    barriers.push({ x: W + 40, w: w, h: h });
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

    // Pedal cadence + wheel spin (rises with speed)
    pedalPhase += dt * (vis / (BASE_SPEED * H)) * PEDAL_CADENCE;

    if (!playing) return;

    // Courier physics — variable-height jump
    if (!courier.grounded) {
      const rising = courier.vy < 0;
      const g = (courier.holding && rising && courier.jumpTime < MAX_HOLD) ? GRAVITY_HOLD : GRAVITY;
      courier.vy += g * H * actorScale * dt;
      courier.y += courier.vy * dt;
      courier.jumpTime += dt;
      if (courier.y >= groundY) {
        courier.y = groundY;
        courier.vy = 0;
        courier.grounded = true;
        courier.holding = false;
      }
    }

    // Barriers: spawn, move, cull
    spawnTimer -= dt;
    if (spawnTimer <= 0) { spawnBarrier(); spawnTimer = nextSpawnInterval(); }
    for (let i = barriers.length - 1; i >= 0; i--) {
      barriers[i].x -= speed * dt;
      if (barriers[i].x + barriers[i].w < -60) barriers.splice(i, 1);
    }

    // Collision: crash if the footprint overlaps a barrier the wheels haven't cleared.
    const lifted = groundY - courier.y;
    const footL = courierX - courierW * 0.24;
    const footR = courierX + courierW * 0.30;
    for (const b of barriers) {
      if (footR > b.x && footL < b.x + b.w && lifted < b.h) { gameOver(); break; }
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
    for (const b of barriers) drawBarrier(b);
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

  // Rounded-rectangle path (no fill/stroke); used by the barrier.
  function roundRectPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  function drawBarrier(b) {
    const top = groundY - b.h;
    const r = Math.min(8, b.w * 0.22);

    // Contact shadow on the road
    ctx.fillStyle = "rgba(0,0,0,0.20)";
    ctx.beginPath();
    ctx.ellipse(b.x + b.w / 2, groundY + H * 0.006, b.w * 0.62, Math.max(3, H * 0.010), 0, 0, Math.PI * 2);
    ctx.fill();

    // Body with diagonal hazard stripes, clipped to a rounded rect (= the solid hit-box)
    ctx.save();
    roundRectPath(b.x, top, b.w, b.h, r);
    ctx.clip();
    ctx.fillStyle = "#f4d44d";                  // yellow base
    ctx.fillRect(b.x, top, b.w, b.h);
    ctx.fillStyle = "#2a2a2e";                  // dark hazard stripes (45°)
    const sw = b.h * 0.55;                       // stripe slant width
    for (let sx = b.x - b.h; sx < b.x + b.w + b.h; sx += sw * 2) {
      ctx.beginPath();
      ctx.moveTo(sx,           groundY);
      ctx.lineTo(sx + sw,      groundY);
      ctx.lineTo(sx + sw + b.h, top);
      ctx.lineTo(sx + b.h,      top);
      ctx.closePath();
      ctx.fill();
    }
    // Darker base where it meets the road
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(b.x, groundY - b.h * 0.14, b.w, b.h * 0.14);
    ctx.restore();

    // Outline
    ctx.strokeStyle = "rgba(0,0,0,0.40)";
    ctx.lineWidth = Math.max(1.5, H * 0.0035);
    roundRectPath(b.x, top, b.w, b.h, r);
    ctx.stroke();
  }

  // 2-bone inverse kinematics: knee position given hip, foot and segment lengths.
  function knee(hx, hy, fx, fy, a, b, bend) {
    const dx = fx - hx, dy = fy - hy;
    const d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, Math.hypot(dx, dy)));
    const base = Math.atan2(dy, dx);
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    const ang = base + bend * Math.acos(Math.min(1, Math.max(-1, cosA)));
    return { x: hx + a * Math.cos(ang), y: hy + a * Math.sin(ang) };
  }

  function drawWheel(cx, cy, r, ang) {
    ctx.lineWidth = r * 0.18;                         // tire
    ctx.strokeStyle = "#2b2b30";
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = Math.max(1, r * 0.04);            // spokes
    ctx.strokeStyle = "rgba(70,70,78,0.85)";
    for (let k = 0; k < 6; k++) {
      const a = ang + k * (Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + r * 0.78 * Math.cos(a), cy + r * 0.78 * Math.sin(a));
      ctx.stroke();
    }
    ctx.lineWidth = r * 0.06;                          // yellow rim
    ctx.strokeStyle = "#f4d44d";
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#2b2b30";                         // hub
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.12, 0, Math.PI * 2); ctx.fill();
  }

  // The courier + bike, drawn in code. Origin is the ground-contact point
  // (courierX, courier.y); everything is sized in units of u = courierH.
  function drawCourier() {
    const u = courierH;
    const gx = courierX, gy = courier.y;

    // Soft shadow on the road (shrinks as the courier rises)
    const lift = (groundY - courier.y) / (H * 0.30);
    const shA = Math.max(0.06, 0.28 - lift * 0.22);
    const shW = u * (0.52 - lift * 0.12);
    ctx.fillStyle = "rgba(0,0,0," + shA + ")";
    ctx.beginPath();
    ctx.ellipse(gx, groundY + H * 0.012, Math.max(8, shW), Math.max(4, H * 0.014), 0, 0, Math.PI * 2);
    ctx.fill();

    // Key points
    const wr     = 0.185 * u;
    const rearW  = { x: gx - 0.28 * u, y: gy - wr };
    const frontW = { x: gx + 0.30 * u, y: gy - wr };
    const bb     = { x: gx + 0.01 * u, y: gy - 0.22 * u };   // crank / bottom bracket
    const seat   = { x: gx - 0.14 * u, y: gy - 0.50 * u };
    const head   = { x: gx + 0.34 * u, y: gy - 0.50 * u };   // head tube (front)
    const hip    = { x: gx - 0.05 * u, y: gy - 0.54 * u };
    const shldr  = { x: gx + 0.11 * u, y: gy - 0.80 * u };
    const bar    = { x: gx + 0.40 * u, y: gy - 0.55 * u };   // handlebar
    const faceC  = { x: gx + 0.20 * u, y: gy - 0.91 * u };
    const faceR  = 0.105 * u;
    const crankR = 0.095 * u;
    const thigh  = 0.27 * u, shin = 0.27 * u;
    const wheelAng = pedalPhase * 2.4;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Pedal positions (180° apart)
    const pedN = { x: bb.x + crankR * Math.cos(pedalPhase),            y: bb.y + crankR * Math.sin(pedalPhase) };
    const pedF = { x: bb.x + crankR * Math.cos(pedalPhase + Math.PI),  y: bb.y + crankR * Math.sin(pedalPhase + Math.PI) };

    function leg(foot, pantCol) {
      const k = knee(hip.x, hip.y, foot.x, foot.y, thigh, shin, -1);
      ctx.strokeStyle = pantCol;
      ctx.lineWidth = 0.092 * u;                         // thigh
      ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(k.x, k.y); ctx.stroke();
      ctx.lineWidth = 0.07 * u;                          // shin
      ctx.beginPath(); ctx.moveTo(k.x, k.y); ctx.lineTo(foot.x, foot.y); ctx.stroke();
      ctx.fillStyle = "#1d1d22";                         // shoe
      ctx.beginPath();
      ctx.ellipse(foot.x + 0.025 * u, foot.y + 0.006 * u, 0.066 * u, 0.036 * u, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.22)";          // sole highlight
      ctx.fillRect(foot.x - 0.04 * u, foot.y + 0.028 * u, 0.13 * u, 0.012 * u);
    }

    // 1) far leg (behind the bike, darker pants)
    leg(pedF, "#2c3446");

    // 2) bike frame
    ctx.strokeStyle = "#34343c";
    ctx.lineWidth = 0.045 * u;
    ctx.beginPath();
    ctx.moveTo(bb.x, bb.y);   ctx.lineTo(rearW.x, rearW.y);   // chain stay
    ctx.moveTo(seat.x, seat.y); ctx.lineTo(rearW.x, rearW.y); // seat stay
    ctx.moveTo(seat.x, seat.y); ctx.lineTo(bb.x, bb.y);       // seat tube
    ctx.moveTo(bb.x, bb.y);   ctx.lineTo(head.x, head.y);     // down tube
    ctx.moveTo(seat.x, seat.y); ctx.lineTo(head.x, head.y);   // top tube
    ctx.moveTo(head.x, head.y); ctx.lineTo(frontW.x, frontW.y); // fork
    ctx.moveTo(head.x, head.y); ctx.lineTo(bar.x, bar.y);     // stem to bars
    ctx.stroke();
    // saddle
    ctx.lineWidth = 0.05 * u; ctx.strokeStyle = "#222";
    ctx.beginPath(); ctx.moveTo(seat.x - 0.06 * u, seat.y); ctx.lineTo(seat.x + 0.05 * u, seat.y - 0.01 * u); ctx.stroke();
    // chainring + crank arms + pedals
    ctx.fillStyle = "#26262c";
    ctx.beginPath(); ctx.arc(bb.x, bb.y, 0.05 * u, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 0.022 * u; ctx.strokeStyle = "#15151a";
    ctx.beginPath();
    ctx.moveTo(bb.x, bb.y); ctx.lineTo(pedN.x, pedN.y);
    ctx.moveTo(bb.x, bb.y); ctx.lineTo(pedF.x, pedF.y);
    ctx.stroke();
    ctx.fillStyle = "#15151a";
    ctx.fillRect(pedF.x - 0.045 * u, pedF.y - 0.012 * u, 0.09 * u, 0.024 * u);
    ctx.fillRect(pedN.x - 0.045 * u, pedN.y - 0.012 * u, 0.09 * u, 0.024 * u);

    // 3) wheels
    drawWheel(rearW.x, rearW.y, wr, wheelAng);
    drawWheel(frontW.x, frontW.y, wr, wheelAng);

    // 4) delivery backpack (yellow food box) with the swirl logo
    ctx.save();
    ctx.translate(gx - 0.115 * u, gy - 0.70 * u);
    ctx.rotate(-0.12);
    const bw = 0.27 * u, bh = 0.31 * u;
    ctx.fillStyle = "#ffcc00";
    roundRectPath(-bw / 2, -bh / 2, bw, bh, 0.055 * u);
    ctx.fill();
    ctx.save();                                          // bottom shading, clipped to box
    roundRectPath(-bw / 2, -bh / 2, bw, bh, 0.055 * u); ctx.clip();
    ctx.fillStyle = "rgba(0,0,0,0.10)";
    ctx.fillRect(-bw / 2, bh * 0.12, bw, bh * 0.4);
    ctx.restore();
    ctx.strokeStyle = "rgba(0,0,0,0.32)"; ctx.lineWidth = 0.012 * u;   // outline
    roundRectPath(-bw / 2, -bh / 2, bw, bh, 0.055 * u); ctx.stroke();
    // swirl logo (Archimedean spiral, Yandex Eda style)
    ctx.strokeStyle = "#23232a";
    ctx.lineWidth = 0.024 * u;
    ctx.lineCap = "round";
    const TURNS = 2.6, MAXR = 0.10 * u, ST = 90;
    ctx.beginPath();
    for (let i = 0; i <= ST; i++) {
      const tt = i / ST, a = tt * TURNS * Math.PI * 2, rr = MAXR * tt;
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    // 5) torso — single flat colour (clean body)
    ctx.strokeStyle = "#ffd21e"; ctx.lineWidth = 0.18 * u;
    ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(shldr.x, shldr.y); ctx.stroke();

    // 6) neck + head (ear, face, nose, eye, cap, visor)
    ctx.strokeStyle = "#e8b58a"; ctx.lineWidth = 0.055 * u;
    ctx.beginPath(); ctx.moveTo(shldr.x + 0.02 * u, shldr.y); ctx.lineTo(faceC.x - 0.03 * u, faceC.y + faceR * 0.85); ctx.stroke();
    ctx.fillStyle = "#e3ad7f";                            // ear (peeks behind face)
    ctx.beginPath(); ctx.arc(faceC.x - faceR * 0.78, faceC.y + faceR * 0.08, faceR * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f1c79b";                            // face
    ctx.beginPath(); ctx.arc(faceC.x, faceC.y, faceR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(faceC.x + faceR * 0.95, faceC.y + faceR * 0.18, faceR * 0.17, 0, Math.PI * 2); ctx.fill(); // nose
    ctx.fillStyle = "#2a2a2e";                            // eye
    ctx.beginPath(); ctx.arc(faceC.x + faceR * 0.42, faceC.y - faceR * 0.04, 0.014 * u, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffcc00";                            // cap dome
    ctx.beginPath(); ctx.arc(faceC.x, faceC.y - faceR * 0.06, faceR * 1.06, Math.PI, 2 * Math.PI); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#f3c200";                            // visor (points forward)
    ctx.beginPath();
    ctx.moveTo(faceC.x + faceR * 0.10, faceC.y - faceR * 0.42);
    ctx.lineTo(faceC.x + faceR * 1.55, faceC.y - faceR * 0.50);
    ctx.lineTo(faceC.x + faceR * 1.35, faceC.y - faceR * 0.24);
    ctx.closePath(); ctx.fill();

    // 7) near arm (shoulder -> elbow -> hand), bent at the elbow
    const elbow = knee(shldr.x, shldr.y, bar.x, bar.y, 0.21 * u, 0.22 * u, 1);
    ctx.strokeStyle = "#ffd21e"; ctx.lineWidth = 0.072 * u;            // upper sleeve
    ctx.beginPath(); ctx.moveTo(shldr.x, shldr.y); ctx.lineTo(elbow.x, elbow.y); ctx.stroke();
    ctx.lineWidth = 0.058 * u;                                         // forearm
    ctx.beginPath(); ctx.moveTo(elbow.x, elbow.y); ctx.lineTo(bar.x, bar.y); ctx.stroke();
    ctx.fillStyle = "#2a2a2e";                                         // glove
    ctx.beginPath(); ctx.arc(bar.x, bar.y, 0.038 * u, 0, Math.PI * 2); ctx.fill();

    // 8) near leg (in front)
    leg(pedN, "#39435a");
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

  boot();
})();
