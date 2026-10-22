/**
 * 覚えておく場所 (NVRAM。`browser.readPersistentArray("nvram://local_web/0", "S:16B")`)。
 *
 * 放送が使う領域 (地上波は TR-B14 第二分冊 5.2、BS は TR-B15):
 *
 * | URI | 誰のものか | ブロック |
 * | --- | --- | --- |
 * | `nvram://local/N`・`nvram://local_web/N` | 局 (original_network_id) | 0〜63・0〜31 |
 * | `nvram://NN;group/N` | 系列 (NN は affiliation_id) | 0〜63 |
 * | `nvram://tr_common/N` | 地上波の局で共通 | 0〜31 |
 * | `nvram://~/N`・`nvram://~/ext/N`・`nvram://common/N` | BS の事業者・共通 | 0〜15・16〜63・0〜15 |
 * | `nvram://receiverinfo/zipcode` など | 受信機の設定 (読むだけ。郵便番号と都道府県は denpa が渡す) | |
 *
 * 1 ブロック 64 バイト (TR-B15 第一分冊 8.2 表8-1: BS の事業者の領域は 64 バイト × 16 ブロック、
 * 8.2.2: 違う名前で読み書きしたら読むのは null・書くのは NaN)。番号の外・64 バイトを超える書き込みは
 * 失敗にして知らせる。中身は置き場 (`store`) に base64 で置く。BS の事業者の区別
 * (broadcaster_id) は BIT が要るが denpa はデコードしないので、サービスごとに分ける (混ざらない側に倒す)。
 */

import { type Cell, parseStructure, readFields, writeFields } from './binary';
import { decodeEuc, encodeEuc } from './euc';

export interface Store {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

export interface ReceiverInfo {
    /** 郵便番号 (数字 7 桁)。無ければ空 */
    zipcode: string;
    /** 都道府県の番号 (STD-B10 付録G 表G-2 の県域。`#lib/prefecture.js`)。無ければ 255 */
    prefecture: number;
}

export interface Who {
    originalNetworkId: number | null;
    serviceId: number | null;
}

const BLOCK = 64;

const AREAS: Record<string, { first: number; last: number; scope: 'network' | 'common' | 'service' }> = {
    local: { first: 0, last: 63, scope: 'network' },
    local_web: { first: 0, last: 31, scope: 'network' },
    tr_common: { first: 0, last: 31, scope: 'common' },
    '~': { first: 0, last: 15, scope: 'service' },
    '~/ext': { first: 16, last: 63, scope: 'service' },
    common: { first: 0, last: 15, scope: 'common' },
};

/** 局の領域を分ける頭 (置き場の名前の真ん中) */
function scopeOf(kind: 'network' | 'common' | 'service', who: Who): string {
    // BS・CS (original_network_id 4・6・7) は局どうしで同じ番号なので、局の領域もサービスで分ける
    const network = who.originalNetworkId;
    const satellite = network === 4 || network === 6 || network === 7;
    if (kind === 'network' && !satellite) return String(network ?? 'unknown');
    if (kind === 'network' || kind === 'service')
        return `${network ?? 'unknown'}.${who.serviceId ?? 'unknown'}`;
    return '';
}

/**
 * 置き場の名前 (`Nvram` が `store` に使う鍵) が、その局から読み書きできるものか。
 * **Hybridcast のアプリへは、起動した局から見える分だけ写して渡す** (`hybridcast/compat.ts`)。
 * アプリが書いてきた鍵もこれで確かめるので、`Nvram` が作らない形 (番号の外など) は通さない
 */
export function visibleFrom(key: string, who: Who): boolean {
    const match = /^([^:]+):([^:]*):(\d+)$/.exec(key);
    if (match === null) return false;
    const [, prefix, scope, blockText] = match;
    const block = Number(blockText);
    if (prefix === 'group') return /^[0-9a-f]{2}$/.test(scope!) && block <= 63;
    const area = Object.hasOwn(AREAS, prefix!) ? AREAS[prefix!] : undefined;
    return (
        area !== undefined && block >= area.first && block <= area.last && scope === scopeOf(area.scope, who)
    );
}

export class Nvram {
    constructor(
        private readonly store: Store,
        private readonly receiver: () => ReceiverInfo,
        private readonly who: () => Who,
        /** 使えない番号・大きすぎる書き込みを知らせる (放送の使い方と規格の食い違いを本番で見る) */
        private readonly log: (message: string) => void = () => {},
    ) {}

    /** 置き場の名前。使えない URI なら null */
    private key(uri: string): string | null {
        const match = /^nvram:\/\/(?:([0-9a-f]{2});)?(.+)\/(\d+)$/i.exec(uri.trim());
        if (match === null) return null;
        const [, affiliation, prefix, blockText] = match;
        const block = Number(blockText);
        if (prefix === 'group') {
            if (affiliation === undefined || block > 63) return null;
            return `group:${affiliation.toLowerCase()}:${block}`;
        }
        // 放送の文字列で引くので、Object.prototype の名前 (constructor など) に当たらない
        const area = Object.hasOwn(AREAS, prefix!) ? AREAS[prefix!] : undefined;
        if (area === undefined || affiliation !== undefined) return null;
        if (block < area.first || block > area.last) {
            this.log(`NVRAM の番号が領域の外です (${prefix} は ${area.first}〜${area.last}): ${uri}`);
            return null;
        }
        return `${prefix}:${scopeOf(area.scope, this.who())}:${block}`;
    }

    private bytes(uri: string): Uint8Array | null {
        switch (uri.trim()) {
            case 'nvram://receiverinfo/zipcode': {
                const zip = this.receiver().zipcode;
                return new TextEncoder().encode(/^\d{7}$/.test(zip) ? zip : '');
            }
            case 'nvram://receiverinfo/prefecture':
                return Uint8Array.of(this.receiver().prefecture);
            case 'nvram://receiverinfo/regioncode':
                return Uint8Array.of(0, 0);
        }
        const key = this.key(uri);
        if (key === null) return null;
        const out = new Uint8Array(BLOCK);
        const kept = this.store.get(key);
        if (kept !== null) {
            try {
                const binary = atob(kept);
                for (let i = 0; i < Math.min(binary.length, BLOCK); i++) out[i] = binary.charCodeAt(i);
            } catch {}
        }
        return out;
    }

    /** `readPersistentArray`。読めなければ null */
    read(uri: string, structure: string): Cell[] | null {
        const fields = parseStructure(structure);
        const data = this.bytes(uri);
        if (fields === null || data === null) return null;
        try {
            // 郵便番号は 7 バイトに満たないと字が詰まらないので、足りない分は NUL
            const padded = new Uint8Array(Math.max(data.length, BLOCK));
            padded.set(data);
            return readFields(padded, fields, decodeEuc)[0];
        } catch {
            return null;
        }
    }

    /** `writePersistentArray`。書いたバイト数、書けなければ NaN */
    write(uri: string, structure: string, values: readonly Cell[]): number {
        const fields = parseStructure(structure);
        const key = this.key(uri);
        if (fields === null || key === null) return Number.NaN;
        if (fields.filter((field) => field.type !== 'P').length > values.length) return Number.NaN;
        let data: Uint8Array;
        try {
            data = writeFields(values, fields, encodeEuc);
        } catch {
            return Number.NaN;
        }
        if (data.length > BLOCK) {
            this.log(`NVRAM の 1 ブロック (${BLOCK} バイト) に収まりません (${data.length} バイト): ${uri}`);
            return Number.NaN;
        }
        let binary = '';
        for (const byte of data) binary += String.fromCharCode(byte);
        this.store.set(key, btoa(binary));
        return data.length;
    }

    /** `checkAccessInfoOfPersistentArray`。2 読み書き・1 読むだけ・NaN 使えない */
    check(uri: string): number {
        // 受信機の設定は読むだけ (郵便番号は denpa の設定から渡す)
        if (uri.startsWith('nvram://receiverinfo/')) return 1;
        return this.key(uri) === null ? Number.NaN : 2;
    }
}
