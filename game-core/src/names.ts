// ニックネームの検証（client / server 共有）。下ネタ・暴言などの禁止ワードを弾く。
// 禁止語は BANNED_WORDS 1か所で調整する（小文字・空白無視で部分一致）。

export const MAX_NAME_LEN = 12;

/**
 * 禁止ワード（部分一致・小文字化・記号/空白除去後に判定）。
 * 性的表現・暴言・差別語・自傷示唆などを想定。運用に合わせて増減する。
 */
export const BANNED_WORDS: readonly string[] = [
  // --- 暴言・侮辱 ---
  'しね', '死ね', 'ころす', '殺す', 'ぶっころ', 'きえろ', '消えろ',
  'ばか', 'あほ', 'かす', 'くず', 'まぬけ', 'のろま', 'うざい', 'きもい', 'きしょ',
  'ぶす', 'でぶ', 'はげ', 'ぶさいく', 'むのう', '無能',
  'がいじ', 'きちがい', '池沼', '障害者', '知恵遅れ',
  // --- 性的・下ネタ ---
  'ちんこ', 'ちんちん', 'まんこ', 'おっぱい', 'せっくす', 'えっち', 'ぬきたい',
  'どうてい', '童貞', 'しょじょ', '処女', 'れいぷ', 'レイプ', 'ちかん', '痴漢',
  'うんこ', 'うんち', 'ちんぽ', 'ぺにす', 'ばいぶ',
  // --- 差別・ヘイト ---
  'ちょん', '在日', '部落', 'にがー',
  // --- English ---
  'fuck', 'shit', 'bitch', 'dick', 'cock', 'pussy', 'cunt', 'asshole',
  'nigger', 'nigga', 'faggot', 'slut', 'whore', 'rape', 'sex', 'penis', 'vagina',
  'kill yourself', 'kys',
];

export interface NameCheck {
  ok: boolean;
  /** トリム済みの名前（長さ上限適用）。 */
  name: string;
  /** NG の理由（日本語・サーバ通知用）。 */
  reason?: string;
  /** 言語非依存の理由コード（クライアントの i18n 用）。 */
  code?: 'empty' | 'banned';
}

/** 判定用に正規化（小文字化・空白/記号除去・全角英数の簡易吸収）。 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_\-.,!?！？。、・~〜＊*]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

export function validateNickname(raw: string): NameCheck {
  const name = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
  if (!name) return { ok: false, name: '', reason: 'ニックネームを入力してください', code: 'empty' };
  const norm = normalize(name);
  if (BANNED_WORDS.some((w) => norm.includes(normalize(w)))) {
    return { ok: false, name, reason: '使用できない語が含まれています', code: 'banned' };
  }
  return { ok: true, name };
}

/** 検証を通せば name、ダメなら fallback を返す（サーバの安全側既定用）。 */
export function safeName(raw: string, fallback = 'プレイヤー'): string {
  const v = validateNickname(raw);
  return v.ok ? v.name : fallback;
}
