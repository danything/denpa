/**
 * 要素の見た目を決める (重ね合わせ)。**決めた値は確かめた数と列挙だけ。**
 *
 * 重ねる順 (後が勝つ):
 *
 * 1. 既定のスタイル (STD-B24 付属2 の既定のスタイルシートのうち、放送が頼るもの)
 * 2. 文書の style 要素・link の規則 (詳細度 → 順番。`!important` は別に重ねて上に)。フォーカス中は
 *    `:focus` の規則も同じ並びに入れる (押されている間は `:active`)。`#a` は `p:focus` に勝つ
 * 3. style 属性と、スクリプトが `normalStyle` に書いたもの
 * 4. フォーカス中は `focusStyle` に書いたもの (押されている間は `activeStyle`)
 * 5. 既定のスタイルの `!important` (div・object の padding 0 など)
 *
 * 継ぐもの (色・字・行の高さ・揃え・字間・見える見えない) は親の値を継ぐ。
 */

import type { Declaration } from './css';

/** 特性の生の値 (`normalStyle.left` が返すもの)。名前は CSS の書き方 */
export type Declarations = Map<string, string>;

export type State = 'normal' | 'focus' | 'active';

/** 決まった見た目 */
export interface Computed {
    left: number;
    top: number;
    width: number;
    height: number;
    visible: boolean;
    colorIndex: number;
    backgroundColorIndex: number;
    /** 文字の縁 (DRCS の中間の 2 階調) [濃い, 薄い] */
    grayscale: [number, number];
    borderWidth: number;
    borderStyle: string;
    /** 上・右・下・左 */
    borderColorIndex: [number, number, number, number];
    padding: [number, number, number, number];
    fontSize: number;
    /** 丸ゴシック・太丸ゴシック・角ゴシック */
    fontFamily: string;
    fontWeight: 'normal' | 'bold';
    /** px。normal なら null */
    lineHeight: number | null;
    textAlign: 'left' | 'center' | 'right' | 'justify';
    letterSpacing: number;
    backgroundImage: string | null;
    /** CSS の色で書いた背景・字の色 (C プロファイルの書き方。#rgb / #rrggbb だけ受ける) */
    backgroundColor: string | null;
    color: string | null;
    navIndex: number | null;
    navUp: number | null;
    navDown: number | null;
    navLeft: number | null;
    navRight: number | null;
    usedKeyList: string[];
    clut: string | null;
    resolution: string | null;
    displayAspectRatio: string | null;
}

/** 継ぐ特性 */
const INHERITED = new Set([
    'color-index',
    'color',
    'grayscale-color-index',
    'font-size',
    'font-family',
    'font-weight',
    'line-height',
    'text-align',
    'letter-spacing',
    'visibility',
]);

/**
 * 既定のスタイル (web-bml の default_css.ts から、放送が頼るものだけ)。
 * 文字の色は規格では受信機しだい。テレビの画面に合わせて白 (7) にする
 */
const DEFAULTS: Record<string, [string, string][]> = {
    '*': [['used-key-list', 'basic data-button']],
    body: [
        ['background-color-index', '0'],
        ['resolution', '960x540'],
        ['visibility', 'visible'],
        ['color-index', '7'],
        ['font-family', '丸ゴシック'],
        ['font-size', '24px'],
        ['line-height', 'normal'],
        ['grayscale-color-index', '30 15'],
    ],
    div: [['background-color-index', '8']],
    p: [
        ['background-color-index', '8'],
        ['font-family', '丸ゴシック'],
        ['font-size', '24px'],
        ['text-align', 'left'],
        ['grayscale-color-index', '30 15'],
    ],
    span: [['background-color-index', '8']],
    a: [['background-color-index', '8']],
    input: [['background-color-index', '8']],
    object: [['background-color-index', '8']],
};

const ZERO_PADDING: [string, string][] = ['top', 'right', 'bottom', 'left'].map((side) => [
    `padding-${side}`,
    '0',
]);

/** span・a は見える見えないを必ず継ぐ (既定のスタイルの `visibility: inherit !important`) */
const FORCED: Record<string, [string, string][]> = {
    span: [
        ['visibility', 'inherit'],
        ['letter-spacing', 'inherit'],
    ],
    a: [
        ['visibility', 'inherit'],
        ['letter-spacing', 'inherit'],
    ],
    body: [['visibility', 'visible'], ...ZERO_PADDING],
    div: ZERO_PADDING,
    object: [...ZERO_PADDING, ['border-width', '0'], ['border-style', 'none']],
};

/** 短い書き方を開く */
export function expand(property: string, value: string): [string, string][] {
    switch (property) {
        case 'padding': {
            const parts = value.split(/\s+/);
            const [t, r = t, b = t, l = r] = parts;
            return [
                ['padding-top', t!],
                ['padding-right', r!],
                ['padding-bottom', b!],
                ['padding-left', l!],
            ];
        }
        case 'border-color-index':
            return ['top', 'right', 'bottom', 'left'].map((side) => [`border-${side}-color-index`, value]);
        default:
            return [[property, value]];
    }
}

/** 重ねる元。要素ごとに当たった規則を状態ごとに持つ */
export interface Cascade {
    tag: string;
    rules: Record<State, Declaration[]>;
    inline: Record<State, Declarations>;
    state: State;
    parent: Cascade | null;
}

/**
 * 生の値を重ねる。返すのは「この要素で効いている値」(継ぐものは親から引いてくる前)。
 * `state` を渡すと、その状態のときの値 (`focusStyle` の読み出し)
 */
export function declared(node: Cascade, state: State = node.state): Declarations {
    const out: Declarations = new Map();
    const important = new Set<string>();
    const put = (property: string, value: string, isImportant: boolean): void => {
        for (const [name, v] of expand(property, value)) {
            if (important.has(name) && !isImportant) continue;
            if (isImportant) important.add(name);
            out.set(name, v);
        }
    };
    for (const [p, v] of DEFAULTS['*']!) put(p, v, false);
    for (const [p, v] of DEFAULTS[node.tag] ?? []) put(p, v, false);
    // 状態の規則は、ふつうの規則と詳細度で並べ直したものを持っている (document.ts の applyRules)
    for (const [p, v, i] of node.rules[state]) put(p, v, i);
    for (const [p, v] of node.inline.normal) put(p, v, false);
    if (state !== 'normal') for (const [p, v] of node.inline[state]) put(p, v, false);
    for (const [p, v] of FORCED[node.tag] ?? []) put(p, v, true);
    return out;
}

/** 生の値を決めた値に (継ぐものは親から)。親の値は `parentValue` で引く */
export function resolved(node: Cascade, property: string, state: State = node.state): string | null {
    const value = declared(node, state).get(property);
    if (value !== undefined && value.toLowerCase() !== 'inherit') return value.trim();
    if ((value !== undefined || INHERITED.has(property)) && node.parent !== null) {
        return resolved(node.parent, property);
    }
    return null;
}

/** `10px` / `10` (px は書かなくてよい) */
export function parsePx(value: string | null): number | null {
    if (value === null) return null;
    const match = /^(-?\d+)(?:px)?$/i.exec(value.trim());
    return match === null ? null : Number(match[1]);
}

function parseIndex(value: string | null, fallback: number): number {
    const n = value === null ? Number.NaN : Number(value.trim());
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : fallback;
}

function parseNav(value: string | null): number | null {
    const n = value === null ? Number.NaN : Number(value.trim());
    return Number.isInteger(n) && n >= 0 && n <= 32767 ? n : null;
}

/** 枠の線の種類。**列挙のどれかだけ** (放送の文字列をそのまま CSS に入れない) */
const BORDER_STYLES = new Set([
    'none',
    'hidden',
    'solid',
    'dashed',
    'dotted',
    'double',
    'groove',
    'ridge',
    'inset',
    'outset',
]);
function borderStyle(value: string | null): string {
    const style = (value ?? 'none').toLowerCase();
    return BORDER_STYLES.has(style) ? style : 'none';
}

function hexColor(value: string | null): string | null {
    return value !== null && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : null;
}

function unquote(value: string): string {
    return value.trim().replace(/^(["'])(.*)\1$/, '$2');
}

/** 決めた見た目。継ぐものは親の決めた見た目から */
export function compute(node: Cascade, parent: Computed | null, state: State = node.state): Computed {
    const own = declared(node, state);
    // 継がない特性の inherit は、親の効いている値をそのまま使う
    for (const [property, value] of own) {
        if (value.trim().toLowerCase() !== 'inherit' || INHERITED.has(property)) continue;
        const from = node.parent === null ? null : resolved(node.parent, property);
        if (from === null) own.delete(property);
        else own.set(property, from);
    }
    const get = (property: string): string | null => {
        const value = own.get(property);
        if (value !== undefined && value.trim().toLowerCase() !== 'inherit') return value.trim();
        return null;
    };
    /** 継ぐか (値が無い・inherit のとき親の値を使う) */
    const inherits = (property: string): boolean => {
        const value = own.get(property);
        return (
            parent !== null &&
            (value === undefined ? INHERITED.has(property) : value.trim().toLowerCase() === 'inherit')
        );
    };
    const px = (property: string, fallback: number): number => parsePx(get(property)) ?? fallback;
    const grayscale = (): [number, number] => {
        const parts = (get('grayscale-color-index') ?? '').split(/\s+/).map(Number);
        return parts.length === 2 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
            ? [parts[0]!, parts[1]!]
            : [30, 15];
    };
    const align = (get('text-align') ?? '').toLowerCase();
    const weight = (get('font-weight') ?? '').toLowerCase();
    const lineHeight = get('line-height');
    const background = get('background-image');
    return {
        left: px('left', 0),
        top: px('top', 0),
        width: px('width', 0),
        height: px('height', 0),
        visible: inherits('visibility')
            ? parent!.visible
            : (get('visibility') ?? 'visible').toLowerCase() !== 'hidden',
        colorIndex: inherits('color-index') ? parent!.colorIndex : parseIndex(get('color-index'), 7),
        backgroundColorIndex: parseIndex(get('background-color-index'), 8),
        grayscale: inherits('grayscale-color-index') ? parent!.grayscale : grayscale(),
        borderWidth: px('border-width', 0),
        borderStyle: borderStyle(get('border-style')),
        borderColorIndex: (['top', 'right', 'bottom', 'left'] as const).map((side) =>
            parseIndex(get(`border-${side}-color-index`), 0),
        ) as [number, number, number, number],
        padding: (['top', 'right', 'bottom', 'left'] as const).map((side) => px(`padding-${side}`, 0)) as [
            number,
            number,
            number,
            number,
        ],
        fontSize: inherits('font-size') ? parent!.fontSize : px('font-size', 24),
        fontFamily: inherits('font-family')
            ? parent!.fontFamily
            : unquote(get('font-family') ?? '丸ゴシック'),
        fontWeight: inherits('font-weight') ? parent!.fontWeight : weight === 'bold' ? 'bold' : 'normal',
        lineHeight: inherits('line-height') ? parent!.lineHeight : parsePx(lineHeight),
        textAlign: inherits('text-align')
            ? parent!.textAlign
            : align === 'center' || align === 'right' || align === 'justify'
              ? align
              : 'left',
        letterSpacing: inherits('letter-spacing') ? parent!.letterSpacing : px('letter-spacing', 0),
        backgroundImage: background === null || background.toLowerCase() === 'none' ? null : background,
        backgroundColor: hexColor(get('background-color')),
        color: inherits('color') ? parent!.color : hexColor(get('color')),
        navIndex: parseNav(get('nav-index')),
        navUp: parseNav(get('nav-up')),
        navDown: parseNav(get('nav-down')),
        navLeft: parseNav(get('nav-left')),
        navRight: parseNav(get('nav-right')),
        usedKeyList: (get('used-key-list') ?? '').split(/\s+/).filter((key) => key !== ''),
        clut: get('clut'),
        resolution: get('resolution'),
        displayAspectRatio: get('display-aspect-ratio'),
    };
}
