/**
 * 衛星 (BS/CS) の局ロゴを拾う。
 *
 * **地上波とは伝送方式が違う。** 地上波は CDT (PID 0x0029) にロゴをそのまま
 * 載せてくるが、衛星は載せない。実機で確かめると、BS を26中継・CS を12中継
 * 開いても CDT は1つも来なかった (地上波は12中継で 29/29 揃う)。
 *
 * 衛星は**データカルーセル (DSM-CC)** で送る (ARIB STD-B21 / TR-B15)。
 * Mirakurun も同じ切り分けで、ネットワーク4 は DSM-CC を読みに行く
 * (`TSFilter.ts` の `_enableParseDSMCC`)。
 *
 * 道のりが長い。
 *
 * 1. PAT から**サービス 929** (エンジニアリングサービス) の PMT を見つける
 * 2. その PMT で `stream_identifier_descriptor` の component_tag が
 *    0x79 (BS) / 0x7A (CS) の ES を見つける。そこにカルーセルが流れている
 * 3. DII (table_id 0x3B) が「どのモジュールが何バイトか」を伝える。
 *    名前が `LOGO-05` / `CS_LOGO-05` のものがロゴ
 * 4. DDB (0x3C) がそのモジュールをブロックに割って何度も流す。揃えると
 *    ロゴデータモジュールになる
 * 5. モジュールの中に「どの局のロゴか」と PNG が入っている
 *
 * 3〜4 は [dsmcc.ts](dsmcc.ts) が持っている。**データ放送も同じ運び方**なので、
 * ここに残っているのはロゴの読み方 (どの ES を見るか、モジュールの中身) だけ。
 *
 * PNG は地上波と同じく色の表が抜けているので、入れ直してから返す。
 */

import { ModuleBuilder, parseDdb, parseDii, TABLE_DII, u16 } from './dsmcc';
import { withPalette } from './logo-palette';
import { descriptors, PID_PAT, parsePat, pmtStreams, SectionAssembler, TABLE_PMT } from './psi';

/** エンジニアリングサービス。衛星のロゴはこのサービスで運ばれる (ARIB TR-B15) */
const ESS_SERVICE_ID = 929;

const DESC_STREAM_IDENTIFIER = 0x52;
/** ロゴのカルーセルが乗る ES の目印。0x79 が BS、0x7A が CS */
const LOGO_COMPONENT_TAGS = new Set([0x79, 0x7a]);

/** モジュール記述子の名前。ロゴかどうかはこれで見分ける */
const LOGO_MODULE_NAMES = new Set(['LOGO-05', 'CS_LOGO-05']);

/**
 * PMT から、ロゴのカルーセルが流れている ES の PID を拾う。
 * 見るのは `stream_identifier_descriptor` の component_tag だけ。
 */
function parseLogoEsPids(section: Uint8Array): { serviceId: number; pids: number[] } | null {
    if (section[0] !== TABLE_PMT) return null;
    const pids: number[] = [];
    for (const [, pid, info] of pmtStreams(section)) {
        for (const [tag, descriptor] of descriptors(info)) {
            if (tag !== DESC_STREAM_IDENTIFIER || descriptor.length < 1) continue;
            if (LOGO_COMPONENT_TAGS.has(descriptor[0])) pids.push(pid);
        }
    }
    return { serviceId: u16(section, 3), pids };
}

export interface ModuleLogo {
    logoId: number;
    logoType: number;
    /** そのロゴを使う局。ロゴのほうが「どの局か」を持っている (SDT を待たなくていい) */
    services: { networkId: number; serviceId: number }[];
    /** そのまま画面に出せる PNG (色の表を入れ直したもの) */
    data: Uint8Array;
}

/**
 * 揃ったモジュールを読む (ARIB STD-B21 ロゴデータモジュール)。
 *
 * ```
 * logo_type 8 / number_of_loop 16 /
 *   { reserved 7 + logo_id 9 / number_of_services 8 /
 *     { original_network_id 16 / transport_stream_id 16 / service_id 16 } * n /
 *     data_size 16 / PNG }
 * ```
 */
export function parseLogoModule(data: Uint8Array): ModuleLogo[] {
    if (data.length < 3) return [];
    const logoType = data[0];
    const count = u16(data, 1);
    let at = 3;

    const logos: ModuleLogo[] = [];
    for (let i = 0; i < count; i++) {
        if (at + 3 > data.length) break;
        const logoId = ((data[at] & 0x01) << 8) | data[at + 1];
        const serviceCount = data[at + 2];
        at += 3;

        const services: { networkId: number; serviceId: number }[] = [];
        for (let j = 0; j < serviceCount; j++) {
            if (at + 6 > data.length) return logos;
            services.push({ networkId: u16(data, at), serviceId: u16(data, at + 4) });
            at += 6;
        }
        if (at + 2 > data.length) break;
        const size = u16(data, at);
        at += 2;
        if (at + size > data.length) break;
        logos.push({ logoId, logoType, services, data: withPalette(data.slice(at, at + size)) });
        at += size;
    }
    return logos;
}

/**
 * 組み立て中のモジュールの見分け。
 *
 * **downloadId だけでは足りない。** 1つのカルーセルに `LOGO-05` と
 * `CS_LOGO-05` が両方流れてくることがあり (実機の BS15_0 がそう)、
 * downloadId で1つだけ持っていた頃は先に来たほうしか組み立てられず、
 * CS のロゴが永久に揃わなかった。
 */
function downloadKey(downloadId: number, moduleId: number): string {
    return `${downloadId}:${moduleId}`;
}

/**
 * 揃ったロゴの見分け。
 *
 * `logo_id` は9ビットで、**BS と CS で番号が別々に振られている**。
 * logo_id だけを鍵にしていると、同じ番号の BS と CS のロゴが上書きし合う。
 */
function logoKey(logo: ModuleLogo): string {
    return `${logo.logoType}:${logo.logoId}:${logo.services[0]?.networkId ?? 0}`;
}

/**
 * 衛星のロゴを拾い集める。
 *
 * PAT → PMT → カルーセル、と辿る必要があるので、拾う PID が動く。
 * `SectionAssembler` を必要になった時点で足していく。
 */
export class DsmccLogoCollector {
    private readonly pat = new SectionAssembler(PID_PAT);
    /** ESS の PMT。PAT を読んでから足す */
    private pmt: SectionAssembler | null = null;
    /** カルーセルが流れている ES。PMT を読んでから足す */
    private readonly carousels = new Map<number, SectionAssembler>();

    /** 組み立て中のモジュール (downloadId + moduleId ごと) */
    private readonly downloads = new Map<string, ModuleBuilder>();
    /** 揃ったロゴ */
    private readonly logos = new Map<string, ModuleLogo>();
    /** PAT を読んだか。読むまでは「この中継にロゴがあるか」を判断できない */
    private sawPat = false;
    private ess = false;

    /** パケットを1つ食わせる */
    feed(packet: Uint8Array): void {
        for (const section of this.pat.feed(packet)) {
            const pmtPid = parsePat(section).get(ESS_SERVICE_ID);
            this.sawPat = true;
            this.ess = pmtPid !== undefined;
            if (pmtPid !== undefined && this.pmt === null) this.pmt = new SectionAssembler(pmtPid);
        }

        for (const section of this.pmt?.feed(packet) ?? []) {
            const found = parseLogoEsPids(section);
            if (found === null || found.serviceId !== ESS_SERVICE_ID) continue;
            for (const pid of found.pids) {
                // DSM-CC は section_syntax_indicator が立たないことがある (psi.ts)
                if (!this.carousels.has(pid)) this.carousels.set(pid, new SectionAssembler(pid, 'syntax'));
            }
        }

        for (const carousel of this.carousels.values()) {
            for (const section of carousel.feed(packet)) this.onSection(section);
        }
    }

    private onSection(section: Uint8Array): void {
        if (section[0] === TABLE_DII) {
            const dii = parseDii(section);
            if (dii === null) return;
            /*
             * **合致するモジュールは全部拾う。** 1つのカルーセルに `LOGO-05` と
             * `CS_LOGO-05` が並んで流れてくる (実機の BS15_0)。最初の1つで
             * 打ち切っていた頃は、CS のロゴが永久に揃わなかった
             */
            for (const module of dii.modules) {
                if (module.name === null || !LOGO_MODULE_NAMES.has(module.name)) continue;
                const key = downloadKey(dii.downloadId, module.moduleId);
                const building = this.downloads.get(key);
                // 組み立て中のものを作り直さない (受け取ったブロックが消える)
                if (building !== undefined && building.moduleVersion === module.moduleVersion) continue;
                this.downloads.set(
                    key,
                    new ModuleBuilder(module.moduleVersion, module.moduleSize, dii.blockSize),
                );
            }
            return;
        }

        const ddb = parseDdb(section);
        if (ddb === null) return;
        const key = downloadKey(ddb.downloadId, ddb.moduleId);
        const download = this.downloads.get(key);
        if (download === undefined) return;
        // 版が変わったら組み立て直し。混ぜると壊れた PNG ができる
        if (download.moduleVersion !== ddb.moduleVersion) {
            this.downloads.delete(key);
            return;
        }
        if (!download.add(ddb.blockNumber, ddb.block)) return;

        // 揃った。次の版が来るまで組み立て直さない
        this.downloads.delete(key);
        for (const logo of parseLogoModule(download.data)) {
            if (logo.data.length > 0) this.logos.set(logoKey(logo), logo);
        }
    }

    collected(): ModuleLogo[] {
        return [...this.logos.values()];
    }

    /**
     * この中継にロゴのカルーセルが載っているか。
     *
     * `null` … まだ PAT を読んでいない (判断できない)
     * `false` … 載っていないので、いくら開いても来ない
     *
     * **衛星のロゴは1つの中継にしかない。** 実機の BS はネットワーク4に26の中継が
     * あるが、エンジニアリングサービス (929) が居るのは `BS15_0` だけだった
     * (NHK BS と同じ中継)。他を開いても永久に来ないので、PAT を見た時点で切り上げる。
     * PAT は1秒に何度も流れてくるので、外れの中継はすぐ諦められる。
     */
    get hasLogoService(): boolean | null {
        return this.sawPat ? this.ess : null;
    }
}
