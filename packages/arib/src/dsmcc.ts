/**
 * データカルーセル (DSM-CC) をデコードする。**放送が同じものを何度も回してくる**中から、
 * ブロックを集めて1つのモジュールに組み立て直すところまで。
 *
 * 使う側が2つある。**中身の読み方だけが違って、運び方は同じ**なので、ここに寄せる。
 *
 * - [logo-dsmcc.ts](https://github.com/danything/denpa/blob/main/src/lib/ts/logo-dsmcc.ts) … 衛星の局ロゴ (ARIB STD-B21)
 * - [bml.ts](bml.ts) … データ放送 (ARIB STD-B24 / TR-B14・TR-B15)
 *
 * ## 流れ
 *
 * 1. **DII** (table_id 0x3B) が「どのモジュールが何バイトで、何ブロックか」を伝える
 * 2. **DDB** (0x3C) がそのモジュールを `blockSize` ごとに割って何度も流す
 * 3. 全ブロック揃うとモジュールになる
 *
 * セクションを取り出すのは [psi.ts](psi.ts) の `SectionAssembler`。**`'syntax'` を
 * 渡すこと** — DSM-CC は `section_syntax_indicator` が立たないことがあり、そのときは
 * 末尾4バイトが CRC ではなく Checksum なので、いつも確かめると全部捨ててしまう。
 */

import { u16, u32 } from "./bytes.js";
import { descriptors } from "./psi.js";

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
  /** カルーセルのバージョン。**変わっていなければ組み立て直さない** */
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
  const length = u16(section, 1) & 0x0fff;
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
  const adaptationLength = message[9]!;
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
    const moduleVersion = message[at + 6]!;
    const infoLength = message[at + 7]!;
    const info = message.subarray(at + 8, at + 8 + infoLength);
    at += 8 + infoLength;

    let name: string | null = null;
    let contentType: string | null = null;
    let compression: DiiModule["compression"] = null;
    for (const [tag, descriptor] of descriptors(info)) {
      if (tag === MODULE_DESC_NAME) name = new TextDecoder().decode(descriptor);
      else if (tag === MODULE_DESC_TYPE)
        contentType = new TextDecoder("ascii").decode(descriptor);
      else if (tag === MODULE_DESC_COMPRESSION && descriptor.length >= 5) {
        // 先頭1バイトは符号付き。運用されるのは 0 (zlib) だけ
        compression = {
          type: (descriptor[0]! << 24) >> 24,
          originalSize: u32(descriptor, 1),
        };
      }
    }
    modules.push({
      moduleId,
      moduleSize,
      moduleVersion,
      name,
      contentType,
      compression,
    });
  }

  /*
   * privateData。長さの手前まで飛ばしたところに記述子が並ぶ。
   * **無いほうがふつう**なので、読めなければ null のまま進む
   */
  let returnToEntry: boolean | null = null;
  if (at + 2 <= message.length) {
    const length = u16(message, at);
    for (const [tag, descriptor] of descriptors(
      message.subarray(at + 2, at + 2 + length),
    )) {
      // arib_bxml_privatedata_descriptor (STD-B24 第二分冊 (1/2) 第二編 9.3.4)
      if (tag === 0xf0 && descriptor.length >= 1)
        returnToEntry = (descriptor[0]! & 0x80) !== 0;
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
  const adaptationLength = message[9]!;
  const messageLength = u16(message, 10);
  let at = 12 + adaptationLength;
  if (at + 6 > message.length) return null;

  const moduleId = u16(message, at);
  const moduleVersion = message[at + 2]!;
  const blockNumber = u16(message, at + 4);
  at += 6;
  const size = messageLength - adaptationLength - 6;
  if (size < 0 || at + size > message.length) return null;

  return {
    downloadId,
    moduleId,
    moduleVersion,
    blockNumber,
    block: message.subarray(at, at + size),
  };
}

/**
 * 組み立てるモジュールの大きさの上限 (16MiB)。**これより大きいと言う DII は信じない。**
 *
 * `moduleSize` は32ビットで、そのまま信じると DII 1つで 4GB を確保させられる。
 * 実際のデータ放送のモジュールは数 KB〜数百 KB、衛星のロゴも全局ぶんで数百 KB なので、
 * 十分に余裕を見た値。zlib で伸ばしたあとの大きさにも同じ上限を使う ([bml.ts](bml.ts) の `inflate`)
 */
export const MAX_MODULE_SIZE = 16 * 1024 * 1024;

/**
 * 組み立て中のモジュール。DDB が来るたびに然るべき位置へ置く。
 *
 * **入れ物は届いたところまでしか確保しない。** DII の言う大きさを先に確保すると、
 * 大きいと言うだけの DII でメモリを使い切らせられる。`MAX_MODULE_SIZE` を超える
 * モジュールはブロックを受け取らない (いつまでも揃わない)。
 *
 * 順番は保証されない (途中から見れば真ん中から始まる) ので、
 * **受け取ったブロック番号を数えて**揃ったかを見る。
 */
export class ModuleBuilder {
  private buffer = new Uint8Array(0);
  /** 受け取ったブロック番号 (1ブロック1ビット)。最初のブロックが来てから確保する */
  private received: Uint8Array | null = null;
  private count = 0;
  private readonly total: number;

  constructor(
    readonly moduleVersion: number,
    private readonly moduleSize: number,
    private readonly blockSize: number,
  ) {
    this.total = Math.ceil(moduleSize / blockSize);
  }

  /** 組み立てた中身。まだ届いていないところは 0。**揃ってから読むこと** (読むとモジュールの大きさぶんを確保する) */
  get data(): Uint8Array {
    if (
      this.buffer.length < this.moduleSize &&
      this.moduleSize <= MAX_MODULE_SIZE
    )
      this.grow(this.moduleSize);
    return this.buffer;
  }

  /** 受け取ったブロックの数 (同じブロックを2度受けても1つ) */
  get blocks(): number {
    return this.count;
  }

  /** 揃ったか。**大きさ 0 のモジュールは初めから揃っている** (運ぶブロックが無いので DDB を待たない) */
  get complete(): boolean {
    return this.count >= this.total;
  }

  /** ブロックを1つ置く。**揃ったら true** */
  add(blockNumber: number, block: Uint8Array): boolean {
    if (this.moduleSize > MAX_MODULE_SIZE) return false;
    // blockSize を超えるブロックは受けない。重なったブロックで受け取る量が膨らむ
    if (blockNumber >= this.total || block.length > this.blockSize)
      return false;
    const at = this.blockSize * blockNumber;
    if (at + block.length > this.moduleSize) return false;
    if (at + block.length > this.buffer.length) this.grow(at + block.length);
    this.buffer.set(block, at);
    this.received ??= new Uint8Array(Math.ceil(this.total / 8));
    const index = blockNumber >> 3;
    const bit = 1 << (blockNumber & 7);
    if ((this.received[index]! & bit) === 0) {
      this.received[index] = this.received[index]! | bit;
      this.count++;
    }
    return this.complete;
  }

  /** 入れ物を広げる。何度も写し直さないよう倍々で、モジュールの大きさまで */
  private grow(length: number): void {
    const next = new Uint8Array(
      Math.min(this.moduleSize, Math.max(length, this.buffer.length * 2)),
    );
    next.set(this.buffer);
    this.buffer = next;
  }
}
