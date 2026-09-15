<script lang="ts" module>
    export interface Notice {
        /** どの知らせか。テストの目印も兼ねる (`data-testid`) */
        key: string;
        /** 見た目。error だけは自分では消えない */
        kind: 'error' | 'info' | 'success';
        text: string;
    }

    /**
     * `form?.message` (fail の言葉) をトーストの形に。無ければ空。
     * どの画面も同じ1行を書いていたので、綴りをここに1本化した。
     * スプレッドでも `push(...)` でもそのまま混ぜられるよう、配列で返す
     */
    export function errorNotice(form: unknown, key: string): Notice[] {
        if (form === null || typeof form !== 'object' || !('message' in form)) return [];
        const { message } = form as { message: unknown };
        if (typeof message !== 'string' || message === '') return [];
        return [{ key, kind: 'error', text: message }];
    }
</script>

<script lang="ts">
    import { untrack } from 'svelte';

    /**
     * 操作の結果を画面の右下に浮かせて出す。
     *
     * **本文の上に差し込まない。** 一覧の上に置くと、知らせが出た分だけ表が下へずれ、
     * 画面からはみ出して外側にスクロールバーが生えていた。読み終わって消えると
     * 今度は逆に飛び上がる。浮かせておけば、下の内容は動かない。
     *
     * 出す場所を1箇所に決めておくのは、画面ごとに違う場所へ出ていると
     * 「どこを見れば結果が分かるのか」が覚えられないため。
     *
     * **ここに出すのは「押した結果」だけ。** 「スキャンに失敗しました」のような
     * *状態*は、そのカードの中に出したままにする (浮かせて消してしまうと、
     * あとから画面を開いた人には何も見えない)。
     */
    let {
        notices,
        source,
    }: {
        notices: Notice[];
        /**
         * この知らせの出どころ (たいてい `form`)。**同一性だけ見る。**
         *
         * 同じ操作を2回した結果は文面まで同じになるので、文面で見分けると
         * 「一度閉じたらもう二度と出ない」ことになる。SvelteKit は返事が来るたびに
         * 新しい `form` を渡してくるので、それが変わったら閉じたことは忘れる
         */
        source?: unknown;
    } = $props();

    /** 自分で消える時間。読み切れるだけ出したら引っ込める */
    const AUTO_HIDE = 6000;

    /** 閉じられた知らせ。key で覚える */
    let dismissed = $state<string[]>([]);

    // 新しい返事が来たら、閉じたことは忘れて出し直す
    $effect(() => {
        void source;
        dismissed = [];
    });

    /** 中身が変わったときだけ数え直す (親が描き直すたびに countdown を戻さない) */
    const ids = $derived(notices.map((notice) => notice.key).join('\n'));
    $effect(() => {
        void ids;
        const timers = untrack(() => notices)
            // 失敗は自分では消さない。読み終わる前に消えると、何が起きたのか分からなくなる
            .filter((notice) => notice.kind !== 'error')
            .map((notice) => setTimeout(() => dismiss(notice.key), AUTO_HIDE));
        return () => {
            for (const timer of timers) clearTimeout(timer);
        };
    });

    function dismiss(key: string): void {
        if (!dismissed.includes(key)) dismissed = [...dismissed, key];
    }

    const shown = $derived(notices.filter((notice) => !dismissed.includes(notice.key)));

    /** 見た目は app.scss の notice(error / info / success) */
    const STYLE: Record<Notice['kind'], string> = {
        error: 'error',
        info: 'info',
        success: 'success',
    };
</script>

{#if shown.length > 0}
    <!-- 右下に浮かせる。z-index はモーダル(60)の下・本文の上 -->
    <div class="toasts">
        {#each shown as notice (notice.key)}
            <div class="notice {STYLE[notice.kind]} toast" data-testid={notice.key}>
                <span class="text">{notice.text}</span>
                <button type="button"
                    class="ghost xs close"
                    onclick={() => dismiss(notice.key)}
                    aria-label="閉じる"
                    data-testid="{notice.key}-close"
                >
                    ✕
                </button>
            </div>
        {/each}
    </div>
{/if}

<style>
    .toasts {
        position: fixed;
        right: 1rem;
        bottom: 1rem;
        z-index: 50;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.5rem;
        max-width: min(28rem, calc(100vw - 2rem));
    }
    .toast {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        border: 1px solid var(--dp-base-300);
        box-shadow: 0 10px 25px rgb(0 0 0 / 0.35);
    }
    .text {
        white-space: pre-wrap;
    }
    .close {
        flex: none;
        border-radius: 999px;
    }
</style>
