/* ============================================================
   Stack — isometric 3D block-stacking tower (iOS "Stack" style).

   A 3D slab slides along one horizontal axis; tap/Space to drop it onto the
   tower. Whatever overhangs the block below (along the slide axis) is sliced off
   and tumbles away, so the next block — which slides along the PERPENDICULAR
   axis — is only as big as the overlap. Miss completely and the run ends. A near-
   perfect drop keeps your size and slightly regrows it (with a combo).

   Rendered in a fixed dimetric projection: each block is drawn as a box (top face
   + two shaded side faces). Packaged as a GameHost module.
   ============================================================ */
(function () {
  "use strict";

  // ---------- Tunables ----------
  const BASE_HALF        = 0.5;    // base block half-extent (world units)
  const S_FRAC           = 0.30;   // horizontal projection scale  (px = W * S_FRAC per world unit)
  const ISO              = 0.5;    // vertical squash of the ground plane (2:1 dimetric)
  const LIFT_FRAC        = 0.090;  // block thickness on screen (px = W * LIFT_FRAC)
  const OY_TOP_FRAC      = 0.70;   // screen Y of the base block's top face
  const TARGET_TOP_FRAC  = 0.34;   // keep the active block near here once the tower is tall
  const AMP              = 1.35;   // slide amplitude (world units, around the block below)
  const MOVE_BASE        = 1.70;   // slide speed (world units / sec)
  const MOVE_RAMP        = 0.035;  // + per level
  const MOVE_MAX         = 4.20;
  const PERFECT_TOL      = 0.055;  // |misalignment| under this = perfect drop (world units)
  const PERFECT_GROW     = 0.040;  // half-extent regained on a perfect drop
  const DEBRIS_GRAV_FRAC = 3.0;    // sliced-piece gravity (H / sec^2)
  const CAM_EASE         = 9;
  const FLASH_DUR        = 0.35;
  const HUE0 = 200, HUE_STEP = 11;

  const READY = 0, PLAYING = 1, GAMEOVER = 2;

  const portraitLock = window.matchMedia("(orientation: landscape) and (pointer: coarse)");
  const PORTRAIT_RATIO = 0.5;

  function create() {
    let host = null, canvas = null, ctx = null, stage = null;
    let elScore, elBest, startScreen, gameOverScreen, elFinalScore, elFinalBest;

    // sizing / projection
    let W = 0, H = 0, DPR = 1, bgGrad = null, bgHue = HUE0;
    let S = 0, LIFT = 0, ox = 0, oyTop = 0, targetTopY = 0;

    // model: blocks/active are { cx, cz, hw, hd, hue }; active also has axis/dir/speed
    let blocks = [], active = null, debris = [], flashes = [];
    let camLift = 0, perfectStreak = 0;
    let score = 0, best = 0, restartAllowedAt = 0, state = READY;
    let last = 0, raf = null;

    let audioCtx = null;
    const listeners = [];
    function on(t, ty, fn, opts) { t.addEventListener(ty, fn, opts); listeners.push([t, ty, fn, opts]); }

    const hueFor = (lvl) => (HUE0 + lvl * HUE_STEP) % 360;
    const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360},${s}%,${l}%)`;

    // World (x,z,level) -> screen point of the TOP face. Bottom face is + LIFT in Y.
    function proj(x, z, level) {
      return {
        sx: ox + (x - z) * S,
        sy: oyTop - level * LIFT + (x + z) * (S * ISO) + camLift,
      };
    }
    function camTarget() {
      return Math.max(0, targetTopY - (oyTop - blocks.length * LIFT));
    }

    // ============================================================
    //  Sizing
    // ============================================================
    function makeBg(h) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, hsl(h + 8, 32, 40));
      g.addColorStop(1, hsl(h, 34, 70));
      return g;
    }
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

      S = W * S_FRAC;
      LIFT = W * LIFT_FRAC;
      ox = W * 0.5;
      oyTop = H * OY_TOP_FRAC;
      targetTopY = H * TARGET_TOP_FRAC;
      bgGrad = makeBg(bgHue);
    }
    function onPortraitChange() { resize(); last = 0; }
    function onVisibility() { if (!document.hidden) last = 0; }

    // ============================================================
    //  Audio
    // ============================================================
    function resumeAudio() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    }
    function beep(freq, dur, type, vol, slideTo) {
      if (!host || host.muted || !audioCtx) return;
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type || "square";
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(vol || 0.06, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + dur);
    }
    const playPlace = () => beep(150, 0.08, "square", 0.05, 110);
    function playPerfect(streak) {
      const base = 520 + Math.min(8, streak) * 70;
      beep(base, 0.10, "triangle", 0.06, base * 1.5);
    }
    const playOver = () => { beep(200, 0.42, "sawtooth", 0.07, 60); beep(96, 0.5, "square", 0.05, 48); };

    // ============================================================
    //  Game flow
    // ============================================================
    function startGame() {
      state = PLAYING;
      blocks = [{ cx: 0, cz: 0, hw: BASE_HALF, hd: BASE_HALF, hue: hueFor(0) }];
      debris = [];
      flashes = [];
      score = 0;
      perfectStreak = 0;
      bgHue = hueFor(0);
      bgGrad = makeBg(bgHue);
      camLift = camTarget();
      spawnActive();
      startScreen.classList.add("hidden");
      gameOverScreen.classList.add("hidden");
      updateHUD();
    }

    function spawnActive() {
      const lvl = blocks.length;
      const below = blocks[lvl - 1];
      const axis = lvl % 2 === 1 ? "x" : "z";   // alternate slide axis each level
      active = {
        cx: below.cx, cz: below.cz, hw: below.hw, hd: below.hd,
        hue: hueFor(lvl), axis, dir: 1,
        speed: Math.min(MOVE_MAX, MOVE_BASE + lvl * MOVE_RAMP),
      };
      if (axis === "x") { active.cx = below.cx - AMP; active.lo = below.cx - AMP; active.hi = below.cx + AMP; }
      else              { active.cz = below.cz - AMP; active.lo = below.cz - AMP; active.hi = below.cz + AMP; }
    }

    function dropBlock() {
      const below = blocks[blocks.length - 1];
      const level = blocks.length;
      const xAxis = active.axis === "x";

      // Centre / half-extent along the slide axis for both blocks.
      const aC = xAxis ? active.cx : active.cz;
      const aH = xAxis ? active.hw : active.hd;
      const bC = xAxis ? below.cx : below.cz;
      const bH = xAxis ? below.hw : below.hd;

      const ovLo = Math.max(aC - aH, bC - bH);
      const ovHi = Math.min(aC + aH, bC + bH);
      const ov = ovHi - ovLo;

      if (ov <= 0) {                                    // total miss -> the block tumbles off
        debris.push(mk(active.cx, active.cz, active.hw, active.hd, active.hue, level, randSpin()));
        active = null;
        gameOver();
        return;
      }

      let newC, newH;
      if (Math.abs(aC - bC) <= PERFECT_TOL) {           // perfect: keep & regrow, build a combo
        newC = bC;
        newH = Math.min(BASE_HALF, bH + PERFECT_GROW);
        perfectStreak++;
        flashes.push({
          level, t: 0,
          gx: xAxis ? newC : below.cx, gz: xAxis ? below.cz : newC,
          hw: xAxis ? newH : below.hw, hd: xAxis ? below.hd : newH,
        });
        playPerfect(perfectStreak);
      } else {                                          // slice: keep the overlap, drop the overhang
        newC = (ovLo + ovHi) / 2;
        newH = ov / 2;
        perfectStreak = 0;
        if (aC - aH < ovLo) debris.push(sliceDebris(below, level, ovLo - (aC - aH), (aC - aH + ovLo) / 2));
        if (aC + aH > ovHi) debris.push(sliceDebris(below, level, (aC + aH) - ovHi, (ovHi + aC + aH) / 2));
        playPlace();
      }

      // Compose the placed block: new extent on the slide axis, below's extent on the other.
      const placed = xAxis
        ? { cx: newC, cz: below.cz, hw: newH, hd: below.hd, hue: active.hue }
        : { cx: below.cx, cz: newC, hw: below.hw, hd: newH, hue: active.hue };
      blocks.push(placed);

      score = blocks.length - 1;
      bgHue = active.hue;
      bgGrad = makeBg(bgHue);
      updateHUD();
      spawnActive();
    }

    // Build a falling debris piece for a sliced overhang (centre/extent on the slide axis).
    function sliceDebris(below, level, fullLen, center) {
      const xAxis = active.axis === "x";
      const hue = active.hue, sp = randSpin();
      return xAxis
        ? mk(center, below.cz, fullLen / 2, below.hd, hue, level, sp)
        : mk(below.cx, center, below.hw, fullLen / 2, hue, level, sp);
    }
    function mk(cx, cz, hw, hd, hue, level, spin) {
      return { cx, cz, hw, hd, hue, level, fy: 0, vy: -H * 0.05, alpha: 1, rot: 0, vr: spin };
    }
    function randSpin() { return (Math.random() * 2 - 1) * 3; }

    function gameOver() {
      state = GAMEOVER;
      playOver();
      if (score > best) { best = score; host.setBest(best); }
      elFinalScore.textContent = score;
      elFinalBest.textContent = best;
      updateHUD();
      host.submitScore(score);   // ranked game only (no-op otherwise)
      gameOverScreen.classList.remove("hidden");
      restartAllowedAt = performance.now() + 450;
    }

    function updateHUD() {
      elScore.textContent = score;
      elBest.textContent = "BEST " + best;
    }

    // ============================================================
    //  Input
    // ============================================================
    function pressDrop() {
      if (portraitLock.matches) return;
      resumeAudio();
      if (state === READY) { startGame(); return; }
      if (state === GAMEOVER) { if (performance.now() >= restartAllowedAt) startGame(); return; }
      if (state === PLAYING && active) dropBlock();
    }
    function onKeyDown(e) {
      if (e.code === "Space" || e.code === "ArrowUp" || e.key === " ") {
        e.preventDefault();
        if (!e.repeat) pressDrop();
      }
    }
    function onPointerDown(e) {
      if (e.target.closest && e.target.closest(".btn")) return;
      e.preventDefault();
      pressDrop();
    }
    function onContextMenu(e) { e.preventDefault(); }

    // ============================================================
    //  Update
    // ============================================================
    function update(dt) {
      if (portraitLock.matches) return;

      camLift += (camTarget() - camLift) * Math.min(1, dt * CAM_EASE);

      if (state === PLAYING && active) {
        const d = active.dir * active.speed * dt;
        if (active.axis === "x") {
          active.cx += d;
          if (active.cx <= active.lo) { active.cx = active.lo; active.dir = 1; }
          else if (active.cx >= active.hi) { active.cx = active.hi; active.dir = -1; }
        } else {
          active.cz += d;
          if (active.cz <= active.lo) { active.cz = active.lo; active.dir = 1; }
          else if (active.cz >= active.hi) { active.cz = active.hi; active.dir = -1; }
        }
      }

      const grav = H * DEBRIS_GRAV_FRAC;
      for (let i = debris.length - 1; i >= 0; i--) {
        const p = debris[i];
        p.vy += grav * dt;
        p.fy += p.vy * dt;
        p.rot += p.vr * dt;
        p.alpha -= dt * 0.8;
        if (p.alpha <= 0 || p.fy > H + LIFT * 4) debris.splice(i, 1);
      }
      for (let i = flashes.length - 1; i >= 0; i--) {
        flashes[i].t += dt;
        if (flashes[i].t >= FLASH_DUR) flashes.splice(i, 1);
      }
    }

    // ============================================================
    //  Render
    // ============================================================
    function draw() {
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      // Tower, back-to-front (bottom level first so the nearer top is drawn over it).
      for (let L = 0; L < blocks.length; L++) {
        if (proj(blocks[L].cx, blocks[L].cz, L).sy > H + LIFT * 2) continue;
        drawBox(blocks[L], L, 1, 0, 0);
      }

      if (active) drawBox(active, blocks.length, 1, 0, 0);

      for (const p of debris) drawBox(p, p.level, Math.max(0, p.alpha), p.fy, p.rot);

      for (const f of flashes) {
        const e = 1 + (f.t / FLASH_DUR) * 0.6;
        const c = [
          proj(f.gx - f.hw * e, f.gz - f.hd * e, f.level),
          proj(f.gx + f.hw * e, f.gz - f.hd * e, f.level),
          proj(f.gx + f.hw * e, f.gz + f.hd * e, f.level),
          proj(f.gx - f.hw * e, f.gz + f.hd * e, f.level),
        ];
        ctx.globalAlpha = (1 - f.t / FLASH_DUR) * 0.8;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = Math.max(1, H * 0.004);
        ctx.beginPath();
        ctx.moveTo(c[0].sx, c[0].sy);
        for (let i = 1; i < 4; i++) ctx.lineTo(c[i].sx, c[i].sy);
        ctx.closePath();
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Draw an isometric box: top face + the two camera-facing side faces.
    function drawBox(b, level, alpha, yOff, rot) {
      const xL = b.cx - b.hw, xR = b.cx + b.hw, zN = b.cz - b.hd, zF = b.cz + b.hd;
      const cxs = ox, cys = proj(b.cx, b.cz, level).sy + (yOff || 0);  // pivot for debris spin
      const P = (x, z) => {
        const p = proj(x, z, level);
        let sx = p.sx, sy = p.sy + (yOff || 0);
        if (rot) { const c = Math.cos(rot), s = Math.sin(rot), dx = sx - cxs, dy = sy - cys; sx = cxs + dx * c - dy * s; sy = cys + dx * s + dy * c; }
        return { sx, sy };
      };
      const At = P(xL, zN), Bt = P(xR, zN), Ct = P(xR, zF), Dt = P(xL, zF);
      const Bb = { sx: Bt.sx, sy: Bt.sy + LIFT }, Cb = { sx: Ct.sx, sy: Ct.sy + LIFT }, Db = { sx: Dt.sx, sy: Dt.sy + LIFT };

      ctx.globalAlpha = alpha;
      face([Bt, Ct, Cb, Bb], hsl(b.hue, 60, 42));   // right face (+x), darkest
      face([Dt, Ct, Cb, Db], hsl(b.hue, 60, 52));   // left face (+z)
      face([At, Bt, Ct, Dt], hsl(b.hue, 58, 63));   // top face, lightest
      ctx.globalAlpha = 1;
    }
    function face(pts, fill) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(pts[0].sx, pts[0].sy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
      ctx.closePath();
      ctx.fill();
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
      blocks = []; active = null; debris = []; flashes = [];
      camLift = 0; score = 0; perfectStreak = 0; bgHue = HUE0; last = 0;
      host.onMuteToggle = null;

      startScreen.classList.remove("hidden");
      gameOverScreen.classList.add("hidden");

      on(window, "resize", resize);
      on(window, "orientationchange", resize);
      on(portraitLock, "change", onPortraitChange);
      on(document, "visibilitychange", onVisibility);
      on(window, "keydown", onKeyDown);
      on(window, "pointerdown", onPointerDown, { passive: false });
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
      id: "stack",
      title: "Stack",
      tagline: "Build the tallest tower",
      emoji: "🧱",
      accent: "#4aa3ff",
      start: {
        title: "Stack",
        lead: "Drop the blocks to build a tower!",
        hint: "<b>Space</b> / <b>Tap</b> to drop",
        sub: "Line them up for a perfect stack",
      },
      over: { title: "Game Over" },
      mount,
      unmount,
    };
  }

  window.GameHost.register(create());
})();
