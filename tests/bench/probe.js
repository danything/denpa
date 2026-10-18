// @ts-nocheck — ページと worker に差し込む素の JS (型の無い大域を書き換えて回る)。型は使う側 (decoded-most.bench.ts) で持つ
/**
 * **ページに差し込んで `DECODED_MOST` を振る仕掛け** (`decoded-most.bench.ts`)。Playwright もふだんの
 * Chrome も同じものを使う。Chrome では `proxy.ts` 越しにホームを開き、DevTools のコンソールで:
 *
 *     await new Promise((r) => { const s = document.createElement('script'); s.src = '/bench/probe.js'; s.onload = r; document.head.append(s); });
 *     __benchInstall({ value: 6, path: 'av1', seconds: 30 });
 *     await __bench.run({ id: 1, load: 'gpu', run: 1 });   // 観る画面へ移って測り、proxy.ts へ送る
 *
 * 値・経路を変えるたびにホームを開き直す (worker は観る画面を開いたときに起こす)。
 *
 * - `Worker` を差し替え、raw/worker.ts のビルドしたものを読んで、比べている所の `DECODED_MOST` を書き換え、
 *   数える仕掛け (`PROBE`) を頭に足して Blob から起こす。WASM のデコーダ (`decoder.mjs`) も包んで数える
 * - `fetch` を差し替え、`/stream` は作り物の映像 (`/bench/<path>`。`proxy.ts` が配る) を返す
 * - 画面の切り替わり (rAF) と、worker が描いた回 (WebGL の drawArrays・2D の drawImage) を控えて返す
 */
globalThis.__benchInstall = (options) => {
    const { value, path, seconds } = options;
    localStorage.setItem('canvas-video', 'on');
    localStorage.setItem('canvas-drive-notice', '1');
    localStorage.setItem('watch-codec', path);

    // ---- worker の中 ----
    const PROBE = String(() => {
        const B = {
            draws: [],
            held: [],
            live: 0,
            liveMax: 0,
            outstandingMax: 0,
            decMax: 0,
            pushMs: [],
            ticks: 0,
            mod: null,
            dec: null,
            peekPts: -1,
        };
        self.__bench = B;
        const now = () => performance.timeOrigin + performance.now();
        // worker の刻み (setTimeout) が実際に何回来たか。窓が隠れた Chrome は刻みを間引くことがある
        const timeout = self.setTimeout;
        self.setTimeout = (fn, ms, ...rest) =>
            timeout(
                typeof fn === 'function'
                    ? (...a) => {
                          B.ticks++;
                          fn(...a);
                      }
                    : fn,
                ms,
                ...rest,
            );
        self.addEventListener('message', (event) => {
            const data = event.data;
            if (data === null || typeof data !== 'object' || data.__bench === undefined) return;
            event.stopImmediatePropagation();
            if (data.__bench === 'reset') {
                B.draws = [];
                B.held = [];
                B.liveMax = 0;
                B.outstandingMax = 0;
                B.decMax = 0;
                B.pushMs = [];
                B.ticks = 0;
                self.postMessage({ __benchReply: 'reset' });
                return;
            }
            self.postMessage({
                __benchReply: {
                    draws: B.draws,
                    held: B.held,
                    liveMax: B.liveMax,
                    outstandingMax: B.outstandingMax,
                    decMax: B.decMax,
                    pushMs: B.pushMs,
                    ticks: B.ticks,
                    wasm: B.mod ? B.mod.HEAPU8.buffer.byteLength : 0,
                },
            });
        });
        // 包んだ decoder.mjs を読む (worker の `import(` をこれに替えてある)
        self.__benchImport = async (url) => {
            const module = await import(url);
            return {
                default: async (opts) => {
                    const m = await module.default(opts);
                    B.mod = m;
                    const peek = m._dec_peek_pts;
                    m._dec_peek_pts = () => (B.peekPts = peek());
                    const push = m._dec_push;
                    m._dec_push = (...args) => {
                        const t = performance.now();
                        const n = push(...args);
                        B.pushMs.push(performance.now() - t);
                        B.decMax = Math.max(B.decMax, n);
                        return n;
                    };
                    return m;
                },
            };
        };
        const gl = self.WebGL2RenderingContext?.prototype;
        if (gl) {
            const names = new WeakMap();
            let field = -1;
            const gul = gl.getUniformLocation;
            gl.getUniformLocation = function (p, n) {
                const l = gul.call(this, p, n);
                if (l !== null) names.set(l, n);
                return l;
            };
            const u1i = gl.uniform1i;
            gl.uniform1i = function (l, v) {
                if (l !== null && names.get(l) === 'field') field = v;
                return u1i.call(this, l, v);
            };
            const da = gl.drawArrays;
            gl.drawArrays = function (m, f, c) {
                B.draws.push([now(), B.peekPts, field]);
                if (B.mod) B.held.push(B.mod._dec_count());
                return da.call(this, m, f, c);
            };
        }
        const c2 = self.OffscreenCanvasRenderingContext2D?.prototype;
        if (c2) {
            const di = c2.drawImage;
            c2.drawImage = function (image, ...rest) {
                if (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame) {
                    B.draws.push([now(), image.timestamp, 0]);
                    B.held.push(B.live + (B.dec ? B.dec.decodeQueueSize : 0));
                }
                return di.call(this, image, ...rest);
            };
        }
        const VD = self.VideoDecoder;
        if (VD) {
            const mine = new WeakSet();
            const count = () => {
                B.liveMax = Math.max(B.liveMax, B.live);
                B.outstandingMax = Math.max(B.outstandingMax, B.live + (B.dec ? B.dec.decodeQueueSize : 0));
            };
            self.VideoDecoder = class extends VD {
                constructor(init) {
                    super({
                        output: (frame) => {
                            mine.add(frame);
                            B.live++;
                            count();
                            init.output(frame);
                        },
                        error: (e) => init.error(e),
                    });
                    B.dec = this;
                }
                decode(chunk) {
                    super.decode(chunk);
                    count();
                }
            };
            const close = VideoFrame.prototype.close;
            VideoFrame.prototype.close = function () {
                if (mine.has(this)) {
                    mine.delete(this);
                    B.live--;
                }
                return close.call(this);
            };
        }
    });

    /** 書き換える所。**数が合わなければ止める** (ビルドの形が変わった) */
    function rewrite(source) {
        let mpeg2 = 0;
        let fmp4 = 0;
        let imports = 0;
        let out = source.replace(/(_dec_count\(\)<)\d+;/g, (_, head) => {
            mpeg2++;
            return `${head}${value};`;
        });
        out = out.replace(/(decodeQueueSize<)\d+\b/g, (_, head) => {
            fmp4++;
            return `${head}${value}`;
        });
        out = out.replace(/\bimport\(/g, () => {
            imports++;
            return 'self.__benchImport(';
        });
        if (mpeg2 !== 1 || fmp4 !== 2 || imports !== 1) {
            throw new Error(`worker を書き換えられません (MPEG-2 ${mpeg2}・fMP4 ${fmp4}・import ${imports})`);
        }
        return `(${PROBE})();\n${out}`;
    }

    const bench = { worker: null, waiting: null, error: null, value, path };
    globalThis.__bench = bench;
    const Native = globalThis.Worker;
    // `new Worker(...)` で呼ばれるので、アロー関数にはしない (関数の宣言にしておく)
    function BenchWorker(url, init) {
        const href = String(url);
        if (!/\/workers\/worker-[^/]*\.js/.test(href)) return new Native(url, init);
        // コンストラクタは同期なので、読むのも同期で
        const xhr = new XMLHttpRequest();
        xhr.open('GET', href, false);
        xhr.send();
        let source;
        try {
            source = rewrite(xhr.responseText);
        } catch (error) {
            bench.error = String(error);
            throw error;
        }
        const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Native(blob, init);
        // 返事は画面 (engine.ts) へ渡さず、待っている `ask` へ
        worker.addEventListener('message', (event) => {
            if (event.data?.__benchReply === undefined) return;
            event.stopImmediatePropagation();
            const answer = bench.waiting;
            bench.waiting = null;
            answer?.(event.data.__benchReply);
        });
        bench.worker = worker;
        return worker;
    }
    globalThis.Worker = BenchWorker;

    const ask = (what) =>
        new Promise((resolve, reject) => {
            const worker = bench.worker;
            if (worker === null) return reject(new Error('worker がまだありません'));
            const timer = setTimeout(() => reject(new Error('worker から返事がありません')), 10_000);
            bench.waiting = (answer) => {
                clearTimeout(timer);
                resolve(answer);
            };
            worker.postMessage({ __bench: what });
        });

    /** `ms` のあいだ rAF を控え、worker の数えたものと合わせて返す */
    bench.measure = async (ms) => {
        await ask('reset');
        const vsyncs = await new Promise((resolve) => {
            const out = [];
            const end = performance.now() + ms;
            const frame = (at) => {
                out.push(performance.timeOrigin + at);
                if (at < end) requestAnimationFrame(frame);
                else resolve(out);
            };
            requestAnimationFrame(frame);
        });
        const probe = await ask('collect');
        const canvas = document.querySelector('[data-testid="live-raw"]');
        return { ...probe, vsyncs, input: canvas?.dataset.input ?? null, ua: navigator.userAgent };
    };

    /**
     * **ふだんの Chrome で1回ぶん。** ページの中で観る画面 (`/watch/<id>`) へ移り、出はじめたら `warm` ms 待って
     * `ms` ms 数え、`proxy.ts` へ送る (`out/chrome.jsonl`。数えるのは report.ts)
     */
    bench.run = async ({ id, load, run, warm = 3000, ms = 15000 }) => {
        const a = document.createElement('a');
        a.href = `/watch/${id}`;
        document.body.append(a);
        a.click();
        const input = path === 'mpeg2' ? 'ts-mpeg2' : 'fmp4';
        const until = performance.now() + 60_000;
        for (;;) {
            const canvas = document.querySelector(`[data-testid="live-raw"][data-input="${input}"]`);
            if (Number(canvas?.dataset.shown ?? 0) > 5) break;
            if (performance.now() > until) return `描きはじめませんでした ${bench.error ?? ''}`;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await new Promise((resolve) => setTimeout(resolve, warm));
        let measured;
        try {
            measured = await bench.measure(ms);
        } catch (error) {
            // 諦めて worker を畳んだ (「再生が追いつきません」など)。失敗として残す
            const reason =
                document.querySelector('[data-testid="watch-stage"]')?.innerText.split('\n')[0] ?? '';
            measured = {
                draws: [],
                held: [],
                liveMax: 0,
                outstandingMax: 0,
                decMax: 0,
                pushMs: [],
                wasm: 0,
                vsyncs: [],
                input: null,
                error: `${error} ${reason}`,
            };
        }
        await nativeFetch('/bench/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, value, load, run, measured }),
        });
        return `${path} ${value} ${load} ${run}: 描いた ${measured.draws.length} 回・rAF ${measured.vsyncs.length} 回`;
    };

    // ---- 流すもの ----
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
            location.href,
        );
        if (/^\/api\/recordings\/\d+\/stream$/.test(url.pathname)) {
            const media = await nativeFetch(`/bench/${path === 'mpeg2' ? 'mpeg2.m2ts' : `${path}.mp4`}`, {
                signal: init?.signal,
            });
            const headers = new Headers(media.headers);
            if (path === 'mpeg2') headers.set('X-Denpa-Origin', media.headers.get('X-Bench-Origin') ?? '0');
            return new Response(media.body, { status: 200, headers });
        }
        if (/^\/api\/recordings\/\d+\/playback$/.test(url.pathname)) {
            if (path === 'mpeg2') {
                const real = await (await nativeFetch(input, init)).json();
                return Response.json({ ...real, duration: seconds });
            }
            return Response.json({
                duration: seconds,
                axis: 'encoded',
                audios: [{ id: '0', label: '' }],
                offers: [
                    path === 'av1'
                        ? { codec: 'av1', way: 'stream', codecs: 'av01.0.09M.08,opus' }
                        : { codec: 'h264', way: 'stream', codecs: 'avc1.64002a,mp4a.40.2' },
                ],
            });
        }
        return nativeFetch(input, init);
    };
};
