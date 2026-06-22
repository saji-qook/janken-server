// 対人マッチ1件のサーバ権威オーケストレーション。
// タイマー・自動セット・解決ループ・切断処理をサーバ側で厳密に管理する。

import {
  createDraftMatch,
  chooseDraft,
  chooseDraftAbility,
  selectCard,
  applyAbility,
  commitCard,
  autoCommit,
  resolveTurn,
  advanceTurn,
  nextRound,
  bothCommitted,
  projectView,
  GameError,
  type MatchState,
  type PlayerIndex,
  type RPS,
  type AbilityId,
  type AbilityInput,
} from '@janken/game-core';

/** 解決演出を見せてから次ターンへ進む待ち時間(ms)。 */
const REVEAL_MS = 2600;
/** ラウンド結果を見せてから次ラウンドへ進む待ち時間(ms)。 */
const ROUND_BREAK_MS = 6000;

export interface MatchSeat {
  socketId: string;
  name: string;
  emit: (view: ReturnType<typeof projectView>, deadline: number | null) => void;
  error: (code: string, message: string) => void;
  oppLeft: () => void;
  /** 接続元IP（同一IP/ネットワーク判定用）。 */
  ip: string;
}

export class ServerMatch {
  state: MatchState;
  private seats: [MatchSeat, MatchSeat];
  private timers: (NodeJS.Timeout | null)[] = [null, null];
  private revealTimer: NodeJS.Timeout | null = null;
  private roundBreakTimer: NodeJS.Timeout | null = null;
  private draftTimer: NodeJS.Timeout | null = null;
  private deadlines: [number | null, number | null] = [null, null];
  ended = false;
  /** マッチ結果の勝者（finish/forfeit で確定）。ランキング更新に使う。 */
  resultWinner: PlayerIndex | 'draw' | null = null;
  /** 合言葉個室の対戦か（連勝ランキングに反映しない）。 */
  isPrivate: boolean;
  private onEnd: () => void;

  constructor(seats: [MatchSeat, MatchSeat], onEnd: () => void, isPrivate = false) {
    this.seats = seats;
    this.onEnd = onEnd;
    this.isPrivate = isPrivate;
    this.state = createDraftMatch({
      players: [
        { id: seats[0].socketId, name: seats[0].name },
        { id: seats[1].socketId, name: seats[1].name },
      ],
    });
  }

  seatIndex(socketId: string): PlayerIndex | -1 {
    if (this.seats[0].socketId === socketId) return 0;
    if (this.seats[1].socketId === socketId) return 1;
    return -1;
  }

  start() {
    this.startDraft();
  }

  // --- ドラフト（1ゲーム目の能力選択） --------------------------------------
  private static DRAFT_MS = 25000;

  private startDraft() {
    this.deadlines = [Date.now() + ServerMatch.DRAFT_MS, Date.now() + ServerMatch.DRAFT_MS];
    this.broadcast();
    this.draftTimer = setTimeout(() => this.autoDraft(), ServerMatch.DRAFT_MS);
  }

  handleChoose(i: PlayerIndex, ability: AbilityId) {
    if (this.state.phase !== 'draft') return;
    this.guard(i, () => {
      chooseDraft(this.state, i, ability);
      // chooseDraft で両者そろうと phase は 'select' になる。
      if ((this.state.phase as string) === 'select') {
        this.clearDraftTimer();
        this.startTurn();
      } else {
        this.broadcast();
      }
    });
  }

  private autoDraft() {
    if (this.ended || this.state.phase !== 'draft') return;
    for (const i of [0, 1] as PlayerIndex[]) {
      if (!this.state.draftChosen[i]) {
        try {
          chooseDraft(this.state, i, chooseDraftAbility(this.state.draftOffers[i]));
        } catch {
          /* noop */
        }
      }
    }
    this.clearDraftTimer();
    if ((this.state.phase as string) === 'select') this.startTurn();
  }

  private clearDraftTimer() {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
  }

  // --- 配信 -----------------------------------------------------------------

  private broadcast() {
    for (const i of [0, 1] as PlayerIndex[]) {
      this.seats[i].emit(projectView(this.state, i), this.deadlines[i]);
    }
    // 中央演出は一度配ったら消費する（再アニメ防止）。
    this.state.freshAbilityEvents = [];
  }

  // --- ターン進行 -----------------------------------------------------------

  private startTurn() {
    this.clearTurnTimers();

    // 3ターン目は手札1枚で強制。短い猶予のあと自動解決する。
    if (this.state.turn === 3) {
      this.deadlines = [null, null];
      this.broadcast();
      this.revealTimer = setTimeout(() => {
        if (this.ended) return;
        autoCommit(this.state, 0);
        autoCommit(this.state, 1);
        this.maybeResolve();
      }, 1600);
      return;
    }

    const now = Date.now();
    for (const i of [0, 1] as PlayerIndex[]) {
      const view = projectView(this.state, i);
      this.deadlines[i] = now + view.timeLimit * 1000;
      this.timers[i] = setTimeout(() => this.onTimeout(i), view.timeLimit * 1000);
    }
    this.broadcast();
  }

  private onTimeout(i: PlayerIndex) {
    if (this.ended || this.state.phase !== 'select') return;
    try {
      autoCommit(this.state, i);
    } catch {
      /* すでにセット済みなど */
    }
    this.maybeResolve();
  }

  private maybeResolve() {
    if (!bothCommitted(this.state)) {
      this.broadcast();
      return;
    }
    this.clearTurnTimers();
    this.deadlines = [null, null];
    resolveTurn(this.state);
    this.broadcast(); // reveal（報告を配信）

    this.revealTimer = setTimeout(() => {
      if (this.ended) return;
      advanceTurn(this.state);
      if (this.state.phase === 'finished') {
        this.broadcast(); // マッチの最終リビール
        this.finish();
      } else if (this.state.phase === 'round-over') {
        this.broadcast(); // ラウンド結果リビール
        this.roundBreakTimer = setTimeout(() => this.startNextRound(), ROUND_BREAK_MS);
      } else {
        this.startTurn();
      }
    }, REVEAL_MS);
  }

  private startNextRound() {
    if (this.ended || this.state.phase !== 'round-over') return;
    if (this.roundBreakTimer) clearTimeout(this.roundBreakTimer);
    this.roundBreakTimer = null;
    nextRound(this.state);
    this.startTurn();
  }

  /** プレイヤーが「次のラウンドへ」を押したら待ち時間を飛ばす。 */
  handleContinue() {
    if (this.state.phase === 'round-over') this.startNextRound();
  }

  // --- プレイヤー操作 -------------------------------------------------------

  handleSelect(i: PlayerIndex, card: RPS) {
    this.guard(i, () => {
      selectCard(this.state, i, card);
      this.broadcast();
    });
  }

  handleAbility(i: PlayerIndex, input: AbilityInput) {
    this.guard(i, () => {
      applyAbility(this.state, i, input);
      this.broadcast();
    });
  }

  handleCommit(i: PlayerIndex, card?: RPS) {
    this.guard(i, () => {
      commitCard(this.state, i, card);
      this.maybeResolve();
    });
  }

  private guard(i: PlayerIndex, fn: () => void) {
    if (this.ended) return;
    try {
      fn();
    } catch (e) {
      if (e instanceof GameError) this.seats[i].error(e.code, e.message);
      else throw e;
    }
  }

  // --- 終了 / 切断 ----------------------------------------------------------

  /** プレイヤー切断・退出。残った側を勝ち扱いにして終了。 */
  forfeit(socketId: string) {
    const i = this.seatIndex(socketId);
    if (i === -1 || this.ended) return;
    const opp = (i === 0 ? 1 : 0) as PlayerIndex;
    this.clearAllTimers();
    this.ended = true;
    this.resultWinner = opp; // 残った側の不戦勝
    // 残った側へ通知（クライアントが walkover 勝利画面を出す）。
    this.seats[opp].oppLeft();
    this.onEnd();
  }

  private finish() {
    this.clearAllTimers();
    this.ended = true;
    this.resultWinner = this.state.matchWinner;
    this.onEnd();
  }

  private clearTurnTimers() {
    for (const i of [0, 1] as PlayerIndex[]) {
      if (this.timers[i]) clearTimeout(this.timers[i]!);
      this.timers[i] = null;
    }
  }
  private clearAllTimers() {
    this.clearTurnTimers();
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = null;
    if (this.roundBreakTimer) clearTimeout(this.roundBreakTimer);
    this.roundBreakTimer = null;
    this.clearDraftTimer();
  }

  ips(): [string, string] {
    return [this.seats[0].ip, this.seats[1].ip];
  }

  seatIds(): [string, string] {
    return [this.seats[0].socketId, this.seats[1].socketId];
  }
}
