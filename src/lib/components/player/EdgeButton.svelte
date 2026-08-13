<script lang="ts">
    import { OVERLAY, OVERLAY_BTN, OVERLAY_DANGER } from './icons';

    /**
     * 「今」へ張り付くボタン — ライブの「ライブ」と追っかけの「最新」。
     * 張り付いている間は赤 (`OVERLAY_DANGER`)、離れていれば黒地に赤丸。
     * 文字は焼き方のボタンと同じ大きさで、幅は詰める (btn-lg のままだと
     * 帯の中でこれだけ太って見えた)
     */
    let {
        active,
        label,
        onclick,
        testid,
    }: {
        /** 張り付いているか (放送の今・録れている際) */
        active: boolean;
        label: string;
        onclick: () => void;
        testid: string;
    } = $props();
</script>

<button
    type="button"
    class="{OVERLAY_BTN} gap-1 px-3 {active ? OVERLAY_DANGER : OVERLAY}"
    {onclick}
    data-testid={testid}
>
    <span class="inline-block size-2 rounded-full {active ? 'bg-white' : 'bg-error'}"></span>
    <span class="text-xs font-semibold">{label}</span>
</button>
