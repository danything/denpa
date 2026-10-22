import { describe, expect, test } from "bun:test";
import { createRealm } from "./builtins";
import { compileScript } from "./compiler";
import { ScriptSyntaxError } from "./lexer";
import { ABORT, JSArray, JSFunction, Suspend, type Value } from "./values";
import { type RunResult, Vm } from "./vm";

/** 2026-10-12 21:30:00 JST */
const NOW = Date.UTC(2026, 9, 12, 12, 30, 0);

function setup(): Vm {
  const realm = createRealm({ now: () => NOW });
  return new Vm(realm);
}

/** 終わるまで動かす (待ちはすぐに済ませる) */
async function finish(
  vm: Vm,
  first: RunResult = vm.run(Number.POSITIVE_INFINITY),
): Promise<RunResult> {
  let result = first;
  while (result.kind === "suspend") {
    vm.resume(await result.promise);
    result = vm.run(Number.POSITIVE_INFINITY);
  }
  return result;
}

/** スクリプトを動かして、大域の `result` を返す */
async function evaluate(source: string, vm = setup()): Promise<Value> {
  vm.startProgram(compileScript(source, "test"));
  const result = await finish(vm);
  if (result.kind === "error") throw result.error;
  return vm.realm.global.get("result");
}

function items(value: Value): Value[] {
  if (!(value instanceof JSArray)) throw new Error("配列ではない");
  return value.items;
}

describe("数は整数", () => {
  test("割り算は 0 の向きに切り捨て、0 で割ると NaN", async () => {
    expect(
      await evaluate(
        "var result = [7 / 2, -7 / 2, 7 % 3, 1 / 0, parseInt(10 / 3)];",
      ).then(items),
    ).toEqual([3, -3, 1, Number.NaN, 3]);
  });

  test("ビット演算は 32 ビット、2^16 を超えるリテラルもそのまま", async () => {
    expect(
      await evaluate(
        "var result = [0xFFFFFFFF | 0, 1 << 31, -1 >>> 28, 0x12345678 & 0xFF00, ~5, 70000];",
      ).then(items),
    ).toEqual([-1, -2147483648, 15, 0x5600, -6, 70000]);
  });

  test("小数のリテラルは切り捨てる", async () => {
    expect(await evaluate("var result = 1.9 + 0;")).toBe(1);
  });

  test("文字列と数", async () => {
    expect(
      await evaluate(
        'var result = ["1" + 2, "3" * "4", "a" * 1, 1 + true, "08" - 0];',
      ).then(items),
    ).toEqual(["12", 12, Number.NaN, 2, 8]);
  });
});

describe("文字は EUC-JP の符号", () => {
  test("charCodeAt と fromCharCode", async () => {
    expect(
      await evaluate(
        'var s = "あA"; var result = [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(5)];',
      ).then(items),
    ).toEqual([0xa4a2, 0x41, Number.NaN]);
    expect(
      await evaluate("var result = String.fromCharCode(0xA4A2, 0xA1A1, 0x41);"),
    ).toBe("あ　A");
  });

  test("大小は EUC-JP の順 (「ア」0xA5A2 は「あ」0xA4A2 より大きい、漢字はかなより後)", async () => {
    expect(
      await evaluate(
        'var result = ["あ" < "ア", "ア" < "亜", "b" < "あ", "あい" < "あ"];',
      ).then(items),
    ).toEqual([true, true, true, false]);
  });

  test("charCodeAt を EUC の範囲と比べる", async () => {
    expect(
      await evaluate(
        'var c = "漢".charCodeAt(0); var result = c >= 0xA1A1 && c <= 0xFEFE && c > 0x80;',
      ),
    ).toBe(true);
  });

  test("非 ASCII の文字列リテラルとの等値", async () => {
    expect(
      await evaluate(
        'var a = "天気"; var result = a == "天気" && a != "天候";',
      ),
    ).toBe(true);
  });
});

describe("文", () => {
  test("for-in は定義の順。delete したものは出ない", async () => {
    expect(
      await evaluate(`
                var o = new Object(); o.b = 1; o.a = 2; o.c = 3;
                delete o.a;
                var result = new Array();
                for (var k in o) result.push(k);
            `).then(items),
    ).toEqual(["b", "c"]);
  });

  test("for-in は配列の添字と、組み込みでない prototype の名前を列挙する", async () => {
    expect(
      await evaluate(`
                function P() { this.own = 1; }
                P.prototype.shared = 2;
                var keys = ""; var p = new P();
                for (k in p) keys += k + ",";
                var a = [5, 6]; for (k in a) keys += k + ",";
                var result = keys;
            `),
    ).toBe("own,shared,0,1,");
  });

  test("switch・do-while・入れ子の break / continue", async () => {
    expect(
      await evaluate(`
                var log = "";
                for (var i = 0; i < 5; i++) {
                    switch (i) {
                        case 1: log += "a"; break;
                        case 2: log += "b";
                        case 3: log += "c"; continue;
                        default: log += "d";
                    }
                    log += i;
                }
                var j = 0;
                do { j++; if (j == 2) continue; log += "j"; } while (j < 3);
                var result = log;
            `),
    ).toBe("d0a1bccd4jj");
  });

  test("for-in の中の break で積んだものを残さない", async () => {
    expect(
      await evaluate(`
                var o = { a: 1, b: 2, c: 3 };
                var n = 0;
                for (var t = 0; t < 3; t++) {
                    for (var k in o) { if (k == "b") break; n++; }
                    for (var k in o) { if (k == "a") continue; n += 10; }
                }
                var result = n;
            `),
    ).toBe(63);
  });

  test("自動の ; と、行頭の <!-- -->", async () => {
    expect(
      await evaluate(`<!--
                var a = 1
                var b = a
                ++b
                var result = a + b
                -->`),
    ).toBe(3);
  });

  test("関数の巻き上げ・閉包・arguments・再帰", async () => {
    expect(
      await evaluate(`
                var result = [early(), counter(), sum(1, 2, 3), fact(5)];
                function early() { return "up"; }
                function counter() {
                    var n = 10;
                    function inc() { n++; return n; }
                    inc();
                    return inc();
                }
                function sum() { var t = 0; for (var i = 0; i < arguments.length; i++) t += arguments[i]; return t; }
                function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
            `).then(items),
    ).toEqual(["up", 12, 6, 120]);
  });

  test("自前のコンストラクタと prototype の関数", async () => {
    expect(
      await evaluate(`
                function Point(x, y) { this.x = x; this.y = y; }
                Point.prototype.sum = function2;
                function function2() { return this.x + this.y; }
                var p = new Point(3, 4);
                var result = [p.sum(), p instanceof Point, typeof p, p.constructor == Point];
            `).then(items),
    ).toEqual([7, true, "object", true]);
  });

  test("typeof は括弧書きでも、綴り違いと比べても偽になるだけ", async () => {
    expect(
      await evaluate(`
                var a = new Array(); var u;
                var result = [typeof(a), typeof(a) == "array", typeof(u) == "undefind", typeof(nothing), typeof(1) == "NUMBER", typeof parseInt];
            `).then(items),
    ).toEqual(["object", false, false, "undefined", false, "function"]);
  });

  test("複合代入と増減 (名前・メンバー・添字)", async () => {
    expect(
      await evaluate(`
                var o = { n: 1 }; var a = [10]; var x = 5;
                var r = [x++, x, ++x, o.n++, o.n, --o.n, a[0]--, a[0], ++a[0]];
                x <<= 2; o.n += "z"; a[0] |= 1;
                r.push(x, o.n, a[0]);
                var result = r;
            `).then(items),
    ).toEqual([5, 6, 7, 1, 2, 1, 10, 9, 10, 28, "1z", 11]);
  });

  test("関数式は読まない (構文の誤り)", () => {
    expect(() => compileScript("var f = function () {};", "x")).toThrow(
      ScriptSyntaxError,
    );
  });
});

describe("組み込み", () => {
  test("文字列の関数", async () => {
    expect(
      await evaluate(`
                var s = "a,bb,,c";
                var result = [s.split(",").length, s.split(",")[1], s.substring(5, 2), s.indexOf("b"), s.search("c"), s.charAt(2), "abc".split("").join("-"), s.length];
            `).then(items),
    ).toEqual([4, "bb", "bb,", 2, 6, "b", "a-b-c", 7]);
  });

  test("parseInt は基数なしでも読む", async () => {
    expect(
      await evaluate(
        'var result = [parseInt("42"), parseInt("0x1F"), parseInt("ffffff", 16), parseInt("x"), parseInt("12px")];',
      ).then(items),
    ).toEqual([42, 31, 0xffffff, Number.NaN, 12]);
  });

  test("配列の関数", async () => {
    expect(
      await evaluate(`
                var a = new Array(3); var b = new Array(0, 0, 0, 0);
                a[5] = 1;
                var c = [3, 1, 2]; c.sort();
                var result = [a.length, b.length, c.join(""), [1, 2].concat([3], 4).length, c.reverse().join(""), c.slice(1).join("")];
            `).then(items),
    ).toEqual([6, 4, "123", 4, "321", "21"]);
  });

  test("Date は日本の時刻。引数無しは放送の時刻、7 個まで受ける", async () => {
    expect(
      await evaluate(`
                var d = new Date();
                var e = new Date(2026, 0, 2, 3, 4, 5, 6);
                var result = [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getDay(), e.getHours(), e.getMilliseconds(), d.getTimezoneOffset(), "" + new Date(2026, 9, 1)];
            `).then(items),
    ).toEqual([2026, 9, 12, 21, 30, 1, 3, 6, -540, "2026-10-01T00:00:00"]);
  });

  test("Date の差は 32 ビットに収まらなくても正しい", async () => {
    expect(
      await evaluate(
        "var result = (new Date(2026, 9, 13) - new Date(2026, 9, 12)) / 1000;",
      ),
    ).toBe(86400);
  });

  test("Math と eval は無い", async () => {
    expect(
      await evaluate("var result = [typeof Math, typeof eval];").then(items),
    ).toEqual(["undefined", "undefined"]);
  });
});

describe("止まる・打ち切る・区切る", () => {
  test("組み込みが待つと、値を受け取って続きから動く", async () => {
    const vm = setup();
    const order: string[] = [];
    vm.realm.global.put(
      "sleep",
      new JSFunction(
        vm.realm.functionProto,
        "sleep",
        {
          kind: "native",
          impl: () => {
            order.push("sleep");
            return new Suspend(Promise.resolve(1));
          },
        },
        null,
      ),
    );
    expect(await evaluate("var a = sleep(300); var result = a + 1;", vm)).toBe(
      2,
    );
    expect(order).toEqual(["sleep"]);
  });

  test("打ち切ると、その後ろは動かない", async () => {
    const vm = setup();
    vm.realm.global.put(
      "launch",
      new JSFunction(
        vm.realm.functionProto,
        "launch",
        { kind: "native", impl: () => ABORT },
        null,
      ),
    );
    vm.startProgram(
      compileScript("var before = 1; launch(); var after = 1;", "x"),
    );
    expect(vm.run(Number.POSITIVE_INFINITY).kind).toBe("abort");
    expect(vm.realm.global.get("before")).toBe(1);
    expect(vm.realm.global.get("after")).toBeUndefined();
    expect(vm.busy).toBe(false);
  });

  test("締め切りで手を放し、次の run で続く", async () => {
    const vm = setup();
    vm.startProgram(
      compileScript(
        "var n = 0; for (var i = 0; i < 100000; i++) n++; var result = n;",
        "x",
      ),
    );
    expect(vm.run(0).kind).toBe("yield");
    expect(vm.busy).toBe(true);
    expect((await finish(vm)).kind).toBe("done");
    expect(vm.realm.global.get("result")).toBe(100000);
  });

  test("終わらないループは誤りにして止める", () => {
    const vm = new Vm(createRealm({ now: () => NOW }), { steps: 10000 });
    vm.startProgram(compileScript("while (true) {}", "x"));
    const result = vm.run(Number.POSITIVE_INFINITY);
    expect(result.kind).toBe("error");
    expect(vm.busy).toBe(false);
  });

  test("呼び出しが深すぎれば誤り", async () => {
    const result = evaluate("function f(n) { return f(n + 1); } f(0);");
    await expect(result).rejects.toThrow("深すぎ");
  });

  test("未定義の名前を読むと誤り。書くのはよい", async () => {
    await expect(evaluate("var result = nothing + 1;")).rejects.toThrow(
      "nothing",
    );
    expect(await evaluate("created = 3; var result = created;")).toBe(3);
  });

  test("イベントの受け手を呼ぶ", async () => {
    const vm = setup();
    vm.startProgram(
      compileScript(
        "var count = 0; function onTick(n) { count += n; return count; }",
        "x",
      ),
    );
    await finish(vm);
    vm.startCall(vm.realm.global.get("onTick"), [5]);
    const result = await finish(vm);
    expect(result).toEqual({ kind: "done", value: 5 });
  });
});

describe("sort の比べる関数", () => {
  test("数で比べる・逆順", async () => {
    expect(
      await evaluate(
        "function up(x, y) { return x - y; } function down(x, y) { return y - x; }" +
          "var a = [10, 9, 1, 100]; a.sort(up);" +
          "var b = [10, 9, 1, 100]; b.sort(down);" +
          'var result = [a.join(","), b.join(",")];',
      ).then(items),
    ).toEqual(["1,9,10,100", "100,10,9,1"]);
  });

  test("戻り値は数にする (文字列でも)", async () => {
    expect(
      await evaluate(
        'function cmp(x, y) { return "" + (x - y); } var a = [3, 1, 2]; a.sort(cmp); var result = a.join(",");',
      ),
    ).toBe("1,2,3");
  });

  test("undefined は後ろに回し、比べる関数には渡さない", async () => {
    expect(
      await evaluate(
        "var seen = 0; var a = [3, undefined, 1, undefined, 2];" +
          "function cmp(x, y) { if (x === undefined || y === undefined) seen++; return x - y; } a.sort(cmp);" +
          "var result = [a[0], a[1], a[2], a[3] === undefined, a[4] === undefined, a.length, seen];",
      ).then(items),
    ).toEqual([1, 2, 3, true, true, 5, 0]);
  });

  test("比べる関数の中で関数を呼べる・入れ子の sort もよい", async () => {
    expect(
      await evaluate(
        "function up(x, y) { return x - y; } function byKey(x, y) { return key(x) - key(y); }" +
          "function key(o) { var k = [o.b, o.a]; k.sort(up); return k[0]; }" +
          "var a = [{a: 5, b: 9}, {a: 1, b: 7}, {a: 8, b: 3}];" +
          "a.sort(byKey);" +
          'var result = a[0].a + "," + a[1].a + "," + a[2].a;',
      ),
    ).toBe("1,8,5");
  });

  test("比べる関数の誤りはそのまま伝わり、実行を止める", async () => {
    const vm = setup();
    vm.startProgram(
      compileScript(
        "function cmp(x, y) { return nothing; } var a = [2, 1]; a.sort(cmp); var result = 1;",
        "x",
      ),
    );
    const result = vm.run(Number.POSITIVE_INFINITY);
    expect(result.kind).toBe("error");
    if (result.kind === "error")
      expect(result.error.message).toContain("nothing");
    expect(vm.busy).toBe(false);
    expect(vm.realm.global.get("result")).toBeUndefined();
  });

  test("関数でないものは誤り", async () => {
    await expect(evaluate("[2, 1].sort(5);")).rejects.toThrow(
      "関数ではありません",
    );
  });

  test("比べる関数の命令も上限に数える", () => {
    const vm = new Vm(createRealm({ now: () => NOW }), { steps: 10000 });
    vm.startProgram(
      compileScript(
        "var a = []; for (var i = 0; i < 200; i++) a.push(200 - i);" +
          "function cmp(x, y) { for (var j = 0; j < 10; j++) {} return x - y; } a.sort(cmp);",
        "x",
      ),
    );
    const result = vm.run(Number.POSITIVE_INFINITY);
    expect(result.kind).toBe("error");
    if (result.kind === "error")
      expect(result.error.message).toContain("終わりません");
    expect(vm.busy).toBe(false);
  });

  test("比べる関数の中で sleep は誤り", async () => {
    const realm = createRealm({ now: () => NOW });
    realm.global.put(
      "sleep",
      new JSFunction(
        realm.functionProto,
        "sleep",
        {
          kind: "native",
          impl: () => new Suspend(Promise.resolve(undefined)),
        },
        null,
      ),
    );
    const vm = new Vm(realm);
    vm.startProgram(
      compileScript(
        "function cmp(x, y) { sleep(); return x - y; } [2, 1].sort(cmp);",
        "x",
      ),
    );
    const result = vm.run(Number.POSITIVE_INFINITY);
    expect(result.kind).toBe("error");
    expect(vm.busy).toBe(false);
    // 誤りの後も次の実行は動く
    expect(await evaluate("var result = 1;", vm)).toBe(1);
  });
});

describe("細かい意味", () => {
  test("配列の sort も EUC-JP の順 (全角英数 0xA3xx は漢字 0xB0xx より前)", async () => {
    expect(
      await evaluate(
        'var a = ["亜", "Ａ", "あ"]; a.sort(); var result = a.join("");',
      ),
    ).toBe("ＡあA".replace("A", "亜"));
  });

  test("文字列の Date は日本の時刻で読み、読めない形式は NaN", async () => {
    expect(
      await evaluate(
        'var d = new Date("2026/10/12 21:30:00"); var result = [d.getHours(), isNaN(new Date("きのう").getTime())];',
      ).then(items),
    ).toEqual([21, true]);
  });

  test("ループの中で消した名前は for-in に出ない", async () => {
    expect(
      await evaluate(
        'var o = { a: 1, b: 2, c: 3 }; var s = ""; for (var k in o) { delete o.b; s += k; } var result = s;',
      ),
    ).toBe("ac");
  });

  test("文字列の添字の外は undefined、同じ名前の引数は後ろが勝つ、配列の空き、undefined という名前", async () => {
    expect(
      await evaluate(`
                function f(a, a) { var b = 9; return a + b; }
                var r = [1,,3];
                var result = ["abc"[5], "abc"[1], f(1, 2), r.length, r[1] == undefined, typeof undefined];
            `).then(items),
    ).toEqual([undefined, "b", 11, 3, true, "undefined"]);
  });

  test("動いている途中に重ねて始めない", () => {
    const vm = setup();
    vm.startProgram(
      compileScript("var n = 0; for (var i = 0; i < 100000; i++) n++;", "x"),
    );
    expect(vm.run(0).kind).toBe("yield");
    expect(() => vm.startProgram(compileScript("var x = 1;", "y"))).toThrow();
    expect(() => vm.resume(1)).toThrow();
  });
});

describe("大きさの上限と配列の空き", () => {
  test("文字列を倍々にしても、上限で誤りにして止める (concat・join)", async () => {
    await expect(
      evaluate('var s = "x"; for (var i = 0; i < 30; i++) s = s.concat(s);'),
    ).rejects.toThrow("長すぎ");
    await expect(
      evaluate(
        'var a = new Array(); var s = "xxxxxxxxxxxxxxxx"; for (var i = 0; i < 16; i++) s = s + s; for (var j = 0; j < 100; j++) a.push(s); a.join("");',
      ),
    ).rejects.toThrow("長すぎ");
  });

  test("delete で空けた要素と、空きのまま作った要素は for-in に出ない。undefined を入れた要素は出る", async () => {
    expect(
      await evaluate(`
                var a = [1, 2, 3]; delete a[1];
                var b = new Array(2); b[3] = undefined;
                var s = ""; for (var k in a) s += k; s += "/"; for (var k in b) s += k;
                var result = [s, a.length, b.length, a[1] == undefined];
            `).then(items),
    ).toEqual(["02/3", 3, 4, true]);
  });

  test("parseInt の桁あふれは NaN", async () => {
    expect(
      await evaluate(
        'var result = isNaN(parseInt("99999999999999999999999"));',
      ),
    ).toBe(true);
  });
});
