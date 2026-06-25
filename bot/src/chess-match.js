/* ============================================================
   ChessMatch — one Durable Object per chess match.

   Authoritative game + clock. Validates moves with chess.js, seats White/Black,
   handles resign / draw / rematch, records finished games to D1, and runs a
   per-side chess clock: the side to move has a running clock; on each move its
   elapsed time is banked and the clock switches. A DO alarm fires at the running
   side's deadline to enforce a flag (loss on time). Clients tick the display
   smoothly between events; the DO only broadcasts on real events.

   Persists to SQLite storage so it survives hibernation.
   ============================================================ */
import { DurableObject } from "cloudflare:workers";
import { Chess } from "chess.js";

const DEFAULT_CLOCK_MS = 5 * 60 * 1000;   // 5 minutes per side (override with CHESS_CLOCK_MS for tests)

export class ChessMatch extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
    });
  }

  clockInitial() { return Math.max(1000, Number(this.env && this.env.CHESS_CLOCK_MS) || DEFAULT_CLOCK_MS); }

  load() {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM kv WHERE k = 'state'").toArray();
    if (rows.length) return JSON.parse(rows[0].v);
    const t = this.clockInitial();
    return {
      fen: new Chess().fen(), players: { white: null, black: null }, roster: null,
      lastMove: null, over: false, result: "", resultCode: null, reason: null,
      drawOffer: null, rematch: [], recorded: false,
      clock: { white: t, black: t, running: null, turnStart: null },
    };
  }
  save(st) {
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (k, v) VALUES ('state', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      JSON.stringify(st)
    );
  }

  colorOf(st, uid) {
    if (st.players.white && st.players.white.id === uid) return "white";
    if (st.players.black && st.players.black.id === uid) return "black";
    return "spectator";
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const url = new URL(request.url);
    const uid = url.searchParams.get("uid") || "anon";
    const name = (url.searchParams.get("name") || "Player").slice(0, 40);

    const st = this.load();
    const color = this.seat(st, uid, name);
    // start White's clock once both players are present
    if (st.clock && !st.over && !st.clock.running && st.players.white && st.players.black) {
      await this.switchClock(st, "white");
      this.save(st);
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid, name });
    server.send(JSON.stringify(this.msg(st, color)));
    this.broadcast(st);
    return new Response(null, { status: 101, webSocket: client });
  }

  seat(st, uid, name) {
    const have = this.colorOf(st, uid);
    if (have !== "spectator") return have;
    if (st.roster) {
      if (st.roster.white === uid) { st.players.white = { id: uid, name }; this.save(st); return "white"; }
      if (st.roster.black === uid) { st.players.black = { id: uid, name }; this.save(st); return "black"; }
      return "spectator";
    }
    if (!st.players.white) { st.players.white = { id: uid, name }; this.save(st); return "white"; }
    if (!st.players.black) { st.players.black = { id: uid, name }; this.save(st); return "black"; }
    return "spectator";
  }

  async assign(whiteUid, blackUid) {
    const st = this.load();
    st.roster = { white: whiteUid, black: blackUid };
    this.save(st);
    return true;
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    const st = this.load();
    const color = this.colorOf(st, att.uid);
    if (m.type === "move")          return this.onMove(st, color, m);
    if (m.type === "resign")        return this.onResign(st, color);
    if (m.type === "draw_offer")    return this.onDrawOffer(st, color);
    if (m.type === "draw_accept")   return this.onDrawResolve(st, color, true);
    if (m.type === "draw_decline")  return this.onDrawResolve(st, color, false);
    if (m.type === "rematch")       return this.onRematch(st, att.uid);
    if (m.type === "sync")          ws.send(JSON.stringify(this.msg(st, color)));
  }

  async onMove(st, color, m) {
    if (st.over || !st.players.white || !st.players.black) return this.broadcast(st);
    const game = new Chess(st.fen);
    if (color !== (game.turn() === "w" ? "white" : "black")) return this.broadcast(st);
    let mv = null;
    try { mv = game.move({ from: m.from, to: m.to, promotion: m.promotion || undefined }); } catch { mv = null; }
    if (!mv) return this.broadcast(st);
    st.fen = game.fen();
    st.lastMove = { from: mv.from, to: mv.to };
    st.drawOffer = null;
    // bank the mover's elapsed time
    if (st.clock && st.clock.running === color && st.clock.turnStart != null) {
      st.clock[color] = Math.max(0, st.clock[color] - (Date.now() - st.clock.turnStart));
    }
    if (game.isGameOver()) {
      const o = outcome(game);
      await this.endGame(st, o.code, o.reason);
      this.save(st); this.broadcast(st); await this.record(st);
      return;
    }
    await this.switchClock(st, color === "white" ? "black" : "white");
    this.save(st); this.broadcast(st);
  }

  async onResign(st, color) {
    if (st.over || (color !== "white" && color !== "black")) return;
    await this.endGame(st, color === "white" ? "black" : "white", "resignation");
    this.save(st); this.broadcast(st); await this.record(st);
  }

  onDrawOffer(st, color) {
    if (st.over || (color !== "white" && color !== "black")) return;
    st.drawOffer = color;
    this.save(st); this.broadcast(st);
  }

  async onDrawResolve(st, color, accept) {
    if (st.over || !st.drawOffer || (color !== "white" && color !== "black") || color === st.drawOffer) return;
    if (accept) {
      await this.endGame(st, "draw", "agreement");
      this.save(st); this.broadcast(st); await this.record(st);
    } else {
      st.drawOffer = null;
      this.save(st); this.broadcast(st);
    }
  }

  async onRematch(st, uid) {
    if (!st.over || this.colorOf(st, uid) === "spectator") return;
    st.rematch = st.rematch || [];
    if (!st.rematch.includes(uid)) st.rematch.push(uid);
    const w = st.players.white, b = st.players.black;
    if (w && b && st.rematch.includes(w.id) && st.rematch.includes(b.id)) {   // both agreed
      const t = this.clockInitial();
      st.fen = new Chess().fen();
      st.players = { white: b, black: w };                                     // swap colours
      if (st.roster) st.roster = { white: st.roster.black, black: st.roster.white };
      st.lastMove = null; st.over = false; st.result = ""; st.resultCode = null; st.reason = null;
      st.drawOffer = null; st.rematch = []; st.recorded = false;
      st.clock = { white: t, black: t, running: null, turnStart: null };
      await this.switchClock(st, "white");
    }
    this.save(st); this.broadcast(st);
  }

  // The running side's clock expired.
  async alarm() {
    const st = this.load();
    if (st.over || !st.clock || !st.clock.running || st.clock.turnStart == null) return;
    const running = st.clock.running;
    const elapsed = Date.now() - st.clock.turnStart;
    if (elapsed < st.clock[running]) {                          // woke early — reschedule to the real deadline
      await this.ctx.storage.setAlarm(st.clock.turnStart + st.clock[running]);
      return;
    }
    st.clock[running] = 0;
    await this.endGame(st, running === "white" ? "black" : "white", "timeout");
    this.save(st); this.broadcast(st); await this.record(st);
  }

  // ---- clock helpers ----
  async switchClock(st, side) {
    if (!st.clock) return;
    st.clock.running = side;
    st.clock.turnStart = Date.now();
    await this.ctx.storage.setAlarm(Date.now() + Math.max(0, st.clock[side]));
  }
  async stopClock(st) {
    if (st.clock) { st.clock.running = null; st.clock.turnStart = null; }
    await this.ctx.storage.deleteAlarm();
  }
  async endGame(st, code, reason) {
    this.finish(st, code, reason);
    await this.stopClock(st);
  }

  finish(st, code, reason) {
    st.over = true;
    st.resultCode = code; st.reason = reason;
    st.result = code === "draw"
      ? (reason && reason !== "draw" ? "Draw — " + reason : "Draw")
      : (code === "white" ? "White" : "Black") + " wins by " + reason;
    st.drawOffer = null; st.rematch = [];
  }

  async record(st) {
    if (st.recorded) return;
    const w = st.players.white, b = st.players.black;
    if (!w || !b || !String(w.id).startsWith("u") || !String(b.id).startsWith("u")) return;
    st.recorded = true; this.save(st);
    if (!this.env.DB) return;
    try {
      await this.env.DB.prepare(
        "INSERT INTO chess_results (white_id, white_name, black_id, black_name, result, reason, ended_at) VALUES (?1,?2,?3,?4,?5,?6,?7)"
      ).bind(w.id, w.name, b.id, b.name, st.resultCode, st.reason, Date.now()).run();
    } catch (_) {}
  }

  msg(st, youAre) {
    return {
      type: "state", fen: st.fen, lastMove: st.lastMove, over: st.over, result: st.result,
      players: {
        white: st.players.white ? st.players.white.name : null,
        black: st.players.black ? st.players.black.name : null,
      },
      draw: st.drawOffer || null,
      clock: clockSnapshot(st),
      youAre: youAre || "spectator",
    };
  }

  broadcast(st) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      try { ws.send(JSON.stringify(this.msg(st, this.colorOf(st, att.uid)))); } catch (_) {}
    }
  }

  webSocketClose() {}
  webSocketError() {}
}

function outcome(game) {
  if (game.isCheckmate()) return { code: game.turn() === "w" ? "black" : "white", reason: "checkmate" };
  if (game.isStalemate()) return { code: "draw", reason: "stalemate" };
  if (game.isThreefoldRepetition()) return { code: "draw", reason: "repetition" };
  if (game.isInsufficientMaterial()) return { code: "draw", reason: "insufficient material" };
  return { code: "draw", reason: "draw" };
}

// Remaining ms per side as of "now" — the running side's value is decremented so
// the client can keep ticking locally from receipt without further broadcasts.
function clockSnapshot(st) {
  const c = st.clock;
  if (!c) return null;
  const out = { white: c.white, black: c.black, running: c.running };
  if (c.running && c.turnStart != null) {
    out[c.running] = Math.max(0, c[c.running] - (Date.now() - c.turnStart));
  }
  return out;
}
