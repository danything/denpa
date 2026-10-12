/**
 * モジュールの中身を読む。**ヘッダ + 空行 + 本体** の形式 (STD-B24 第二編 第9章) で、
 * 多くは `multipart/mixed` に BML と画像がまとめて入っている。
 *
 *     Content-Type: multipart/mixed; boundary=XXX
 *
 *     --XXX
 *     Content-Type: text/X-arib-bml; charset="EUC-JP"
 *     Content-Location: startup.bml
 *
 *     <?xml ...
 *     --XXX--
 *
 * もとは web-bml の `entity_parser.ts` を借りていた。運用される形式は上のとおり狭いので、
 * RFC 2068 の字句を全部なぞらず、**ヘッダの行を拾って `Content-Type` をデコードし、
 * 区切りで切る**だけにしてある。
 */

import type { MediaType, MediaTypeParameter } from './bml-protocol';

/** ヘッダ 1 つ。名前は小文字にそろえる */
export interface EntityHeader {
    name: string;
    value: string;
}

/** 読んだ中身。`multipart/mixed` なら `parts` に1つずつ入る */
export interface Entity {
    headers: EntityHeader[];
    body: Uint8Array;
    parts: Entity[] | null;
}

const CR = 0x0d;
const LF = 0x0a;
const CRLF = Uint8Array.of(CR, LF);
const utf8 = new TextDecoder();
const encoder = new TextEncoder();

/** token に使えない字 (RFC 2068 2.2 の tspecials と制御文字) */
const TSPECIALS = '()<>@,;:\\"/[]?={} \t';

function isTokenChar(char: string): boolean {
    const code = char.charCodeAt(0);
    return code > 0x20 && code < 0x7f && !TSPECIALS.includes(char);
}

/**
 * `type/subtype; a=b; c="d"` を読む。名前は小文字にそろえ、元の綴りも残す。
 *
 * **引数の途中で崩れていても、読めたところまでは返す** — 型と下位型が分かれば
 * 読み方は決まる。型すら読めなければ null
 */
export function parseMediaType(text: string): MediaType | null {
    let at = 0;
    const skipSpace = (): void => {
        while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
    };
    const token = (): string | null => {
        const from = at;
        while (at < text.length && isTokenChar(text[at]!)) at++;
        return at === from ? null : text.slice(from, at);
    };
    const quoted = (): string | null => {
        if (text[at] !== '"') return null;
        at++;
        let out = '';
        while (at < text.length && text[at] !== '"') {
            if (text[at] === '\\' && at + 1 < text.length) at++;
            out += text[at++];
        }
        at++;
        return out;
    };

    skipSpace();
    const type = token();
    if (type === null) return null;
    const parameters: MediaTypeParameter[] = [];
    const made = (subtype: string): MediaType => ({
        type: type.toLowerCase(),
        originalType: type,
        subtype: subtype.toLowerCase(),
        originalSubtype: subtype,
        parameters,
    });
    if (text[at] !== '/') return made('');
    at++;
    const subtype = token() ?? '';
    skipSpace();
    while (text[at] === ';') {
        at++;
        skipSpace();
        const attribute = token();
        if (attribute === null || text[at] !== '=') break;
        at++;
        const value = quoted() ?? token();
        if (value === null) break;
        parameters.push({ attribute: attribute.toLowerCase(), originalAttribute: attribute, value });
        skipSpace();
    }
    return made(subtype);
}

/** `needle` を `from` から探す。無ければ -1 */
function find(haystack: Uint8Array, needle: Uint8Array, from: number): number {
    const first = needle[0]!;
    for (let at = haystack.indexOf(first, from); at !== -1; at = haystack.indexOf(first, at + 1)) {
        if (at + needle.length > haystack.length) return -1;
        let same = true;
        for (let k = 1; k < needle.length; k++) {
            if (haystack[at + k] !== needle[k]) {
                same = false;
                break;
            }
        }
        if (same) return at;
    }
    return -1;
}

/**
 * 中身を1つ読む。**ヘッダの終わり (空行) が無いものは null** — どこからが本体か
 * 分からない。`multipart/mixed` なら中までデコードする (入れ子も同じ形)。
 *
 * @param part multipart の中の部品か。部品はヘッダの行でちょうど終わってよい (下の説明)
 */
export function readEntity(data: Uint8Array, part = false): Entity | null {
    const headers: EntityHeader[] = [];
    let at = 0;
    for (;;) {
        // 中身が空の部品は、ヘッダの空行の CRLF が次の区切りの頭に食われて、ヘッダの行で
        // ちょうど終わる (`--X\r\nContent-Type: a\r\n\r\n--X--`)。空の本体として受ける
        // (web-bml の entity-parser はここで null を返し、モジュールごと捨てていた)
        if (part && at === data.length && headers.length > 0) break;
        const end = find(data, CRLF, at);
        if (end === -1) return null;
        if (end === at) {
            at += 2;
            break;
        }
        const line = utf8.decode(data.subarray(at, end));
        at = end + 2;
        // 行頭が空白なら前の行の続き (折り返し)
        if ((line[0] === ' ' || line[0] === '\t') && headers.length > 0) {
            const last = headers[headers.length - 1]!;
            last.value = `${last.value} ${line.trim()}`;
            continue;
        }
        const colon = line.indexOf(':');
        if (colon <= 0) return null;
        headers.push({
            name: line.slice(0, colon).trim().toLowerCase(),
            value: line.slice(colon + 1).trim(),
        });
    }

    const body = data.subarray(at);
    const type = headers.find((header) => header.name === 'content-type');
    const media = type === undefined ? null : parseMediaType(type.value);
    let parts: Entity[] | null = null;
    if (media?.type === 'multipart' && media.subtype === 'mixed') {
        const boundary = media.parameters.find((parameter) => parameter.attribute === 'boundary')?.value;
        parts = boundary === undefined ? null : splitParts(body, boundary);
    }
    return { headers, body, parts };
}

/**
 * 区切りで切る。**閉じの区切り (`--XXX--`) まで揃っていないものは捨てる** —
 * 最後の1つがどこで終わるか分からない
 */
function splitParts(body: Uint8Array, boundary: string): Entity[] | null {
    const open = encoder.encode(`--${boundary}\r\n`);
    const next = encoder.encode(`\r\n--${boundary}`);
    let at = find(body, open, 0);
    if (at === -1) return null;
    at += open.length;
    const parts: Entity[] = [];
    for (let from = at; ; ) {
        const end = find(body, next, from);
        if (end === -1) return null;
        const after = end + next.length;
        // `--` が続けば閉じ、CRLF なら次の1つ。どちらでもなければ本体の中の似た並び
        const close = body[after] === 0x2d && body[after + 1] === 0x2d;
        if (!close && (body[after] !== CR || body[after + 1] !== LF)) {
            from = end + 1;
            continue;
        }
        const part = readEntity(body.subarray(at, end), true);
        if (part === null) return null;
        parts.push(part);
        if (close) return parts;
        at = after + 2;
        from = at;
    }
}
