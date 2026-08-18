/**
 * データ放送 (ARIB STD-B24 の BML) を解く。**1局に絞った TS を食わせると、
 * 組み立て終わったファイルが出てくる。**
 *
 *     TS → PAT → PMT → データ符号化方式記述子 (0xFD) の付いた ES
 *                       → DII/DDB (カルーセル) → モジュール → ファイル
 *
 * ## なぜ自前なのか
 *
 * **運び方は衛星のロゴと同じ DSM-CC** で、denpa はそれを既に持っている
 * ([dsmcc.ts](dsmcc.ts) / [logo-dsmcc.ts](logo-dsmcc.ts))。借りていた
 * [web-bml](../vendor/web-bml/README.md) の `decode_ts.ts` は998行あるが、
 * **denpa が通るのは3割だけ**で、残りは EIT/SDT/NIT や字幕の PES —
 * どれも自前のものがある ([eit.ts](eit.ts) / [psi.ts](psi.ts) / ffmpeg)。
 * その3割のために `@chinachu/aribts` (2.3MB) を抱えていた。
 *
 * **出す形は借りたまま。** [ws_api.ts](../vendor/web-bml/server/ws_api.ts) の
 * `ResponseMessage` をそのまま作るので、描画側 (web-bml のブラウザ) から見ると
 * 出どころが変わったことは分からない。**型が食い違いを見張ってくれる**のが、
 * ここを自前にできる理由でもある。
 *
 * 中身を読むところ (multipart の解体) だけは借りたままにしてある
 * (`entity_parser.ts`)。**依存の無いただの解析**で、書き直しても得るものが無い。
 */

import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import {
    EntityParser,
    entityHeaderToString,
    parseMediaType,
    parseMediaTypeFromString,
} from '$lib/vendor/web-bml/server/entity_parser';
import type {
    AdditionalAribBXMLInfo,
    ComponentPMT,
    ESEvent,
    ModuleFile,
    ResponseMessage,
} from '$lib/vendor/web-bml/server/ws_api';
import type { DiiModule } from './dsmcc';
import {
    dataEventIdOf,
    ModuleBuilder,
    parseDdb,
    parseDii,
    TABLE_DII,
    TABLE_STREAM_DESCRIPTOR,
    u16,
    u32,
} from './dsmcc';
import { parseMjdTime } from './eit';
import { descriptors, PacketStream, parsePat, pmtStreams, SectionAssembler } from './psi';

const PID_PAT = 0x0000;
/** TDT / TOT。放送の現在時刻。BML の `getCurrentDateTime` がこれを見る */
const PID_TIME = 0x0014;

const TABLE_TDT = 0x70;
const TABLE_TOT = 0x73;

const DESC_STREAM_IDENTIFIER = 0x52;
/** データ符号化方式記述子 (STD-B10 第2部 6.2.20) */
const DESC_DATA_COMPONENT = 0xfd;

/**
 * BML が載っている符号化方式 (STD-B10 第2部 付録J 表J-1)。
 * 0x0C/0x0D が地上波、0x07 が BS、0x0B が CS
 */
const BXML_COMPONENT_IDS = new Set([0x07, 0x0b, 0x0c, 0x0d]);

/** zlib。Compression Type 記述子で運用されるのはこれだけ */
const COMPRESSION_ZLIB = 0;

/**
 * データ符号化方式記述子の後半を読む。
 *
 * 地上波は TR-B14 第二分冊 2.1.4 表2-3、BS/CS は TR-B15 第一分冊 5.1.5 表5-4。
 *
 * **`data_component_id` は16ビット。** 借りていた側はここで `aribtsの実装が
 * おかしくて8ビットとして読んでる` という但し書き付きの補正をしていたが、
 * 自前で読むならその歪みごと無い。
 */
export function parseBxmlInfo(data: Uint8Array): AdditionalAribBXMLInfo {
    let at = 0;
    // 00 のみ運用 (データカルーセル伝送方式およびイベントメッセージ伝送方式)
    const transmissionFormat = (data[at] >> 6) & 0b11;
    // component_tag=0x40 のとき必ず1。startup.xml が最初に起動される
    const entryPointFlag = ((data[at] >> 5) & 1) === 1;
    const info: AdditionalAribBXMLInfo = { transmissionFormat, entryPointFlag };

    if (entryPointFlag) {
        const autoStartFlag = ((data[at] >> 4) & 1) === 1;
        /*
         * 画面の大きさ。運用されるのは 0011 (960x540)、0100 (640x480 16:9)、
         * 0101 (640x480 4:3) の3つ
         */
        const documentResolution = data[at] & 0x0f;
        at++;
        const useXML = ((data[at] >> 7) & 1) === 1;
        const defaultVersionFlag = ((data[at] >> 6) & 1) === 1;
        // BS/CS では 0 のとき単独視聴不可。地上波は常に1
        const independentFlag = ((data[at] >> 5) & 1) === 1;
        const styleForTVFlag = ((data[at] >> 4) & 1) === 1;
        at++;
        // 既定は BS の 1.0。地上波は3、CS は2が入ってくる
        info.entryPointInfo = {
            autoStartFlag,
            documentResolution,
            useXML,
            defaultVersionFlag,
            independentFlag,
            styleForTVFlag,
            bmlMajorVersion: 1,
            bmlMinorVersion: 0,
        };
        if (!defaultVersionFlag) {
            info.entryPointInfo.bmlMajorVersion = u16(data, at);
            info.entryPointInfo.bmlMinorVersion = u16(data, at + 2);
            at += 4;
            // 運用されない
            if (useXML) {
                info.entryPointInfo.bxmlMajorVersion = u16(data, at);
                info.entryPointInfo.bxmlMinorVersion = u16(data, at + 2);
                at += 4;
            }
        }
    } else {
        at++;
    }

    if (transmissionFormat === 0) {
        // additional_arib_carousel_info (STD-B24 第三分冊 第三編 C.1)
        const dataEventId = (data[at] >> 4) & 0x0f;
        const eventSectionFlag = ((data[at] >> 3) & 1) === 1;
        at++;
        const ondemandRetrievalFlag = ((data[at] >> 7) & 1) === 1;
        const fileStorableFlag = ((data[at] >> 6) & 1) === 1;
        const startPriority = (data[at] >> 5) & 1;
        info.additionalAribCarouselInfo = {
            dataEventId,
            eventSectionFlag,
            ondemandRetrievalFlag,
            fileStorableFlag,
            startPriority,
        };
    }
    return info;
}

/**
 * PMT から ES を並べる。**部品タグ (component_tag) を持たない ES は数に入れない** —
 * データ放送は「何番の部品か」でしか物を指せないので、番号の無いものは指しようがない。
 */
function parsePmt(section: Uint8Array): ComponentPMT[] {
    const components: ComponentPMT[] = [];
    for (const [streamType, pid, info] of pmtStreams(section)) {
        let componentId: number | undefined;
        let dataComponentId: number | undefined;
        let bxmlInfo: AdditionalAribBXMLInfo | undefined;
        for (const [tag, descriptor] of descriptors(info)) {
            if (tag === DESC_STREAM_IDENTIFIER && descriptor.length >= 1) componentId = descriptor[0];
            else if (tag === DESC_DATA_COMPONENT && descriptor.length >= 2) {
                dataComponentId = u16(descriptor, 0);
                if (BXML_COMPONENT_IDS.has(dataComponentId)) bxmlInfo = parseBxmlInfo(descriptor.subarray(2));
            }
        }
        if (componentId === undefined) continue;
        components.push({ componentId, pid, streamType, dataComponentId, bxmlInfo });
    }
    return components;
}

/** ストリーム記述子 (table_id 0x3D)。NPT と イベントメッセージが載っている */
function parseEsEvents(section: Uint8Array): ESEvent[] {
    const events: ESEvent[] = [];
    const length = ((section[1] & 0x0f) << 8) | section[2];
    const body = section.subarray(8, Math.min(3 + length - 4, section.length));
    for (const [tag, descriptor] of descriptors(body)) {
        if (tag === 0x17 && descriptor.length >= 18) {
            // NPT 参照記述子。放送の時計と番組内の時刻を結び付ける
            events.push({
                type: 'nptReference',
                postDiscontinuityIndicator: (descriptor[0] & 0x80) !== 0,
                dsmContentId: descriptor[0] & 0x7f,
                STCReference: u32(descriptor, 2) + (descriptor[1] & 1) * 0x100000000,
                NPTReference: u32(descriptor, 10) + (descriptor[9] & 1) * 0x100000000,
                scaleNumerator: u16(descriptor, 14),
                scaleDenominator: u16(descriptor, 16),
            });
        } else if (tag === 0x40 && descriptor.length >= 11) {
            // 汎用イベントメッセージ記述子。運用されるのは time_mode 0 と 2 だけ
            const groupId = (u16(descriptor, 0) >> 4) & 0x0fff;
            const timeMode = descriptor[2];
            const eventMessageType = descriptor[8];
            const eventMessageId = u16(descriptor, 9);
            const privateDataByte = [...descriptor.subarray(11)];
            if (timeMode === 0) {
                events.push({
                    type: 'immediateEvent',
                    timeMode: 0,
                    eventMessageGroupId: groupId,
                    eventMessageType,
                    eventMessageId,
                    privateDataByte,
                });
            } else if (timeMode === 2) {
                events.push({
                    type: 'nptEvent',
                    timeMode: 2,
                    eventMessageGroupId: groupId,
                    eventMessageNPT: u32(descriptor, 4) + (descriptor[3] & 1) * 0x100000000,
                    eventMessageType,
                    eventMessageId,
                    privateDataByte,
                });
            }
        }
    }
    return events;
}

/**
 * 組み立て中のモジュール1つ。
 *
 * **DII の言い分を持ち歩く。** 縮んでいるか・中身が何かは DII にしか書いておらず、
 * ブロックを運ぶ DDB は何も知らない。揃ったときに読み方が分からないと困る
 */
interface Building {
    module: DiiModule;
    builder: ModuleBuilder;
}

/** カルーセルが流れている ES 1本ぶんの覚え書き */
interface Component {
    componentId: number;
    sections: SectionAssembler;
    /** DII の transaction_id。**変わっていなければ組み立て直さない** */
    transactionId: number | null;
    dataEventId: number;
    /** 組み立て中のモジュール (moduleId ごと) */
    building: Map<number, Building>;
    /** 配り終えたモジュールの版。**同じものを配り直さない**ため */
    done: Map<number, string>;
}

/**
 * 1局に絞った TS を食わせると、データ放送の知らせが出てくる。
 *
 * **1つの選局に1つ。** 局を変えたら作り直す — カルーセルは局ごとに別物で、
 * 組み立て中のものを持ち越すと混ざる。
 */
export class BmlDecoder {
    private readonly packets = new PacketStream();
    private readonly pat = new SectionAssembler(PID_PAT);
    // TDT は CRC を持たない。DSM-CC と同じ理由で 'syntax' で受ける
    private readonly time = new SectionAssembler(PID_TIME, 'syntax');
    private pmt: SectionAssembler | null = null;
    private pmtPid: number | null = null;
    /** カルーセルが流れている ES。PID ごと */
    private readonly components = new Map<number, Component>();
    /** 最後に配った PMT。**変わったときだけ配る** */
    private sent: string | null = null;

    constructor(private readonly send: (message: ResponseMessage) => void) {}

    /** 1局に絞った TS を食わせる */
    feed(chunk: Uint8Array): void {
        for (const packet of this.packets.feed(chunk)) {
            for (const section of this.pat.feed(packet)) this.onPat(section);
            for (const section of this.pmt?.feed(packet) ?? []) this.onPmt(section);
            for (const section of this.time.feed(packet)) this.onTime(section);
            for (const component of this.components.values()) {
                for (const section of component.sections.feed(packet)) this.onCarousel(component, section);
            }
        }
    }

    private onPat(section: Uint8Array): void {
        /*
         * **1局に絞ったあとを食わせる前提。** 入っているサービスは1つなので、
         * 最初に見つかったものの PMT を追う
         */
        for (const pmtPid of parsePat(section).values()) {
            if (this.pmtPid === pmtPid) return;
            this.pmtPid = pmtPid;
            this.pmt = new SectionAssembler(pmtPid);
            return;
        }
    }

    private onPmt(section: Uint8Array): void {
        const components = parsePmt(section);
        if (components.length === 0) return;

        /*
         * 放送は同じ表を何度も送る。**変わったときだけ配る** — 受け側は
         * PMT が来るたびに画面を組み直すので、そのまま通すと出っ放しになる
         */
        const shape = JSON.stringify(components);
        if (this.sent !== shape) {
            this.sent = shape;
            this.send({ type: 'pmt', components });
        }

        for (const component of components) {
            // カルーセルが流れているのは、BML の符号化方式が付いた ES だけ
            if (component.bxmlInfo === undefined) continue;
            if (this.components.has(component.pid)) continue;
            this.components.set(component.pid, {
                componentId: component.componentId,
                // DSM-CC は section_syntax_indicator が立たないことがある (psi.ts)
                sections: new SectionAssembler(component.pid, 'syntax'),
                transactionId: null,
                dataEventId: -1,
                building: new Map(),
                done: new Map(),
            });
        }
    }

    /** TDT / TOT。頭3バイトのあとに MJD + BCD が5バイト */
    private onTime(section: Uint8Array): void {
        if (section[0] !== TABLE_TDT && section[0] !== TABLE_TOT) return;
        const at = parseMjdTime(section, 3);
        if (at !== null) this.send({ type: 'currentTime', timeUnixMillis: at });
    }

    private onCarousel(component: Component, section: Uint8Array): void {
        if (section[0] === TABLE_STREAM_DESCRIPTOR) {
            const extension = u16(section, 3);
            this.send({
                type: 'esEventUpdated',
                componentId: component.componentId,
                events: parseEsEvents(section),
                dataEventId: extension >> 12,
            });
            return;
        }
        if (section[0] === TABLE_DII) this.onDii(component, section);
        else this.onDdb(component, section);
    }

    private onDii(component: Component, section: Uint8Array): void {
        const dii = parseDii(section);
        if (dii === null) return;
        // 同じカルーセルが回ってきただけ。組み立て中のものを捨てない
        if (component.transactionId === dii.transactionId) return;
        component.transactionId = dii.transactionId;

        /*
         * **番組が変わったら覚えていたものを捨てる。** dataEventId はカルーセルの
         * 「回」で、ここが変わると前の番組のファイルは使えない
         */
        const dataEventId = dataEventIdOf(dii.downloadId);
        if (component.dataEventId !== dataEventId) {
            component.dataEventId = dataEventId;
            component.done.clear();
        }

        component.building.clear();
        for (const module of dii.modules) {
            component.building.set(module.moduleId, {
                module,
                builder: new ModuleBuilder(module.moduleVersion, module.moduleSize, dii.blockSize),
            });
        }

        this.send({
            type: 'moduleListUpdated',
            componentId: component.componentId,
            modules: dii.modules.map((module) => ({
                id: module.moduleId,
                version: module.moduleVersion,
                size: module.moduleSize,
            })),
            dataEventId,
            returnToEntryFlag: dii.returnToEntry ?? undefined,
        });
    }

    private onDdb(component: Component, section: Uint8Array): void {
        const ddb = parseDdb(section);
        if (ddb === null) return;
        const held = component.building.get(ddb.moduleId);
        // 版が食い違うブロックを混ぜると壊れたファイルができる
        if (held === undefined || held.builder.moduleVersion !== ddb.moduleVersion) return;
        if (!held.builder.add(ddb.blockNumber, ddb.block)) return;

        // 揃った。次の DII が来るまで組み立て直さない
        component.building.delete(ddb.moduleId);
        /*
         * **同じものを配り直さない。** カルーセルは回り続けるので、版が上がって
         * いなくても同じモジュールが何度も揃う。そのたびに配ると、受け側は
         * 中身の変わらない画面を組み直し続ける
         */
        const stamp = `${ddb.moduleVersion}:${component.dataEventId}`;
        if (component.done.get(ddb.moduleId) === stamp) return;
        component.done.set(ddb.moduleId, stamp);

        const data = inflate(held.builder.data, held.module.compression);
        if (data === null) return;
        const files = moduleFiles(data, held.module.contentType);
        if (files.length === 0) return;

        this.send({
            type: 'moduleDownloaded',
            componentId: component.componentId,
            moduleId: ddb.moduleId,
            files,
            version: ddb.moduleVersion,
            dataEventId: component.dataEventId,
        });
    }
}

/**
 * 揃ったモジュールをファイルに分ける。
 *
 * **多くは `multipart/mixed`** で、1つのモジュールに BML と画像がまとめて
 * 入っている。Type 記述子が無いときも中身は multipart なので、同じ扱いにする。
 */
export function moduleFiles(data: Uint8Array, contentType: string | null): ModuleFile[] {
    const declared = contentType === null ? null : parseMediaTypeFromString(contentType).mediaType;
    if (declared !== null && !(declared.type === 'multipart' && declared.subtype === 'mixed')) {
        return [{ contentLocation: null, contentType: declared, dataBase64: base64(data) }];
    }

    const entity = new EntityParser(Buffer.from(data)).readEntity();
    if (entity?.multipartBody == null) return [];
    const files: ModuleFile[] = [];
    for (const part of entity.multipartBody) {
        const location = part.headers.find((header) => header.name === 'content-location');
        const type = part.headers.find((header) => header.name === 'content-type');
        // どちらも必ず入っている。欠けているものは置き場所も読み方も分からない
        if (location === undefined || type === undefined) continue;
        const mediaType = parseMediaType(type.value).mediaType;
        if (mediaType === null) continue;
        files.push({
            contentLocation: entityHeaderToString(location),
            contentType: mediaType,
            dataBase64: base64(part.body),
        });
    }
    return files;
}

function base64(data: Uint8Array): string {
    return Buffer.from(data).toString('base64');
}

/** zlib で縮めてあれば伸ばす。伸ばせなければ諦めて null */
export function inflate(data: Uint8Array, compression: { type: number } | null): Uint8Array | null {
    if (compression === null) return data;
    if (compression.type !== COMPRESSION_ZLIB) return null;
    try {
        return inflateSync(data);
    } catch {
        return null;
    }
}
