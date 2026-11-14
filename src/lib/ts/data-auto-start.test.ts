import { describe, expect, test } from "bun:test";

import type { ComponentPMT } from "@danything/arib/bml-protocol";

import { autoStarts } from "./data-auto-start";

/** 部品 1 つ。`autoStart` が null なら入口の情報 (entryPointInfo) を持たない */
function component(
  componentId: number,
  autoStart: boolean | null,
): ComponentPMT {
  return {
    pid: 0x800 + componentId,
    componentId,
    streamType: 0x0d,
    dataComponentId: 0x0c,
    bxmlInfo: {
      transmissionFormat: 0,
      entryPointFlag: autoStart !== null,
      ...(autoStart === null
        ? {}
        : {
            entryPointInfo: {
              autoStartFlag: autoStart,
              documentResolution: 3,
              useXML: false,
              defaultVersionFlag: true,
              independentFlag: true,
              styleForTVFlag: false,
              bmlMajorVersion: 1,
              bmlMinorVersion: 0,
            },
          }),
    },
  };
}

describe("入口の部品に自動起動の指定があるか", () => {
  test("入口の部品 (0x40) の auto_start_flag を見る", () => {
    expect(autoStarts([component(0x40, true)])).toBe(true);
    expect(autoStarts([component(0x40, false)])).toBe(false);
    expect(autoStarts([component(0x40, null)])).toBe(false);
  });

  test("入口の部品が無ければ false。ほかの部品の指定は見ない", () => {
    expect(autoStarts([])).toBe(false);
    expect(autoStarts([component(0x41, true)])).toBe(false);
    expect(
      autoStarts(
        new Map([
          [0x41, component(0x41, true)],
          [0x40, component(0x40, false)],
        ]).values(),
      ),
    ).toBe(false);
  });
});
