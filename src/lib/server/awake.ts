/**
 * **Windows と Mac をスリープさせないように OS へ伝える。** ほかの OS では何もしない。
 *
 * - Windows は `SetThreadExecutionState`。伝えるのは「システムが要る」(`ES_SYSTEM_REQUIRED`) だけで、画面は消えてよい。
 *   `ES_CONTINUOUS` を付けるので、取り消すまで (またはプロセスが終わるまで) 効き続ける。効くのは**呼んだスレッドだけ**なので、
 *   JS のスレッドから呼ぶ (bun:ffi の呼び出しはそのスレッドで動く)。サービス (SYSTEM のタスク) からでも効く
 * - Mac は IOKit の `IOPMAssertionCreateWithName` で `PreventUserIdleSystemSleep` を取る。Windows と同じく、操作が無いことで
 *   眠るのだけを止め、画面は消えてよい (蓋を閉じる・メニューからスリープを選ぶのは止めない)。取り消すときは `IOPMAssertionRelease`。
 *   LaunchDaemon (root) からでも効く
 *
 * どちらもプロセスが落ちれば OS が外すので、伝えたまま残らない。
 *
 * Mac の IOKit と CoreFoundation の呼び出し (`macPower`) は、録画の前に起こす予約 (`power.ts`) でも使う。
 *
 * 何も import しない (CI がこのファイルだけを配布物の bun で読み、Windows は `powercfg /requests`、Mac は
 * `pmset -g assertions` に出るかを見る。tests/native-smoke.ts)
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

/** Mac の電源の呼び出し (IOKit・CoreFoundation)。返す数はどれも IOKit の `IOReturn` で、0 が成功 */
export interface MacPower {
  /** 名前を付けて `PreventUserIdleSystemSleep` を取る。取れたら番号 (`IOPMAssertionID`)、取れなければ null */
  hold(name: string): number | null;
  /** `hold` で取ったものを返す */
  release(id: number): number;
  /** `at` (ms) にスリープから起こす予約を `by` の名前で置く (`IOPMSchedulePowerEvent`。root が要る) */
  schedule(at: number, by: string): number;
  /** `schedule` で置いた予約を取り消す。時刻と名前が置いたときと同じものだけが消える */
  cancel(at: number, by: string): number;
}

const COREFOUNDATION =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit";
const kCFStringEncodingUTF8 = 0x08000100;
/** CoreFoundation の時刻 (`CFAbsoluteTime`) は 2001-01-01 (UTC) からの秒。1970 年からとの差 */
const kCFAbsoluteTimeIntervalSince1970 = 978307200;
const kIOPMAssertionLevelOn = 255;
/** 操作が無いことで眠るのを止める (`kIOPMAssertionTypePreventUserIdleSystemSleep`) */
const PREVENT_IDLE_SLEEP = "PreventUserIdleSystemSleep";
/** スリープから起こす予約の種類 (`kIOPMAutoWake`)。電源が切れているときは入れない */
const AUTO_WAKE = "wake";

/** JS の時刻 (ms) を CoreFoundation の時刻 (秒) に */
export function cfAbsoluteTime(ms: number): number {
  return ms / 1000 - kCFAbsoluteTimeIntervalSince1970;
}

let mac: MacPower | null | undefined;

/** Mac の電源の呼び出し。Mac でないか、読めなければ null (1 度だけ試す) */
export async function macPower(): Promise<MacPower | null> {
  if (mac !== undefined) return mac;
  if (process.platform !== "darwin") return (mac = null);
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const cf = dlopen(COREFOUNDATION, {
      CFStringCreateWithCString: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.ptr,
      },
      CFDateCreate: { args: [FFIType.ptr, FFIType.f64], returns: FFIType.ptr },
      CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    });
    const io = dlopen(IOKIT, {
      IOPMAssertionCreateWithName: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      IOPMAssertionRelease: { args: [FFIType.u32], returns: FFIType.i32 },
      IOPMSchedulePowerEvent: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      IOPMCancelScheduledPowerEvent: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    type Ptr = Parameters<typeof cf.symbols.CFRelease>[0];
    /** CFString を作って `use` に渡し、終わったら放す。作れなければ -1 */
    const withStrings = (
      texts: string[],
      use: (refs: Ptr[]) => number,
    ): number => {
      const refs = texts.map((text) =>
        cf.symbols.CFStringCreateWithCString(
          null,
          Buffer.from(`${text}\0`, "utf8"),
          kCFStringEncodingUTF8,
        ),
      );
      try {
        if (refs.some((ref) => ref === null)) return -1;
        return use(refs as Ptr[]);
      } finally {
        for (const ref of refs) if (ref !== null) cf.symbols.CFRelease(ref);
      }
    };
    /** `at` (ms) の CFDate と、予約の名前・種類の CFString で `call` を呼ぶ */
    const withEvent = (
      at: number,
      by: string,
      call: (date: Ptr, id: Ptr, type: Ptr) => number,
    ): number => {
      const date = cf.symbols.CFDateCreate(null, cfAbsoluteTime(at));
      if (date === null) return -1;
      try {
        return withStrings([by, AUTO_WAKE], ([id, type]) =>
          call(date, id!, type!),
        );
      } finally {
        cf.symbols.CFRelease(date);
      }
    };
    mac = {
      hold: (name) => {
        const out = new Uint32Array(1);
        const code = withStrings([PREVENT_IDLE_SLEEP, name], ([type, label]) =>
          io.symbols.IOPMAssertionCreateWithName(
            type!,
            kIOPMAssertionLevelOn,
            label!,
            out,
          ),
        );
        return code === 0 ? out[0]! : null;
      },
      release: (id) => io.symbols.IOPMAssertionRelease(id),
      schedule: (at, by) =>
        withEvent(at, by, (date, id, type) =>
          io.symbols.IOPMSchedulePowerEvent(date, id, type),
        ),
      cancel: (at, by) =>
        withEvent(at, by, (date, id, type) =>
          io.symbols.IOPMCancelScheduledPowerEvent(date, id, type),
        ),
    };
  } catch (error) {
    console.warn(
      `[power] IOKit を読めません。スリープを止められず、録画の前にスリープから起こせません: ${error}`,
    );
    mac = null;
  }
  return mac;
}

/** いま OS に「スリープさせない」と伝えているか */
let held = false;
/** Mac で取っている `PreventUserIdleSystemSleep` の番号 */
let assertion: number | null = null;

/** `pmset -g assertions` に出る名前 (Mac)。**ASCII だけで書く** (pmset は ASCII でない名前を空で出す。CI で見た) */
const AWAKE_NAME = "denpa: recording, live viewing or encoding";

/**
 * `busy` のあいだスリープさせない。変わったときだけ OS に伝える。
 * 伝えられたら true (Windows と Mac 以外と、変わらないときも true)
 */
export async function holdAwake(busy: boolean): Promise<boolean> {
  if (busy === held) return true;
  if (process.platform === "win32") {
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
  } else if (process.platform === "darwin") {
    const power = await macPower();
    if (power === null) return false;
    if (busy) {
      assertion = power.hold(AWAKE_NAME);
      if (assertion === null) {
        console.warn("[power] IOPMAssertionCreateWithName が失敗しました");
        return false;
      }
    } else if (assertion !== null) {
      power.release(assertion);
      assertion = null;
    }
  } else {
    return true;
  }
  held = busy;
  console.log(
    busy
      ? "[power] 録画・視聴・エンコードの間、スリープさせません"
      : "[power] スリープの抑止を解除しました",
  );
  return true;
}
