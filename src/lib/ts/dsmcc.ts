/**
 * データカルーセル (DSM-CC) を解く。**放送が同じものを何度も回してくる**中から、
 * ブロックを拾って1つのモジュールに組み立て直すところまで。
 *
 * 使う側が2つある。**中身の読み方だけが違って、運び方は同じ**なので、ここに寄せる。
 *
 * - [logo-dsmcc.ts](logo-dsmcc.ts) … 衛星の局ロゴ (ARIB STD-B21)
 * - [bml.ts](bml.ts) … データ放送 (ARIB STD-B24 / TR-B14・TR-B15)
 *
 * ## 道のり
 *
 * 1. **DII** (table_id 0x3B) が「どのモジュールが何バイトで、何ブロックか」を伝える
 * 2. **DDB** (0x3C) がそのモジュールを `blockSize` ごとに割って何度も流す
 * 3. 全ブロック揃うとモジュールになる
 *
 * セクションを取り出すのは [psi.ts](psi.ts) の `SectionAssembler`。**`'syntax'` を
 * 渡すこと** — DSM-CC は `section_syntax_indicator` が立たないことがあり、そのときは
 * 末尾4バイトが CRC ではなく Checksum なので、いつも確かめると全部捨ててしまう。
 */

import { descriptors } from './psi';

export const TABLE_DII = 0x3b;
const TABLE_DDB = 0x3c;
/** ストリーム記述子。NPT と イベントメッセージが載る (データ放送だけが使う) */
export const TABLE_STREAM_DESCRIPTOR = 0x3d;

/** モジュール記述子 (STD-B24 第三分冊 第三編 6.2.3) */
const MODULE_DESC_TYPE = 0x01;
const MODULE_DESC_NAME = 0x02;
const MODULE_DESC_COMPRESSION = 0xc2;

/** DII が blockSize を持っていないときの既定 (ARIB TR-B15) */
const DEFAULT_BLOCK_SIZE = 4066;

export function u16(data: Uint8Array, at: number): number {
    return (data[at] << 8) | data[at + 1];
}

export function u32(data: Uint8Array, at: number): number {
    return ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
}

/**
 * 同じカルーセルの中の「回」。**downloadId の上位4ビットに入っている**
 * (下位28ビットは常に1で運用される)。
 *
 * 番組が変わるとここが変わるので、**前の番組のモジュールを捨てる合図**になる。
 */
export function dataEventIdOf(downloadId: number): number {
    return (downloadId >>> 28) & 0x0f;
}

export interface DiiModule {
    moduleId: number;
    moduleSize: number;
    moduleVersion: number;
    /** モジュール記述子の名前。ロゴかどうかの見分けに使う */
    name: string | null;
    /** Type 記述子。`multipart/mixed` など。データ放送だけが使う */
    contentType: string | null;
    /** Compression Type 記述子。**0 が zlib**。伸ばしたあとの大きさ付き */
    compression: { type: number; originalSize: number } | null;
}

export interface Dii {
    downloadId: number;
    /** カルーセルの版。**変わっていなければ組み立て直さない** */
    transactionId: number;
    blockSize: number;
    modules: DiiModule[];
    /**
     * ARIB の private データ記述子 (0xF0) の入口フラグ。
     * データ放送で「次に入口へ戻すか」を伝える。無ければ null
     */
    returnToEntry: boolean | null;
}

export interface Ddb {
    downloadId: number;
    moduleId: number;
    moduleVersion: number;
    blockNumber: number;
    block: Uint8Array;
}

/** DSM-CC セクションの中身 (メッセージ本体) を切り出す */
function messageOf(section: Uint8Array): Uint8Array | null {
    const length = ((section[1] & 0x0f) << 8) | section[2];
    const end = 3 + length - 4;
    if (end <= 8 || end > section.length) return null;
    return section.subarray(8, end);
}

/**
 * DII (Download Info Indication)。
 *
 * 頭は共通で protocolDiscriminator/dsmccType/messageId/transaction_id と続き、
 * adaptationLength ぶん飛ばした先に本体が入っている。
 */
export function parseDii(section: Uint8Array): Dii | null {
    if (section[0] !== TABLE_DII) return null;
    const message = messageOf(section);
    if (message === null || message.length < 20) return null;

    const transactionId = u32(message, 4);
    const adaptationLength = message[9];
    let at = 12 + adaptationLength;
    if (at + 20 > message.length) return null;

    const downloadId = u32(message, at);
    const blockSize = u16(message, at + 4) || DEFAULT_BLOCK_SIZE;
    at += 4 + 2 + 1 + 1 + 4 + 4;
    // compatibilityDescriptor。中身は使わないので長さぶん飛ばす
    if (at + 2 > message.length) return null;
    at += 2 + u16(message, at);
    if (at + 2 > message.length) return null;

    const count = u16(message, at);
    at += 2;
    const modules: DiiModule[] = [];
    for (let i = 0; i < count; i++) {
        if (at + 8 > message.length) return null;
        const moduleId = u16(message, at);
        const moduleSize = u32(message, at + 2);
        const moduleVersion = message[at + 6];
        const infoLength = message[at + 7];
        const info = message.subarray(at + 8, at + 8 + infoLength);
        at += 8 + infoLength;

        let name: string | null = null;
        let contentType: string | null = null;
        let compression: DiiModule['compression'] = null;
        for (const [tag, descriptor] of descriptors(info)) {
            if (tag === MODULE_DESC_NAME) name = new TextDecoder().decode(descriptor);
            else if (tag === MODULE_DESC_TYPE) contentType = new TextDecoder('ascii').decode(descriptor);
            else if (tag === MODULE_DESC_COMPRESSION && descriptor.length >= 5) {
                // 先頭1バイトは符号付き。運用されるのは 0 (zlib) だけ
                compression = { type: (descriptor[0] << 24) >> 24, originalSize: u32(descriptor, 1) };
            }
        }
        modules.push({ moduleId, moduleSize, moduleVersion, name, contentType, compression });
    }

    /*
     * privateData。長さの手前まで飛ばしたところに記述子が並ぶ。
     * **無いほうがふつう**なので、読めなければ null のまま進む
     */
    let returnToEntry: boolean | null = null;
    if (at + 2 <= message.length) {
        const length = u16(message, at);
        for (const [tag, descriptor] of descriptors(message.subarray(at + 2, at + 2 + length))) {
            // arib_bxml_privatedata_descriptor (STD-B24 第二分冊 (1/2) 第二編 9.3.4)
            if (tag === 0xf0 && descriptor.length >= 1) returnToEntry = (descriptor[0] & 0x80) !== 0;
        }
    }
    return { downloadId, transactionId, blockSize, modules, returnToEntry };
}

/** DDB (Download Data Block)。モジュールを割ったブロックが1つ入っている */
export function parseDdb(section: Uint8Array): Ddb | null {
    if (section[0] !== TABLE_DDB) return null;
    const message = messageOf(section);
    if (message === null || message.length < 12) return null;

    const downloadId = u32(message, 4);
    const adaptationLength = message[9];
    const messageLength = u16(message, 10);
    let at = 12 + adaptationLength;
    if (at + 6 > message.length) return null;

    const moduleId = u16(message, at);
    const moduleVersion = message[at + 2];
    const blockNumber = u16(message, at + 4);
    at += 6;
    const size = messageLength - adaptationLength - 6;
    if (size < 0 || at + size > message.length) return null;

    return { downloadId, moduleId, moduleVersion, blockNumber, block: message.subarray(at, at + size) };
}

/**
 * 組み立て中のモジュール。**DII が言った大きさぶんの入れ物を先に用意して**、
 * DDB が来るたびに然るべき位置へ置く。
 *
 * 順番は保証されない (途中から見れば真ん中から始まる) ので、
 * **受け取ったブロック番号を数えて**揃ったかを見る。
 */
export class ModuleBuilder {
    readonly data: Uint8Array;
    private readonly received = new Set<number>();
    private readonly total: number;

    constructor(
        readonly moduleVersion: number,
        moduleSize: number,
        private readonly blockSize: number,
    ) {
        this.data = new Uint8Array(moduleSize);
        this.total = Math.ceil(moduleSize / blockSize);
    }

    /** ブロックを1つ置く。**揃ったら true** */
    add(blockNumber: number, block: Uint8Array): boolean {
        const at = this.blockSize * blockNumber;
        if (at + block.length > this.data.length) return false;
        this.data.set(block, at);
        this.received.add(blockNumber);
        return this.received.size >= this.total;
    }
}
