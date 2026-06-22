import type { RPS, Winner, PlayerIndex, PerspectiveResult } from './types.js';
import { RPS_ALL } from './types.js';

/** a が b に勝つか（グー>チョキ>パー>グー）。 */
const BEATS: Record<RPS, RPS> = {
  rock: 'scissors',
  scissors: 'paper',
  paper: 'rock',
};

/** 2手のじゃんけん判定。0 = a の勝ち / 1 = b の勝ち / 'draw'。 */
export function judge(a: RPS, b: RPS): Winner {
  if (a === b) return 'draw';
  return BEATS[a] === b ? 0 : 1;
}

/** winner（全体視点）を player 視点の結果へ変換。 */
export function toPerspective(winner: Winner, player: PlayerIndex): PerspectiveResult {
  if (winner === 'draw') return 'draw';
  return winner === player ? 'win' : 'lose';
}

/** player 視点の結果を全体視点の winner へ変換。 */
export function fromPerspective(result: PerspectiveResult, player: PlayerIndex): Winner {
  if (result === 'draw') return 'draw';
  const other: PlayerIndex = player === 0 ? 1 : 0;
  return result === 'win' ? player : other;
}

export function other(player: PlayerIndex): PlayerIndex {
  return player === 0 ? 1 : 0;
}

/** v 以外の出目2種。 */
export function otherFaces(v: RPS): RPS[] {
  return RPS_ALL.filter((f) => f !== v);
}
