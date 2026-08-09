/**
 * 録画を観るときの、**押したことの読み方**。DOM を触らない。
 *
 * 画面 (`routes/watch/[id]/+page.svelte`) から切り離してあるのは、ここが
 * **指の癖に合わせて何度も直すところ**だからで、試験で当てられる形にしておきたい。
 *
 * 決まりは動画アプリの通例に合わせる:
 *
 * - **どこを押しても再生/一時停止** (マウスのとき)。指のときは操作列の出し入れ
 * - **左右の端を素早く2回**で 10秒 戻す/送る。続けて押せばそのぶん重なる
 * - **チャプター送り**は「いま観ているものの頭」を挟む (曲送りと同じ癖)
 */

/** 1回で動かす秒数。動画アプリの通例に合わせる */
export const SKIP = 10;

/**
 * 2回目とみなす間合い (ms)。
 *
 * **短いと繋がらず、長いと普通の連打まで拾う。** 300ms は OS の既定
 * (ダブルクリック) とほぼ同じで、指でも届く
 */
export const DOUBLE_TAP = 300;

/**
 * 左右それぞれ、幅のどれだけを端とみなすか。
 *
 * **真ん中は空けておく。** ここまで端にすると、絵の真ん中を押したつもりが
 * 送りになる。3分割よりやや狭くして、中央に余白を残す
 */
export const EDGE = 0.3;

export type Zone = 'left' | 'center' | 'right';

/** 押されたのが左端か右端か真ん中か。`x` は絵の左端からの距離 */
export function zoneOf(x: number, width: number): Zone {
    if (width <= 0) return 'center';
    const ratio = x / width;
    if (ratio < EDGE) return 'left';
    if (ratio > 1 - EDGE) return 'right';
    return 'center';
}

export type TapAction =
    /** 送る・戻す。`undo` が true なら、直前に切り替えた再生/一時停止も戻す */
    | { kind: 'seek'; by: number; undo: boolean }
    /** 再生/一時停止 */
    | { kind: 'play' }
    /** 操作列の出し入れ */
    | { kind: 'controls' };

/** 前に押されたときのこと。2回目かどうかを決めるのに要る */
export interface Tap {
    at: number;
    zone: Zone;
}

/**
 * 1回押されたときに何をするか。
 *
 * **待たせない。** 2回目を待ってから決める作りにすると、押してから再生が
 * 止まるまでに間合いのぶん (0.3秒) 遅れる。1回目はその場で効かせておいて、
 * 2回目が来たら**1回目を打ち消す** (`undo`)。
 *
 * @param last 前に押されたときのこと。無ければ null
 * @param now いまの時刻 (ms)
 * @param zone 押された場所
 * @param coarse 指で触っているか (`(pointer: coarse)`)
 */
export function tap(
    last: Tap | null,
    now: number,
    zone: Zone,
    coarse: boolean,
): { action: TapAction; next: Tap } {
    const next: Tap = { at: now, zone };
    const again = last !== null && now - last.at < DOUBLE_TAP && last.zone === zone;

    if (again && zone !== 'center') {
        /*
         * **続けて押せば重なる。** 30秒 戻したいときに3回押せるようにしておく
         * (`next` を残すので、次の1回もまた2回目として届く)。
         *
         * 打ち消すのはマウスのときだけ — 指のときの1回目は操作列の出し入れで、
         * 再生には触っていない
         */
        return { action: { kind: 'seek', by: zone === 'left' ? -SKIP : SKIP, undo: !coarse }, next };
    }
    return { action: coarse ? { kind: 'controls' } : { kind: 'play' }, next };
}

/** チャプター1つ。`start` / `end` は秒 */
export interface Chapter {
    start: number;
    end: number;
    title: string;
}

/**
 * 「頭出し」とみなす猶予 (秒)。
 *
 * **これより後ろで戻すと、まずいまのチャプターの頭に戻る。** 曲送りと同じ癖で、
 * 押し間違えたときに1つ前まで飛ばずに済む
 */
const REWIND_HEAD = 3;

/**
 * 次のチャプターの頭。**無ければ null** (最後のチャプターに居る)。
 *
 * CM はチャプターとして入っているので (`docs/encode.md`)、これが
 * **そのままCM飛ばし**になる。
 */
export function nextChapterAt(chapters: Chapter[], at: number): number | null {
    for (const chapter of chapters) {
        if (chapter.start > at + 0.01) return chapter.start;
    }
    return null;
}

/**
 * 前のチャプターの頭。**無ければ null**。
 *
 * 頭から `REWIND_HEAD` 秒より後ろに居るなら、**いま観ているものの頭**へ戻す。
 */
export function prevChapterAt(chapters: Chapter[], at: number): number | null {
    let head: number | null = null;
    let before: number | null = null;
    for (const chapter of chapters) {
        if (chapter.start > at + 0.01) break;
        before = head;
        head = chapter.start;
    }
    if (head === null) return null;
    if (at - head > REWIND_HEAD) return head;
    return before;
}

/**
 * いま観ているチャプター。**無ければ null**。
 *
 * 何本目かではなく中身を返す — 画面に出すのは名前 (「本編」「CM」) のほう
 */
export function chapterAt(chapters: Chapter[], at: number): Chapter | null {
    let found: Chapter | null = null;
    for (const chapter of chapters) {
        if (chapter.start > at + 0.01) break;
        found = chapter;
    }
    if (found === null) return null;
    return at < found.end ? found : null;
}

/**
 * ffprobe の `-show_chapters -print_format json` を読む。
 *
 * **時刻は秒の文字列で来る** (`start_time`)。刻み (`time_base`) から起こす手も
 * あるが、ffprobe が既に直したものを添えてくるのでそちらを採る。
 *
 * 読めない・1つも無いときは空。**チャプターの無い録画はある** — CMを切って
 * 焼いたもの (切ったので位置が無い) と、CM検出が当たらなかったもの
 */
export function parseChapters(json: string): Chapter[] {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return [];
    }
    const list = (raw as { chapters?: unknown })?.chapters;
    if (!Array.isArray(list)) return [];

    const chapters: Chapter[] = [];
    for (const entry of list) {
        const item = entry as { start_time?: unknown; end_time?: unknown; tags?: { title?: unknown } };
        const start = Number(item.start_time);
        const end = Number(item.end_time);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const title = typeof item.tags?.title === 'string' && item.tags.title !== '' ? item.tags.title : '—';
        chapters.push({ start, end, title });
    }
    return chapters.sort((a, b) => a.start - b.start);
}

/**
 * 続きから観る、の「続き」をどこにするか。
 *
 * **端に来たら覚えない。**
 *
 * - 末尾の近く … 観終えたということ。覚えると**次はエンドロールから始まる**
 * - 頭のすぐそば … まだ観はじめていない。覚えても頭から出すのと同じで、
 *   「続きがある」と見えるぶんだけ紛らわしい
 *
 * サーバも画面も同じ判断をする必要がある (片方だけが「観終えた」と思うと、
 * 目印が残ったり消えたりが噛み合わない) ので、ここ1箇所に置く。
 *
 * @param at いまの位置 (秒)
 * @param length 尺 (秒)。分からなければ 0
 * @returns 覚える位置。覚えないなら null
 */
export function resumePoint(at: number, length: number): number | null {
    if (!Number.isFinite(at) || at < RESUME_HEAD) return null;
    if (Number.isFinite(length) && length > 0 && at > length - RESUME_EDGE) return null;
    return at;
}

/** 末尾のここから先は「観終えた」とみなす (秒) */
export const RESUME_EDGE = 30;
/** 頭のここまでは「まだ観ていない」とみなす (秒) */
export const RESUME_HEAD = 15;
