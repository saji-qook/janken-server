import { describe, it, expect } from 'vitest';
import {
  createMatch,
  assignAbilities,
  applyAbility,
  commitCard,
  resolveTurn,
  advanceTurn,
  nextRound,
  createDraftMatch,
  chooseDraft,
  finalResult,
  autoCommit,
  forcedCard,
  GameError,
  projectView,
  judge,
  toPerspective,
  seededRng,
  decideAbility,
  decideCard,
  validateNickname,
  type MatchState,
  type AbilityId,
} from '../index.js';

function newMatch(abilities: [AbilityId, AbilityId]): MatchState {
  return createMatch({
    players: [
      { id: 'p0', name: 'A' },
      { id: 'p1', name: 'B' },
    ],
    abilities,
    rng: seededRng(1),
  });
}

describe('rules', () => {
  it('じゃんけん判定', () => {
    expect(judge('rock', 'scissors')).toBe(0);
    expect(judge('scissors', 'rock')).toBe(1);
    expect(judge('paper', 'paper')).toBe('draw');
    expect(judge('paper', 'rock')).toBe(0);
  });
  it('視点変換', () => {
    expect(toPerspective(0, 0)).toBe('win');
    expect(toPerspective(0, 1)).toBe('lose');
    expect(toPerspective('draw', 1)).toBe('draw');
  });
});

describe('ability assignment', () => {
  it('必ず別々の能力を配る', () => {
    const rng = seededRng(42);
    for (let i = 0; i < 200; i++) {
      const [a, b] = assignAbilities(rng);
      expect(a).not.toBe(b);
    }
  });
});

describe('basic flow', () => {
  it('1ラウンド3ターンを通して採点できる（引き分けラウンドは round-over）', () => {
    const s = newMatch(['designate', 'transform']);
    // T1
    commitCard(s, 0, 'rock');
    commitCard(s, 1, 'scissors');
    resolveTurn(s);
    expect(s.records[0]!.winner).toBe(0);
    advanceTurn(s);
    // T2
    commitCard(s, 0, 'scissors');
    commitCard(s, 1, 'rock');
    resolveTurn(s);
    expect(s.records[1]!.winner).toBe(1);
    advanceTurn(s);
    // T3 強制
    expect(forcedCard(s, 0)).toBe('paper');
    expect(forcedCard(s, 1)).toBe('paper');
    commitCard(s, 0, 'paper');
    commitCard(s, 1, 'paper');
    resolveTurn(s);
    advanceTurn(s);
    // 引き分けラウンド → マッチ未決着で round-over、勝敗数は据え置き
    expect(s.phase).toBe('round-over');
    expect(s.roundWins).toEqual([0, 0]);
    const fr = finalResult(s);
    expect(fr.scores).toEqual([1, 1]);
    expect(fr.winner).toBe('draw');
  });

  it('autoCommit は未選択でも止めずに確定する', () => {
    const s = newMatch(['designate', 'transform']);
    autoCommit(s, 0, seededRng(3));
    autoCommit(s, 1, seededRng(7));
    expect(s.players[0]!.committed).toBe(true);
    expect(s.players[1]!.committed).toBe(true);
  });
});

describe('マッチ (Best of 3)', () => {
  // p0 が全ターン勝つラウンドを進める（能力は未使用なので結果に影響しない）。
  function playRoundP0Wins(s: MatchState) {
    commitCard(s, 0, 'rock');
    commitCard(s, 1, 'scissors'); // rock>scissors
    resolveTurn(s);
    advanceTurn(s);
    commitCard(s, 0, 'scissors');
    commitCard(s, 1, 'paper'); // scissors>paper
    resolveTurn(s);
    advanceTurn(s);
    commitCard(s, 0, 'paper');
    commitCard(s, 1, 'rock'); // paper>rock
    resolveTurn(s);
    advanceTurn(s);
  }

  it('先に2ラウンド取ったら matchOver', () => {
    const s = newMatch(['designate', 'transform']);
    playRoundP0Wins(s);
    expect(s.phase).toBe('round-over');
    expect(s.roundWins).toEqual([1, 0]);
    expect(s.matchOver).toBe(false);

    nextRound(s, seededRng(2));
    expect(s.round).toBe(2);
    expect(s.players[0]!.hand.length).toBe(3); // 手札リセット
    playRoundP0Wins(s);

    expect(s.phase).toBe('finished');
    expect(s.matchOver).toBe(true);
    expect(s.roundWins).toEqual([2, 0]);
    expect(s.matchWinner).toBe(0);
  });

  it('nextRound で能力が配り直される（両者別々）', () => {
    const s = newMatch(['designate', 'transform']);
    playRoundP0Wins(s);
    nextRound(s, seededRng(99));
    expect(s.players[0]!.ability).not.toBe(s.players[1]!.ability);
    expect(s.players[0]!.abilityUsed).toBe(false);
  });
});

describe('能力ドラフト', () => {
  it('1Gは2択から選び、確定で5能力が配分される', () => {
    const s = createDraftMatch({
      players: [{ id: '0', name: 'A' }, { id: '1', name: 'B' }],
      rng: seededRng(7),
    });
    expect(s.phase).toBe('draft');
    expect(s.draftOffers[0].length).toBe(2);
    expect(s.draftOffers[1].length).toBe(2);
    // 2択は互いに重複しない（disjoint）
    expect(s.draftOffers[0].some((a) => s.draftOffers[1].includes(a))).toBe(false);

    chooseDraft(s, 0, s.draftOffers[0][0]!, seededRng(1));
    expect(s.phase).toBe('draft'); // 片方だけではまだ
    chooseDraft(s, 1, s.draftOffers[1][1]!, seededRng(1));
    expect(s.phase).toBe('select');
    expect(s.round).toBe(1);
    // 3ラウンド分の割当ができ、3Gはミラー（同能力）。
    expect(s.roundAbilities.length).toBe(3);
    expect(s.roundAbilities[2]![0]).toBe(s.roundAbilities[2]![1]);
    // 1Gの能力＝選んだもの
    expect(s.players[0]!.ability).toBe(s.roundAbilities[0]![0]);
    // 5能力すべてが登場する（1G2 + 2G2 + 3G1）
    const used = new Set([...s.roundAbilities[0]!, ...s.roundAbilities[1]!, s.roundAbilities[2]![0]]);
    expect(used.size).toBe(5);
  });

  it('提示外の能力は選べない', () => {
    const s = createDraftMatch({ players: [{ id: '0', name: 'A' }, { id: '1', name: 'B' }], rng: seededRng(3) });
    const notOffered = (['designate', 'transform', 'falsify', 'victory', 'time'] as AbilityId[]).find(
      (a) => !s.draftOffers[0].includes(a),
    )!;
    expect(() => chooseDraft(s, 0, notOffered)).toThrow(GameError);
  });
});

describe('指定 (designate / 新案)', () => {
  it('相手のランダムな1枚を、選んだ出目に書き換える', () => {
    const s = newMatch(['designate', 'transform']);
    // 相手の手札に rock を押し込む → rock が2枚に、1種が欠ける。
    applyAbility(s, 0, { ability: 'designate', value: 'rock' }, seededRng(5));
    const oppHand = s.players[1]!.hand;
    expect(oppHand.length).toBe(3);
    expect(oppHand.filter((c) => c === 'rock').length).toBe(2);
    expect(new Set(oppHand).size).toBe(2); // 被り＋欠け
  });
});

describe('複製 (transform / 新案)', () => {
  it('増やす出目を選ぶと別の1枚がそれに変わる（2枚同じ+1種欠け）', () => {
    const s = newMatch(['transform', 'designate']);
    applyAbility(s, 0, { ability: 'transform', source: 'rock' }, seededRng(1));
    const hand = s.players[0]!.hand;
    expect(hand.filter((c) => c === 'rock').length).toBe(2);
    expect(new Set(hand).size).toBe(2);
    expect(hand.length).toBe(3);
  });
});

describe('偽り (falsify)', () => {
  it('相手の報告だけ偽装され、自分の真の報告は変わらない', () => {
    const s = newMatch(['falsify', 'designate']);
    // p0 が偽り：相手(p1)に「あなたの勝ち」と思わせる
    applyAbility(s, 0, { ability: 'falsify', show: 'win' });
    commitCard(s, 0, 'rock'); // p0 rock
    commitCard(s, 1, 'scissors'); // p1 scissors -> 実際は p0 の勝ち
    resolveTurn(s);
    const rec = s.records[0]!;
    expect(rec.winner).toBe(0);
    // p1 は本当は負けだが「勝ち」と報告される
    expect(rec.reports[1]).toBe('win');
    expect(rec.deceived[1]).toBe(true);
    // p0 は真実
    expect(rec.reports[0]).toBe('win');
    expect(rec.deceived[0]).toBe(false);
  });
});

describe('勝利 (victory / 予言)', () => {
  it('的中ならそのターンは予言者の勝ち、報告は伏せる', () => {
    const s = newMatch(['victory', 'designate']);
    // T1 を普通に消化（引き分け、rock を温存）
    commitCard(s, 0, 'scissors');
    commitCard(s, 1, 'scissors');
    resolveTurn(s);
    advanceTurn(s);
    // T2: p0 が「自分の勝ち」を予言、実際に勝つ手を出す
    applyAbility(s, 0, { ability: 'victory', predict: 'win' });
    commitCard(s, 0, 'paper');
    commitCard(s, 1, 'rock');
    resolveTurn(s);
    const rec = s.records[1]!;
    expect(rec.victory).toEqual({ by: 0, predict: 'win', hit: true });
    expect(rec.winner).toBe(0);
    expect(rec.reports[0]).toBe('prophecy');
  });

  it('外れたらそのターンは引き分け（負けにはならない）', () => {
    const s = newMatch(['victory', 'designate']);
    commitCard(s, 0, 'scissors');
    commitCard(s, 1, 'scissors');
    resolveTurn(s);
    advanceTurn(s);
    // p0 が「勝ち」と予言したが負ける手
    applyAbility(s, 0, { ability: 'victory', predict: 'win' });
    commitCard(s, 0, 'rock');
    commitCard(s, 1, 'paper'); // paper>rock → 実際は p1 の勝ち → 予言外れ
    resolveTurn(s);
    const rec = s.records[1]!;
    expect(rec.victory!.hit).toBe(false);
    expect(rec.winner).toBe('draw'); // 新案: 外れ→引き分け
  });

  it('victory(予言) は1ターン目にも使える', () => {
    const s = newMatch(['victory', 'designate']);
    expect(s.turn).toBe(1);
    applyAbility(s, 0, { ability: 'victory', predict: 'win' });
    expect(s.players[0]!.abilityUsed).toBe(true);
  });
});

describe('時間 (time)', () => {
  it('1ターン目終了時に自動発動し、相手の2ターン目を5秒に縛る', () => {
    const s = newMatch(['time', 'designate']);
    commitCard(s, 0, 'rock');
    commitCard(s, 1, 'rock');
    resolveTurn(s);
    advanceTurn(s);
    expect(s.players[0]!.abilityUsed).toBe(true);
    expect(s.timeRestrictedPlayer).toBe(1);
    const v1 = projectView(s, 1);
    expect(v1.timeLimit).toBe(10);
    const v0 = projectView(s, 0);
    expect(v0.timeLimit).toBe(60);
  });
});

describe('view redaction', () => {
  it('相手の手札中身は見えず、枚数のみ', () => {
    const s = newMatch(['designate', 'transform']);
    const v = projectView(s, 0);
    expect(v.opponent.handCount).toBe(3);
    expect((v.opponent as any).hand).toBeUndefined();
    expect(v.self.hand.length).toBe(3);
  });
  it('能力告知は自分のものだけ名前が見え、相手は伏せる', () => {
    const s = newMatch(['designate', 'transform']);
    applyAbility(s, 0, { ability: 'designate', value: 'rock' }, seededRng(2));
    const mine = projectView(s, 0);
    const theirs = projectView(s, 1);
    expect(mine.notices[0]!.name).toBe('指定');
    expect(theirs.notices[0]!.name).toBeNull();
    expect(theirs.notices[0]!.mine).toBe(false);
  });
  it('ラウンド終了で最終リビールが付く（round-over）', () => {
    const s = newMatch(['designate', 'transform']);
    for (let t = 0; t < 3; t++) {
      autoCommit(s, 0, seededRng(t + 1));
      autoCommit(s, 1, seededRng(t + 11));
      resolveTurn(s);
      advanceTurn(s);
    }
    const v = projectView(s, 0);
    expect(v.phase).toBe('round-over');
    expect(v.final).not.toBeNull();
    expect(v.final!.records.length).toBe(3);
    expect(v.final!.abilities).toEqual(['designate', 'transform']);
    expect(v.match.target).toBe(2);
  });
});

describe('ニックネーム検証', () => {
  it('通常名は通る', () => {
    expect(validateNickname('アオ').ok).toBe(true);
    expect(validateNickname('  Taro  ').name).toBe('Taro');
  });
  it('空はNG', () => {
    expect(validateNickname('').ok).toBe(false);
    expect(validateNickname('   ').ok).toBe(false);
  });
  it('禁止ワードを弾く（記号や全角を挟んでも）', () => {
    expect(validateNickname('死ね').ok).toBe(false);
    expect(validateNickname('f u c k').ok).toBe(false);
    expect(validateNickname('ｓｅｘ').ok).toBe(false);
  });
  it('12文字に丸める', () => {
    expect(validateNickname('あ'.repeat(20)).name.length).toBe(12);
  });
});

describe('CPU', () => {
  it('能力は1試合1回・許可ターンのみ', () => {
    const s = newMatch(['designate', 'victory']);
    // CPU=1 は victory。T1 では出さない
    expect(decideAbility(s, 1, seededRng(1))).toBeNull();
  });
  it('decideCard は手札からのみ返す', () => {
    const s = newMatch(['designate', 'transform']);
    const c = decideCard(s, 1, seededRng(9));
    expect(s.players[1]!.hand).toContain(c);
  });
});
