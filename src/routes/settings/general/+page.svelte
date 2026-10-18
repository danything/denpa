<script lang="ts">
    import { onMount } from 'svelte';
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import { teslaBrowser } from '#lib/canvas-video.js';
    import Lead from '#lib/components/Lead.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { measure } from '#lib/measure.svelte.js';
    import { type CanvasSupport, canvasSupport } from '#lib/raw/support.js';
    import { THEME_LABEL, THEME_MODES, theme } from '#lib/theme.svelte.js';
    import type { SubmitFunction } from '$app/forms';
    import { resolve } from '$app/paths';

    let { data, form } = $props();

    const notices = $derived.by(() => {
        const list: Notice[] = [];
        list.push(...errorNotice(form, 'settings-error'));
        if (form?.loggedOut !== undefined) {
            list.push({
                key: 'logged-out-others',
                kind: 'success',
                text:
                    form.loggedOut === 0
                        ? 'ほかにログインしている端末はありませんでした'
                        : `ほかの端末のログインを ${form.loggedOut} 件終わらせました`,
            });
        }
        return list;
    });

    /**
     * **2回押させる** (削除と同じ `arming`)。押し間違えると、家族の端末まで入り直しになる。
     * 押す場所は1つなので、構えの鍵は 0 で足りる
     */
    const confirming = arming('[data-testid^="logout-others"]');
    const sent: SubmitFunction = () => async (options) => {
        await options.update();
        confirming.fire();
    };

    /*
     * **この端末だけの設定。** どれもサーバには送らず、端末に覚える (localStorage)。
     * 読むのは画面に出てから (localStorage・UA・VideoDecoder はサーバでは読めない)
     */
    let tesla = $state(false);
    let support = $state<CanvasSupport | null>(null);
    onMount(() => {
        tesla = teslaBrowser();
        void canvasSupport().then((found) => (support = found));
    });
</script>

<svelte:window onclick={confirming.stand} />

<Toasts {notices} source={form} />

<!-- 節の並びと名前は `#lib/settings-sections.ts`。`id` は左の一覧から飛ぶ先 -->
<div class="part" id="browser" data-part>
    <div class="sections readable">
        <!--
            **テーマ。** ヘッダーのボタン (押すたびに巡る) と同じもの (`theme.svelte.ts`)。
            ここでは3つを並べて、いまどれなのかと次に何があるのかを見せる
        -->
        <section class="section" data-testid="theme-card">
            <div class="section-head">
                <h2>テーマ</h2>
            </div>
            <div class="theme-choices">
                {#each THEME_MODES as mode (mode)}
                    <label class="check">
                        <input
                            type="radio"
                            name="theme"
                            value={mode}
                            checked={theme.mode === mode}
                            onchange={() => theme.set(mode)}
                            data-testid="theme-{mode}"
                        />
                        <span>{THEME_LABEL[mode]}</span>
                    </label>
                {/each}
            </div>
            <Lead><strong>この端末だけ</strong>の設定です。ヘッダーのボタンでも切り替えられます</Lead>
        </section>

        <!--
            **互換モード** (`canvas-video.ts`)。`<video>` の再生が止まる端末 (テスラの車載ブラウザ) のため、
            ライブ・追っかけ・録画の動画を canvas に描く。端末ごとの設定。
            **オン/オフは再生画面の ⚙ (再生の設定。`StageTail`) で切り替える。** ここに残すのは、この端末で使えるものの一覧だけ。
            canvas・WebCodecs といった言葉は画面に出さない (docs/writing.md「画面の言葉」)
        -->
        <section class="section" data-testid="canvas-video">
            <div class="section-head">
                <h2>互換モードで再生</h2>
            </div>
            <p class="small" data-testid="canvas-video-hint">オン/オフは、再生画面の ⚙ (再生の設定) で切り替えます。</p>
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
</div>

<div class="part" id="login" data-part>
    <div class="sections readable">
        <!--
            **ログアウトはヘッダーではなくここ。** ヘッダーとスマホの「その他」に置いていた頃は、
            たまにしか押さないものが毎回目に入っていた。押すのは POST (`/logout`)。
            リンク (GET) にすると、先読みで勝手に切れる
        -->
        <section class="section" data-testid="login-card">
            <div class="section-head">
                <h2>ログイン</h2>
            </div>
            {#if data.user && data.others !== null}
                <form method="POST" action={resolve('logout')}>
                    <button type="submit" class="small secondary outline" data-testid="logout">ログアウト</button>
                </form>

                <div class="others">
                    <form method="POST" action="?/logoutOthers" use:submitting={sent}>
                        {#if confirming.armed === 0}
                            <button type="submit" class="small danger" data-testid="logout-others-confirm">ログアウトを確定</button>
                        {:else}
                            <button
                                type="button"
                                class="small secondary outline"
                                onclick={() => confirming.arm(0)}
                                data-testid="logout-others"
                            >
                                ほかの端末からもログアウト
                            </button>
                        {/if}
                    </form>
                    <Lead>
                        <span data-testid="other-sessions">
                            {data.others === 0
                                ? 'ほかにログインしている端末はありません'
                                : `この端末のほかに ${data.others} 件のログインがあります`}
                        </span>
                        {#snippet more()}
                            <p>
                                この端末のほかのログインを、誰のものでも全部終わらせます。なくした端末や手放した端末を止めるときに使います。
                                終わらせた端末は、次に開いたときにログインし直しになります。
                            </p>
                            <p>
                                テレビのアプリは止まりません。テレビは
                                <a href={`${resolve('settings/integrations')}#tv`}>テレビのアプリ</a>で1台ずつ取り消します。
                            </p>
                        {/snippet}
                    </Lead>
                </div>
            {:else}
                <!-- 素通し (TRUSTED_NETWORKS) で入っている。控えが無いので、切るものも無い -->
                <p class="small muted" data-testid="login-none">
                    ログインせずに使っています (信頼するネットワークから入っているため)。ログアウトするものはありません
                </p>
            {/if}
        </section>
    </div>
</div>

<div class="part" id="version" data-part>
    <div class="sections readable">
        <!--
            **動いている版と、新しい版が出ているか。** 新しい版はヘッダーにも出す (`server/update.ts`)。
            main のイメージと手元は `dev` で、リリースと見比べない
        -->
        <section class="section" data-testid="version-card">
            <div class="section-head">
                <h2>バージョン</h2>
            </div>
            <p class="small" data-testid="version">
                {data.version === 'dev' ? '開発版 (dev)' : data.version}
            </p>
            {#if data.update !== null}
                <Lead>
                    <a href={data.update.url} target="_blank" rel="noopener noreferrer" data-testid="version-update">
                        {data.update.version} が公開されています
                    </a>
                </Lead>
            {:else if data.version === 'dev'}
                <Lead>開発版なので、新しいリリースとは見比べません</Lead>
            {:else}
                <Lead>新しい版が出たら、こことヘッダーに出ます</Lead>
            {/if}
        </section>
    </div>
</div>

<style>
    .section form {
        margin: 0;
    }
    .others {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--dp-space-2);
    }
    .theme-choices {
        display: flex;
        flex-wrap: wrap;
        gap: var(--dp-space-2) var(--dp-space-4);
    }
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
