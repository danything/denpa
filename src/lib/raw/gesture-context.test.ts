import { expect, test } from "bun:test";

import { GestureContext, GESTURES } from "./gesture-context";

/** 押されたときだけ `resume` で動き出す AudioContext (iOS の Safari と同じ) */
class FakeContext {
  state: AudioContextState = "suspended";
  resumed = 0;
  closed = false;
  resume(): Promise<void> {
    this.resumed++;
    this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

function setup(wanted = true) {
  const made: FakeContext[] = [];
  let want = wanted;
  const shared = new GestureContext(
    () => {
      const context = new FakeContext();
      made.push(context);
      return context as unknown as AudioContext;
    },
    () => want,
  );
  const target = new EventTarget();
  shared.listen(target);
  return {
    shared,
    made,
    target,
    press: (type: string = "click") => target.dispatchEvent(new Event(type)),
    want: (next: boolean) => (want = next),
  };
}

test.each(GESTURES)(
  "%s で作って起こしておき、あとで押さずに使っても動いている",
  (type) => {
    const { shared, made, press } = setup();
    press(type);
    expect(made).toHaveLength(1);
    expect(made[0]?.state).toBe("running");
    // MPEG-2 から段を下げて `<video>` に移る (押されていない)
    expect(shared.get()).toBe(made[0] as unknown as AudioContext);
    expect(made).toHaveLength(1);
  },
);

test("押し始め (pointerdown) では作らない (Safari は数えないことがある)", () => {
  const { made, press } = setup();
  press("pointerdown");
  expect(made).toHaveLength(0);
});

test("使う見込みが無ければ押されても作らない", () => {
  const { shared, made, press } = setup(false);
  press();
  expect(made).toHaveLength(0);
  // 使うときには作る (押されていないので止まったまま)
  expect((shared.get() as unknown as FakeContext).state).toBe("suspended");
});

test("作ったあとは見込みによらず、止まっていれば押したときに起こす", () => {
  const { shared, made, press, want } = setup(false);
  shared.get();
  want(false);
  press();
  expect(made[0]?.resumed).toBe(1);
  // 動いている間は起こし直さない
  press();
  expect(made[0]?.resumed).toBe(1);
  // 止められた (iOS の割り込み)
  (made[0] as FakeContext).state = "suspended";
  press("touchend");
  expect(made[0]?.resumed).toBe(2);
});

test("何度 listen しても押した 1 回で起こすのは 1 回", () => {
  const { shared, made, press, target } = setup();
  shared.listen(target);
  shared.listen(target);
  press();
  expect(made[0]?.resumed).toBe(1);
});

test("閉じたら待つのをやめ、listen し直せば作り直す", () => {
  const { shared, made, press, target } = setup();
  press();
  shared.close();
  expect(made[0]?.closed).toBe(true);
  press();
  expect(made).toHaveLength(1);
  shared.listen(target);
  press();
  expect(made).toHaveLength(2);
  expect(made[1]?.state).toBe("running");
});

test("AudioContext を作れなくても押したときに投げない", () => {
  const shared = new GestureContext(
    () => {
      throw new Error("AudioContext が無い");
    },
    () => true,
  );
  const target = new EventTarget();
  shared.listen(target);
  expect(() => target.dispatchEvent(new Event("click"))).not.toThrow();
});
