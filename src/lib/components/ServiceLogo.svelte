<script lang="ts">
    import { resolve } from '$app/paths';

    /**
     * 局ロゴ。放送波から拾ったもの (`/api/services/<id>/logo`)。録画の一覧・番組表・ライブで同じ口。
     *
     * **まだ拾えていない局** (`has` が偽) は `fallback` を出す — 文字を入れれば札 (ライブの「GR」)、
     * 空文字なら場所だけ (番組表。局名の頭が列ごとにずれないように)、省けば何も出さない
     * (一覧。行が細く、代わりの箱を置くと局名より目立つ)。
     *
     * **出せなかったときに引っ込めない** (`onerror` で消すと Svelte の節点を横から触ることになる)。
     * `alt=""` なので、出せなければ場所だけが残る = 持っていない局と同じ見た目になる
     */
    let {
        id,
        has,
        style = '',
        fallback,
    }: {
        id: number;
        has: boolean | null;
        /** 大きさと置き方。画面ごとに違う */
        style?: string;
        fallback?: string;
    } = $props();
</script>

{#if has}
    <img src={resolve(`api/services/${id}/logo`)} alt="" loading="lazy" class="logo" {style} />
{:else if fallback !== undefined}
    <span class="logo empty" {style}>{fallback}</span>
{/if}

<style>
    .logo {
        flex-shrink: 0;
        border-radius: 0.25rem;
        object-fit: contain;
    }
    .empty {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 0.75rem;
    }
    .empty:not(:empty) {
        background: var(--dp-base-300);
    }
</style>
