// ===========================================================================
// 対人通信プロトコル（client / server 共有）
// クライアントへは ClientView（redact 済み）のみ送る。真の状態は送らない。
// ===========================================================================

import type { RPS, AbilityInput, AbilityId } from './types.js';
import type { ClientView } from './view.js';

/** Client → Server */
export interface ClientToServer {
  /** ニックネーム登録（接続直後）。 */
  'hello': (payload: { name: string }) => void;
  /** 対人マッチング待機キューに入る。room（数字4桁）指定で合言葉個室、未指定でランダム。 */
  'queue:join': (payload: { room?: string }) => void;
  /** 待機キューを離脱。 */
  'queue:leave': () => void;
  /** 1ゲーム目の能力ドラフト選択。 */
  'game:choose-ability': (payload: { ability: AbilityId }) => void;
  /** カード選択（未確定）。 */
  'game:select': (payload: { card: RPS }) => void;
  /** 能力発動。 */
  'game:ability': (payload: { input: AbilityInput }) => void;
  /** カードをセット（確定）。 */
  'game:commit': (payload: { card?: RPS }) => void;
  /** ラウンド間に「次のラウンドへ」（待ち時間を飛ばす）。 */
  'game:continue': () => void;
  /** 「もう一度」希望（再マッチング）。 */
  'game:rematch': () => void;
}

/** Server → Client */
export interface ServerToClient {
  /** 現在の同時接続人数。 */
  'presence': (payload: { online: number; queue: number }) => void;
  /** マッチング待機中。 */
  'queue:waiting': () => void;
  /** マッチ成立。 */
  'match:found': (payload: { opponentName: string }) => void;
  /** プレイヤー視点ビュー（状態が変わるたび）。 */
  'view': (payload: { view: ClientView; deadline: number | null }) => void;
  /** 相手が切断/退出。残った側を勝ち扱い。 */
  'opponent:left': () => void;
  /** 連続勝利数ランキング（日・週・全期間別）。 */
  'ranking': (payload: RankingPeriods) => void;
  /** 自分の現在の連勝数（サーバ権威）。 */
  'streak': (payload: { value: number }) => void;
  /** エラー通知。 */
  'error:msg': (payload: { code: string; message: string }) => void;
}

export interface RankingEntry {
  name: string;
  streak: number;
}

/** 連勝ランキングを期間別に保持する。 */
export interface RankingPeriods {
  day: RankingEntry[];
  week: RankingEntry[];
  all: RankingEntry[];
}
