import { describe, expect, test } from "bun:test";

import { createRealm } from "./builtins";
import { compileScript } from "./compiler";
import { BmlDocument, type BmlElement } from "./document";
import { Dom, type DomHost } from "./dom";
import { JSArray, type Value } from "./values";
import { Vm } from "./vm";
import { parseXml } from "./xml";

const items = (value: Value): Value[] =>
  value instanceof JSArray ? value.items : [];

const BML = `<?xml version="1.0" encoding="EUC-JP"?>
<bml><head><title>t</title></head>
<body>
<bevent><beitem id="bi" type="ModuleUpdated" module_ref="/40/0001" onoccur="x();"/></bevent>
<div id="box" style="left:10px;top:20px;width:100px;height:50px;background-color-index:3">
  <p id="msg" style="left:0px;top:0px;width:100px;height:24px;nav-index:0">はじめ</p>
</div>
</body></bml>`;

interface Setup {
  vm: Vm;
  doc: BmlDocument;
  subscribed: BmlElement[];
  run(source: string): Promise<Value>;
}

function setup(): Setup {
  const xml = parseXml(BML);
  if (xml === null) throw new Error();
  const doc = new BmlDocument(xml);
  doc.applyRules([]);
  const realm = createRealm({ now: () => Date.UTC(2026, 9, 12, 3) });
  const vm = new Vm(realm);
  const subscribed: BmlElement[] = [];
  let invisible = true;
  let focused: BmlElement | null = null;
  const host: DomHost = {
    realm,
    document: doc,
    focused: () => focused,
    focus: (element) => {
      focused = element;
    },
    blur: () => {
      focused = null;
    },
    event: () => null,
    invisible: () => invisible,
    setInvisible: (value) => {
      invisible = value;
    },
    subscribed: (element) => subscribed.push(element),
    stream: () => {},
  };
  const dom = new Dom(host);
  realm.global.put("document", dom.document);
  return {
    vm,
    doc,
    subscribed,
    async run(source: string): Promise<Value> {
      vm.startProgram(compileScript(source, "test"));
      let result = vm.run(Number.POSITIVE_INFINITY);
      while (result.kind === "suspend") {
        vm.resume(await result.promise);
        result = vm.run(Number.POSITIVE_INFINITY);
      }
      if (result.kind === "error") throw result.error;
      return realm.global.get("result");
    },
  };
}

describe("BML の DOM", () => {
  test("要素と文字を読み書きし、見た目を書き換える", async () => {
    const s = setup();
    const result = await s.run(`
            var p = document.getElementById("msg");
            var before = p.firstChild.data;
            p.firstChild.data = "あと";
            var box = document.getElementById("box");
            box.normalStyle.left = "40px";
            box.normalStyle.visibility = "hidden";
            var result = [before, typeof document, box.normalStyle.backgroundColorIndex, box.normalStyle.top, p.parentNode == box, document.getElementById("none")];
        `);
    expect(s.doc.getElementById("msg")!.children[0]).toMatchObject({
      data: "あと",
    });
    const box = s.doc.getElementById("box")!.style();
    expect([box.left, box.visible]).toEqual([40, false]);
    expect(items(result)).toEqual([
      "はじめ",
      "hostobject",
      "3",
      "20px",
      true,
      null,
    ]);
  });

  test("beitem の subscribe を立てると知らせ、body の invisible を書ける", async () => {
    const s = setup();
    await s.run(`
            document.getElementById("bi").subscribe = true;
            document.documentElement.lastChild;
            var body = document.getElementById("box").parentNode;
            body.invisible = false;
            var result = body.invisible;
        `);
    expect(s.subscribed.map((e) => e.id)).toEqual(["bi"]);
    expect(s.doc.getElementById("bi")!.attr("subscribe")).toBe("subscribe");
  });

  test("focus() でフォーカスが移る", async () => {
    const s = setup();
    expect(
      await s.run(
        'document.getElementById("msg").focus(); var result = document.currentFocus.id;',
      ),
    ).toBe("msg");
  });
});
