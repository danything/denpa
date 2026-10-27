import { describe, expect, test } from "bun:test";

import {
  CATCH_UP,
  CEILING,
  cover,
  Extreme,
  FLOOR,
  GAP_MOST,
  GAP_WINDOW,
  JUMP,
  nextTarget,
  pacing,
  SETTLED,
  SLOW_DOWN,
  speedLabel,
  STEADY,
  steer,
  stepSpeed,
} from "./pacing";

/** 宅内で落ち着いている状態 */
const at = (over: Partial<Parameters<typeof pacing>[0]>) =>
  pacing({
    start: 100,
    end: 100 + FLOOR,
    at: 100,
    playing: true,
    target: FLOOR,
    chasing: false,
    speed: 1,
    ...over,
  });

/**
 * **ここが「かくつき」の分かれ目。** 届いた端で再生すると、1コマ遅れるたびに
 * 止まる。少し貯めてから出し、離れたら速めて詰める。
 */
describe("再生位置の決め方", () => {
  test("範囲の外にいたら、持っている先頭へ移る", () => {
    // -copyts で放送の時刻をそのまま持っているので、0 秒から始まらない
    expect(at({ start: 50_000, end: 50_002, at: 0, playing: false })).toEqual({
      seek: 50_000,
      play: false,
      rate: 1,
      caught: false,
    });
  });

  test("貯まるまでは始めない", () => {
    expect(at({ end: 100 + FLOOR / 2, playing: false }).play).toBe(false);
  });

  test("貯まったら始める", () => {
    const after = at({ playing: false });
    expect(after.play).toBe(true);
    expect(after.seek).toBeNull();
  });

  /*
   * **飛ぶのは大きく離れたときだけ。** 飛ぶと音が切れるので、常用すると
   * それ自体が「かくつき」になる
   */
  test("少し離れたら、飛ばずに速めて詰める", () => {
    const late = at({ end: 100 + FLOOR * 2 });
    expect(late.seek).toBeNull();
    expect(late.rate).toBeGreaterThan(1);
  });

  test("大きく離れたら飛ぶ", () => {
    const far = at({ end: 100 + FLOOR + JUMP + 5 });
    expect(far.seek).toBe(100 + FLOOR + JUMP + 5 - FLOOR);
    expect(far.rate).toBe(1);
  });

  test("追いついたら速さを戻す", () => {
    expect(at({}).rate).toBe(1);
  });

  /*
   * **狙いの近くに居着かせる。** 幅を広く採っていた頃は、実機で 0.4 秒を
   * 狙って 0.70 秒に居着いていた (始めた直後は必ず狙いより溜まるので、
   * 放っておくと下りてこない)
   */
  test("狙いの2倍まで溜まったら詰めにかかる", () => {
    expect(at({ end: 100 + FLOOR * 2 }).rate).toBeGreaterThan(1);
  });

  /*
   * **戻す境目と速める境目を離してある。** 同じ値だと、そのあたりで
   * 速める・戻すを往復して、かえって見づらくなる
   */
  test("境目の間では速さをいじらない", () => {
    const between = at({ end: 100 + FLOOR * 1.3 });
    expect(between.rate).toBeNull();
    expect(between.seek).toBeNull();
  });

  /*
   * **貯める量が増えても、飛ぶ境目はそのぶん先へずれる。** ずれないと、
   * 宅外向けに大きく貯めた状態が「離れすぎ」と見なされて飛び続ける
   */
  test("たくさん貯めているときに、それを離れすぎとは見ない", () => {
    const generous = at({ target: 4, end: 100 + 4 });
    expect(generous.seek).toBeNull();
    expect(generous.rate).toBe(1);
  });
});

/**
 * 追っかけ再生。**わざと遅れて見ている状態。**
 *
 * ライブと追っかけでは見ているものが違う。ライブは「放送の今」を追うので
 * 大きく離れたら飛ぶのが正しいが、追っかけで飛ぶと**見ようとしていた場面が
 * 飛ぶ**。分けていなかった頃は、止めて再開すると勝手に放送の今へ飛んでいた —
 * 「止めた所から見られる」と謳っておきながら、8秒より長く止めると戻れなかった。
 */
describe("追っかけ再生", () => {
  /** 5分遅れて見ている状態 */
  const chase = (over: Partial<Parameters<typeof pacing>[0]> = {}) =>
    at({ end: 100 + 300, chasing: true, speed: 1.5, ...over });

  test("どれだけ離れていても飛ばない", () => {
    expect(chase().seek).toBeNull();
  });

  /** ライブなら飛んでいた距離で、飛ばないことを確かめる */
  test("ライブなら飛ぶ距離でも、追っかけなら飛ばない", () => {
    const far = { end: 100 + FLOOR + JUMP + 5 };
    expect(at({ ...far, chasing: false }).seek).not.toBeNull();
    expect(at({ ...far, chasing: true, speed: 1 }).seek).toBeNull();
  });

  test("選ばれた速さで進む", () => {
    expect(chase({ speed: 2 }).rate).toBe(2);
    expect(chase({ speed: 1 }).rate).toBe(1);
  });

  /*
   * **追いついたら自分でライブに戻る。** 戻さずに選ばれた速さのまま進むと
   * 放送を追い越し、溜まりを使い切って止まる
   */
  test("追いついたら、速さを戻してライブへ返す", () => {
    const caught = chase({ end: 100 + FLOOR });
    expect(caught.caught).toBe(true);
    expect(caught.rate).toBe(1);
  });

  test("追いつくまでは返さない", () => {
    expect(chase().caught).toBe(false);
  });

  /** 貯める量が増えていれば、追いついたと見なす境目もそのぶん先へ */
  test("たくさん貯めているときは、その手前で追いついたと見る", () => {
    expect(chase({ target: 4, end: 100 + 4 }).caught).toBe(true);
    expect(chase({ target: 4, end: 100 + 20 }).caught).toBe(false);
  });
});

/**
 * **宅内と宅外で必要な量が桁違いに違う。** どちらから見ているかは分からないので、
 * 実際に止まったかどうかで決める。
 */
describe("貯める量の決め直し", () => {
  /** 覚えていない状態。**まだ一度も止まっていない** */
  const fresh = (target: number) => ({ target, floor: FLOOR });
  /** 落ち着いている時間。下限を下げ直す条件には届かない長さ */
  const CALM = SETTLED;

  test("詰まったら伸ばす", () => {
    expect(nextTarget(fresh(FLOOR), true, 0, 0).target).toBeGreaterThan(FLOOR);
  });

  test("無事が続いたら縮める", () => {
    expect(nextTarget(fresh(2), false, CALM, 0).target).toBeLessThan(2);
  });

  test("無事でも、すぐには縮めない", () => {
    expect(nextTarget(fresh(2), false, CALM - 1, 0).target).toBe(2);
  });

  /** **伸ばすほうを大きく採る。** 縮めて止まると「直っていない」としか映らない */
  test("伸ばす量のほうが、縮める量より大きい", () => {
    const grown = nextTarget(fresh(1), true, 0, 0).target - 1;
    const shrunk = 1 - nextTarget(fresh(1), false, CALM, 0).target;
    expect(grown).toBeGreaterThan(shrunk);
  });

  test("下限より下げず、上限より上げない", () => {
    expect(nextTarget(fresh(FLOOR), false, CALM * 10, 0).target).toBe(FLOOR);
    expect(
      nextTarget({ target: CEILING, floor: CEILING }, true, 0, 0).target,
    ).toBe(CEILING);
  });

  /**
   * **膨らんだぶんほど速く戻す。**
   *
   * 決め打ちで 0.15 ずつ戻していた頃は、一度増えた遅れが減っていかないように
   * 見えた (実機)。1.4 秒から 0.2 秒まで 8回 = 40秒かかり、その間にもう一度
   * 止まれば振り出しに戻る — 止まりがちな経路では、事実上ずっと増えっぱなし
   */
  test("大きく膨らんでいるときほど、1回で大きく戻る", () => {
    const 大きい = 3 - nextTarget(fresh(3), false, CALM, 0).target;
    const 小さい = 0.5 - nextTarget(fresh(0.5), false, CALM, 0).target;
    expect(大きい).toBeGreaterThan(小さい);
  });

  /** 割合だけだと、小さいところで止まってしまう */
  test("小さくても、必ずいくらかは戻る", () => {
    expect(nextTarget(fresh(0.3), false, CALM, 0).target).toBeLessThanOrEqual(
      0.2,
    );
  });
});

/**
 * **戻る先を覚える。**
 *
 * いつも `FLOOR` まで戻していた頃は、**同じ高さで止まり続けた** — 手元の
 * ブラウザ (入口込み・H.264) で8分測ると、0.4秒まで縮む→詰まる→3.1秒に
 * 跳ねる→詰めて0.4秒、をちょうど60秒ごとに繰り返して10回。縮め方をいくら
 * 直しても、**戻る先が「そこでは止まる」と分かっている高さ**なら意味がない
 */
describe("止まった高さを覚える", () => {
  /** 止まるまで縮め、止まったら伸ばす、を繰り返す */
  const cycle = (rounds: number) => {
    let now = { target: FLOOR, floor: FLOOR };
    for (let i = 0; i < rounds; i++) {
      now = nextTarget(now, true, 0, 0);
      // 落ち着いたので縮めにかかる。下限まで下りたら止まる
      for (let k = 0; k < 20; k++) now = nextTarget(now, false, SETTLED, 0);
    }
    return now;
  };

  test("止まった高さより下へは戻さない", () => {
    const after = nextTarget({ target: 1, floor: FLOOR }, true, 0, 0);
    expect(after.floor).toBeGreaterThan(1);
    // いくら無事が続いても、そこから下へは行かない
    let settled = after;
    for (let i = 0; i < 20; i++)
      settled = nextTarget(settled, false, SETTLED, 0);
    expect(settled.target).toBe(after.floor);
  });

  /** **同じところで止まり続けない。** 止まるたびに戻る先が上がる */
  test("止まるたびに、落ち着く高さが上がる", () => {
    expect(cycle(2).target).toBeGreaterThan(cycle(1).target);
    expect(cycle(3).target).toBeGreaterThan(cycle(2).target);
  });

  /** 荒れた経路でも、無限には伸びない */
  test("上限は超えない", () => {
    const far = cycle(40);
    expect(far.target).toBeLessThanOrEqual(CEILING);
    expect(far.floor).toBeLessThanOrEqual(CEILING);
  });

  /**
   * **覚えたままにしない。** 経路は変わる (宅外から宅内へ帰る)。
   * 長く無事なら下限そのものを下げて試し直す
   */
  test("長く無事なら、下限そのものが下がる", () => {
    const held = { target: 1.5, floor: 1.5 };
    expect(nextTarget(held, false, SETTLED, SETTLED).floor).toBe(1.5);
    expect(nextTarget(held, false, 1800, 1800).floor).toBeLessThan(1.5);
  });

  test("下げ直しても、下限より下へは行かない", () => {
    let now = { target: FLOOR, floor: FLOOR };
    for (let i = 0; i < 50; i++) now = nextTarget(now, false, 1800, 1800);
    expect(now.floor).toBe(FLOOR);
    expect(now.target).toBe(FLOOR);
  });
});

/**
 * **下限は起動時間そのもの。**
 *
 * 再生を始める条件は「貯まった尺 ≧ 貯める量」で、電波は実時間で届くのだから、
 * 0.4 秒貯めるには 0.4 秒かかる。開いてから映像が出るまでの内訳のうち、
 * **こちらの都合で動かせるのはここだけ** (電波のロックも ffmpeg の立ち上がりも
 * 動かせない)。
 */
describe("貯める量の下限", () => {
  /** サーバは 0.05 秒ずつ塊を出す (`server/live.ts` の -frag_duration) */
  const FRAGMENT = 0.05;

  test("塊いくつかぶんに収める", () => {
    expect(FLOOR).toBeLessThanOrEqual(0.25);
    // 1つ2つでは、届き方が少し揺れただけで足りなくなる
    expect(FLOOR).toBeGreaterThanOrEqual(FRAGMENT * 3);
  });

  /*
   * **小さすぎても壊れない。** 足りずに止まったら増える。荒れる経路
   * (宅外) では自分で伸びていくので、下限は宅内に合わせてよい
   */
  test("足りなければ、そこから伸びる", () => {
    let now = { target: FLOOR, floor: FLOOR };
    for (let i = 0; i < 3; i++) now = nextTarget(now, true, 0, 0);
    expect(now.target).toBeGreaterThan(1);
    expect(now.target).toBeLessThanOrEqual(CEILING);
  });

  /**
   * 伸びたぶんは、無事が続けば下限まで戻る。**下限そのものを下げ直すだけの
   * 時間が要る** — 一度止まった高さは覚えている (`PROBE`)
   */
  test("無事が続けば下限まで戻る", () => {
    let now = nextTarget({ target: FLOOR, floor: FLOOR }, true, 0, 0);
    for (let i = 0; i < 200; i++) now = nextTarget(now, false, 1800, 1800);
    expect(now.target).toBe(FLOOR);
  });
});

/**
 * **届く間隔を覆う** (#1210)。止まるたびに 0.3 秒ずつしか上がらなかった頃は、15〜30秒おきに
 * 0.7 秒空く経路で 2分半に8回止まった。**ただし低い遅延が先** — 上げるのは証拠のぶんだけ
 */
describe("届く間隔を覆う", () => {
  /** 宅内の塊の間隔 (`server/live.ts` の -frag_duration) */
  const SMOOTH = 0.05;
  const fresh = (target: number) => ({ target, floor: FLOOR });

  test("宅内の間隔なら下限のまま。遅延を足さない", () => {
    expect(cover(SMOOTH)).toBe(FLOOR);
    expect(cover(0)).toBe(FLOOR);
    expect(cover(Number.NaN)).toBe(FLOOR);
    expect(nextTarget(fresh(FLOOR), false, SETTLED, 0, SMOOTH)).toEqual({
      target: FLOOR,
      floor: FLOOR,
    });
  });

  test("空いた間隔の 1.2 倍に 0.1 秒足すだけ貯める", () => {
    expect(cover(0.7)).toBeCloseTo(0.94);
    expect(cover(0.5)).toBeCloseTo(0.7);
  });

  test("長すぎる空きは途絶えと見て、覆いにいかない", () => {
    expect(cover(30)).toBeCloseTo(cover(GAP_MOST));
    expect(cover(30)).toBeLessThan(CEILING);
  });

  test("止まる前から、空いた間隔を覆うところまで上げる", () => {
    const next = nextTarget(fresh(FLOOR), false, 0, 0, 0.7);
    expect(next.target).toBeCloseTo(cover(0.7));
    // 覚える下限は動かさない。間隔は窓 (`GAP_WINDOW`) の中だけで効く
    expect(next.floor).toBe(FLOOR);
  });

  test("1回止まれば足りる。詰まらせた空きを覆う高さへ一度に上げる", () => {
    const after = nextTarget(fresh(0.3), true, 0, 0, 0.7);
    expect(after.target).toBeGreaterThanOrEqual(cover(0.7));
    // 空きが続くあいだは、いくら無事でもそこから縮めない (また止まる)
    let now = after;
    for (let i = 0; i < 40; i++)
      now = nextTarget(now, false, SETTLED + i * 15, 0, 0.7);
    expect(now.target).toBeCloseTo(cover(0.7));
  });

  test("空きで説明がつく詰まりは、覚える下限を上げない (1回の空きでずっと遅れない)", () => {
    expect(nextTarget(fresh(0.3), true, 0, 0, 0.7).floor).toBe(FLOOR);
  });

  test("空きで説明がつかない詰まりは、今までどおり止まった高さのすぐ上を覚える", () => {
    const after = nextTarget(fresh(1), true, 0, 0, SMOOTH);
    expect(after.floor).toBeGreaterThan(1);
    expect(after.target).toBeGreaterThan(1);
  });

  test("空きが来なくなれば、数分で下限まで戻る", () => {
    let now = nextTarget(fresh(0.3), true, 0, 0, 0.7);
    // 窓を過ぎた (間隔は宅内に戻った)。15秒ごとに決め直す
    let settles = 0;
    for (; now.target > FLOOR && settles < 100; settles++) {
      now = nextTarget(now, false, GAP_WINDOW + settles * 15, 0, SMOOTH);
    }
    expect(now.target).toBe(FLOOR);
    // 縮めるのは 15 秒に1回。窓 (3分) と合わせても数分で戻る
    expect(settles * 15).toBeLessThanOrEqual(120);
  });

  test("覚えた下限はゆっくり下げる。ただし空きがまだ来ているうちは、それを覆う高さより下げない", () => {
    let now = { target: 1.5, floor: 1.5 };
    for (let i = 0; i < 20; i++) now = nextTarget(now, false, 1800, 1800, 0.7);
    expect(now.floor).toBeCloseTo(cover(0.7));
    expect(now.target).toBeCloseTo(cover(0.7));
    // 空きが止めば、下限まで下げ直す
    for (let i = 0; i < 20; i++)
      now = nextTarget(now, false, 1800, 1800, SMOOTH);
    expect(now.floor).toBe(FLOOR);
  });

  test("下げ直しは1回に少しずつ", () => {
    expect(
      nextTarget({ target: 1.5, floor: 1.5 }, false, 1800, 1800, 0).floor,
    ).toBeCloseTo(1.2);
  });
});

/**
 * **届いた直後の貯まりで決めない** (#1210)。届いた直後はいちばん多く、そこで速めると
 * 次の塊が遅れたときに使い切る。見るのは次が届く直前の低いところ (`low`)
 */
describe("貯まりの低いところで決める", () => {
  test("届いた直後に多く見えても、低いところが狙いの近くなら速めない", () => {
    const peak = at({ end: 100 + FLOOR * 2, low: FLOOR * 1.2 });
    expect(peak.rate).toBeNull();
    // 低いところを知らなければ、今までどおり速めて詰める
    expect(at({ end: 100 + FLOOR * 2 }).rate).toBe(CATCH_UP);
  });

  test("低いところが狙いを割ったら、少し遅くする", () => {
    expect(at({ end: 100 + FLOOR * 1.4, low: FLOOR * 0.5 }).rate).toBe(
      SLOW_DOWN,
    );
  });

  /*
   * **滑らかに届いていれば、今までと同じ高さで決める** (遅延を足さない)。届く直前の低いところは
   * 塊1つぶん (0.05秒) 低いので、届く間隔を足して戻す
   */
  test("届く間隔を足すので、滑らかに届けば遅くしない", () => {
    const smooth = { end: 100 + FLOOR, low: FLOOR - 0.05 };
    expect(at({ ...smooth, dip: 0.05 }).rate).toBe(1);
    expect(at(smooth).rate).toBe(SLOW_DOWN);
  });

  /** 束で届く経路。束の間隔を貯める量 (`cover`) と低いところの両方で数えると、二重に貯めて遅れる */
  test("束で届いても、束の間隔ぶんを二重に貯めない", () => {
    const target = cover(0.5);
    // 束の直前は狙いから束の間隔ぶん下がっている。それで足りている
    expect(
      at({ target, end: 100 + target, low: target - 0.5, dip: 0.5 }).rate,
    ).toBe(1);
  });

  test("追っかけは選んだ速さのまま。遅くしない", () => {
    expect(at({ end: 100 + 300, chasing: true, speed: 1.5, low: 0 }).rate).toBe(
      1.5,
    );
  });
});

/**
 * **速さの境目。** dash.js などのライブと同じく、足りなければ少し遅く、多すぎれば少し速く。
 * 遅くするのは足りないときだけで、戻ったらすぐやめる (遅延を足すのは要るあいだだけ)
 */
describe("steer", () => {
  const t = 0.5;
  test("多すぎれば速める", () => {
    expect(steer(t * 1.6, t)).toBe(CATCH_UP);
  });
  test("狙いを割ったら遅くする。割っていなければ遅くしない", () => {
    expect(steer(t * 0.9, t)).toBe(SLOW_DOWN);
    expect(steer(t, t)).toBe(1);
  });
  test("遅くしている間は、狙いに戻ったらすぐ等速に戻す", () => {
    expect(steer(t * 0.99, t, SLOW_DOWN)).toBe(SLOW_DOWN);
    expect(steer(t, t, SLOW_DOWN)).toBe(1);
    expect(steer(t * 1.3, t, SLOW_DOWN)).toBe(1);
  });
  test("速めている間は、狙いの少し上まで下りたら等速に戻す", () => {
    expect(steer(t * 1.3, t, CATCH_UP)).toBeNull();
    expect(steer(t * 1.05, t, CATCH_UP)).toBe(1);
  });
  test("境目の間で等速なら、そのまま", () => {
    expect(steer(t * 1.3, t, 1)).toBeNull();
  });
});

/**
 * **Safari は速さを変えるたびにつまずく** (#1210)。遅くせず、余裕があるときだけ速め、戻すのも余裕のあるうちに
 */
describe("steer (STEADY)", () => {
  const t = 0.5;
  test("狙いを割っても遅くしない", () => {
    expect(steer(t * 0.5, t, 1, STEADY)).toBe(1);
    expect(steer(0, t, 1, STEADY)).toBe(1);
  });
  test("狙いより 1 秒多く貯まるまで速めない", () => {
    expect(steer(t + 0.99, t, 1, STEADY)).toBeNull();
    expect(steer(t + 1.01, t, 1, STEADY)).toBe(CATCH_UP);
  });
  test("速めている間は、狙いの 1.3 倍まで下りたら等速に戻す", () => {
    expect(steer(t * 1.4, t, CATCH_UP, STEADY)).toBeNull();
    expect(steer(t * 1.3, t, CATCH_UP, STEADY)).toBe(1);
  });
  test("pacing にも効く", () => {
    expect(
      at({ end: 100 + FLOOR * 1.4, low: FLOOR * 0.5, steering: STEADY }).rate,
    ).toBe(1);
  });
});

describe("Extreme", () => {
  test("窓の中のいちばん大きい値。窓を出たら忘れる", () => {
    const most = new Extreme(10, true);
    expect(most.peek(0)).toBeNull();
    most.push(0, 0.7);
    most.push(1, 0.05);
    most.push(2, 0.3);
    expect(most.peek(5)).toBe(0.7);
    expect(most.peek(10.5)).toBe(0.3);
    expect(most.peek(13)).toBeNull();
  });
  test("小さいほうも覚えられる", () => {
    const least = new Extreme(2, false);
    least.push(0, 0.4);
    least.push(0.5, 0.1);
    least.push(1, 0.3);
    expect(least.peek(1)).toBe(0.1);
    expect(least.peek(2.8)).toBe(0.3);
    least.clear();
    expect(least.peek(2.8)).toBeNull();
  });
  test("塊が毎秒20個で10分来ても、窓の中のいちばんを返す", () => {
    const most = new Extreme(GAP_WINDOW, true);
    // 間隔がだんだん縮む最悪の並び以外は、負けた値を捨てるので短いまま
    for (let i = 0; i < 20 * 600; i++)
      most.push(i / 20, 0.05 + (i % 7) * 0.001);
    expect(most.peek(600)).toBeCloseTo(0.056);
  });
});

describe("stepSpeed", () => {
  test("1段ずつ動き、端では止まる", () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1.5, -1)).toBe(1.25);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(1, -1)).toBe(1);
  });
  test("並びに無い速さからは等速の位置から数える", () => {
    expect(stepSpeed(3, 1)).toBe(1.25);
  });
});

describe("speedLabel", () => {
  test("等速は名前だけ。ボタンはアイコンだけなので、数字は読まない", () => {
    expect(speedLabel("再生の速さ", 1)).toBe("再生の速さ");
  });
  test("速めているときは速さも読む (ボタンは数字だけ)", () => {
    expect(speedLabel("再生の速さ", 1.25)).toBe("再生の速さ 1.25倍");
    expect(speedLabel("追っかけの速さ", 2)).toBe("追っかけの速さ 2倍");
  });
});
