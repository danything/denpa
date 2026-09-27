<script lang="ts">
    import { LIVE_CODECS, type LiveCodec } from '$lib/live';
    import ControlButton from './ControlButton.svelte';
    import OverlayMenu from './OverlayMenu.svelte';

    /**
     * 焼き方 (コーデック) の切り替え。**ライブと追っかけで同じもの。**
     *
     * 絵の中身ではなく「その端末で出るかどうか」の話なので、音声とは別に並べる。
     * 押すと焼き直しになるので絵が一瞬止まるが、前の絵を貼ったまま差し替わる。
     *
     * `onraw` を渡すと (ライブだけ) 末尾に **MPEG-2** が並ぶ。焼かずに放送そのままを
     * この端末で解く道 (docs/stream.md §5.5)
     */
    let {
        testid,
        codec,
        onselect,
        raw = false,
        onraw,
    }: {
        testid: string;
        codec: LiveCodec;
        onselect: (codec: LiveCodec) => void;
        /** いま生で見ているか */
        raw?: boolean;
        onraw?: () => void;
    } = $props();

    const MPEG2 = 'mpeg2';
    const current = $derived(raw ? MPEG2 : codec);
    const items = $derived([
        ...LIVE_CODECS.map((c) => ({ key: c.id as string, label: c.label, active: c.id === current })),
        ...(onraw ? [{ key: MPEG2, label: 'MPEG-2', active: raw }] : []),
    ]);
</script>

<OverlayMenu
    {testid}
    attrName="codec"
    {items}
    onselect={(key) => (key === MPEG2 ? onraw?.() : onselect(key as LiveCodec))}
>
    {#snippet trigger()}
        <ControlButton label="画質 (コーデック) を選ぶ" {testid}>
            <span style="font-size: 0.75rem; font-weight: 600">
                {items.find((item) => item.active)?.label ?? 'H.264'}
            </span>
        </ControlButton>
    {/snippet}
</OverlayMenu>
