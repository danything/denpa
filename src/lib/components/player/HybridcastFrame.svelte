<script lang="ts">
    /**
     * Hybridcast のアプリを映像の上に開く ([docs/stream.md](../../../../docs/stream.md#hybridcast))。
     * 開くのはデータ放送が起動を求めたとき (`DataBroadcast` の `hybridcast`)。
     *
     * - アプリの HTML は中継で取り、差し込み (`#lib/hybridcast/shim.ts`) を入れて sandbox の iframe へ渡す
     * - iframe からのリクエスト (通信・記憶・映像の置き場・選局・字幕・閉じる) は postMessage で受ける。
     *   **送り元が自分の iframe かを必ず見る**
     * - 通信は中継 (`/api/bml/proxy`・`/api/bml/post`) を通す。決まり (公開アドレスだけ・10 秒・4MB・
     *   cookie も UA も受信機を見分けるものも送らない) はデータ放送と同じ
     * - 受信機の記憶はアプリごとに分けて覚える (`storageKey`)
     * - データ放送の Greg と NVRAM を写して渡し、書かれたら戻す (`broadcast`・`onwrite`。`#lib/hybridcast/compat.ts`)
     */
    import { onDestroy } from 'svelte';
    import type { Service } from '#lib/bml/engine.js';
    import {
        decodeHtml,
        type FrameMessage,
        frameMessage,
        type HcState,
        prepareApp,
        receiverKey,
        STORAGE_LIMIT,
        storageKey,
        VIEWPORT,
    } from '#lib/hybridcast/app.js';
    import type { CompatInit } from '#lib/hybridcast/compat.js';
    import compat from '#lib/hybridcast/compat.ts?inject';
    import { read, write } from '#lib/keep.js';
    import type { HybridcastLink } from '#lib/live.js';
    import { resolve } from '$app/paths';
    import StageNote from './StageNote.svelte';

    type Place = Extract<FrameMessage, { type: 'video' }>['place'];

    interface Props {
        app: HybridcastLink;
        /** いまの局・番組・字幕。変わったらアプリへ送り直す */
        hc: HcState;
        /** データ放送の Greg と NVRAM (ページを開くたびに読む。前のページが書いた Greg も渡す) */
        broadcast: () => CompatInit;
        /** アプリが Greg・NVRAM に書いた (`who` はいまのページを開いた局) */
        onwrite: (change: Extract<FrameMessage, { type: 'greg' | 'nvram' }>, who: CompatInit['who']) => void;
        /** 閉じてデータ放送へ戻る */
        onclose: () => void;
        /** 選局 (データ放送の epgTune と同じ範囲)。できなければ false */
        ontune: (service: Service) => boolean;
        oncaptions: (on: boolean) => void;
        /** 放送の映像をどこに出すか (アプリの画面 1920x1080 の座標) */
        onvideo: (place: Place) => void;
        /** リモコン (AribKeyCode) を渡す関数 (bind で受け取る)。戻ると d は閉じる */
        press?: ((code: number, down: boolean) => void) | null;
    }

    let { app, hc, broadcast, onwrite, onclose, ontune, oncaptions, onvideo, press = $bindable(null) }: Props = $props();

    let box = $state<HTMLDivElement | null>(null);
    let frame = $state<HTMLIFrameElement | null>(null);
    let phase = $state<'loading' | 'ready' | 'failed'>('loading');
    let scale = $state('scale(1)');
    /** 渡す HTML (取れたら入る) と、iframe が受け取れるようになったか */
    let html: string | null = null;
    let ready = false;
    /**
     * いま開いているページ。**アプリが別のページへ移ったら替わる** (`navigate`。NHK は Hybridcast のトップへ移る)。
     * 同じアプリの続きとして扱う (受信機の記憶・識別は最初のアプリのまま)
     */
    // svelte-ignore state_referenced_locally
    let url = $state(app.url);
    /** iframe を開き直すたびに変える (同じ入れ物を読み直させる) */
    let round = $state(0);
    let gone = false;
    /** いまのページを開いた局 (アプリの NVRAM はこの局の領域) */
    let opened: CompatInit['who'] = { originalNetworkId: null, serviceId: null };
    // svelte-ignore state_referenced_locally
    const key = storageKey(app.organisationId, app.applicationId);

    function remembered(): Record<string, string> {
        try {
            const value: unknown = JSON.parse(read(key) ?? '{}');
            return value !== null && typeof value === 'object' ? (value as Record<string, string>) : {};
        } catch {
            return {};
        }
    }

    function post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
        // 中は使い捨てのオリジン ("null") なので相手を名指しできない。送るのはアプリがリクエストしたものとその状態だけ
        frame?.contentWindow?.postMessage({ hc: 1, ...message }, '*', transfer);
    }

    function hand(): void {
        if (!ready || html === null || gone) return;
        post({ type: 'html', html });
        html = null;
        phase = 'ready';
        frame?.focus();
    }

    async function load(): Promise<void> {
        // 読み込んでいる間に別のページへ移ったら、古いほうは捨てる (後から届いて新しいページを上書きしない)
        const target = url;
        try {
            const response = await fetch(resolve(`api/bml/proxy?url=${encodeURIComponent(target)}`));
            if (response.headers.get('x-bml-relayed') !== '1' || !response.ok) throw new Error(String(response.status));
            const body = new Uint8Array(await response.arrayBuffer());
            const text = decodeHtml(body, response.headers.get('content-type') ?? '');
            const relay = await relayFor(target);
            if (target !== url) return;
            const given = broadcast();
            opened = given.who;
            html = prepareApp(text, {
                url: target,
                organisationId: app.organisationId,
                applicationId: app.applicationId,
                storage: remembered(),
                state: $state.snapshot(hc),
                relay,
                compat: given,
            },
            compat,
            );
            hand();
        } catch (failure) {
            if (target !== url) return;
            console.warn(`[hybridcast] アプリを取得できません: ${target} (${String(failure)})`);
            phase = 'failed';
        }
    }

    /**
     * **http のアプリは denpa の https 越しに読ませる** (`server/hc-relay.ts`)。https の画面から http の script は
     * Mixed Content として止められる (NHK のアプリは http にしか無い)。https のアプリには要らない (null)
     */
    async function relayFor(url: string): Promise<{ root: string; origin: string } | null> {
        const target = new URL(url);
        if (target.protocol !== 'http:' || location.protocol !== 'https:') return null;
        const response = await fetch(resolve('api/bml/hc'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
        });
        if (!response.ok) throw new Error(`中継を用意できません (${response.status})`);
        const { root } = (await response.json()) as { root: string | null };
        return root === null ? null : { root: new URL(resolve(root as '/'), location.href).href, origin: target.origin };
    }

    /** アプリの通信を中継へ。中継が断った・相手まで行けなかったら error */
    async function relay(message: Extract<FrameMessage, { type: 'fetch' }>): Promise<void> {
        try {
            const target = new URL(message.url);
            if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error(target.protocol);
            const query = `url=${encodeURIComponent(target.href)}`;
            let response: Response;
            if (message.method === 'GET' || message.method === 'HEAD') {
                response = await fetch(resolve(`api/bml/proxy?${query}`));
            } else if (message.method === 'POST') {
                response = await fetch(resolve(`api/bml/post?${query}`), {
                    method: 'POST',
                    headers: message.contentType === null ? {} : { 'content-type': message.contentType },
                    body: message.body ?? new ArrayBuffer(0),
                });
            } else {
                throw new Error(message.method);
            }
            if (response.headers.get('x-bml-relayed') !== '1') throw new Error(String(response.status));
            const body = await response.arrayBuffer();
            const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
            post({ type: 'response', id: message.id, status: response.status, contentType, body }, [body]);
        } catch (failure) {
            console.warn(`[hybridcast] 通信を中継できません: ${message.method} ${message.url} (${String(failure)})`);
            post({ type: 'response', id: message.id, error: true });
        }
    }

    function receive(event: MessageEvent): void {
        // **自分の iframe から来たものだけ**
        if (frame === null || event.source !== frame.contentWindow) return;
        const message = frameMessage(event.data);
        if (message === null) return;
        switch (message.type) {
            case 'ready':
                ready = true;
                hand();
                break;
            case 'fetch':
                void relay(message);
                break;
            case 'store': {
                const json = JSON.stringify(message.items);
                if (json.length <= STORAGE_LIMIT) write(key, json);
                else console.warn(`[hybridcast] 受信機の記憶が上限を超えたので覚えません (${json.length} 文字)`);
                break;
            }
            case 'video':
                onvideo(message.place);
                break;
            case 'tune':
                if (
                    !ontune({
                        originalNetworkId: message.onid,
                        transportStreamId: message.tsid,
                        serviceId: message.sid,
                    })
                )
                    console.warn('[hybridcast] 選局できません');
                break;
            case 'captions':
                oncaptions(message.on);
                break;
            case 'close':
                onclose();
                break;
            case 'log':
                console.warn(`[hybridcast] ${message.message}`);
                break;
            case 'greg':
            case 'nvram':
                onwrite(message, opened);
                break;
            case 'navigate':
                navigate(message.url);
                break;
        }
    }

    /** アプリが別のページへ移った。入れ物を読み直して、そのページを同じ手順 (中継・差し込み) で開く */
    function navigate(next: string): void {
        console.warn(`[hybridcast] 別のページへ移ります: ${next}`);
        url = next;
        html = null;
        ready = false;
        phase = 'loading';
        round += 1;
        void load();
    }

    // いまの局・番組・字幕が変わったら送り直す
    $effect(() => {
        const state = $state.snapshot(hc);
        if (phase === 'ready') post({ type: 'state', state });
    });

    // 枠に合わせて 1920x1080 を伸ばす (縦横を別々に。下の映像と同じだけ伸ばす)
    $effect(() => {
        if (box === null) return;
        const target = box;
        const fit = (): void => {
            const r = target.getBoundingClientRect();
            scale = `scale(${r.width / VIEWPORT.width}, ${r.height / VIEWPORT.height})`;
        };
        fit();
        const watcher = new ResizeObserver(fit);
        watcher.observe(target);
        return () => watcher.disconnect();
    });

    press = (code, down) => {
        if (code === 19 || code === 20) {
            if (down) onclose();
            return;
        }
        const found = receiverKey(code);
        if (found !== null) post({ type: 'key', key: found.key, code: found.code, down });
    };

    void load();

    onDestroy(() => {
        gone = true;
        press = null;
        onvideo('full');
    });
</script>

<svelte:window onmessage={receive} />

<div
    bind:this={box}
    class="app"
    data-testid="live-hybridcast-app"
    data-state={phase}
    data-url={url}
>
    <iframe
        bind:this={frame}
        title={app.name === '' ? 'Hybridcast' : app.name}
        src="{resolve('api/bml/hybridcast')}{round === 0 ? '' : `?page=${round}`}"
        sandbox="allow-scripts"
        allow="autoplay"
        referrerpolicy="no-referrer"
        style:width="{VIEWPORT.width}px"
        style:height="{VIEWPORT.height}px"
        style:transform={scale}
    ></iframe>
    {#if phase !== 'ready'}
        <div class="corner">
            <StageNote>
                {phase === 'loading' ? 'Hybridcast を読み込み中…' : 'Hybridcast のアプリを読み込めませんでした (戻るで閉じる)'}
            </StageNote>
        </div>
    {/if}
</div>

<style>
    .app {
        pointer-events: auto;
        position: absolute;
        inset: 0;
        overflow: hidden;
    }
    iframe {
        position: absolute;
        left: 0;
        top: 0;
        border: 0;
        transform-origin: top left;
        background: transparent;
        /* 中の文書と揃える (違うとブラウザが iframe を不透明に塗り、下の映像が隠れる) */
        color-scheme: light;
    }
    .corner {
        position: absolute;
        top: 0.75rem;
        right: 0.75rem;
        z-index: 10;
        display: flex;
    }
</style>
