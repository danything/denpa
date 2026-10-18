<!--
    断られたとき・無かったときの画面 (`error(404, …)` など)。

    SvelteKit の素の画面は「404」と理由の1行が左上に置かれるだけで、**戻る手段が無かった**。
    消した録画のリンク (410) を開いた人は、ヘッダーから行き先を選び直すしかない。
    ログアウト・ペアリングと同じ真ん中の1枚 (`.solo`) にして、一覧へ戻るボタンを置く。

    理由はサーバが書いた言葉 (「この録画は削除されています」) をそのまま見出しにする。
    番号は小さく添えるだけ — 人が読むのは言葉のほう
-->

<script lang="ts">
    import { resolve } from '$app/paths';
    import { page } from '$app/state';

    /** 理由が書かれていなければ、番号から言う (素の `Not Found` は英語なので使わない) */
    const FALLBACK: Record<number, string> = {
        404: 'ページが見つかりません',
        410: 'もうありません',
    };
    /** 次に何をすればよいか。番号ごとに1行 */
    const HINT: Record<number, string> = {
        404: 'リンクが古いか、もう無いものを開いたのかもしれません。',
        410: '消したものは戻せません。',
    };

    const message = $derived.by(() => {
        const text = page.error?.message ?? '';
        if (text !== '' && text !== 'Not Found' && text !== 'Internal Error') return text;
        return FALLBACK[page.status] ?? 'うまく開けませんでした';
    });
    const hint = $derived(
        HINT[page.status] ??
            (page.status >= 500 ? '時間をおいて開き直してください。続くときはサーバのログに理由が出ています。' : ''),
    );
</script>

<svelte:head><title>{message} - denpa</title></svelte:head>

<div class="solo">
    <div class="panel" data-testid="error-card">
        <h1>{message}</h1>
        <p class="small muted">{hint} <span class="num">({page.status})</span></p>
        <a class="button" href={resolve('')} data-testid="error-home">録画へ戻る</a>
    </div>
</div>
