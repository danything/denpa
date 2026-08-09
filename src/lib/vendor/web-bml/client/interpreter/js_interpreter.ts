/*
 * **これだけ denpa が書いたもの。上流のファイルではない。**
 *
 * 上流の `js_interpreter.ts` は JS-Interpreter (Google) を包むもので、
 * **向こうの README が「この実装は ../es2 に置き換えられたため未使用」**と
 * 言っている。`bml_browser.ts` からも `localStorage` に `use_js_interpreter` を
 * 置いたときしか呼ばれない、切り分け用の抜け道になっている。
 *
 * 写さない理由は2つ。
 *
 * - **185KB を、誰も通らない道のために抱えることになる** (interpreter.js 117KB
 *   + acorn.js 68KB)
 * - **Vite では読み込んだ時点で転ぶ。** 上流は1行目が
 *   `require("../../JS-Interpreter/interpreter")` で、webpack の CommonJS 扱いと
 *   `ProvidePlugin` の大域 `acorn` に乗っている。素の ESM に `require` は無い
 *
 * 消すには `bml_browser.ts` を書き換えることになるので、**代わりにこのファイルを
 * 置いて、抜け道を本物のほうへ寄せている**。上流を取り直すとき、ここだけ
 * 写さなければいい ([README](../../README.md) の「更新のしかた」)。
 */

export { ES2Interpreter as JSInterpreter } from './es2_interpreter';
