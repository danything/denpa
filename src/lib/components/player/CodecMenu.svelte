<script lang="ts">
    import { LIVE_CODECS, type LiveCodec } from '$lib/live';
    import ControlButton from './ControlButton.svelte';
    import OverlayMenu from './OverlayMenu.svelte';

    /**
     * 焼き方 (コーデック) の切り替え。**ライブと追っかけで同じもの。**
     *
     * 絵の中身ではなく「その端末で出るかどうか」の話なので、音声とは別に並べる。
     * 押すと焼き直しになるので絵が一瞬止まるが、前の絵を貼ったまま差し替わる
     */
    let {
        testid,
        codec,
        onselect,
    }: {
        testid: string;
        codec: LiveCodec;
        onselect: (codec: LiveCodec) => void;
    } = $props();
</script>

<OverlayMenu
    {testid}
    attrName="codec"
    menuClass="w-36 text-base"
    items={LIVE_CODECS.map((c) => ({ key: c.id, label: c.label, active: c.id === codec }))}
    {onselect}
>
    {#snippet trigger()}
        <ControlButton label="焼き方を選ぶ" {testid}>
            <span class="text-xs font-semibold">
                {LIVE_CODECS.find((c) => c.id === codec)?.label ?? 'H.264'}
            </span>
        </ControlButton>
    {/snippet}
</OverlayMenu>
