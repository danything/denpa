import { describe, expect, test } from "bun:test";

import { DRY, LAST_WAIT, LEAD, Playout, SLACK, SLACK_FOR } from "./playout";

/** AAC の1コマ (1024 標本 @48kHz) = 1920 (90kHz) = 21.3ms */
const D = 1920;
const chunk = (n: number) => ({ pts: 90_000 + n * D, duration: D, n });

describe("Playout", () => {
  test("貯まるまで鳴らさない。貯まったら放送の今から target 手前で始める", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.2);
    // 0.2秒 = 9.4コマ。9コマでは足りない
    for (let n = 0; n < 9; n++) expect(playout.push(chunk(n), 0)).toBeNull();
    expect(playout.tick(0).kind).toBe("none");
    expect(playout.position(0)).toBeNull();

    for (let n = 9; n < 20; n++) playout.push(chunk(n), 0);
    const started = playout.tick(10);
    expect(started.kind).toBe("start");
    if (started.kind !== "start") return;
    const newest = 90_000 + 20 * D;
    // 鳴らし始めは新しい端の 0.2秒手前。そこより古いコマは予約しない
    expect(playout.position(10 + LEAD)).toBeCloseTo(newest - 0.2 * 90_000, 5);
    expect(
      started.schedule.every((s) => s.chunk.pts + D > newest - 0.2 * 90_000),
    ).toBe(true);
    // 途中から鳴らすコマは頭を飛ばす
    expect(started.schedule[0]!.offset).toBeGreaterThan(0);
  });

  test("鳴らしている間に届いたものは、時刻どおりに並べる", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.1);
    for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
    const started = playout.tick(0);
    if (started.kind !== "start") throw new Error("始まらない");
    const next = playout.push(chunk(10), 0.01);
    const last = started.schedule.at(-1)!;
    // 前のコマの終わりにぴったり続く (隙間も重なりも無い)
    expect(next?.when).toBeCloseTo(last.when + D / 90_000, 9);
  });

  test("使い切ったら止まって、貯め直す", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.1);
    for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
    playout.tick(0);
    // 何も届かないまま 0.3 秒たつ
    const stalled = playout.tick(0.3);
    expect(stalled.kind).toBe("stall");
    expect(playout.playing).toBe(false);
    expect(DRY).toBeLessThan(0.1);
  });

  test("溜まりすぎが続いたら放送の今へ飛ぶ。一瞬では飛ばない", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.1);
    for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
    playout.tick(0);
    // 一度に 5 秒ぶん届く (裏から戻ったタブ)
    for (let n = 10; n < 260; n++) playout.push(chunk(n), 0.01);
    expect(playout.tick(0.02).kind).toBe("none");
    const jumped = playout.tick(0.02 + SLACK_FOR);
    expect(jumped.kind).toBe("jump");
    expect(playout.lead(0.02 + SLACK_FOR + LEAD)).toBeLessThan(0.1 + SLACK);
  });

  test("止めている間は鳴らし始めず、溜め込みもしない", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.1);
    playout.hold();
    for (let n = 0; n < 500; n++) playout.push(chunk(n), 0);
    expect(playout.tick(1).kind).toBe("none");
    expect(playout.lead(1)).toBeLessThanOrEqual(0.1 + SLACK + 0.03);
    playout.resume();
    expect(playout.tick(1).kind).toBe("start");
  });

  test("時計を替えても、鳴っている位置は動かさない", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.1);
    for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
    playout.tick(0);
    const here = playout.position(0.06) as number;
    playout.rebase(here, 500);
    expect(playout.position(500 + LEAD)).toBeCloseTo(here, 5);
  });
});

describe("Playout (追っかけ: 放送の今を追わない)", () => {
  test("溜まりすぎても飛ばない", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.1);
    playout.follow = true;
    for (let n = 0; n < 10; n++) playout.push(chunk(n), 0);
    playout.tick(0);
    // 倍速で送り込まれて 5 秒ぶん溜まる
    for (let n = 10; n < 260; n++) playout.push(chunk(n), 0.01);
    expect(playout.tick(0.02).kind).toBe("none");
    expect(playout.tick(0.02 + SLACK_FOR).kind).toBe("none");
    expect(playout.lead(0.02 + SLACK_FOR)).toBeGreaterThan(0.1 + SLACK);
  });

  test("止めて再開は、止めた所から。止めている間に届いたぶんも捨てない", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.1);
    playout.follow = true;
    for (let n = 0; n < 100; n++) playout.push(chunk(n), 0);
    const started = playout.tick(0);
    if (started.kind !== "start") throw new Error("始まらない");
    // 追っかけは頭 (いちばん古いもの) から鳴らす
    expect(playout.position(LEAD)).toBeCloseTo(90_000, 5);
    const here = playout.position(0.5) as number;
    playout.hold(0.5);
    for (let n = 100; n < 600; n++) playout.push(chunk(n), 1);
    expect(playout.tick(5).kind).toBe("none");
    playout.resume();
    const resumed = playout.tick(5);
    expect(resumed.kind).toBe("start");
    expect(playout.position(5 + LEAD)).toBeCloseTo(here, 5);
    expect(playout.lead(5 + LEAD)).toBeGreaterThan(10);
  });
});

describe("Playout (録画: 飛ぶ先と終わり)", () => {
  test("飛ぶ先 (from) から鳴らす。手前のぶんは貯めた量に数えない", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.1);
    playout.follow = true;
    // サーバは飛び先の少し手前から流してくる。飛び先は 50 コマ目
    const from = chunk(50).pts;
    playout.reset(from);
    for (let n = 0; n < 52; n++) playout.push(chunk(n), 0);
    // 飛び先から先は 2 コマ (0.04 秒) しかない。手前の 50 コマを数えて鳴らし始めない
    expect(playout.lead(0)).toBeCloseTo((2 * D) / 90_000, 5);
    expect(playout.tick(0).kind).toBe("none");
    for (let n = 52; n < 60; n++) playout.push(chunk(n), 0);
    const started = playout.tick(0);
    expect(started.kind).toBe("start");
    if (started.kind !== "start") return;
    expect(playout.position(LEAD)).toBeCloseTo(from, 5);
    expect(started.schedule.every((s) => s.chunk.n >= 50)).toBe(true);
  });

  test("届いてから飛ぶ先を決めても同じ (aim)", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(0.1);
    playout.follow = true;
    playout.reset();
    playout.aim(chunk(20).pts);
    for (let n = 0; n < 40; n++) playout.push(chunk(n), 0);
    expect(playout.tick(0).kind).toBe("start");
    expect(playout.position(LEAD)).toBeCloseTo(chunk(20).pts, 5);
  });

  test("終わりまで届いたら、貯めが足りなくても残りを鳴らし、鳴らしきったら end", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(1);
    playout.follow = true;
    // 尻の 3 コマ (0.06 秒) だけ。target (1 秒) には届かない
    for (let n = 0; n < 3; n++) playout.push(chunk(n), 0);
    expect(playout.tick(0).kind).toBe("none");
    playout.finish();
    expect(playout.tick(0).kind).toBe("start");
    // 使い切っても貯め直さない (stall ではなく end)
    expect(playout.tick(1).kind).toBe("end");
    expect(playout.playing).toBe(false);
    expect(playout.tick(2).kind).toBe("none");
  });

  test("飛び直すと、終わりの印も消える", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(1);
    playout.follow = true;
    playout.finish();
    playout.reset(chunk(0).pts);
    for (let n = 0; n < 3; n++) playout.push(chunk(n), 0);
    expect(playout.tick(0).kind).toBe("none");
  });
});

describe("Playout (録画: 何も来ないまま終わった)", () => {
  test("飛んだ先が尻の先で何も届かなければ、少し待ってから end", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(1);
    playout.follow = true;
    playout.reset(chunk(0).pts);
    playout.finish();
    // 渡したぶんの音がまだ戻ってきていないかもしれないので、すぐには終わりにしない
    expect(playout.tick(10).kind).toBe("none");
    expect(playout.tick(10 + LAST_WAIT / 2).kind).toBe("none");
    expect(playout.tick(10 + LAST_WAIT).kind).toBe("end");
    expect(playout.tick(20).kind).toBe("none");
  });

  test("止めている間は終わりにしない", () => {
    const playout = new Playout<ReturnType<typeof chunk>>(1);
    playout.follow = true;
    playout.hold();
    playout.finish();
    expect(playout.tick(0).kind).toBe("none");
    expect(playout.tick(10).kind).toBe("none");
  });
});
