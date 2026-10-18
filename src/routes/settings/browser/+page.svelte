<script lang="ts">
    import { onMount } from 'svelte';
    import { canvasVideo, chooseCanvas, seeDriveNotice, teslaBrowser } from '#lib/canvas-video.js';
    import DriveNotice from '#lib/components/DriveNotice.svelte';
    import Lead from '#lib/components/Lead.svelte';
    import { measure } from '#lib/measure.svelte.js';
    import { type CanvasSupport, canvasSupport } from '#lib/raw/support.js';

    /*
     * **この端末だけの設定。** どちらもサーバには送らず、端末に覚える (localStorage)。
     * 読むのは画面に出てから (localStorage・UA・VideoDecoder はサーバでは読めない)
     */
    let compat = $state(false);
    let tesla = $state(false);
    let support = $state<CanvasSupport | null>(null);
    /** 入れようとしている (運転中の注意を出している) */
    let confirming = $state(false);
    onMount(() => {
        compat = canvasVideo();
        tesla = teslaBrowser();
        void canvasSupport().then((found) => (support = found));
    });

    /** 入れるときは運転中の注意を先に出し、「わかりました」で入れる。切るのはその場で */
    function setCompat(on: boolean): void {
        if (on) {
            confirming = true;
            return;
        }
        chooseCanvas(false);
        compat = false;
    }

    function acceptCompat(): void {
        seeDriveNotice();
        chooseCanvas(true);
        compat = true;
        confirming = false;
    }
</script>

<div class="sections readable">
    <!--
        **互換モード** (`canvas-video.ts`)。`<video>` の再生が止まる端末 (テスラの車載ブラウザ) のため、
        ライブ・追っかけ・録画の動画を canvas に描く。端末ごとの設定。
        入れるときは運転中の注意を出し、「わかりました」で入る (`DriveNotice`)。
        canvas・WebCodecs といった言葉は画面に出さない (docs/writing.md「画面の言葉」)
    -->
    <section class="section" data-testid="canvas-video">
        <div class="section-head">
            <h2>互換モードで再生</h2>
        </div>
        <label class="check">
            <input
                type="checkbox"
                role="switch"
                aria-checked={compat || confirming}
                checked={compat || confirming}
                onchange={(event) => setCompat(event.currentTarget.checked)}
                data-testid="canvas-video-toggle"
            />
            <span>互換モードで再生する</span>
        </label>
        <Lead class="indent">
            動画が止まってしまう端末 (テスラの車載ブラウザなど) 向け
            {#snippet more()}
                <p>
                    <strong>この端末だけ</strong>の設定で、サーバにも他の端末にも伝わりません。
                    テスラの車載ブラウザでは、触らなくても入っています。
                </p>
                <p>
                    ライブ・追っかけ再生・録画を、動画が止まりにくい方法で再生します。使えない画質は選べなくなります。
                    速さは変えられません。ライブはさかのぼって見ることができません。
                </p>
            {/snippet}
        </Lead>
        <ul class="support small" data-testid="canvas-video-support">
            <li>H.264: {support === null ? '確認中' : support.h264 ? '使えます' : '使えません'}</li>
            <li>AV1: {support === null ? '確認中' : support.av1 ? '使えます' : '使えません'}</li>
            <li>テスラの車載ブラウザ: {tesla ? 'はい' : 'いいえ'}</li>
        </ul>
    </section>

    <!--
        **端末でしか出ない食い違いを、その端末で読むための入口。** 縦のはみ出しは、引っ込む
        アドレスバーや画面の切り欠きが絡むと**その端末でしか起きない**。入り口をここに置くのは、
        PWA にアドレスバーが無いため (`?measure` を打つところがない)
    -->
    <section class="section">
        <div class="section-head">
            <h2>画面の高さを見る</h2>
        </div>
        <label class="check">
            <input
                type="checkbox"
                role="switch"
                aria-checked={measure.on}
                checked={measure.on}
                onchange={(event) => measure.set(event.currentTarget.checked)}
                data-testid="measure-toggle"
            />
            <span>高さの表示を出す</span>
        </label>
        <Lead class="indent">
            右下に、この端末での画面の高さを出します
            {#snippet more()}
                <p><strong>この端末だけ</strong>の設定で、サーバにも他の端末にも伝わりません。</p>
                <p>
                    出るのは「窓 / 枠 / 中身 = はみ出し」「dvh / svh / lvh / vh の実測」と、
                    <strong>はみ出している要素</strong>。はみ出しが 0 でなければページごと動きます。
                    単位の4つが同じ数なら、食い違いが原因ではありません。
                </p>
            {/snippet}
        </Lead>
    </section>
</div>

<DriveNotice open={confirming} onaccept={acceptCompat} oncancel={() => (confirming = false)} />

<style>
    /* 互換モードで使えるもの。点は付けずに詰めて並べる */
    .support {
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .support li {
        margin: 0;
        list-style: none;
    }
</style>
