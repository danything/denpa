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
    import { read, write } from '#lib/keep.js';
    import type { HybridcastLink } from '#lib/live.js';
    import { resolve } from '$app/paths';
    import StageNote from './StageNote.svelte';

    type Place = Extract<FrameMessage, { type: 'video' }>['place'];

    interface Props {
        app: HybridcastLink;
        /** いまの局・番組・字幕。変わったらアプリへ送り直す */
        hc: HcState;
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

    let { app, hc, onclose, ontune, oncaptions, onvideo, press = $bindable(null) }: Props = $props();

    let box = $state<HTMLDivElement | null>(null);
    let frame = $state<HTMLIFrameElement | null>(null);
    let phase = $state<'loading' | 'ready' | 'failed'>('loading');
    let scale = $state('scale(1)');
    /** 渡す HTML (取れたら入る) と、iframe が受け取れるようになったか */
    let html: string | null = null;
    let ready = false;
    let gone = false;
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
        try {
            const response = await fetch(resolve(`api/bml/proxy?url=${encodeURIComponent(app.url)}`));
            if (response.headers.get('x-bml-relayed') !== '1' || !response.ok) throw new Error(String(response.status));
            const body = new Uint8Array(await response.arrayBuffer());
            const text = decodeHtml(body, response.headers.get('content-type') ?? '');
            html = prepareApp(text, {
                url: app.url,
                organisationId: app.organisationId,
                applicationId: app.applicationId,
                storage: remembered(),
                state: $state.snapshot(hc),
            });
            hand();
        } catch (failure) {
            console.warn(`[hybridcast] アプリを取得できません: ${app.url} (${String(failure)})`);
            phase = 'failed';
        }
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
        }
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
    data-url={app.url}
>
    <iframe
        bind:this={frame}
        title={app.name === '' ? 'Hybridcast' : app.name}
        src={resolve('api/bml/hybridcast')}
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
