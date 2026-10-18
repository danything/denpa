<script lang="ts">
    /**
     * **運転中の注意** (互換モード。`canvas-video.ts`)。
     *
     * 出すのは2か所: 設定画面で互換モードを入れたとき (取消もできる) と、UA の既定で入っている
     * 端末 (テスラ) で初めて canvas で再生する前 (ライブ。押すまで再生を始めない)。
     * 押したら覚えて、二度目からは出さない (`seeDriveNotice`。覚えるのは呼ぶ側)。
     *
     * 窓は `<dialog>` を `showModal` で開く — 後ろを押させない・Esc で閉じる (取消と同じ扱い)。
     * 見た目は番組の詳細と同じ浮かぶ箱 (`app.css` の `.modal-box`・`.modal-actions`)。
     * 開いたらフォーカスは箱に置く — 最初のボタン (取消) に置くと、押していないのに枠が付いて見える。
     * Tab で次はボタンへ進み、後ろへは出ない (モーダルの dialog なので)
     */
    let {
        open,
        onaccept,
        oncancel,
    }: {
        open: boolean;
        onaccept: () => void;
        /** 渡すと「取消」を出す (設定画面)。渡さなければ「わかりました」だけ (再生の前) */
        oncancel?: () => void;
    } = $props();

    let dialog = $state<HTMLDialogElement | null>(null);
    let box = $state<HTMLElement | null>(null);

    $effect(() => {
        if (dialog === null) return;
        if (open && !dialog.open) {
            dialog.showModal();
            box?.focus();
        } else if (!open && dialog.open) dialog.close();
    });

    /** Esc。取消があれば取消、無ければ閉じさせない (押すまで再生を始めない) */
    function cancel(event: Event): void {
        event.preventDefault();
        oncancel?.();
    }
</script>

<dialog bind:this={dialog} oncancel={cancel} data-testid="drive-notice" aria-labelledby="drive-notice-title">
    <article class="modal-box" bind:this={box} tabindex="-1">
        <h2 id="drive-notice-title">走行中は画面を見ないでください</h2>
        <p>運転中に画面を注視することは法律で禁じられています。</p>
        <footer class="modal-actions">
            {#if oncancel}
                <button type="button" class="secondary" onclick={oncancel} data-testid="drive-notice-cancel">取消</button>
            {/if}
            <button type="button" onclick={onaccept} data-testid="drive-notice-accept">わかりました</button>
        </footer>
    </article>
</dialog>

<style>
    /* 短い知らせなので、番組の詳細より狭く */
    .modal-box {
        max-width: 28rem;
    }
    h2 {
        margin-bottom: var(--dp-space-3);
        font-size: var(--dp-text-lg);
    }
    p {
        margin: 0;
    }
</style>
