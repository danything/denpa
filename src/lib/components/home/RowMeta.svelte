<script lang="ts">
    /**
     * 局名・尺・サイズ。1行にまとめて、空のものは出さない。
     * 局ロゴは**まだ取得できていない局では何も出さない** (ServiceLogo)。
     * 局名は放送から来た字なので放送の字 (`.broadcast`)。残りはこちらで書いた字。
     *
     * **何でこの1本が立ったのか** (`rule`)。要らないものが混ざっていたときに直す先 (どのルールか) が分かるよう、
     * ルール名をそのままルールの編集への入口にする。手動予約は、録れたもの (後から見返すもの) にだけ書く
     */
    import ServiceLogo from '#lib/components/ServiceLogo.svelte';
    import { resolve } from '$app/paths';

    let {
        service,
        parts,
        row,
        rule,
        excerpt = '',
    }: {
        service: string;
        parts: string[];
        row: { service_id: number; has_logo: boolean | null };
        rule: { rule_id: number | null; rule_name: string | null } | 'manual' | null;
        /** 残りの幅を埋める番組の説明の頭 (1行で「…」まで。狭い画面では出さない) */
        excerpt?: string;
    } = $props();
    const rest = $derived(parts.filter(Boolean).join(' ・ '));
</script>

<div class="row-meta">
    <ServiceLogo
        id={row.service_id}
        has={row.has_logo}
        style="height: 1rem; margin-right: 0.375rem; vertical-align: -0.1875rem"
    />
    <span><span class="broadcast">{service}</span>{service && rest ? ' ・ ' : ''}<span class="num">{rest}</span></span>
    {#if rule === 'manual'}
        <span class="t-rule"> ・ <span data-testid="rule-name">手動予約</span></span>
    {:else if rule !== null}
        <span class="t-rule">
            ・
            <span data-testid="rule-name">
                ルール:
                {#if rule.rule_id !== null}
                    <a href={resolve(`search?rule=${rule.rule_id}`)} title={rule.rule_name ?? undefined}>{rule.rule_name}</a>
                {:else}
                    (削除済み)
                {/if}
            </span>
        </span>
    {/if}
    {#if excerpt}<span class="t-excerpt broadcast"> — {excerpt}</span>{/if}
</div>
