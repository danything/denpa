/**
 * AIT (Application Information Table) を読む。**Hybridcast の在り処。**
 *
 * データ放送 (BML) と違って、**Hybridcast のアプリは電波に乗っていません**。
 * 乗っているのはこの表だけで、中身は「どこにアプリがあるか」の住所です。
 * アプリそのものは放送局のサーバから HTTPS で取ってきます。
 *
 * ```
 * PMT ─ ES に application_signalling_descriptor (0x6F) ─→ その PID に AIT
 * AIT ─ transport_protocol_descriptor (URL の頭)
 *     └ simple_application_location_descriptor (その先の道)  →  アプリのURL
 * ```
 *
 * **denpa は動かしません。読んで在ることを言うだけです。** 動かすには受信機の
 * API (IPTVFJ STD-0010) をアプリの文脈に用意する必要があり、別オリジンの
 * ページには手を入れられません。放送局のサーバが認証された受信機を期待する
 * ことも多く、そこは denpa 側の努力では越えられません
 * ([docs/stream.md](../../../docs/stream.md#58-hybridcast))。
 */

import { decodeAribText } from './aribtext';
import { u16, u32 } from './dsmcc';
import { descriptors, PacketStream, pmtStreams, SectionAssembler } from './psi';

/** AIT のセクション */
const TABLE_AIT = 0x74;

/** PMT の ES に付く。**その PID に AIT が流れている**という印 */
const DESC_APPLICATION_SIGNALLING = 0x6f;

/** AIT の中の記述子 */
const DESC_APPLICATION = 0x00;
const DESC_APPLICATION_NAME = 0x01;
const DESC_TRANSPORT_PROTOCOL = 0x02;
const DESC_SIMPLE_APPLICATION_LOCATION = 0x15;

/** 通信路で運ぶ (HTTP/HTTPS)。1 は放送のカルーセルで運ぶもの */
const PROTOCOL_HTTP = 0x0003;

/**
 * HTML5 のアプリ。**Hybridcast はこれ** (ARIB STD-B23)。
 *
 * 他の値は DVB のもの (DVB-J は 1、DVB-HTML は 2) で、日本の放送には出てきません
 */
export const APPLICATION_TYPE_HTML5 = 0x0010;

/**
 * 起動のしかた (application_control_code)。
 *
 * **`autostart` は「選局したら勝手に始めよ」**で、テレビは黙って動かします。
 * `present` は「用意はあるが、人が呼ぶまで始めるな」。denpa はどちらも
 * 動かさないので、**画面に出すときの言い方が変わるだけ**です
 */
export const CONTROL = {
    autostart: 0x01,
    present: 0x02,
    destroy: 0x03,
    kill: 0x04,
    prefetch: 0x05,
    remote: 0x06,
    disabled: 0x07,
    playbackAutostart: 0x08,
} as const;

export interface HybridcastApp {
    /** 放送局を表す番号 (organisation_id) */
    organisationId: number;
    applicationId: number;
    /** `CONTROL` のどれか。生の値をそのまま持つ (知らない値でも捨てない) */
    controlCode: number;
    /** アプリの名前。放送が入れていなければ空 */
    name: string;
    /** 取りに行く先。`transport_protocol` と `location` を繋いだもの */
    url: string;
}

export interface Ait {
    /** `APPLICATION_TYPE_HTML5` なら Hybridcast */
    applicationType: number;
    applications: HybridcastApp[];
}

/**
 * PMT から「AIT が流れている PID」を拾う。
 *
 * **記述子が付いている ES を見るだけ。** `stream_type` では決められません —
 * AIT は DSM-CC セクション (0x0D) で運ばれ、データ放送のカルーセルと同じ型を
 * 名乗るので、型だけでは見分けが付きません
 */
export function aitPidsFromPmt(section: Uint8Array): number[] {
    const pids: number[] = [];
    for (const [, pid, info] of pmtStreams(section)) {
        for (const [tag] of descriptors(info)) {
            if (tag === DESC_APPLICATION_SIGNALLING) {
                pids.push(pid);
                break;
            }
        }
    }
    return pids;
}

/**
 * URL の頭を取り出す (transport_protocol_descriptor)。
 *
 * **通信路で運ぶものだけ見ます。** `protocol_id` が 1 のものは放送のカルーセルで
 * 運ぶアプリ (データ放送と同じ道) で、Hybridcast の話ではありません
 */
function transportUrl(body: Uint8Array): string | null {
    if (body.length < 3) return null;
    if (u16(body, 0) !== PROTOCOL_HTTP) return null;
    // [0..1] protocol_id, [2] transport_protocol_label, [3] URL_base_length
    const baseLength = body[3];
    if (body.length < 4 + baseLength) return null;
    return new TextDecoder().decode(body.subarray(4, 4 + baseLength));
}

/**
 * 名前を取り出す (application_name_descriptor)。
 *
 * 言語ごとに何本も入っていることがあるので**最初の1本**を採ります。中身は
 * ARIB の8単位符号なので、番組名と同じ道で読みます (`aribtext.ts`)
 */
function applicationName(body: Uint8Array): string {
    // [0..2] ISO_639_language_code, [3] application_name_length
    if (body.length < 4) return '';
    const length = body[3];
    if (body.length < 4 + length) return '';
    return decodeAribText(body.subarray(4, 4 + length)).trim();
}

/**
 * AIT のセクションを1つ読む。**壊れていたら `null`** (放送は途中から拾うので、
 * 読めないものが来るのは普通のこと)
 */
export function parseAit(section: Uint8Array): Ait | null {
    if (section[0] !== TABLE_AIT || section.length < 16) return null;
    const applicationType = u16(section, 3) & 0x7fff;
    const commonLength = ((section[8] & 0x0f) << 8) | section[9];
    let at = 10 + commonLength;
    const end = section.length - 4;
    if (at + 2 > end) return null;
    const loopLength = ((section[at] & 0x0f) << 8) | section[at + 1];
    at += 2;
    const stop = Math.min(at + loopLength, end);

    const applications: HybridcastApp[] = [];
    while (at + 9 <= stop) {
        const organisationId = u32(section, at);
        const applicationId = u16(section, at + 4);
        const controlCode = section[at + 6];
        const infoLength = ((section[at + 7] & 0x0f) << 8) | section[at + 8];
        const info = section.subarray(at + 9, at + 9 + infoLength);
        at += 9 + infoLength;

        let base: string | null = null;
        let path = '';
        let name = '';
        for (const [tag, descriptor] of descriptors(info)) {
            if (tag === DESC_TRANSPORT_PROTOCOL) base = transportUrl(descriptor) ?? base;
            else if (tag === DESC_SIMPLE_APPLICATION_LOCATION) path = new TextDecoder().decode(descriptor);
            else if (tag === DESC_APPLICATION_NAME) name = applicationName(descriptor);
            else if (tag === DESC_APPLICATION) {
                // いまは読むものが無い (優先度と可視性。動かさないので使い道がない)
            }
        }
        // **URL の無いものは出さない。** 在ることだけ言われても行き先が無い
        if (base === null) continue;
        applications.push({ organisationId, applicationId, controlCode, name, url: base + path });
    }
    return { applicationType, applications };
}

/**
 * TS から Hybridcast のアプリを見つける。
 *
 * **PMT を見てから AIT を読む** という2段なので、繋いだ直後は何も返しません。
 * 局を変えたら作り直します (`reset`)。
 *
 * 局に Hybridcast が無ければ、**PMT に印が無い**ので AIT を待つこともしません
 * — その局では永久に何も返さないのが正しい振る舞いです。
 */
export class AitReader {
    private readonly packets = new PacketStream();
    private readonly pat = new SectionAssembler(0);
    /** PMT を組み立てるもの。**PID が決まってから作る** */
    private pmt: SectionAssembler | null = null;
    private pmtPid: number | null = null;
    /** AIT を組み立てるもの。PID ごとに1つ */
    private aits = new Map<number, SectionAssembler>();

    constructor(private readonly serviceId: number) {}

    /**
     * TS を食べて、見つかったものを返す。**見つからない間は空**。
     *
     * 同じものが何度も返るのは呼ぶ側で畳んでください — 放送は同じ表を
     * 繰り返し流すので、ここで覚えると「局を変えても消えない」になります
     */
    public feed(chunk: Uint8Array): Ait[] {
        const found: Ait[] = [];
        for (const packet of this.packets.feed(chunk)) {
            for (const section of this.pat.feed(packet)) {
                if (section[0] !== 0x00) continue;
                const pid = pmtPidOf(section, this.serviceId);
                if (pid === null || pid === this.pmtPid) continue;
                // 局が変わった。PMT も AIT も拾い直す
                this.pmtPid = pid;
                this.pmt = new SectionAssembler(pid);
                this.aits = new Map();
            }
            for (const section of this.pmt?.feed(packet) ?? []) {
                if (section[0] !== 0x02) continue;
                for (const pid of aitPidsFromPmt(section)) {
                    if (!this.aits.has(pid)) this.aits.set(pid, new SectionAssembler(pid));
                }
            }
            for (const reader of this.aits.values()) {
                for (const section of reader.feed(packet)) {
                    const ait = parseAit(section);
                    if (ait !== null) found.push(ait);
                }
            }
        }
        return found;
    }
}

/** PAT から、そのサービスの PMT の PID */
function pmtPidOf(section: Uint8Array, serviceId: number): number | null {
    const end = section.length - 4;
    for (let at = 8; at + 4 <= end; at += 4) {
        if (u16(section, at) !== serviceId) continue;
        return ((section[at + 2] & 0x1f) << 8) | section[at + 3];
    }
    return null;
}
