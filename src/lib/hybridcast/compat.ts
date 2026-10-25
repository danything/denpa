/**
 * **Hybridcast のアプリから、データ放送の受信機の機能を使わせる** (`navigator.bmlCompat`・`navigator.applicationManager`。
 * IPTV フォーラム「Hybridcast 技術仕様」)。アプリの文書の中で動く。
 *
 * NHK のアプリはこれを当てにして動く — Hybridcast のトップは、データ放送に戻ったとき何を出すかを Greg に書き、
 * 設定を局の NVRAM (`nvram://00;group/14` など) に読み書きする。
 *
 * - **Greg** … データ放送のエンジンと同じもの。開くときに写して渡し、書かれたら親へ知らせて戻す
 * - **NVRAM** … データ放送と同じ置き場・同じ決まり (`bml/nvram.ts`)。**放送の文書と同じ領域を使える** —
 *   アプリは AIT で局が起動させたもの。渡すのは起動した局から見える分だけ (`visibleFrom`)、書いたら親へ知らせる
 * - **データ放送へ戻る** (`launchDataBroadcastingBrowser`) … アプリを閉じる
 *
 * `readPersistentArray` は値をその場で返す決まりなので、NVRAM の読み書きはここで済ませる。
 * 差し込み (`shim.ts`) と違って `bml/` の部品を使うので、**組むときに 1 本の script に束ねて**
 * (`vite.config.ts` の `?inject`) 差し込みの後ろに入れる
 */

import type { Cell } from "../bml/binary";
import { clipEuc } from "../bml/euc";
import { Nvram, type ReceiverInfo, type Who } from "../bml/nvram";

export interface CompatInit {
  /** データ放送の Greg (64 本) */
  greg: string[];
  /** NVRAM の置き場の中身 (起動した局から見える分。鍵は `Nvram` のもの) */
  nvram: Record<string, string>;
  receiver: ReceiverInfo;
  /** 起動した局 */
  who: Who;
}

/** 親へ知らせるもの (`FrameMessage` の `greg`・`nvram`・`log`・`close`) */
export type CompatPost = (message: Record<string, unknown>) => void;

export function bmlCompat(
  init: CompatInit,
  post: CompatPost,
): { bmlCompat: unknown; applicationManager: unknown } {
  const greg = init.greg.slice(0, 64);
  while (greg.length < 64) greg.push("");
  const gregs = new Proxy(greg, {
    set: (target, key, value) => {
      const index = typeof key === "string" ? Number(key) : Number.NaN;
      if (!Number.isInteger(index) || index < 0 || index >= 64) return true;
      target[index] = clipEuc(String(value), 256);
      post({ type: "greg", index, value: target[index] });
      return true;
    },
  });
  const kept = { ...init.nvram };
  const nvram = new Nvram(
    {
      get: (key) => (Object.hasOwn(kept, key) ? kept[key]! : null),
      set: (key, value) => {
        kept[key] = value;
        post({ type: "nvram", key, value });
      },
    },
    () => init.receiver,
    () => init.who,
    (message) => post({ type: "log", message }),
  );
  const cells = (values: unknown): Cell[] =>
    Array.isArray(values)
      ? values.map((v) =>
          typeof v === "boolean" || typeof v === "number" ? v : String(v),
        )
      : [];
  return {
    bmlCompat: {
      browserPseudo: {
        Greg: gregs,
        readPersistentArray: (uri: unknown, structure: unknown) => {
          const values = nvram.read(String(uri), String(structure));
          return values === null
            ? null
            : values.map((v) => (typeof v === "object" ? null : v));
        },
        writePersistentArray: (
          uri: unknown,
          structure: unknown,
          values: unknown,
        ) => nvram.write(String(uri), String(structure), cells(values)),
        checkAccessInfoOfPersistentArray: (uri: unknown) =>
          nvram.check(String(uri)),
      },
    },
    applicationManager: {
      // 戻る先の部品 (component_tag) は選べない。いま出ているデータ放送へ戻る
      launchDataBroadcastingBrowser: () => post({ type: "close" }),
    },
  };
}

/** 差し込み (`shim.ts`) が `__hcCompat` に置いたものを読んで、navigator に置く */
function install(): void {
  // oxlint-disable-next-line typescript/no-explicit-any -- アプリの文書の中で動く (型の無い世界)
  const w = globalThis as any;
  const init = w.__hcCompat as CompatInit | undefined;
  if (init === undefined || w.navigator === undefined) return;
  delete w.__hcCompat;
  const made = bmlCompat(init, (message) => {
    message["hc"] = 1;
    w.parent.postMessage(message, "*");
  });
  for (const [name, value] of Object.entries(made)) {
    try {
      Object.defineProperty(w.navigator, name, { value, configurable: true });
    } catch {
      // 置けなければ無いまま
    }
  }
}

install();
