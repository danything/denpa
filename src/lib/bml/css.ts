/**
 * BML の CSS を読む。**ブラウザの CSS には渡さない** — 規則を読んで自分で重ね合わせ
 * ([style.ts](style.ts))、確かめた値だけを要素の style に書く ([render.ts](render.ts))。
 *
 * 放送が使うセレクタは `*`・`要素名`・`.class`・`#id`・`要素名.class` (と規格の `:focus`・
 * `:active`) だけ。子孫セレクタ・@ 規則は運用されないので、来たら読み飛ばす。
 */

export interface Selector {
    tag: string | null;
    id: string | null;
    classes: string[];
    pseudo: 'focus' | 'active' | null;
    /** 詳細度 (id 100・class と擬似クラス 10・要素名 1) */
    specificity: number;
}

/** [特性, 値, !important] */
export type Declaration = [property: string, value: string, important: boolean];

export interface Rule {
    selector: Selector;
    declarations: Declaration[];
    /** 文書の中の順番 (同じ詳細度なら後が勝つ) */
    order: number;
}

const SIMPLE = /^(\*|[a-z][a-z0-9-]*)?((?:[.#][a-zA-Z0-9_-]+)*)(?::(focus|active))?$/i;

/** 単純セレクタを読む。使えない書き方 (子孫など) なら null */
function parseSelector(text: string): Selector | null {
    const match = SIMPLE.exec(text.trim());
    if (match === null || text.trim() === '') return null;
    const tag = match[1] === undefined || match[1] === '*' ? null : match[1].toLowerCase();
    let id: string | null = null;
    const classes: string[] = [];
    for (const part of match[2]?.match(/[.#][a-zA-Z0-9_-]+/g) ?? []) {
        if (part[0] === '#') id = part.slice(1);
        else classes.push(part.slice(1));
    }
    const pseudo = (match[3]?.toLowerCase() as 'focus' | 'active' | undefined) ?? null;
    const specificity =
        (id === null ? 0 : 100) + (classes.length + (pseudo === null ? 0 : 1)) * 10 + (tag === null ? 0 : 1);
    return { tag, id, classes, pseudo, specificity };
}

/** `a: b; c: d !important` を読む。名前は小文字に */
export function parseDeclarations(text: string): Declaration[] {
    const out: Declaration[] = [];
    for (const part of stripComments(text).split(';')) {
        const colon = part.indexOf(':');
        if (colon <= 0) continue;
        const property = part.slice(0, colon).trim().toLowerCase();
        let value = part.slice(colon + 1).trim();
        let important = false;
        const bang = /!\s*important\s*$/i.exec(value);
        if (bang !== null) {
            important = true;
            value = value.slice(0, bang.index).trim();
        }
        if (property === '' || value === '') continue;
        out.push([property, value, important]);
    }
    return out;
}

function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--|-->/g, ' ');
}

/** スタイルシートを読む。`order` は `start` から振る (文書の中の複数の style の通し番号) */
export function parseStylesheet(text: string, start = 0): Rule[] {
    const rules: Rule[] = [];
    const source = stripComments(text);
    let at = 0;
    let order = start;
    while (at < source.length) {
        const open = source.indexOf('{', at);
        if (open === -1) break;
        // 余った `}` の後ろから読む (前の規則の閉じすぎ)
        const raw = source.slice(at, open);
        const head = raw.slice(raw.lastIndexOf('}') + 1).trim();
        // @ 規則 (@media など) は運用されない。`;` で終わる @ 規則は head に混ざるので落とす
        const selectorText = head.replace(/@[^;{]*;/g, '').trim();
        if (selectorText.startsWith('@')) {
            // 括弧の対応を見て終わりを探す (@ 規則の入れ子を読み飛ばす)
            let depth = 1;
            let i = open + 1;
            for (; i < source.length && depth > 0; i++) {
                if (source[i] === '{') depth++;
                else if (source[i] === '}') depth--;
            }
            at = i;
            continue;
        }
        // 本体は次の `}` まで。その前に `{` が来たら閉じ忘れ: そこまでの区切り (`;` か改行) で本体を
        // 終え、残りは次の規則として読み直す (壊れた所だけ捨てる。後ろの規則まで道連れにしない)
        const close = source.indexOf('}', open + 1);
        const inner = source.indexOf('{', open + 1);
        let body: string;
        if (inner !== -1 && (close === -1 || inner < close)) {
            const cut = Math.max(source.lastIndexOf(';', inner), source.lastIndexOf('\n', inner));
            const end = cut > open ? cut + 1 : open + 1;
            body = source.slice(open + 1, end);
            at = end;
        } else {
            const end = close === -1 ? source.length : close;
            body = source.slice(open + 1, end);
            at = end + 1;
        }
        const declarations = parseDeclarations(body);
        for (const part of selectorText.split(',')) {
            const selector = parseSelector(part);
            if (selector !== null) rules.push({ selector, declarations, order: order++ });
        }
    }
    return rules;
}

/** 要素に当たるか (状態は `pseudo` で別に見る) */
export function matches(selector: Selector, tag: string, id: string, classes: readonly string[]): boolean {
    if (selector.tag !== null && selector.tag !== tag) return false;
    if (selector.id !== null && selector.id !== id) return false;
    for (const name of selector.classes) if (!classes.includes(name)) return false;
    return true;
}

/** `url(...)` の中身。無ければ null */
export function parseUrl(value: string): string | null {
    const match = /^url\(\s*(["']?)(.*?)\1\s*\)$/i.exec(value.trim());
    return match === null ? null : match[2]!.replace(/\\(.)/g, '$1');
}
