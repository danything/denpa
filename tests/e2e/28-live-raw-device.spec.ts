import {
  expect,
  flipSetting,
  goto,
  pickCodec,
  syncEpg,
  test,
  wakeControls,
} from "./helpers";
import { chooseRaw } from "./live";

/**
 * ライブを MPEG-2 のまま見るときの、端末ごとの扱い ([docs/stream.md](../../docs/stream.md#放送そのままmpeg-2を送る))。
 * バックグラウンド再生を入れたときの音、MPEG-2 をデコードできない端末、端末に覚える選択。
 * 偽エージェントが流すもの・見るもの・ほかの部分は [28-live-raw.spec.ts](28-live-raw.spec.ts) の冒頭にある
 */
test.describe("ライブを MPEG-2 のまま見る", () => {
  // MPEG-2 をデコードできる端末として開く (`stack.ts` の `liveWithoutMpeg2`)
  test.use({ liveMpeg2: true });

  test.beforeEach(async ({ request }) => {
    await syncEpg(request);
  });

  /*
   * **バックグラウンド再生を入れたら、生の音は `<audio>` から鳴らす** (`raw/engine.ts` の `route`)。
   * Web Audio のまま鳴らすと、ブラウザによっては効果音の扱いで裏へ回すと止まる (テスラの
   * 車載ブラウザ)。AudioContext の出口をストリームにして `<audio>` に渡し、メディアの再生にする。
   *
   * 裏に回すのは別のタブを前に出し、`visibilityState` も差し替えて通知を送る (ヘッドレスは
   * タブを移っても `visible` のまま)。裏でも音は進み続け、**映像はデコードしない** (CPU を使わない。戻れば出す) こと、`<audio>` が鳴って
   * いること、`<audio>` を外から止める・再開する (ロック画面・車の操作) と操作バーが合うこと、
   * 切れば直に鳴らすのに戻ること、CSP に止められないことを見る
   */
  test("バックグラウンド再生を入れると生の音は <audio> から鳴り、裏でも進み続ける", async ({
    page,
    context,
  }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (globalThis as { cspViolations?: string[] }).cspViolations = seen;
      document.addEventListener("securitypolicyviolation", (event) =>
        seen.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await chooseRaw(page);
    const canvas = page.getByTestId("live-raw");
    const count = async (name: "shown" | "audio") =>
      Number((await canvas.getAttribute(`data-${name}`)) ?? 0);
    await expect
      .poll(() => count("shown"), { timeout: 30_000 })
      .toBeGreaterThan(10);

    // 切っている間は作らない (直に鳴らす)
    const audio = page.getByTestId("live-raw-audio");
    await expect(audio).toHaveCount(0);

    await wakeControls(page, "live-frame");
    const toggle = page.getByTestId("live-background");
    await flipSetting(page, "live", "background");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const paused = () => audio.evaluate((a) => (a as HTMLAudioElement).paused);
    await expect.poll(paused, { timeout: 10_000 }).toBe(false);
    expect(
      await audio.evaluate(
        (a) =>
          ((a as HTMLAudioElement).srcObject as MediaStream).getAudioTracks()
            .length,
      ),
    ).toBe(1);

    // 裏に回す
    const other = await context.newPage();
    await other.bringToFront();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // 数は 1 秒ごとに書き出される。隠す前のぶんが出そろってから数え始める
    await page.waitForTimeout(1_500);
    const heard = await count("audio");
    const shown = await count("shown");
    await page.waitForTimeout(5_000);
    // 音は 1 秒に 47 コマ (48kHz・1024 サンプル)。5 秒で半分より多くは進む
    expect((await count("audio")) - heard).toBeGreaterThan(100);
    // 映像は裏ではデコードしない (同じ端末で見ているほかのタブに CPU を回す。`raw/worker.ts` の `hidden`)
    expect((await count("shown")) - shown).toBeLessThan(5);
    expect(await paused()).toBe(false);
    const play = page.getByTestId("live-play");
    await expect(play).toHaveAttribute("aria-label", "一時停止");

    // 戻ってくる
    await other.close();
    await page.bringToFront();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // 戻れば映像も出す (いちばん新しいキーフレームから)
    const back = await count("shown");
    await expect
      .poll(() => count("shown"), { timeout: 10_000 })
      .toBeGreaterThan(back + 20);
    /*
     * 戻った直後に追いつくまでコマを捨てても、B を飛ばしはじめない (`raw/worker.ts` の `resetThin`)。
     * 数えはじめるのは戻ってから 2 秒後。飛ばしはじめれば最初は 20 秒続くので、その後の数秒で見える
     */
    await page.waitForTimeout(4_000);
    await expect(canvas).toHaveAttribute("data-thinned", "false");

    // `<audio>` を外から止める・再開すると (ロック画面・車の操作)、操作バーも止まる・再開する
    await audio.evaluate((a) => (a as HTMLAudioElement).pause());
    await expect(play).toHaveAttribute("aria-label", "再生");
    await audio.evaluate((a) => (a as HTMLAudioElement).play());
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await expect.poll(paused).toBe(false);
    // 操作バーから止める・再開すると `<audio>` も止まる・鳴りだす
    await wakeControls(page, "live-frame");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "再生");
    await expect.poll(paused).toBe(true);
    await wakeControls(page, "live-frame");
    await play.click();
    await expect(play).toHaveAttribute("aria-label", "一時停止");
    await expect.poll(paused).toBe(false);

    // 切れば直に鳴らすのに戻る。音はデコードでき続ける
    await wakeControls(page, "live-frame");
    await flipSetting(page, "live", "background");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect.poll(paused).toBe(true);
    const after = await count("audio");
    await expect
      .poll(() => count("audio"), { timeout: 10_000 })
      .toBeGreaterThan(after + 20);

    expect(
      await page.evaluate(
        () => (globalThis as { cspViolations?: string[] }).cspViolations,
      ),
    ).toEqual([]);
  });

  /*
   * **`<audio>` の `play()` を断られても黙らせない** (自動再生)。直に鳴らすのに戻し、操作バーは
   * 止めたことにしない。断られたことを「外から止められた」と取り違えないことも見る
   */
  test("<audio> の再生を断られたら、直に鳴らすまま止めない", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        if (this instanceof HTMLAudioElement) {
          return Promise.reject(new DOMException("断る", "NotAllowedError"));
        }
        return play.call(this);
      };
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await chooseRaw(page);
    const canvas = page.getByTestId("live-raw");
    const heard = async () =>
      Number((await canvas.getAttribute("data-audio")) ?? 0);
    await expect
      .poll(
        async () => Number((await canvas.getAttribute("data-shown")) ?? 0),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(10);

    await wakeControls(page, "live-frame");
    const toggle = page.getByTestId("live-background");
    await flipSetting(page, "live", "background");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const audio = page.getByTestId("live-raw-audio");
    await expect(audio).toHaveCount(1);
    await page.waitForTimeout(500);
    expect(await audio.evaluate((a) => (a as HTMLAudioElement).paused)).toBe(
      true,
    );
    await expect(page.getByTestId("live-play")).toHaveAttribute(
      "aria-label",
      "一時停止",
    );
    const before = await heard();
    await expect.poll(heard, { timeout: 10_000 }).toBeGreaterThan(before + 20);
  });

  test("デコードできない端末ではエンコードしたものに戻り、理由を出す", async ({
    page,
  }) => {
    // worker へ描く先を渡せない端末 (OffscreenCanvas の無い古い Safari)
    await page.addInitScript(() => {
      // oxlint-disable-next-line typescript/no-explicit-any -- 端末に無いことにする
      delete (HTMLCanvasElement.prototype as any).transferControlToOffscreen;
    });
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await chooseRaw(page);
    await expect(page.getByTestId("live-warning")).toContainText(
      "MPEG-2 を再生できません",
    );
    // 選んでいた MPEG-2 は自動に戻す (開くたびに断り書きを出さない)。家の中の順 (MPEG-2 → H.264 → AV1) で MPEG-2 の次の H.264
    await expect(page.getByTestId("live-codec")).toContainText("自動 (H.264)");
    await expect(page.getByTestId("live-raw")).toHaveCount(0);
    // 断り書きは局を替えても消さず、10 秒で引っ込める (`SWITCH_NOTE`)。切り替えた先はメニューの行に残る
    await page.getByTestId("live-channel").nth(1).click();
    await expect(page.getByTestId("live-warning")).toBeVisible();
    await expect(page.getByTestId("live-warning")).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("live-codec")).toContainText("自動 (H.264)");
  });

  test("選んだものはエンコード方式と同じくこの端末に覚える", async ({
    page,
  }) => {
    await goto(page, "/live");
    await page.getByTestId("live-channel").first().click();
    await expect(page.getByTestId("live-title")).toBeVisible();
    await chooseRaw(page);
    await expect(page.getByTestId("live-raw")).toBeVisible({ timeout: 30_000 });

    // 開き直しても MPEG-2 のまま (自動ではなく、選んだもの)
    await goto(page, "/live");
    await expect(page.getByTestId("live-raw")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("live-codec")).toContainText("MPEG-2");
    await expect(page.getByTestId("live-codec")).not.toContainText("自動");

    // AV1 に替えるとエンコードしたものになり、それも覚える
    await wakeControls(page, "live-frame");
    await pickCodec(page, "live", "av1");
    await expect(page.getByTestId("live-raw")).toHaveCount(0, {
      timeout: 30_000,
    });
    await goto(page, "/live");
    await expect(page.getByTestId("live-title")).toBeVisible();
    await expect(page.getByTestId("live-codec")).toContainText("AV1");
    await expect(page.getByTestId("live-raw")).toHaveCount(0);
  });
});
