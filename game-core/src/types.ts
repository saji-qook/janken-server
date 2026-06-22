// ===========================================================================
// 念動戦 — 共有ゲームコア / 型定義
// フレームワーク非依存。クライアントとサーバが同じ型・ロジックを共有する。
// ===========================================================================

/** 出目（内部表現）。UI ラベル(グー/チョキ/パー)・画像は client 側でマッピングする。 */
export type RPS = 'rock' | 'scissors' | 'paper';
export const RPS_ALL: readonly RPS[] = ['rock', 'scissors', 'paper'] as const;

/** プレイヤー番号。サーバ権威の真の状態では 0 / 1 で識別する。 */
export type PlayerIndex = 0 | 1;

/** あるターンの勝者。'draw' は引き分け。 */
export type Winner = PlayerIndex | 'draw';

/** ある視点（プレイヤー目線）での結果。報告や予言はこの形で扱う。 */
export type PerspectiveResult = 'win' | 'lose' | 'draw';

/** 5種の能力。必ず両者に別々の1つが配られる。 */
export type AbilityId =
  | 'designate' // 指定：相手のカード1枚を別の出目(ランダム)に書き換え
  | 'transform' // 変化：自分の1枚を別の出目に書き換え(2枚同じ+1種欠け)
  | 'falsify'   // 偽り：そのターンの「報告」を相手に偽装
  | 'victory'   // 勝利：2ターン目専用。結果を予言し、的中なら勝ち/外れなら負け
  | 'time';     // 時間：1ターン目終了時に自動発動。相手の2ターン目を5秒に縛る

export const ABILITY_IDS: readonly AbilityId[] = [
  'designate',
  'transform',
  'falsify',
  'victory',
  'time',
] as const;

// 注: 内部IDは安定のため据え置き（designate/transform/falsify/victory/time）。
// 表示名のみ変更: 指定 / 複製 / 虚偽 / 予言 / 加速。
/** 各能力の日本語名（告知表示などに使用）。 */
export const ABILITY_NAME: Record<AbilityId, string> = {
  designate: '指定',
  transform: '複製',
  falsify: '虚偽',
  victory: '予言',
  time: '加速',
};

/** 能力の説明（メニューのルール・対戦中のヘルプで共有）。 */
export interface AbilityInfo {
  id: AbilityId;
  name: string;
  timing: string;
  detail: string;
}

export const ABILITY_INFO: readonly AbilityInfo[] = [
  {
    id: 'designate',
    name: '指定',
    timing: '1・2ターン目',
    detail: '相手の手札1枚（ランダムに選ばれる）を、自分が選んだ出目に書き換える。狙った目を相手に押し込める。',
  },
  {
    id: 'transform',
    name: '複製',
    timing: '1・2ターン目',
    detail: '自分の手札から増やす出目を1つ選ぶ。別の1枚（ランダム）がその出目に変わる（2枚同じ＋1種欠け）。',
  },
  {
    id: 'falsify',
    name: '虚偽',
    timing: '1・2ターン目',
    detail: 'そのターンの「報告」を相手に偽装する。真のスコアは変わらず、最終リビールで嘘がバレる。',
  },
  {
    id: 'victory',
    name: '予言',
    timing: '1・2ターン目',
    detail: 'そのターンの結果を予言。的中ならそのターンは自分の勝ち、外れても引き分け（負けにはならない）。',
  },
  {
    id: 'time',
    name: '加速',
    timing: '1ターン目終了時・自動',
    detail: '相手の2ターン目の制限時間を60秒→10秒に縛る（自動発動）。',
  },
] as const;

// --- 能力の入力（プレイヤー/ CPU が能力発動時に渡すパラメータ） -------------

export interface DesignateInput {
  ability: 'designate';
  /** 相手の手札（ランダムに選ばれた1枚）に押し込む出目。 */
  value: RPS;
}
export interface TransformInput {
  ability: 'transform';
  /** 増やす出目（自分の手札にある出目）。別の1枚(ランダム)がこの出目に変わる。 */
  source: RPS;
}
export interface FalsifyInput {
  ability: 'falsify';
  /** 相手にそう思わせたい結果（相手視点）。 */
  show: PerspectiveResult;
}
export interface VictoryInput {
  ability: 'victory';
  /** 予言する結果（自分視点）。 */
  predict: PerspectiveResult;
}
export type AbilityInput =
  | DesignateInput
  | TransformInput
  | FalsifyInput
  | VictoryInput;

// --- 真の状態（サーバ権威。クライアントには redact してから渡す） -----------

export interface PlayerState {
  id: string;
  name: string;
  ability: AbilityId;
  abilityUsed: boolean;
  /** 残り手札（出目の多重集合）。能力で重複/欠けが生じうる。 */
  hand: RPS[];
  /** 現ターンで選択中のカード（未確定）。 */
  selected: RPS | null;
  /** 現ターンのカードを確定(セット)済みか。 */
  committed: boolean;
}

/** 1ターンの確定記録（真実。最終リビールで開示）。 */
export interface TurnRecord {
  turn: number; // 1..3
  cards: [RPS, RPS];
  /** 純粋なじゃんけん結果。 */
  rawWinner: Winner;
  /** 採点上の実効結果（勝利=予言の的中/外れで上書きされる）。 */
  winner: Winner;
  /** 勝利(予言)の記録。 */
  victory?: { by: PlayerIndex; predict: PerspectiveResult; hit: boolean };
  /** 各プレイヤーがそのターンに受け取った報告。'prophecy' は予言で伏せられた状態。 */
  reports: [PerspectiveResult | 'prophecy', PerspectiveResult | 'prophecy'];
  /** reports[i] が真実と異なる（偽りを受けた）か。 */
  deceived: [boolean, boolean];
  /** そのターンに使用された能力（種類）。「能力発動」表示数の根拠。 */
  abilitiesUsed: { by: PlayerIndex; ability: AbilityId }[];
}

/** 能力使用ログ（最終リビールの語り用）。 */
export interface AbilityEvent {
  turn: number;
  by: PlayerIndex;
  ability: AbilityId;
}

export type Phase = 'draft' | 'select' | 'reveal' | 'round-over' | 'finished';

export interface MatchState {
  players: [PlayerState, PlayerState];
  turn: number; // 1..3（round-over 後は 4）
  phase: Phase;
  /** 現在のラウンド番号（1-based）。 */
  round: number;
  /** マッチのラウンド勝利数。 */
  roundWins: [number, number];
  /** マッチが決着したか。 */
  matchOver: boolean;
  /** マッチの勝者（matchOver のとき有効）。 */
  matchWinner: Winner;
  /** 現ターンに積まれた偽り（解決時に reports へ反映）。 */
  pendingFalsify: { by: PlayerIndex; show: PerspectiveResult }[];
  /** 現ターン(2ターン目)に積まれた予言。 */
  pendingVictory: { by: PlayerIndex; predict: PerspectiveResult } | null;
  /** 現ターンに使用された能力（TurnRecord.abilitiesUsed の元）。 */
  thisTurnAbilities: { by: PlayerIndex; ability: AbilityId }[];
  /** 直近で発動し、まだ告知していない能力（中央演出用）。 */
  freshAbilityEvents: AbilityEvent[];
  records: TurnRecord[];
  abilityLog: AbilityEvent[];
  /** 「時間」により制限時間が縛られる対象（2ターン目）。 */
  timeRestrictedPlayer: PlayerIndex | null;

  // --- 能力ドラフト（draft モードのみ。simple モードでは空） ---
  /** 1ゲーム目に各プレイヤーへ提示される2択。 */
  draftOffers: [AbilityId[], AbilityId[]];
  /** 1ゲーム目の選択（両者そろうとドラフト確定）。 */
  draftChosen: [AbilityId | null, AbilityId | null];
  /** ドラフト確定後の各ラウンドの能力割当（[0]=1G,[1]=2G,[2]=3G）。simple では空。 */
  roundAbilities: [AbilityId, AbilityId][];
}

/** 制限時間（秒）。 */
export const NORMAL_TIME_LIMIT = 60;
export const TIME_ABILITY_LIMIT = 10;

/** マッチ設定。1試合=1ゲーム（その1ゲームの勝者が試合の勝者）。 */
export const MATCH_WIN_TARGET = 1;
export const MAX_ROUNDS = 1;
