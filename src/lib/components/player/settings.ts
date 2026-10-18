import type { CaptionLanguage } from '#lib/caption-text.js';
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
    /**
     * 押したらメニューを閉じる (既定は閉じない)。押したあとに窓を出すもの (互換モードの運転中の注意) — 開いたままだと、
     * 窓のボタンを押した1回目がメニューの外を押したことになって、閉じるだけで終わる
     */
    closes?: boolean;
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

/**
 * 字幕 (`subtitle`)。**オフと、選べる字幕を1つの並びに。** 字幕のストリームが複数ある放送 (`tracks`。たまにある) は
 * ストリームごとに、1本の中に言語が複数ある放送 (`languages`) は言語ごとに並べる。言語が分かるのは
 * いまデコードしているストリームだけ (ほかのストリームは切り替えるまで分からない) なので、そこだけ言語に開く。
 *
 * 選んだら字幕を出す (`onoff(true)`)。ストリームを替えるのは再エンコード (`ontrack`)、言語を替えるのは
 * 出すものを替えるだけ (`onlanguage`)
 */
export function subtitles(opts: {
    icon: IconShape;
    on: boolean;
    /** 字幕のストリーム (ライブ・追っかけ)。観る画面は1本なので省く */
    tracks?: { index: number; label: string }[];
    track?: number;
    languages: CaptionLanguage[];
    language: number;
    onoff: (on: boolean) => void;
    ontrack?: (index: number) => void;
    onlanguage: (index: number) => void;
}): SettingChoice {
    const tracks = opts.tracks ?? [];
    const current = opts.track ?? 0;
    const languages = opts.languages.length > 1 ? opts.languages : [];
    const options: SettingOption[] = [{ key: 'off', label: 'オフ', active: !opts.on }];
    const one = (key: string, label: string, active: boolean) =>
        options.push({ key, label, active: opts.on && active });
    if (tracks.length > 1) {
        for (const t of tracks) {
            if (t.index === current && languages.length > 0) {
                for (const l of languages)
                    one(`${t.index}:${l.index}`, `${t.label} ${l.label}`, opts.language === l.index);
            } else {
                one(`${t.index}:0`, t.label, t.index === current);
            }
        }
    } else if (languages.length > 0) {
        for (const l of languages) one(`${current}:${l.index}`, l.label, opts.language === l.index);
    } else {
        // 選ぶものが無い (言語が1つだけ・まだ分からない)。出すか消すかだけ
        const only = opts.languages[0];
        one(`${current}:0`, only !== undefined && only.code !== '' ? only.label : 'オン', true);
    }
    const chosen = options.find((o) => o.active && o.key !== 'off');
    return {
        id: 'subtitle',
        label: '字幕',
        icon: opts.icon,
        value: opts.on ? (chosen?.label ?? 'オン') : 'オフ',
        options,
        pick: (key) => {
            if (key === 'off') return opts.onoff(false);
            const [track = current, language = 0] = String(key).split(':').map(Number);
            opts.onoff(true);
            if (track !== current) opts.ontrack?.(track);
            else if (language > 0) opts.onlanguage(language);
        },
    };
}
