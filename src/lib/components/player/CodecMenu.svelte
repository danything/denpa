<script lang="ts">
    import { LIVE_CODECS, type LiveCodec } from '#lib/live.js';
    import ControlButton from './ControlButton.svelte';
    import OverlayMenu from './OverlayMenu.svelte';

    /**
     * エンコード方式 (コーデック) の切り替え。**ライブ・追っかけ・観る画面で同じもの。**
     *
     * 絵の中身ではなく「その端末で出るかどうか」の話なので、音声とは別に並べる。
     * 押すと再エンコードになるので絵が一瞬止まるが、前の絵を貼ったまま差し替わる。
     *
     * `onraw` を渡すと (ライブだけ) 末尾に **MPEG-2** が並ぶ。エンコードせずに放送そのままを
     * この端末でデコードする道 (docs/stream.md §5.5)
     *
     * `unavailable` に挙げた形は、並べるが押せない (互換モードでこの端末が描けない形。
     * `live-player.svelte.ts` の `unavailable`)
     *
     * `choices` を渡すと (観る画面) その並びをそのまま出す。録画ごとに観られるものが違い、
     * 「自動」も並ぶため (`ts/playback.ts` の `codecChoices`)。`disabled` を立てたものは並べるが押せない
     * (互換モードでこの端末が描けない形。`canvasChoices`)
     */
    let {
        testid,
        codec = 'h264',
        onselect,
        raw = false,
        onraw,
        unavailable = [],
        choices,
        selected,
        onpick,
    }: {
        testid: string;
        codec?: LiveCodec;
        onselect?: (codec: LiveCodec) => void;
        /** いま生で見ているか */
        raw?: boolean;
        onraw?: () => void;
        /** この端末では表示できない形 */
        unavailable?: LiveCodec[];
        /** 並べるもの (観る画面)。渡せば LIVE_CODECS の代わりにこれ */
        choices?: { key: string; label: string; disabled?: boolean }[];
        /** `choices` のうち選ばれているもの */
        selected?: string;
        onpick?: (key: string) => void;
    } = $props();

    const MPEG2 = 'mpeg2';
    const current = $derived(raw ? MPEG2 : codec);
    const items = $derived(
        choices !== undefined
            ? choices.map((c) => ({
                  key: c.key,
                  label: c.disabled === true ? `${c.label} (この端末では表示できません)` : c.label,
                  active: c.key === selected,
                  disabled: c.disabled === true,
              }))
            : [
                  ...LIVE_CODECS.map((c) => {
                      const off = unavailable.includes(c.id);
                      return {
                          key: c.id as string,
                          label: off ? `${c.label} (この端末では表示できません)` : c.label,
                          active: c.id === current,
                          disabled: off,
                      };
                  }),
                  ...(onraw ? [{ key: MPEG2, label: 'MPEG-2', active: raw }] : []),
              ],
    );
    /** 口に出す名前。注記は付けない */
    const shownLabel = $derived(
        choices !== undefined
            ? (choices.find((c) => c.key === selected)?.label ?? choices[0]?.label ?? '')
            : current === MPEG2
              ? 'MPEG-2'
              : (LIVE_CODECS.find((c) => c.id === current)?.label ?? 'H.264'),
    );

    function pick(key: string): void {
        if (choices !== undefined) onpick?.(key);
        else if (key === MPEG2) onraw?.();
        else onselect?.(key as LiveCodec);
    }
</script>

<OverlayMenu {testid} attrName="codec" {items} onselect={pick}>
    {#snippet trigger()}
        <ControlButton label="画質 (コーデック) を選ぶ" {testid}>
            <span style="font-size: 0.75rem; font-weight: 600">
                {shownLabel}
            </span>
        </ControlButton>
    {/snippet}
</OverlayMenu>
