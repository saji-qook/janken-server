// ===========================================================================
// CPU 思考（CPU対戦時）。難易度は CPU_OPTIMAL_RATE 1か所で調整する。
// 注意: 単体プレイのため CPU はローカルで相手の残り手札を参照してよい。
// ===========================================================================

import type { MatchState, PlayerIndex, RPS, AbilityInput, PerspectiveResult, AbilityId } from './types.js';
import { RPS_ALL } from './types.js';
import { judge, other } from './rules.js';
import { type Rng, defaultRng, pick } from './rng.js';

/** CPU が最適手を選ぶ確率（残りはランダム）。難易度調整はここだけ。 */
export const CPU_OPTIMAL_RATE = 0.7;

const PERSPECTIVES: PerspectiveResult[] = ['win', 'lose', 'draw'];

/** 能力の強さランク（シミュレーション測定の強い順）。ドラフトの選好に使う。 */
export const ABILITY_RANK: AbilityId[] = ['victory', 'transform', 'designate', 'falsify', 'time'];

/** 1ゲーム目ドラフト: 2択のうち強い方を選ぶ。 */
export function chooseDraftAbility(options: AbilityId[], _rng: Rng = defaultRng): AbilityId {
  return [...options].sort((a, b) => ABILITY_RANK.indexOf(a) - ABILITY_RANK.indexOf(b))[0]!;
}

/** cpuCard で oppCard に対し勝ち=1 / 分け=0 / 負け=-1。 */
function score(cpuCard: RPS, oppCard: RPS): number {
  const w = judge(cpuCard, oppCard);
  if (w === 'draw') return 0;
  return w === 0 ? 1 : -1; // judge は第1引数を 0 とみなす
}

/** 相手の残り手札（一様と仮定）に対する各候補の期待値。最良候補群を返す。 */
function bestCards(cpuHand: RPS[], oppHand: RPS[]): RPS[] {
  const candidates = Array.from(new Set(cpuHand));
  let best = -Infinity;
  let result: RPS[] = [];
  for (const c of candidates) {
    const ev = oppHand.reduce((s, o) => s + score(c, o), 0) / oppHand.length;
    if (ev > best + 1e-9) {
      best = ev;
      result = [c];
    } else if (Math.abs(ev - best) < 1e-9) {
      result.push(c);
    }
  }
  return result;
}

/** CPU の出すカードを決める。rushed（時間で急かされた）ならランダム化（弱体化）。 */
export function decideCard(
  state: MatchState,
  cpu: PlayerIndex,
  rng: Rng = defaultRng,
  rushed = false,
): RPS {
  const me = state.players[cpu];
  const opp = state.players[other(cpu)];
  if (rushed) return pick(me.hand, rng);
  if (rng() < CPU_OPTIMAL_RATE) {
    return pick(bestCards(me.hand, opp.hand), rng);
  }
  return pick(me.hand, rng);
}

/** rushed 判定（2ターン目に「時間」で縛られているか）。 */
export function isCpuRushed(state: MatchState, cpu: PlayerIndex): boolean {
  return state.turn === 2 && state.timeRestrictedPlayer === cpu;
}

/**
 * CPU の能力使用を決める。発動するなら AbilityInput、しないなら null。
 * セット前(選択フェーズ)に1度だけ呼ぶ想定。
 */
export function decideAbility(
  state: MatchState,
  cpu: PlayerIndex,
  rng: Rng = defaultRng,
): AbilityInput | null {
  const me = state.players[cpu];
  if (me.abilityUsed) return null;
  const opp = state.players[other(cpu)];
  const turn = state.turn;

  switch (me.ability) {
    case 'time':
      return null; // 自動発動のみ

    case 'victory': {
      if (turn > 2) return null; // 1・2ターン目に使用可
      if (!useNow(turn, rng)) return null;
      // 自分の最良手 vs 相手の最頻手 の結果を予言（外しても引き分けなので撃ちやすい）。
      return { ability: 'victory', predict: predictHeuristic(me.hand, opp.hand, rng) };
    }

    case 'designate': {
      if (!useNow(turn, rng)) return null;
      // 押し込んだ後に自分が最も有利になる出目を選ぶ。
      return { ability: 'designate', value: chooseDesignateValue(me.hand, opp.hand, rng) };
    }

    case 'transform': {
      if (!useNow(turn, rng)) return null;
      // 相手の残りに強い出目を増やす（書き換え先はランダム＝エンジン側）。
      const source = pick(bestCards(me.hand, opp.hand), rng);
      const faces = Array.from(new Set(me.hand));
      if (faces.length < 2) return null; // 既に偏っている
      return { ability: 'transform', source };
    }

    case 'falsify': {
      if (!useNow(turn, rng)) return null;
      return { ability: 'falsify', show: pick(PERSPECTIVES, rng) };
    }
  }
}

/** designate/transform/falsify の発動タイミング判断。1ターン目で渋り、2ターン目で使い切る。 */
function useNow(turn: number, rng: Rng): boolean {
  if (turn === 1) return rng() < 0.45;
  if (turn === 2) return rng() < 0.85; // 使えるのは2ターン目まで → 高確率で使い切る
  return false;
}

/** 指定(新): ランダムに1枚が value になる前提で、自分の最良応手EVが最大の value を選ぶ。 */
function chooseDesignateValue(meHand: RPS[], oppHand: RPS[], rng: Rng): RPS {
  let best = -Infinity;
  let res: RPS[] = [];
  for (const v of RPS_ALL) {
    let ev = 0;
    for (let k = 0; k < oppHand.length; k++) {
      const h = [...oppHand];
      h[k] = v;
      ev += Math.max(...bestCards(meHand, h).map((c) => h.reduce((a, o) => a + score(c, o), 0) / h.length));
    }
    ev /= oppHand.length;
    if (ev > best + 1e-9) (best = ev), (res = [v]);
    else if (Math.abs(ev - best) < 1e-9) res.push(v);
  }
  return pick(res, rng);
}

/** 予言(新): 自分の最良手 vs 相手の最頻手 の結果を予言。 */
function predictHeuristic(meHand: RPS[], oppHand: RPS[], rng: Rng): PerspectiveResult {
  const myCard = pick(bestCards(meHand, oppHand), rng);
  const om = modal(oppHand, rng);
  const w = judge(myCard, om);
  return w === 'draw' ? 'draw' : w === 0 ? 'win' : 'lose';
}

function modal(hand: RPS[], rng: Rng): RPS {
  const counts = new Map<RPS, number>();
  for (const c of hand) counts.set(c, (counts.get(c) ?? 0) + 1);
  let max = 0;
  let res: RPS[] = [];
  for (const [c, n] of counts) {
    if (n > max) (max = n), (res = [c]);
    else if (n === max) res.push(c);
  }
  return pick(res, rng);
}
