/* ============================================================
   Bike Courier — an endless runner (Google Dino-style)
   A Yandex Eda courier rides the road, jumping onto multi-level railings.
   ============================================================ */

(() => {
  "use strict";

  // ---------- Canvas ----------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("stage");
  let W = 0, H = 0, DPR = 1;
  let skyGrad = null, roadGrad = null;   // full-frame gradients, rebuilt on resize

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
  const COURIER_FRAC     = 0.22;  // courier display height (before ACTOR_SCALE)

  // The game is portrait-locked (~0.5 aspect) on every device — touch devices are
  // locked out of landscape and desktop renders inside a portrait frame — so one
  // scale keeps the courier, railings and jump sized for that frame. (Sprites are
  // measured in H units, which would otherwise look oversized on a tall screen.)
  const ACTOR_SCALE      = 0.55;

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

  // Railings — elevated ledges you jump ONTO and ride along the top; ram the
  // front (left) face and you crash. Multi-level: each spawns at a random height.
  const RAIL_MIN_W     = 0.55;              // length (H units) — "long"
  const RAIL_MAX_W     = 1.20;
  const RAIL_LEVELS    = [0.09, 0.155, 0.22]; // top height above the road (H units, pre-scale)
  const RAIL_GAP       = 0.55;              // clear ground (H units) between consecutive railings
  const RAIL_CRASH_TOL = 0.02;              // feet this far below the top still count as "on top"

  // Animation
  const PEDAL_CADENCE    = 7.5;   // crank radians per second at base speed

  // Drone-crash cutscene (one-off spectacle)
  const DRONE_AT         = 11000;  // score that triggers it
  const DRONE_FLY        = 1.4;   // seconds the drone dives before impact
  const EXPLODE_DUR      = 1.1;   // explosion / fireball duration
  const SETTLE_DUR       = 0.6;   // smoke settle before play resumes

  // ---------- State ----------
  const READY = 0, PLAYING = 1, GAMEOVER = 2, CUTSCENE = 3;
  let state = READY;

  let groundY = 0, courierX = 0, courierH = 0, courierW = 0;
  let actorScale = ACTOR_SCALE;  // multiplier applied to courier, railings & jump
  let speed = 0, distance = 0, scoreFloat = 0, score = 0;
  let best = parseInt(localStorage.getItem("courier_best") || "0", 10) || 0;
  let nextPointAt = 100;
  let restartAllowedAt = 0;

  const courier = { y: 0, vy: 0, grounded: true, holding: false, jumpTime: 0 };
  let pedalPhase = 0;       // radians; drives leg pedaling + wheel spin

  let rails = [];
  let spawnTimer = 0;

  // Parallax offsets (in px, ever-decreasing; wrapped at draw time)
  let cloudX = 0, bldX = 0, roadX = 0;

  // Drone-crash cutscene
  let cutTime = 0, cutExploded = false, droneDone = false;
  let cutParticles = [];

  // ============================================================
  //  Sizing / responsiveness
  // ============================================================
  // On touch devices the game is portrait-only (a consistent aspect ratio makes
  // difficulty easier to balance); in landscape we freeze and show the #rotate
  // overlay (CSS, same query). Desktop (fine pointer) is never affected.
  const portraitLock = window.matchMedia("(orientation: landscape) and (pointer: coarse)");
  const PORTRAIT_RATIO = 0.5;   // desktop renders the game in this W:H portrait frame (≈ a phone)

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    const winW = window.innerWidth || document.documentElement.clientWidth || 800;
    const winH = window.innerHeight || document.documentElement.clientHeight || 600;

    // Touch devices fill the screen (already portrait; landscape is locked out).
    // Desktop plays in a centered portrait frame so the playfield matches mobile.
    if (window.matchMedia("(pointer: coarse)").matches) {
      W = winW; H = winH;
    } else if (winW / winH > PORTRAIT_RATIO) {
      H = winH; W = Math.round(winH * PORTRAIT_RATIO);   // window wider than the frame
    } else {
      W = winW; H = Math.round(winW / PORTRAIT_RATIO);   // very narrow window
    }

    stage.style.width = W + "px";
    stage.style.height = H + "px";
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    groundY = H * GROUND_FRAC;
    courierH = H * COURIER_FRAC * actorScale;
    courierW = courierH * 0.95;
    courierX = Math.max(W * 0.18, 78);

    // Cache the full-frame gradients — they only change when the canvas resizes.
    skyGrad = ctx.createLinearGradient(0, 0, 0, groundY);
    skyGrad.addColorStop(0, "#9ad9ff");
    skyGrad.addColorStop(0.7, "#cdeeff");
    skyGrad.addColorStop(1, "#fdf3cf");
    roadGrad = ctx.createLinearGradient(0, groundY, 0, H);
    roadGrad.addColorStop(0, "#4c4c55");
    roadGrad.addColorStop(1, "#2c2c32");

    if (courier.grounded) courier.y = groundY;
    else courier.y = Math.min(courier.y, groundY);
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  window.addEventListener("load", resize);
  portraitLock.addEventListener("change", () => { resize(); last = 0; });
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
    decodeExplosion();   // decode the explosion clip now that we have a context
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

  // ---------- Explosion sound (sounds/explosion.mp3) ----------
  const EXPLOSION_VOL = 1.0;        // raise for a louder blast
  let explosionBuf = null;          // decoded AudioBuffer
  let explosionBytes = null;        // raw file bytes; decoded once the audio context exists

  fetch("sounds/explosion.mp3")
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
    .then((ab) => { explosionBytes = ab; decodeExplosion(); })
    .catch(() => {});

  function decodeExplosion() {
    if (!audioCtx || explosionBuf || !explosionBytes) return;
    // slice(0) keeps a copy — decodeAudioData detaches the buffer it's given.
    audioCtx.decodeAudioData(explosionBytes.slice(0), (buf) => { explosionBuf = buf; }, () => {});
  }

  function playExplosion() {
    if (muted || !audioCtx || !explosionBuf) return;
    try {
      const src = audioCtx.createBufferSource();
      src.buffer = explosionBuf;
      const g = audioCtx.createGain();
      g.gain.value = EXPLOSION_VOL;
      src.connect(g).connect(audioCtx.destination);
      src.start();
    } catch (_) {}
  }

  // Sustained quadcopter buzz for the crash cutscene: two detuned sawtooths
  // (the "engine") chopped by a tremolo LFO (the rotors), pitch rising as the
  // drone accelerates into its dive. Held until stopDroneSound() at impact.
  let droneNodes = null;
  function startDroneSound() {
    if (muted || !audioCtx) return;
    stopDroneSound();                                        // never stack two
    try {
      const t = audioCtx.currentTime, end = t + DRONE_FLY;
      const master = audioCtx.createGain();
      master.gain.setValueAtTime(0.0001, t);
      master.gain.exponentialRampToValueAtTime(0.05, t + 0.2);   // fade in
      const lp = audioCtx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(800, t);
      lp.frequency.linearRampToValueAtTime(1400, end);
      master.connect(lp).connect(audioCtx.destination);

      const trem = audioCtx.createGain();                   // amplitude chopped by the LFO
      trem.gain.value = 0.55;
      const lfo = audioCtx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.setValueAtTime(26, t);
      lfo.frequency.linearRampToValueAtTime(44, end);       // chops faster as it speeds up
      const depth = audioCtx.createGain();
      depth.gain.value = 0.45;
      lfo.connect(depth).connect(trem.gain);
      trem.connect(master);

      const a = audioCtx.createOscillator(), b = audioCtx.createOscillator();
      a.type = b.type = "sawtooth";
      a.frequency.setValueAtTime(85, t); a.frequency.linearRampToValueAtTime(150, end);
      b.frequency.setValueAtTime(90, t); b.frequency.linearRampToValueAtTime(158, end);
      a.connect(trem); b.connect(trem);

      a.start(t); b.start(t); lfo.start(t);
      droneNodes = { master, a, b, lfo };
    } catch (_) { droneNodes = null; }                       // audio must never break the game
  }
  function stopDroneSound() {
    if (!droneNodes || !audioCtx) return;
    const t = audioCtx.currentTime, n = droneNodes;
    droneNodes = null;
    try {
      n.master.gain.cancelScheduledValues(t);
      n.master.gain.setValueAtTime(Math.max(0.0001, n.master.gain.value), t);
      n.master.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);  // quick fade
      n.a.stop(t + 0.1); n.b.stop(t + 0.1); n.lfo.stop(t + 0.1);
    } catch (_) {}
  }

  function updateMuteIcon() { muteBtn.textContent = muted ? "🔇" : "🔊"; }
  muteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    muted = !muted;
    localStorage.setItem("courier_muted", muted ? "1" : "0");
    updateMuteIcon();
    if (muted) stopDroneSound();   // silence the drone immediately if muted mid-flight
    resumeAudio();
  });

  // ============================================================
  //  Input — unified for keyboard, mouse, touch & pen
  // ============================================================
  function pressJump() {
    if (portraitLock.matches) return;   // ignore input while asking to rotate
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
    droneDone = false;
    rails = [];
    spawnTimer = 0.8; // brief grace before the first railing
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
  //  Railings
  // ============================================================
  // Spawn one railing at a random level, then schedule the next so a clear stretch
  // of road (RAIL_GAP) follows it — at most one railing is ever above the courier.
  function spawnRail() {
    const w = (RAIL_MIN_W + Math.random() * (RAIL_MAX_W - RAIL_MIN_W)) * H * actorScale;
    const level = RAIL_LEVELS[(Math.random() * RAIL_LEVELS.length) | 0];
    rails.push({ x: W + 40, prevX: W + 40, w: w, top: groundY - level * H * actorScale });
    spawnTimer = (w + RAIL_GAP * H * actorScale) / speed;
  }

  // ============================================================
  //  Pseudo-random helper for deterministic, seamless scenery
  // ============================================================
  function rnd(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }

  // ============================================================
  //  Update
  // ============================================================
  function update(dt) {
    if (portraitLock.matches) return;                       // paused: rotate to portrait (touch + landscape)
    if (state === CUTSCENE) { updateCutscene(dt); return; } // world frozen during the crash
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

    // Railings: spawn, move, cull
    spawnTimer -= dt;
    if (spawnTimer <= 0) spawnRail();
    for (let i = rails.length - 1; i >= 0; i--) {
      rails[i].prevX = rails[i].x;
      rails[i].x -= speed * dt;
      if (rails[i].x + rails[i].w < -60) rails.splice(i, 1);
    }

    // Courier physics — variable-height jump, landing on the road or a railing top.
    const prevFeet = courier.y;
    if (!courier.grounded) {
      const rising = courier.vy < 0;
      const g = (courier.holding && rising && courier.jumpTime < MAX_HOLD) ? GRAVITY_HOLD : GRAVITY;
      courier.vy += g * H * actorScale * dt;
      courier.y += courier.vy * dt;
      courier.jumpTime += dt;
    }

    // Floor under the courier: the road, or a railing top it's descending onto
    // (one-way — only landable from at/above its surface).
    let surface = groundY;
    for (const r of rails) {
      if (courierX > r.x && courierX < r.x + r.w && r.top < surface && prevFeet <= r.top + 1) {
        surface = r.top;
      }
    }
    if (courier.vy >= 0 && courier.y >= surface) {   // resting on / landing on the surface
      courier.y = surface;
      courier.vy = 0;
      courier.grounded = true;
      courier.holding = false;
    } else {
      courier.grounded = false;                       // rising, or ran off the end of a railing
    }

    // Crash: ram the front (left) face — the courier's nose is past a railing's left
    // edge while its centre hasn't reached it yet and its wheels are below the top.
    const footR = courierX + courierW * 0.30;
    const tol = RAIL_CRASH_TOL * H * actorScale;
    for (const r of rails) {
      // the railing's front edge swept past the courier's nose this frame, with the
      // wheels still below the top => rammed the side (robust to large dt / low FPS).
      if (r.prevX >= footR && r.x < footR && courier.y > r.top + tol) { gameOver(); break; }
    }

    // Score
    scoreFloat += dt * (speed / (BASE_SPEED * H)) * 10;
    const newScore = Math.floor(scoreFloat);
    if (newScore !== score) { score = newScore; updateHUD(); }
    if (score >= nextPointAt) { nextPointAt += 100; playPoint(); }
    if (state === PLAYING && !droneDone && score >= DRONE_AT) { droneDone = true; startDrone(); }
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
    for (const r of rails) drawRail(r);
    drawCourier();
    if (state === CUTSCENE) drawCutscene();
  }

  function drawSky() {
    ctx.fillStyle = skyGrad;
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
    ctx.fillStyle = roadGrad;
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

  // Rounded-rectangle path (no fill/stroke); used by the drone & its box.
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

  // An elevated railing: a solid ledge from its top down to the road, with a
  // bright top bar you ride on. The left face is the side you crash into.
  function drawRail(r) {
    const top = r.top, h = groundY - top, x = r.x, w = r.w;

    // Ledge body (solid — this is the hit-box)
    const g = ctx.createLinearGradient(0, top, 0, groundY);
    g.addColorStop(0, "#7b8089");
    g.addColorStop(1, "#565a63");
    ctx.fillStyle = g;
    ctx.fillRect(x, top, w, h);

    // Vertical support posts
    ctx.fillStyle = "rgba(0,0,0,0.10)";
    const postW = Math.max(2, 0.012 * H * actorScale);
    const postGap = 0.18 * H * actorScale;
    for (let px = x + postGap * 0.6; px < x + w - postW; px += postGap) ctx.fillRect(px, top, postW, h);

    // Front (left) face — the side you crash into
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(x, top, Math.max(2, 0.014 * H * actorScale), h);

    // Bright top rail (the surface you ride)
    const barH = Math.max(3, 0.032 * H * actorScale);
    ctx.fillStyle = "#f4d44d";
    ctx.fillRect(x, top, w, barH);
    ctx.fillStyle = "rgba(255,255,255,0.40)";
    ctx.fillRect(x, top, w, Math.max(1, barH * 0.32));      // highlight
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(x, top + barH, w, Math.max(1, barH * 0.25)); // shade under the bar
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

    // Shadow: right under the wheels when riding a surface (road or railing);
    // a fainter one cast on the road below while airborne.
    if (courier.grounded) {
      ctx.fillStyle = "rgba(0,0,0,0.26)";
      ctx.beginPath();
      ctx.ellipse(gx, gy + H * 0.012, u * 0.52, Math.max(4, H * 0.013), 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const lift = (groundY - courier.y) / (H * 0.30);
      const shA = Math.max(0.05, 0.22 - lift * 0.18);
      ctx.fillStyle = "rgba(0,0,0," + shA + ")";
      ctx.beginPath();
      ctx.ellipse(gx, groundY + H * 0.012, Math.max(8, u * (0.5 - lift * 0.12)), Math.max(3, H * 0.012), 0, 0, Math.PI * 2);
      ctx.fill();
    }

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
  //  Drone-crash cutscene (fires once at DRONE_AT points)
  // ============================================================
  function cutGeom() {
    const bx = 0.58 * W, bw = 0.20 * W, top = 0.34 * H;
    return { bx, bw, top, bottom: groundY, ix: bx + 0.05 * W, iy: top + 0.06 * H };
  }

  function startDrone() {
    state = CUTSCENE;
    cutTime = 0;
    cutExploded = false;
    cutParticles = [];
    startDroneSound();
  }

  function spawnExplosion(x, y) {
    const cols = ["#ffd34d", "#ff9b2f", "#ff5a2a", "#ffd34d", "#55555f"];
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.25 + Math.random() * 1.05) * H;
      const life = 0.5 + Math.random() * 0.7;
      cutParticles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.25 * H,           // slight upward bias
        grav: (1.4 + Math.random()) * H,
        r: (0.006 + Math.random() * 0.013) * H,
        life, maxLife: life,
        col: cols[(Math.random() * cols.length) | 0],
      });
    }
  }

  function updateCutscene(dt) {
    cutTime += dt;
    const g = cutGeom();
    if (!cutExploded && cutTime >= DRONE_FLY) {
      cutExploded = true;
      stopDroneSound();   // engine cuts out...
      spawnExplosion(g.ix, g.iy);
      playExplosion();    // ...replaced by the boom
    }
    for (let i = cutParticles.length - 1; i >= 0; i--) {
      const p = cutParticles[i];
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) cutParticles.splice(i, 1);
    }
    if (cutTime >= DRONE_FLY + EXPLODE_DUR + SETTLE_DUR) state = PLAYING; // resume
  }

  function drawCutBuilding(g, fade) {
    ctx.globalAlpha = fade;
    ctx.fillStyle = "#8a79b6";                                   // tower (foreground)
    ctx.fillRect(g.bx, g.top, g.bw, g.bottom - g.top);
    ctx.fillStyle = "#6f5fa0";                                   // shaded side
    ctx.fillRect(g.bx + g.bw * 0.72, g.top, g.bw * 0.28, g.bottom - g.top);
    ctx.fillStyle = "#5b4d86";                                   // roof line
    ctx.fillRect(g.bx, g.top, g.bw, H * 0.014);
    ctx.fillStyle = "rgba(255,255,255,0.5)";                     // windows
    const ww = g.bw * 0.13, wh = ww * 1.3;
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 8; r++) {
        const wy = g.top + H * 0.05 + r * (H * 0.055);
        if (wy + wh > g.bottom - H * 0.02) break;
        if (rnd(c * 13 + r * 7 + 3) > 0.25)
          ctx.fillRect(g.bx + g.bw * (0.13 + c * 0.22), wy, ww, wh);
      }
    if (cutExploded) {                                           // scorch crater
      ctx.fillStyle = "rgba(18,16,20,0.85)";
      ctx.beginPath(); ctx.arc(g.ix, g.iy, 0.07 * H, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawDrone(t, g) {
    const p = Math.min(1, t / DRONE_FLY);
    const ease = p * p;                                          // accelerates into the dive
    const sx = W * 0.95, sy = -0.12 * H;
    let x = sx + (g.ix - sx) * ease + Math.sin(t * 23) * (1 - p) * 0.02 * H;
    let y = sy + (g.iy - sy) * ease + Math.sin(t * 17) * (1 - p) * 0.012 * H;
    const ang = Math.sin(t * 20) * (1 - p) * 0.28 + ease * 0.9;  // wobble -> tumble
    const s = 0.10 * H;

    ctx.globalAlpha = 0.22;                                      // failing smoke trail
    ctx.fillStyle = "#6a6a72";
    for (let i = 1; i <= 4; i++) {
      const tp = Math.max(0, ease - i * 0.05);
      ctx.beginPath();
      ctx.arc(sx + (g.ix - sx) * tp, sy + (g.iy - sy) * tp, s * (0.2 + i * 0.06), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#3a3a42"; ctx.lineWidth = s * 0.1;        // arms (X)
    ctx.beginPath();
    ctx.moveTo(-s * 0.62, -s * 0.42); ctx.lineTo(s * 0.62, s * 0.42);
    ctx.moveTo(-s * 0.62, s * 0.42); ctx.lineTo(s * 0.62, -s * 0.42);
    ctx.stroke();
    const ends = [[-0.62, -0.42], [0.62, 0.42], [-0.62, 0.42], [0.62, -0.42]];
    for (const e of ends) {                                      // rotors
      const rx = e[0] * s, ry = e[1] * s;
      ctx.fillStyle = "#23232a"; ctx.beginPath(); ctx.arc(rx, ry, s * 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = s * 0.04;
      ctx.beginPath(); ctx.ellipse(rx, ry, s * 0.36, s * 0.06, t * 45 + e[0] + e[1], 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = "#2a2a30";                                   // body
    roundRectPath(-s * 0.42, -s * 0.28, s * 0.84, s * 0.56, s * 0.16); ctx.fill();
    ctx.fillStyle = "#ffcc00";                                   // yellow stripe
    roundRectPath(-s * 0.42, -s * 0.28, s * 0.84, s * 0.18, s * 0.08); ctx.fill();
    ctx.fillStyle = "#15151a";                                   // camera
    ctx.beginPath(); ctx.arc(0, s * 0.32, s * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#33333a"; ctx.lineWidth = s * 0.03;       // box cords
    ctx.beginPath();
    ctx.moveTo(-s * 0.1, s * 0.3); ctx.lineTo(-s * 0.1, s * 0.5);
    ctx.moveTo(s * 0.1, s * 0.3); ctx.lineTo(s * 0.1, s * 0.5); ctx.stroke();
    ctx.fillStyle = "#ffcc00";                                   // hanging delivery box
    roundRectPath(-s * 0.2, s * 0.5, s * 0.4, s * 0.34, s * 0.06); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.stroke();
    ctx.restore();
  }

  function drawFireball(x, y, et) {
    const grow = Math.min(1, et / 0.45);
    const R = (0.05 + grow * 0.17) * H;
    const fade = Math.max(0, 1 - Math.max(0, et - 0.2) / (EXPLODE_DUR - 0.2));
    ctx.globalAlpha = 0.5 * fade;                                // smoke halo
    ctx.fillStyle = "#43434c";
    ctx.beginPath(); ctx.arc(x, y, R * 1.2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = fade;
    const layers = [["#ff5a2a", 1.0], ["#ff9b2f", 0.7], ["#ffd34d", 0.44], ["#fff6d8", 0.22]];
    for (const L of layers) {
      ctx.fillStyle = L[0];
      ctx.beginPath(); ctx.arc(x, y, R * L[1], 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawCutscene() {
    const t = cutTime, g = cutGeom(), total = DRONE_FLY + EXPLODE_DUR + SETTLE_DUR;

    let dim = 0.24;                                              // spotlight: dim the frozen scene
    if (t < 0.3) dim *= t / 0.3;
    if (t > total - 0.4) dim *= Math.max(0, (total - t) / 0.4);
    ctx.fillStyle = "rgba(18,16,28," + dim + ")";
    ctx.fillRect(0, 0, W, H);

    let shx = 0, shy = 0;                                        // screen shake on the blast
    if (cutExploded) {
      const mag = Math.max(0, 1 - (t - DRONE_FLY) / 0.45) * H * 0.018;
      shx = (Math.random() * 2 - 1) * mag;
      shy = (Math.random() * 2 - 1) * mag;
    }
    ctx.save();
    ctx.translate(shx, shy);

    let bf = 1;
    if (t < 0.3) bf = t / 0.3;
    if (t > total - 0.4) bf = Math.max(0, (total - t) / 0.4);
    drawCutBuilding(g, bf);

    if (t < DRONE_FLY + 0.04) drawDrone(t, g);
    if (cutExploded) drawFireball(g.ix, g.iy, t - DRONE_FLY);

    for (const p of cutParticles) {                             // debris
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    if (cutExploded) {                                          // white impact flash
      const fa = Math.max(0, 0.9 * (1 - (t - DRONE_FLY) / 0.18));
      if (fa > 0) { ctx.fillStyle = "rgba(255,250,235," + fa + ")"; ctx.fillRect(0, 0, W, H); }
    }
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
