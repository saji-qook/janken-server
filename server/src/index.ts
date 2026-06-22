// 念動戦 対人サーバ（サーバ権威 / Socket.IO）
// - マッチング（待機キューからランダムペア）
// - 同時接続人数のリアルタイム配信
// - 60秒制限・時間能力・自動セットはサーバが裁定（ServerMatch）
// - 切断時は残った側を勝ち扱い

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import type {
  ClientToServer,
  ServerToClient,
  RPS,
  AbilityId,
  AbilityInput,
  RankingEntry,
  RankingPeriods,
} from '@janken/game-core';
import { validateNickname } from '@janken/game-core';
import { ServerMatch, type MatchSeat } from './match.js';

const PORT = Number(process.env.PORT ?? 8787);

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('念動戦 server: ok');
});

const io = new Server<ClientToServer, ServerToClient>(httpServer, {
  cors: { origin: true },
});

// --- 状態 -------------------------------------------------------------------

interface Waiter {
  socketId: string;
  name: string;
}
let queue: Waiter[] = [];
const rooms = new Map<string, Waiter>(); // 合言葉(数字4桁) -> 待機中の1人
const matches = new Map<string, ServerMatch>(); // socketId -> match

function isRoomCode(code: string | undefined): code is string {
  return !!code && /^\d{4}$/.test(code);
}

function names(socketId: string): string {
  const s = io.sockets.sockets.get(socketId);
  return (s?.data?.name as string) || 'プレイヤー';
}

function broadcastPresence() {
  io.emit('presence', { online: io.sockets.sockets.size, queue: queue.length });
}

// --- 連続勝利数ランキング（ニックネーム別の最高連勝） -----------------------

const RANKING_FILE = fileURLToPath(new URL('../ranking.json', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const RECORD_TTL = WEEK_MS + DAY_MS; // 8日より古い記録は破棄（日/週集計に十分）

const bestStreaks = new Map<string, number>(); // name -> 全期間の最高連勝
interface StreakRecord {
  name: string;
  streak: number;
  at: number;
}
let streakRecords: StreakRecord[] = []; // 期間別集計用（タイムスタンプ付き）

function pruneRecords() {
  const cutoff = Date.now() - RECORD_TTL;
  streakRecords = streakRecords.filter((r) => r.at >= cutoff);
}

function loadRanking() {
  try {
    const raw = JSON.parse(readFileSync(RANKING_FILE, 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && ('best' in raw || 'records' in raw)) {
      const obj = raw as { best?: Record<string, number>; records?: StreakRecord[] };
      for (const [name, n] of Object.entries(obj.best ?? {})) bestStreaks.set(name, n);
      if (Array.isArray(obj.records)) streakRecords = obj.records;
    } else if (raw && typeof raw === 'object') {
      // 旧形式 { name: number } からの移行（全期間のみ）
      for (const [name, n] of Object.entries(raw as Record<string, number>)) bestStreaks.set(name, n);
    }
    pruneRecords();
  } catch {
    /* 初回は無し */
  }
}
function saveRanking() {
  try {
    pruneRecords();
    const data = { best: Object.fromEntries(bestStreaks), records: streakRecords };
    writeFileSync(RANKING_FILE, JSON.stringify(data), 'utf8');
  } catch {
    /* 失敗は無視 */
  }
}

function topFromMap(map: Map<string, number>, limit: number): RankingEntry[] {
  return [...map.entries()]
    .map(([name, streak]) => ({ name, streak }))
    .filter((e) => e.streak > 0)
    .sort((a, b) => b.streak - a.streak)
    .slice(0, limit);
}
function topWithin(sinceMs: number, limit: number): RankingEntry[] {
  const since = Date.now() - sinceMs;
  const best = new Map<string, number>();
  for (const r of streakRecords) {
    if (r.at < since) continue;
    if (r.streak > (best.get(r.name) ?? 0)) best.set(r.name, r.streak);
  }
  return topFromMap(best, limit);
}
function rankingPeriods(limit = 10): RankingPeriods {
  return {
    day: topWithin(DAY_MS, limit),
    week: topWithin(WEEK_MS, limit),
    all: topFromMap(bestStreaks, limit),
  };
}
function broadcastRanking() {
  io.emit('ranking', rankingPeriods());
}

function emitStreak(sock: ReturnType<typeof io.sockets.sockets.get>) {
  if (sock) sock.emit('streak', { value: (sock.data.streak as number) || 0 });
}

/** マッチ終了時に連勝数を更新する。 */
function updateStreaks(match: ServerMatch) {
  const [id0, id1] = match.seatIds();
  const s0 = io.sockets.sockets.get(id0);
  const s1 = io.sockets.sockets.get(id1);
  const [ipA, ipB] = match.ips();

  const recordBest = (sock: NonNullable<typeof s0>) => {
    const name = (sock.data.name as string) || 'プレイヤー';
    const cur = (sock.data.streak as number) || 0;
    if (cur <= 0) return;
    // 勝つたびに到達した連勝数をタイムスタンプ付きで記録（日/週集計用）
    streakRecords.push({ name, streak: cur, at: Date.now() });
    if (cur > (bestStreaks.get(name) ?? 0)) bestStreaks.set(name, cur); // 全期間の最高を更新
    saveRanking();
  };
  const win = (w?: typeof s0, l?: typeof s0) => {
    if (w) {
      w.data.streak = ((w.data.streak as number) || 0) + 1;
      recordBest(w);
    }
    if (l) l.data.streak = 0; // 敗者は連勝ストップ
  };

  // 合言葉個室・同一IP/同一ネットワークの対戦は、連勝を加算も停止もしない。
  if (!match.isPrivate && !sameNetwork(ipA, ipB)) {
    if (match.resultWinner === 0) win(s0, s1);
    else if (match.resultWinner === 1) win(s1, s0);
    // 引き分けは連勝を維持（停止しない）＝ 何もしない。
  }

  emitStreak(s0);
  emitStreak(s1);
  broadcastRanking();
}

loadRanking();

function normalizeIp(addr: string | undefined): string {
  if (!addr) return '';
  return addr.replace(/^::ffff:/, ''); // IPv4-mapped IPv6 を素のIPv4へ
}

/** 同一IP、または同一ネットワーク(IPv4 /24)か。 */
function sameNetwork(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = a.split('.');
  const pb = b.split('.');
  if (pa.length === 4 && pb.length === 4) {
    return pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2]; // /24
  }
  return false;
}

function makeSeat(socketId: string): MatchSeat {
  const sock = io.sockets.sockets.get(socketId)!;
  return {
    socketId,
    name: names(socketId),
    ip: normalizeIp(sock.handshake.address),
    emit: (view, deadline) => sock.emit('view', { view, deadline }),
    error: (code, message) => sock.emit('error:msg', { code, message }),
    oppLeft: () => sock.emit('opponent:left'),
  };
}

function endMatch(match: ServerMatch) {
  updateStreaks(match);
  for (const id of match.seatIds()) matches.delete(id);
}

/** 2名でマッチを開始する。private=合言葉個室（ランキング非反映）。 */
function pair(aId: string, bId: string, isPrivate = false) {
  const an = names(aId);
  const bn = names(bId);
  const match = new ServerMatch([makeSeat(aId), makeSeat(bId)], () => endMatch(match), isPrivate);
  matches.set(aId, match);
  matches.set(bId, match);
  io.sockets.sockets.get(aId)?.emit('match:found', { opponentName: bn });
  io.sockets.sockets.get(bId)?.emit('match:found', { opponentName: an });
  match.start();
}

function tryMatchmake() {
  while (queue.length >= 2) {
    // 待機者からランダムに2名を選ぶ。
    const a = queue.splice(Math.floor(Math.random() * queue.length), 1)[0]!;
    const b = queue.splice(Math.floor(Math.random() * queue.length), 1)[0]!;
    // どちらかが既に切断していたら戻してやり直し。
    if (!io.sockets.sockets.get(a.socketId)) {
      if (io.sockets.sockets.get(b.socketId)) queue.push(b);
      continue;
    }
    if (!io.sockets.sockets.get(b.socketId)) {
      queue.push(a);
      continue;
    }
    pair(a.socketId, b.socketId);
  }
  broadcastPresence();
}

/** 合言葉個室への入室。同じ合言葉の待機者がいれば即マッチ、いなければ待機。 */
function joinRoom(socketId: string, code: string) {
  removeWaiting(socketId);
  const waiting = rooms.get(code);
  if (waiting && waiting.socketId !== socketId && io.sockets.sockets.get(waiting.socketId)) {
    rooms.delete(code);
    pair(waiting.socketId, socketId, true); // 個室＝ランキング非反映
  } else {
    rooms.set(code, { socketId, name: names(socketId) });
    io.sockets.sockets.get(socketId)?.emit('queue:waiting');
  }
  broadcastPresence();
}

/** 待機状態（公開キュー・個室）から外す。 */
function removeWaiting(socketId: string) {
  const before = queue.length;
  queue = queue.filter((w) => w.socketId !== socketId);
  for (const [code, w] of rooms) if (w.socketId === socketId) rooms.delete(code);
  if (queue.length !== before) broadcastPresence();
}

function removeFromQueue(socketId: string) {
  removeWaiting(socketId);
}

// --- ソケット ---------------------------------------------------------------

io.on('connection', (socket) => {
  socket.data.name = 'プレイヤー';
  socket.data.streak = 0;
  broadcastPresence();
  socket.emit('ranking', rankingPeriods());
  socket.emit('streak', { value: 0 });

  socket.on('hello', ({ name }) => {
    // サーバ権威で禁止ワードを検証。NG なら安全側の既定名にし、本人へ通知。
    const v = validateNickname(name);
    socket.data.name = v.ok ? v.name : 'プレイヤー';
    if (!v.ok && (name ?? '').trim()) {
      socket.emit('error:msg', { code: 'BAD_NAME', message: v.reason ?? '使用できない名前です' });
    }
    // 接続直後の取りこぼし対策：現在の人数をこのソケットへ確実に返す。
    socket.emit('presence', { online: io.sockets.sockets.size, queue: queue.length });
  });

  socket.on('queue:join', (payload) => {
    if (matches.has(socket.id)) return; // 対戦中
    const room = payload?.room;
    if (isRoomCode(room)) {
      joinRoom(socket.id, room); // 合言葉個室
      return;
    }
    if (queue.some((w) => w.socketId === socket.id)) return;
    queue.push({ socketId: socket.id, name: names(socket.id) });
    socket.emit('queue:waiting');
    tryMatchmake();
  });

  socket.on('queue:leave', () => removeFromQueue(socket.id));

  socket.on('game:choose-ability', ({ ability }) => {
    const m = matches.get(socket.id);
    if (!m) return;
    const i = m.seatIndex(socket.id);
    if (i !== -1) m.handleChoose(i, ability as AbilityId);
  });

  socket.on('game:select', ({ card }) => {
    const m = matches.get(socket.id);
    if (!m) return;
    const i = m.seatIndex(socket.id);
    if (i !== -1) m.handleSelect(i, card as RPS);
  });

  socket.on('game:ability', ({ input }) => {
    const m = matches.get(socket.id);
    if (!m) return;
    const i = m.seatIndex(socket.id);
    if (i !== -1) m.handleAbility(i, input as AbilityInput);
  });

  socket.on('game:commit', ({ card }) => {
    const m = matches.get(socket.id);
    if (!m) return;
    const i = m.seatIndex(socket.id);
    if (i !== -1) m.handleCommit(i, card as RPS | undefined);
  });

  socket.on('game:continue', () => {
    matches.get(socket.id)?.handleContinue();
  });

  socket.on('game:rematch', () => {
    // 既存マッチを掃除してから再キュー。
    const m = matches.get(socket.id);
    if (m) {
      endMatch(m);
    }
    queue.push({ socketId: socket.id, name: names(socket.id) });
    socket.emit('queue:waiting');
    tryMatchmake();
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    const m = matches.get(socket.id);
    if (m) m.forfeit(socket.id);
    broadcastPresence();
  });
});

// 0.0.0.0 にバインドして、同一LAN内のスマホ等からも接続できるようにする。
httpServer.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[念動戦] server listening on http://0.0.0.0:${PORT} (LAN可)`);
});
