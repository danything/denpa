import { seeDriveNotice } from "./canvas-video";

/**
 * **運転中の注意** (互換モード。`canvas-video.ts`・`DriveNotice.svelte`)。UA の既定で互換モードに
 * 入っている端末 (テスラ) で、初めて canvas で再生する前に出す。**「わかりました」を押すまで再生を始めない。**
 * ライブ・追っかけ・観る画面で同じ。
 */
export function driveGate() {
  let open = $state(false);
  let waiters: (() => void)[] = [];

  return {
    /** 出しているか (`<DriveNotice open>`) */
    get open(): boolean {
      return open;
    },
    /** 出して、押されるまで待つ */
    confirm(): Promise<void> {
      return new Promise((done) => {
        waiters.push(done);
        open = true;
      });
    },
    /** 押された (`<DriveNotice onaccept>`)。見せたことを覚えて、待っている再生を進める */
    accept(): void {
      seeDriveNotice();
      open = false;
      const waiting = waiters;
      waiters = [];
      for (const done of waiting) done();
    },
  };
}
