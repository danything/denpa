import { normalizeVlcHost } from '$lib/vlc-host';
import { settings } from './settings';

/**
 * テレビの VLC (リモートアクセス) の居場所。
 *
 * **叩くのはサーバではなく、画面を開いている端末。** VLC の `/play` はただの
 * GET なので、端末のブラウザが `http://<テレビ>:8080/play?id=0&path=<URL>` を
 * **トップレベルで開けば**そのまま再生が始まる (`+page.svelte` の `playOnTv`)。
 * fetch では混在コンテンツ・自己署名・CORS・Cookie の4つに塞がれるが、
 * ページ遷移にはどれも掛からず、SameSite=Lax の合鍵 Cookie も付く。
 *
 * サーバから叩く形 (denpa がペアリングして Cookie を控える) も作ったが落とした —
 * 家のサーバからは**出先のテレビに届かない**し、端末から直に開くなら
 * ペアリングも VLC 自身のログイン画面 (テレビに出る6桁コード) がそのまま使える。
 * ここに残っているのは「設定に書いてあるテレビの一覧」だけ。
 */

/**
 * そのテレビに渡すファイルの選び方。`auto` は配信の「今いいほう」に任せる。
 * `h264` は AV1 を解けないテレビ用 (両方焼いた録画で H.264 のほうを渡す)、
 * `ts` はエンコード済みを解けないテレビ用 (生TSが残っていればそちらを渡す)
 */
export type VlcCodec = 'auto' | 'h264' | 'ts';

export interface VlcTarget {
    name: string;
    host: string;
    codec: VlcCodec;
}

function asCodec(raw: string | undefined): VlcCodec {
    return raw === 'h264' || raw === 'ts' ? raw : 'auto';
}

/**
 * `名前=ホスト:ポート#コーデック` のカンマ区切りを読む。名前 (`=` から前) と
 * コーデック (`#` から後ろ) はどちらも略せる — 旧書式 (`名前=ホスト:ポート`) は
 * そのまま読める。ホストの整え方は `$lib/vlc-host` と共通
 */
export function parseTargets(text: string): VlcTarget[] {
    const out: VlcTarget[] = [];
    for (const part of text.split(',')) {
        const trimmed = part.trim();
        if (trimmed === '') continue;
        const eq = trimmed.indexOf('=');
        const rest = eq === -1 ? trimmed : trimmed.slice(eq + 1);
        const sharp = rest.indexOf('#');
        const host = normalizeVlcHost(sharp === -1 ? rest : rest.slice(0, sharp));
        // ホスト名が無い崩れは黙って飛ばす
        if (host === '') continue;
        const name = eq === -1 ? host : trimmed.slice(0, eq).trim();
        out.push({
            name: name === '' ? host : name,
            host,
            codec: asCodec(sharp === -1 ? undefined : rest.slice(sharp + 1).trim()),
        });
    }
    return out;
}

export function targets(): VlcTarget[] {
    return parseTargets(settings().vlcTargets);
}

/**
 * 一覧を設定の文字列に戻す。読み直すのは `parseTargets` — 往復して同じに
 * なることが書式の定義そのもの (`vlc.test.ts`)。名前がホストと同じ (=付けて
 * いない) ものは名前を書かず、コーデックも `auto` なら書かない。
 * **`,` `=` `#` は区切りなので中身には使えない** — 名前からは saveVlc が抜き、
 * ホストは normalizeVlcHost が混ざったものを弾く
 */
export function serializeTargets(list: VlcTarget[]): string {
    return list
        .map((t) => {
            const base = t.name === t.host || t.name.trim() === '' ? t.host : `${t.name}=${t.host}`;
            return t.codec === 'auto' ? base : `${base}#${t.codec}`;
        })
        .join(', ');
}
