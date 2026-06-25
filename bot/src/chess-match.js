/* ============================================================
   ChessMatch — one Durable Object per chess match.

   Authoritative: validates every move with chess.js, assigns White/Black on join,
   broadcasts the position to both players' WebSockets, and persists state to the
   DO's SQLite storage so it survives hibernation. Uses the WebSocket Hibernation
   API (acceptWebSocket + webSocket* handlers) so the DO can sleep between moves.
   ============================================================ */
import { DurableObject } from "cloudflare:workers";
import { Chess } from "chess.js";

export class ChessMatch extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
    });
  }

  // The whole match is one JSON blob: load it, mutate, save it.
  load() {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM kv WHERE k = 'state'").toArray();
    if (rows.length) return JSON.parse(rows[0].v);
    return { fen: new Chess().fen(), players: { white: null, black: null }, lastMove: null, over: false, result: "" };
  }
  save(st) {
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (k, v) VALUES ('state', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      JSON.stringify(st)
    );
  }

  // WebSocket upgrade (the Worker has already resolved identity into uid/name).
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const uid = url.searchParams.get("uid") || "anon";
    const name = (url.searchParams.get("name") || "Player").slice(0, 40);

    const st = this.load();
    const color = this.seat(st, uid, name);

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid, color });
    server.send(JSON.stringify(this.msg(st, color)));
    this.broadcast(st);                       // presence: tell the other side someone joined
    return new Response(null, { status: 101, webSocket: client });
  }

  // First unseated visitor = White, second = Black, rest = spectators.
  // A returning uid keeps its colour (reconnection).
  seat(st, uid, name) {
    if (st.players.white && st.players.white.id === uid) return "white";
    if (st.players.black && st.players.black.id === uid) return "black";
    if (!st.players.white) { st.players.white = { id: uid, name }; this.save(st); return "white"; }
    if (!st.players.black) { st.players.black = { id: uid, name }; this.save(st); return "black"; }
    return "spectator";
  }

  webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    const st = this.load();
    if (m.type === "move") this.onMove(ws, att, st, m);
    else if (m.type === "resign") this.onResign(att, st);
    else if (m.type === "sync") ws.send(JSON.stringify(this.msg(st, att.color)));
  }

  onMove(ws, att, st, m) {
    // Reject if the game's done, both seats aren't filled, or it isn't this player's turn.
    if (st.over || !st.players.white || !st.players.black) return ws.send(JSON.stringify(this.msg(st, att.color)));
    const game = new Chess(st.fen);
    const turn = game.turn() === "w" ? "white" : "black";
    if (att.color !== turn) return ws.send(JSON.stringify(this.msg(st, att.color)));

    let mv = null;
    try { mv = game.move({ from: m.from, to: m.to, promotion: m.promotion || undefined }); } catch { mv = null; }
    if (!mv) return ws.send(JSON.stringify(this.msg(st, att.color)));   // illegal -> resync just that client

    st.fen = game.fen();
    st.lastMove = { from: mv.from, to: mv.to };
    if (game.isGameOver()) { st.over = true; st.result = result(game); }
    this.save(st);
    this.broadcast(st);
  }

  onResign(att, st) {
    if ((att.color !== "white" && att.color !== "black") || st.over) return;
    st.over = true;
    st.result = (att.color === "white" ? "Black" : "White") + " wins by resignation";
    this.save(st);
    this.broadcast(st);
  }

  msg(st, youAre) {
    return {
      type: "state",
      fen: st.fen,
      lastMove: st.lastMove,
      over: st.over,
      result: st.result,
      players: {
        white: st.players.white ? st.players.white.name : null,
        black: st.players.black ? st.players.black.name : null,
      },
      youAre: youAre || "spectator",
    };
  }

  broadcast(st) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      try { ws.send(JSON.stringify(this.msg(st, att.color))); } catch (_) {}
    }
  }

  webSocketClose() { /* keep the seat for reconnection; runtime drops the socket */ }
  webSocketError() {}
}

function result(game) {
  if (game.isCheckmate()) return (game.turn() === "w" ? "Black" : "White") + " wins by checkmate";
  if (game.isStalemate()) return "Draw — stalemate";
  if (game.isThreefoldRepetition()) return "Draw — repetition";
  if (game.isInsufficientMaterial()) return "Draw — insufficient material";
  return "Draw";
}
