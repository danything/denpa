import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import type { CDPSession, Page } from "@playwright/test";

import { test } from "../stack";

/**
 * **番組表のマスを描く重さを測る** (CI では流さない)。地上波 22 局 × 24 時間 ≒ 650 マスを DB に入れ、
 * ホームから番組表へ画面の中で移り (本番と同じくブラウザで描く)、最初のマスが出るまでと長い処理 (longtask) を取る。
 * CPU を 4 倍遅くした回も取る。中身の内訳は `GUIDE_TRACE` を置くと Chrome のトレースに書き出す
 *
 *     bunx playwright test -c tests/bench guide-render
 */
const STATIONS = 22;
const RUNS = Number(process.env["GUIDE_RUNS"] ?? 5);

function seed(db: string): void {
  const script = `
        import { Database } from 'bun:sqlite';
        const db = new Database(${JSON.stringify(db)});
        const d = new Date();
        if (d.getHours() < 4) d.setDate(d.getDate() - 1);
        d.setHours(4, 0, 0, 0);
        const day = d.getTime();
        const now = 9_000_000_000_000;
        let rnd = 7;
        const random = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
        const minutes = [5, 10, 15, 30, 30, 30, 30, 54, 60, 60, 60, 90, 114, 120];
        let id = 9_000_000_000;
        db.run('BEGIN');
        for (let i = 0; i < ${STATIONS}; i++) {
            const sid = 1024 + i * 8;
            const service = 32000 + i;
            db.run('INSERT OR REPLACE INTO services (id, service_id, network_id, name, type, service_type, channel, remote_control_key, has_logo, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
                [service * 100000 + sid, sid, service, '測定局' + (i + 1), 'GR', 1, 'T' + (40 + i), (i % 12) + 1, 0, now]);
            let at = day - 30 * 60_000;
            let ev = 1;
            while (at < day + 24 * 3600_000) {
                const len = minutes[Math.floor(random() * minutes.length)] * 60_000;
                db.run('INSERT OR REPLACE INTO programs (id, service_id, network_id, event_id, start_at, end_at, name, description, genres, copy_never, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                    [id++, service * 100000 + sid, service, ev++, at, at + len,
                     '測定用の番組 ' + ev + ' 第' + ((ev % 12) + 1) + '話「長めの副題がここに入る」',
                     'あらすじ。出演者の名前や内容の紹介がここに並ぶ。'.repeat(3),
                     JSON.stringify([Math.floor(random() * 12)]), 0, now]);
                at += len;
            }
        }
        db.run('COMMIT');
    `;
  execFileSync("bun", ["-e", script]);
}

interface Sample {
  firstCell: number;
  done: number;
  longtasks: [number, number][];
  cells: number;
}

/** 計測の印を入れておく。時刻はどれも移る瞬間 (クリック) から */
async function arm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const out = {
      t0: 0,
      firstCell: -1,
      done: -1,
      longtasks: [] as [number, number][],
    };
    w["__guide"] = out;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        out.longtasks.push([e.startTime, e.duration]);
    }).observe({ type: "longtask" });
    new MutationObserver((_, observer) => {
      if (out.t0 === 0) return;
      if (
        out.firstCell < 0 &&
        document.querySelector('[data-testid="program-button"]')
      ) {
        out.firstCell = performance.now() - out.t0;
      }
      const grid = document.querySelector('[data-testid="guide-grid"]');
      if (
        out.firstCell >= 0 &&
        grid !== null &&
        !grid.hasAttribute("aria-busy")
      ) {
        out.done = performance.now() - out.t0;
        observer.disconnect();
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    addEventListener(
      "click",
      () => {
        out.t0 = performance.now();
      },
      { capture: true },
    );
  });
}

async function once(
  page: Page,
  cdp: CDPSession,
  rate: number,
  trace: string | null,
): Promise<Sample> {
  await page.goto("/");
  await page.locator('[data-hydrated="true"]').waitFor();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await arm(page);
  const events: unknown[] = [];
  if (trace !== null) {
    cdp.on("Tracing.dataCollected", (e) => events.push(...e.value));
    await cdp.send("Tracing.start", {
      categories:
        "devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,disabled-by-default-v8.cpu_profiler",
      transferMode: "ReportEvents",
    });
  }
  await page.getByTestId("nav-guide").first().click();
  // Playwright の待ち (locator) は表の中を何度も調べて測りたいものに混ざるので、ページの中の印を待つ
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const out = (window as unknown as Record<string, { done: number }>)[
            "__guide"
          ];
          if (out !== undefined && out.done >= 0) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      }),
  );
  await page.waitForTimeout(1500);
  if (trace !== null) {
    const finished = new Promise((resolve) =>
      cdp.once("Tracing.tracingComplete", resolve),
    );
    await cdp.send("Tracing.end");
    await finished;
    writeFileSync(trace, JSON.stringify({ traceEvents: events }));
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const raw = await page.evaluate(() => {
    const out = (window as unknown as Record<string, unknown>)["__guide"] as {
      t0: number;
      firstCell: number;
      done: number;
      longtasks: [number, number][];
    };
    return {
      firstCell: out.firstCell,
      done: out.done,
      longtasks: out.longtasks
        .filter(([start]) => start >= out.t0)
        .map(
          ([start, d]) =>
            [Math.round(start - out.t0), Math.round(d)] as [number, number],
        ),
      cells: document.querySelectorAll('[data-testid="program-button"]').length,
    };
  });
  return {
    ...raw,
    firstCell: Math.round(raw.firstCell),
    done: Math.round(raw.done),
  };
}

test.use({ viewport: { width: 1541, height: 954 } });

test("番組表のマスを描く重さ", async ({ page, stack }) => {
  await page.goto("/");
  seed(`${stack.root}/denpa.db`);
  const cdp = await page.context().newCDPSession(page);
  // 1 回目は読み込み (JS の取得・コンパイル) が混ざるので捨てる
  await once(page, cdp, 1, null);
  const label = process.env["GUIDE_LABEL"] ?? "run";
  for (const rate of [1, 4]) {
    const samples: Sample[] = [];
    for (let i = 0; i < RUNS; i++) {
      const trace =
        process.env["GUIDE_TRACE"] && i === 0
          ? `${process.env["GUIDE_TRACE"]}/${label}-x${rate}.json`
          : null;
      samples.push(await once(page, cdp, rate, trace));
    }
    for (const s of samples) {
      console.log(
        `x${rate} cells=${s.cells} first=${s.firstCell} done=${s.done} long=${s.longtasks.map(([a, d]) => `${d}@${a}`).join(" ")}`,
      );
    }
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const longest = samples.map((s) =>
      Math.max(0, ...s.longtasks.map(([, d]) => d)),
    );
    const total = samples.map((s) =>
      s.longtasks.reduce((sum, [, d]) => sum + d, 0),
    );
    console.log(
      `x${rate} median first=${median(samples.map((s) => s.firstCell))} done=${median(samples.map((s) => s.done))} longest=${median(longest)} longtotal=${median(total)}`,
    );
  }
});
