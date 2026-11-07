/**
 * **Windows をスリープさせないように OS へ伝える** (`SetThreadExecutionState`)。Windows 以外では何もしない。
 *
 * 伝えるのは「システムが要る」(`ES_SYSTEM_REQUIRED`) だけで、画面は消えてよい。`ES_CONTINUOUS` を付けるので、
 * 取り消すまで (またはプロセスが終わるまで) 効き続ける。プロセスが落ちれば OS が外すので、伝えたまま残らない。
 *
 * 効くのは**呼んだスレッドだけ**なので、JS のスレッドから呼ぶ (bun:ffi の呼び出しはそのスレッドで動く)。
 * サービス (SYSTEM のタスク) からでも効く。
 *
 * 何も import しない (CI がこのファイルだけを配布物の bun で読み、`powercfg /requests` に出るかを見る。tests/windows-smoke.ts)
 */

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;

/** kernel32 の `SetThreadExecutionState`。読めなければ null (1 度だけ試す) */
let setState: ((flags: number) => number) | null | undefined;

async function executionState(): Promise<((flags: number) => number) | null> {
  if (setState !== undefined) return setState;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const kernel32 = dlopen("kernel32.dll", {
      SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
    });
    setState = (flags) =>
      Number(kernel32.symbols.SetThreadExecutionState(flags));
  } catch (error) {
    console.warn(
      `[power] SetThreadExecutionState を読めません。スリープを止められません: ${error}`,
    );
    setState = null;
  }
  return setState;
}

/** いま OS に「スリープさせない」と伝えているか */
let held = false;

/**
 * `busy` のあいだスリープさせない。変わったときだけ OS に伝える。
 * 伝えられたら true (Windows 以外と、変わらないときも true)
 */
export async function holdAwake(busy: boolean): Promise<boolean> {
  if (process.platform !== "win32" || busy === held) return true;
  const set = await executionState();
  if (set === null) return false;
  const flags = busy
    ? (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0
    : ES_CONTINUOUS >>> 0;
  // 失敗すると 0 を返す
  if (set(flags) === 0) {
    console.warn("[power] SetThreadExecutionState が失敗しました");
    return false;
  }
  held = busy;
  console.log(
    busy
      ? "[power] 録画・視聴・エンコードの間、スリープさせません"
      : "[power] スリープの抑止を解除しました",
  );
  return true;
}
