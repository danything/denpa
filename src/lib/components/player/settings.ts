import { LIVE_CODECS, type LiveCodec } from '#lib/live.js';
import type { IconShape } from './icons';

/**
 * 再生の設定 (⚙ `SettingsMenu`) に並べるもの。**3画面 (ライブ・追っかけ・観る画面) で同じ形。**
 *
 * - 選ぶもの (`SettingChoice`) … 行にいまの値を出し、押すと選択肢の並びに入る (コーデック・音声)
 * - 切り替え (`SettingToggle`) … 行を押すとその場でオン/オフ (CMスキップ・アンビエントモード・バックグラウンド再生)
 *
 * 何を覚えるか (端末ごと) は今までどおり各画面と `ambient.svelte.ts`・`background.svelte.ts` が持つ。ここは並べ方だけ
 */
export interface SettingOption {
    key: string | number;
    label: string;
    /** いま選ばれているか (`aria-checked`) */
    active: boolean;
    /** 並べるが押せない (互換モードでこの端末が描けない形式) */
    disabled?: boolean;
}

export interface SettingChoice {
    /** testid の後ろ (`{prefix}-{id}`、選択肢は `{prefix}-{id}-option`) と、選択肢の `data-{id}` */
    id: string;
    label: string;
    icon: IconShape;
    /** 行に出すいまの値。注記 (再生できません) は付けない */
    value: string;
    options: SettingOption[];
    pick: (key: string | number) => void;
}

export interface SettingToggle {
    id: string;
    label: string;
    icon: IconShape;
    on: boolean;
    toggle: () => void;
}

/** 押せない形式に添える注記 (docs/writing.md「同じことは同じ文言で」) */
function unplayable(label: string, disabled: boolean): string {
    return disabled ? `${label} (再生できません)` : label;
}

const MPEG2 = 'mpeg2';

/**
 * ライブと追っかけのコーデック。押すと再エンコードになるので映像が一瞬止まるが、前の映像を貼ったまま差し替わる。
 *
 * `onraw` を渡すと (ライブだけ) 末尾に **MPEG-2** が並ぶ。エンコードせずに放送そのままを
 * この端末でデコードする経路 (docs/stream.md#放送そのままmpeg-2を送る)。
 * `unavailable` に挙げた形式は、並べるが押せない (`live-player.svelte.ts` の `unavailable`)
 */
export function liveCodecs(opts: {
    icon: IconShape;
    codec: LiveCodec;
    raw?: boolean;
    unavailable: LiveCodec[];
    onselect: (codec: LiveCodec) => void;
    onraw?: () => void;
}): SettingChoice {
    const raw = opts.raw === true;
    const current = raw ? MPEG2 : opts.codec;
    return {
        id: 'codec',
        label: 'コーデック',
        icon: opts.icon,
        value: raw ? 'MPEG-2' : (LIVE_CODECS.find((c) => c.id === current)?.label ?? 'H.264'),
        options: [
            ...LIVE_CODECS.map((c) => {
                const off = opts.unavailable.includes(c.id);
                return {
                    key: c.id as string,
                    label: unplayable(c.label, off),
                    active: c.id === current,
                    disabled: off,
                };
            }),
            ...(opts.onraw ? [{ key: MPEG2, label: 'MPEG-2', active: raw }] : []),
        ],
        pick: (key) => {
            if (key === MPEG2) opts.onraw?.();
            else opts.onselect(key as LiveCodec);
        },
    };
}

/**
 * 観る画面のコーデック。録画ごとに観られるものが違い、「自動」も並ぶので、並びは渡されたまま
 * (`ts/playback.ts` の `codecChoices`)。`disabled` は互換モードでこの端末が描けない形式 (`canvasChoices`)
 */
export function recordingCodecs(opts: {
    icon: IconShape;
    choices: { key: string; label: string; disabled?: boolean }[];
    selected: string;
    onpick: (key: string) => void;
}): SettingChoice {
    return {
        id: 'codec',
        label: 'コーデック',
        icon: opts.icon,
        value: (opts.choices.find((c) => c.key === opts.selected) ?? opts.choices[0])?.label ?? '',
        options: opts.choices.map((c) => ({
            key: c.key,
            label: unplayable(c.label, c.disabled === true),
            active: c.key === opts.selected,
            disabled: c.disabled === true,
        })),
        pick: (key) => opts.onpick(String(key)),
    };
}

/**
 * 音声 (主音声・副音声・解説など)。二カ国語も多重音声も、見ている人には「音声を選ぶ」1つの操作。
 * 選べるものが2つ以上あるときだけ渡す — 何が「選べるもの」かは画面ごとに違う
 * (ライブは再エンコードで切り替え、録画はコンテナの中から選ぶ)
 */
export function audioTracks<T extends string | number>(opts: {
    icon: IconShape;
    items: { key: T; label: string; active: boolean }[];
    onselect: (key: T) => void;
}): SettingChoice {
    return {
        id: 'audio',
        label: '音声',
        icon: opts.icon,
        value: opts.items.find((item) => item.active)?.label ?? '',
        options: opts.items,
        pick: (key) => opts.onselect(key as T),
    };
}
