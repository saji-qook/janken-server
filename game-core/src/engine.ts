// ===========================================================================
// 念動戦 — ゲームエンジン（純ロジック / サーバ権威の真の状態を駆動）
//
// オーケストレーション（タイマー・自動セット・演出ディレイ）は呼び出し側
// (server / client) が担当し、本モジュールは状態遷移と裁定のみを担う。
//
// 注意: 関数は state を「破壊的に更新」して同じ参照を返す。React 等で使う場合は
// 呼び出し後に view へ射影し直す（projectView）こと。
// ===========================================================================

import type {
  MatchState,
  PlayerState,
  PlayerIndex,
  RPS,
  AbilityId,
  AbilityInput,
  TurnRecord,
  Winner,
  PerspectiveResult,
} from './types.js';
import { RPS_ALL, ABILITY_IDS, MATCH_WIN_TARGET, MAX_ROUNDS } from './types.js';
import { judge, toPerspective, other, otherFaces } from './rules.js';
import { type Rng, defaultRng, pick } from './rng.js';

export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'GameError';
  }
}

/** 両者に必ず別々の能力を1つずつ割り当てる。 */
export function assignAbilities(rng: Rng = defaultRng): [AbilityId, AbilityId] {
  const a = pick(ABILITY_IDS, rng);
  let b = pick(ABILITY_IDS, rng);
  while (b === a) b = pick(ABILITY_IDS, rng);
  return [a, b];
}

export interface CreateMatchOptions {
  players: [{ id: string; name: string }, { id: string; name: string }];
  rng?: Rng;
  /** テスト用に能力を固定したい場合。省略時はランダム(別々)。 */
  abilities?: [AbilityId, AbilityId];
}

export function createMatch(opts: CreateMatchOptions): MatchState {
  const rng = opts.rng ?? defaultRng;
  const abilities = opts.abilities ?? assignAbilities(rng);
  if (abilities[0] === abilities[1]) {
    throw new GameError('SAME_ABILITY', '両者に同じ能力は配れません');
  }
  const mkPlayer = (i: PlayerIndex): PlayerState => ({
    id: opts.players[i].id,
    name: opts.players[i].name,
    ability: abilities[i],
    abilityUsed: false,
    hand: [...RPS_ALL],
    selected: null,
    committed: false,
  });
  return {
    players: [mkPlayer(0), mkPlayer(1)],
    turn: 1,
    phase: 'select',
    round: 1,
    roundWins: [0, 0],
    matchOver: false,
    matchWinner: 'draw',
    pendingFalsify: [],
    pendingVictory: null,
    thisTurnAbilities: [],
    freshAbilityEvents: [],
    records: [],
    abilityLog: [],
    timeRestrictedPlayer: null,
    draftOffers: [[], []],
    draftChosen: [null, null],
    roundAbilities: [],
  };
}

function shuffle<T>(arr: readonly T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i]!, a[j]!] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * 能力ドラフト方式のマッチを作る。
 * 1G: 各プレイヤーに別々の2択を提示（phase='draft'）→ chooseDraft で1つ選ぶ。
 * 2G: 残り3つから各1つランダム。3G: 残り1つで両者ミラー。
 */
export function createDraftMatch(opts: { players: CreateMatchOptions['players']; rng?: Rng }): MatchState {
  const rng = opts.rng ?? defaultRng;
  const order = shuffle(ABILITY_IDS, rng); // 5
  const offers: [AbilityId[], AbilityId[]] = [
    [order[0]!, order[1]!],
    [order[2]!, order[3]!],
  ];
  const s = createMatch({ players: opts.players, rng, abilities: [order[0]!, order[2]!] });
  s.phase = 'draft';
  s.draftOffers = offers;
  s.draftChosen = [null, null];
  return s;
}

/** 1ゲーム目の能力を選ぶ（draft フェーズ）。両者そろうとドラフト確定。 */
export function chooseDraft(state: MatchState, player: PlayerIndex, ability: AbilityId, rng: Rng = defaultRng): MatchState {
  if (state.phase !== 'draft') throw new GameError('WRONG_PHASE', 'ドラフトフェーズではありません');
  if (state.draftChosen[player]) throw new GameError('ALREADY_CHOSEN', 'すでに選択済みです');
  if (!state.draftOffers[player].includes(ability)) {
    throw new GameError('NOT_OFFERED', '提示されていない能力です');
  }
  state.draftChosen[player] = ability;
  if (state.draftChosen[0] && state.draftChosen[1]) finalizeDraft(state, rng);
  return state;
}

function finalizeDraft(state: MatchState, rng: Rng) {
  const c0 = state.draftChosen[0]!;
  const c1 = state.draftChosen[1]!;
  // 選ばれなかった3つ（両者の不採用＋未提示の1つ）。
  const pool = shuffle(ABILITY_IDS.filter((a) => a !== c0 && a !== c1), rng);
  state.roundAbilities = [
    [c0, c1],
    [pool[0]!, pool[1]!],
    [pool[2]!, pool[2]!], // 3G ミラー
  ];
  applyRoundAbilities(state, 1);
  state.phase = 'select';
}

/** roundAbilities[round-1] を両者へ割り当て、手札を初期化する。 */
function applyRoundAbilities(state: MatchState, round: number) {
  const ab = state.roundAbilities[round - 1]!;
  state.players[0].ability = ab[0];
  state.players[1].ability = ab[1];
  for (const p of state.players) {
    p.abilityUsed = false;
    p.hand = [...RPS_ALL];
    p.selected = null;
    p.committed = false;
  }
}

// --- カード選択 / セット -----------------------------------------------------

function assertSelectPhase(state: MatchState) {
  if (state.phase !== 'select') {
    throw new GameError('WRONG_PHASE', `選択フェーズではありません (${state.phase})`);
  }
}

/** 手札に含まれる出目か（重複手札も考慮）。 */
function handHas(p: PlayerState, card: RPS): boolean {
  return p.hand.includes(card);
}

/** カードを選択（タップ）。確定はしない。 */
export function selectCard(state: MatchState, player: PlayerIndex, card: RPS): MatchState {
  assertSelectPhase(state);
  const p = state.players[player];
  if (p.committed) throw new GameError('ALREADY_COMMITTED', 'すでにセット済みです');
  if (!handHas(p, card)) throw new GameError('NOT_IN_HAND', '手札にないカードです');
  p.selected = card;
  return state;
}

/** カードをセット（確定）。card を渡すと選択も同時に行う。 */
export function commitCard(state: MatchState, player: PlayerIndex, card?: RPS): MatchState {
  assertSelectPhase(state);
  const p = state.players[player];
  if (p.committed) throw new GameError('ALREADY_COMMITTED', 'すでにセット済みです');
  if (card) p.selected = card;
  if (!p.selected) throw new GameError('NOTHING_SELECTED', 'カードが選択されていません');
  if (!handHas(p, p.selected)) throw new GameError('NOT_IN_HAND', '手札にないカードです');
  p.committed = true;
  return state;
}

/**
 * タイムアップ時の自動セット。
 * 選択中ならそれを、無ければ残り手札からランダムに確定する（試合を止めないため）。
 */
export function autoCommit(state: MatchState, player: PlayerIndex, rng: Rng = defaultRng): MatchState {
  const p = state.players[player];
  if (p.committed) return state;
  if (!p.selected) p.selected = pick(p.hand, rng);
  return commitCard(state, player);
}

/** 3ターン目など手札が1枚で強制のとき、その1枚を返す。 */
export function forcedCard(state: MatchState, player: PlayerIndex): RPS | null {
  const p = state.players[player];
  return p.hand.length === 1 ? p.hand[0]! : null;
}

export function bothCommitted(state: MatchState): boolean {
  return state.players[0].committed && state.players[1].committed;
}

// --- 能力 -------------------------------------------------------------------

function allowedThisTurn(ability: AbilityId, turn: number): boolean {
  switch (ability) {
    case 'designate':
    case 'transform':
    case 'falsify':
      return turn === 1 || turn === 2;
    case 'victory':
      return turn === 1 || turn === 2; // 予言：1・2ターン目に使用可
    case 'time':
      return false; // 自動発動のみ。手動使用不可
  }
}

/** 能力発動。発動はそのターンのセット前のみ。state を破壊的に更新する。 */
export function applyAbility(
  state: MatchState,
  player: PlayerIndex,
  input: AbilityInput,
  rng: Rng = defaultRng,
): MatchState {
  assertSelectPhase(state);
  const p = state.players[player];
  if (p.committed) throw new GameError('ALREADY_COMMITTED', 'セット後は能力を使えません');
  if (p.abilityUsed) throw new GameError('ABILITY_USED', '能力は1試合に1回のみです');
  if (input.ability !== p.ability) {
    throw new GameError('WRONG_ABILITY', '所持していない能力です');
  }
  if (!allowedThisTurn(p.ability, state.turn)) {
    throw new GameError('ABILITY_NOT_ALLOWED', `このターンでは「${p.ability}」を使えません`);
  }

  switch (input.ability) {
    case 'designate':
      applyDesignate(state, player, input.value, rng);
      break;
    case 'transform':
      applyTransform(state, player, input.source, rng);
      break;
    case 'falsify':
      state.pendingFalsify.push({ by: player, show: input.show });
      break;
    case 'victory':
      state.pendingVictory = { by: player, predict: input.predict };
      break;
  }

  p.abilityUsed = true;
  const ev = { turn: state.turn, by: player, ability: p.ability };
  state.thisTurnAbilities.push({ by: player, ability: p.ability });
  state.freshAbilityEvents.push(ev);
  state.abilityLog.push(ev);
  return state;
}

/** 指定（新）：相手の手札からランダムに1枚選び、指定した出目 value に書き換える。 */
function applyDesignate(state: MatchState, player: PlayerIndex, value: RPS, rng: Rng) {
  const opp = state.players[other(player)];
  const idx = Math.floor(rng() * opp.hand.length); // 対象はランダム
  opp.hand[idx] = value; // 出目は選択
}

/** 複製（新）：自分の別の1枚(ランダム)を source の出目へ書き換える（2枚同じ+1種欠け）。 */
function applyTransform(state: MatchState, player: PlayerIndex, source: RPS, rng: Rng) {
  const p = state.players[player];
  if (!p.hand.includes(source)) throw new GameError('NOT_IN_HAND', '増やす出目が手札にありません');
  const targets = p.hand.map((c, i) => (c !== source ? i : -1)).filter((i) => i !== -1);
  if (targets.length === 0) return; // 既に全て source なら何もしない
  const idx = pick(targets, rng); // 書き換え先（消える札）はランダム
  p.hand[idx] = source;
}

// --- ターン解決 -------------------------------------------------------------

/** 両者セット済みのとき、ターンを解決して reveal フェーズへ。 */
export function resolveTurn(state: MatchState): MatchState {
  if (state.phase !== 'select') throw new GameError('WRONG_PHASE', '選択フェーズではありません');
  if (!bothCommitted(state)) throw new GameError('NOT_READY', '両者のセットが必要です');

  const c0 = state.players[0].selected!;
  const c1 = state.players[1].selected!;
  const cards: [RPS, RPS] = [c0, c1];
  const rawWinner = judge(c0, c1);

  let winner: Winner = rawWinner;
  let victory: TurnRecord['victory'];
  if (state.pendingVictory) {
    const { by, predict } = state.pendingVictory;
    const hit = toPerspective(rawWinner, by) === predict;
    // 予言（新）：的中ならそのターンは自分の勝ち、外れたら引き分け（負けにはならない）。
    winner = hit ? by : 'draw';
    victory = { by, predict, hit };
  }

  // 報告（各プレイヤー視点）。
  const reports: TurnRecord['reports'] = [
    toPerspective(winner, 0),
    toPerspective(winner, 1),
  ];
  // 偽り: 相手(=被対象)の報告を差し替え。
  for (const f of state.pendingFalsify) {
    const targetP = other(f.by);
    reports[targetP] = f.show;
  }
  // 予言した本人は結果を伏せる（'prophecy'）。偽りより優先。
  if (victory) reports[victory.by] = 'prophecy';

  const deceived: [boolean, boolean] = [false, false];
  for (const i of [0, 1] as PlayerIndex[]) {
    const r = reports[i];
    if (r !== 'prophecy') deceived[i] = r !== toPerspective(winner, i);
  }

  const record: TurnRecord = {
    turn: state.turn,
    cards,
    rawWinner,
    winner,
    victory,
    reports,
    deceived,
    abilitiesUsed: [...state.thisTurnAbilities],
  };
  state.records.push(record);

  // 出した札を手札から取り除く。
  removeOne(state.players[0].hand, c0);
  removeOne(state.players[1].hand, c1);

  state.phase = 'reveal';
  return state;
}

function removeOne(hand: RPS[], card: RPS) {
  const i = hand.indexOf(card);
  if (i !== -1) hand.splice(i, 1);
}

/**
 * reveal から次へ進める。
 * 1ターン目終了時には「時間」を自動発動する。
 * 3ターン終了でラウンドを締め、マッチ決着なら finished、続くなら round-over。
 */
export function advanceTurn(state: MatchState): MatchState {
  if (state.phase !== 'reveal') throw new GameError('WRONG_PHASE', 'reveal フェーズではありません');

  const finishedTurn = state.turn;

  // 次ターンの準備。
  state.pendingFalsify = [];
  state.pendingVictory = null;
  state.thisTurnAbilities = [];
  for (const p of state.players) {
    p.selected = null;
    p.committed = false;
  }
  state.timeRestrictedPlayer = null;

  if (finishedTurn >= 3) {
    endRound(state);
    return state;
  }

  state.turn = finishedTurn + 1;
  state.phase = 'select';

  // 1ターン目終了 → 2ターン目開始時に「時間」自動発動。
  if (finishedTurn === 1) {
    for (const i of [0, 1] as PlayerIndex[]) {
      const p = state.players[i];
      if (p.ability === 'time' && !p.abilityUsed) {
        p.abilityUsed = true;
        state.timeRestrictedPlayer = other(i);
        const ev = { turn: state.turn, by: i, ability: 'time' as AbilityId };
        state.freshAbilityEvents.push(ev);
        state.abilityLog.push(ev);
      }
    }
  }
  return state;
}

/** ラウンドを締める。マッチ決着なら finished、続行なら round-over。 */
function endRound(state: MatchState): void {
  const rr = finalResult(state); // このラウンドの結果
  if (rr.winner !== 'draw') state.roundWins[rr.winner]++;

  const reached =
    state.roundWins[0] >= MATCH_WIN_TARGET || state.roundWins[1] >= MATCH_WIN_TARGET;
  const lastRound = state.round >= MAX_ROUNDS;

  state.turn = 4;
  if (reached || lastRound) {
    state.matchOver = true;
    state.phase = 'finished';
    state.matchWinner =
      state.roundWins[0] > state.roundWins[1]
        ? 0
        : state.roundWins[1] > state.roundWins[0]
          ? 1
          : 'draw';
  } else {
    state.phase = 'round-over';
  }
}

/**
 * 次のラウンドを開始する（round-over のときのみ）。
 * 手札をリセットし、能力を配り直す（両者別々のランダム）。
 */
export function nextRound(state: MatchState, rng: Rng = defaultRng): MatchState {
  if (state.phase !== 'round-over') {
    throw new GameError('WRONG_PHASE', 'round-over フェーズではありません');
  }
  state.round += 1;
  state.turn = 1;
  state.phase = 'select';
  state.records = [];
  state.abilityLog = [];
  state.pendingFalsify = [];
  state.pendingVictory = null;
  state.thisTurnAbilities = [];
  state.freshAbilityEvents = [];
  state.timeRestrictedPlayer = null;
  if (state.roundAbilities.length >= state.round) {
    // ドラフト方式：あらかじめ決めた割当を適用。
    applyRoundAbilities(state, state.round);
  } else {
    // simple モード：ランダムに配り直す。
    const abilities = assignAbilities(rng);
    state.players.forEach((p, i) => {
      p.ability = abilities[i]!;
      p.abilityUsed = false;
      p.hand = [...RPS_ALL];
      p.selected = null;
      p.committed = false;
    });
  }
  return state;
}

/** 中央演出を消費したら呼ぶ。 */
export function clearAbilityEvents(state: MatchState): MatchState {
  state.freshAbilityEvents = [];
  return state;
}

// --- 最終結果 ---------------------------------------------------------------

export interface FinalResult {
  scores: [number, number]; // 各プレイヤーの勝ちターン数
  winner: Winner;           // 試合の勝者
}

export function finalResult(state: MatchState): FinalResult {
  const scores: [number, number] = [0, 0];
  for (const r of state.records) {
    if (r.winner !== 'draw') scores[r.winner]++;
  }
  let winner: Winner = 'draw';
  if (scores[0] > scores[1]) winner = 0;
  else if (scores[1] > scores[0]) winner = 1;
  return { scores, winner };
}
