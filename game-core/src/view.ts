// ===========================================================================
// プレイヤー視点ビューへの射影（redaction）
//
// サーバ権威の MatchState には「真実」「相手の手札」「偽りの種明かし」が含まれる。
// クライアントへ渡す前に、そのプレイヤーが見てよい情報だけに絞り込む。
// 対人ではこれをそのままネットワーク送出すれば、チートで真実を覗けない。
// ===========================================================================

import type {
  MatchState,
  PlayerIndex,
  RPS,
  AbilityId,
  PerspectiveResult,
  TurnRecord,
} from './types.js';
import { ABILITY_NAME, NORMAL_TIME_LIMIT, TIME_ABILITY_LIMIT, MATCH_WIN_TARGET } from './types.js';
import { other } from './rules.js';
import { finalResult, type FinalResult } from './engine.js';

/** 中央演出の通知（種類は自分のものだけ開示）。 */
export interface AbilityNotice {
  mine: boolean;
  /** 自分の能力なら名前。相手のものなら null（「能力発動」とだけ表示）。 */
  name: string | null;
}

export interface SelfView {
  name: string;
  ability: AbilityId;
  abilityName: string;
  abilityUsed: boolean;
  hand: RPS[];
  selected: RPS | null;
  committed: boolean;
}

export interface OpponentView {
  name: string;
  /** 残り手札枚数のみ（中身は伏せる）。 */
  handCount: number;
  committed: boolean;
  /** 相手が能力を使ったか（種類は不明）。 */
  abilityUsed: boolean;
}

/** 最終リビール（全3ターンの真実）。phase==='finished' のときのみ付与。 */
export interface FinalReveal {
  records: TurnRecord[];
  abilities: [AbilityId, AbilityId];
  scores: [number, number];
  outcome: PerspectiveResult; // この視点の最終結果
  result: FinalResult;
}

export interface ClientView {
  you: PlayerIndex;
  turn: number;
  phase: MatchState['phase'];
  self: SelfView;
  opponent: OpponentView;
  /** このターン・このプレイヤーの制限時間（秒）。 */
  timeLimit: number;
  /** 直近の中央演出（未消費分）。 */
  notices: AbilityNotice[];
  /** reveal 時に届く自分への報告（嘘・'prophecy' を含みうる）。 */
  report: PerspectiveResult | 'prophecy' | null;
  /** ラウンドの最終結果（round-over / finished のとき）。 */
  final: FinalReveal | null;
  /** ドラフト（1ゲーム目の能力選択）情報。phase==='draft' のときのみ。 */
  draft: {
    options: AbilityId[];
    chosen: AbilityId | null;
    opponentChosen: boolean;
  } | null;
  /** 現在のラウンド番号。 */
  round: number;
  /** マッチ（Best of 3）の状況（この視点）。 */
  match: {
    yourWins: number;
    oppWins: number;
    target: number;
    over: boolean;
    /** マッチ決着時のこの視点の結果。 */
    outcome: PerspectiveResult | null;
  };
}

export function projectView(state: MatchState, you: PlayerIndex): ClientView {
  const me = state.players[you];
  const opp = state.players[other(you)];

  const timeLimit =
    state.turn === 2 && state.timeRestrictedPlayer === you
      ? TIME_ABILITY_LIMIT
      : NORMAL_TIME_LIMIT;

  const notices: AbilityNotice[] = state.freshAbilityEvents.map((e) => ({
    mine: e.by === you,
    name: e.by === you ? ABILITY_NAME[e.ability] : null,
  }));

  let report: ClientView['report'] = null;
  if (state.phase === 'reveal' && state.records.length > 0) {
    report = state.records[state.records.length - 1]!.reports[you];
  }

  let final: FinalReveal | null = null;
  if (state.phase === 'finished' || state.phase === 'round-over') {
    const result = finalResult(state);
    const outcome: PerspectiveResult =
      result.winner === 'draw' ? 'draw' : result.winner === you ? 'win' : 'lose';
    final = {
      records: state.records,
      abilities: [state.players[0].ability, state.players[1].ability],
      scores: result.scores,
      outcome,
      result,
    };
  }

  const matchOutcome: PerspectiveResult | null = !state.matchOver
    ? null
    : state.matchWinner === 'draw'
      ? 'draw'
      : state.matchWinner === you
        ? 'win'
        : 'lose';

  return {
    you,
    turn: state.turn,
    phase: state.phase,
    self: {
      name: me.name,
      ability: me.ability,
      abilityName: ABILITY_NAME[me.ability],
      abilityUsed: me.abilityUsed,
      hand: [...me.hand],
      selected: me.selected,
      committed: me.committed,
    },
    opponent: {
      name: opp.name,
      handCount: opp.hand.length,
      committed: opp.committed,
      abilityUsed: opp.abilityUsed,
    },
    timeLimit,
    notices,
    report,
    final,
    draft:
      state.phase === 'draft'
        ? {
            options: [...state.draftOffers[you]],
            chosen: state.draftChosen[you],
            opponentChosen: state.draftChosen[other(you)] !== null,
          }
        : null,
    round: state.round,
    match: {
      yourWins: state.roundWins[you],
      oppWins: state.roundWins[other(you)],
      target: MATCH_WIN_TARGET,
      over: state.matchOver,
      outcome: matchOutcome,
    },
  };
}
