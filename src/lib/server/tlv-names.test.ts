import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { concatBytes } from "@danything/arib/bytes";
import { TlvServiceReader } from "@danything/arib/mmt-si";
import {
  compressedIp,
  m2SectionMessage,
  mhSdtSection,
  signalingPackets,
  tlvPacket,
} from "@danything/arib/synth-mmt";

import { fakeAgentTls, fakeAgentUrl } from "./fake-agent";
import { trustFakeAgent } from "./fake-agent-trust";
import type { AgentChannel } from "./tuner";

/**
 * MH-SDT[actual] を受信できなかった 4K の局 (TLV)。スキャンは仮の局名で入れ、番組表の取得が MH-SDT[actual] を受信したら直す。
 *
 * `fixtures/qc26-si.tlv` は実機の録り (PX-MLT5PE と J:COM の QC26 の BS4K、2026-11-11 の 0.9 秒) から、
 * エージェントと同じく分割 TLV を組み立て、信号の TLV パケットだけを受けたまま抜いたもの (TLV-NIT 1・PLT 8・MPT 8・MH-SDT[other] 1)。
 * 末尾に TLV の同期を取るための空のパケットを 1 つ足してある。MH-SDT[actual] は入っていない
 */
const { config } = await import("./config");
config.dbPath = join(
  mkdtempSync(join(tmpdir(), "denpa-tlv-names-")),
  "denpa.db",
);
config.dataDir = dirname(config.dbPath);

/** エージェントの控え。PUT で入れ替わる */
let saved: AgentChannel[] = [];
const puts: { channels: AgentChannel[]; scanned: string[] }[] = [];
const server = Bun.serve({
  port: 0,
  tls: fakeAgentTls(),
  async fetch(request) {
    if (new URL(request.url).pathname !== "/denpa/channels")
      return new Response("not found", { status: 404 });
    if (request.method === "PUT") {
      const body = (await request.json()) as {
        channels: AgentChannel[];
        scanned: string[];
      };
      puts.push(body);
      saved = [
        ...saved.filter((c) => !body.scanned.includes(c.type)),
        ...body.channels,
      ];
    }
    return Response.json(saved);
  },
});
config.agentUrl = fakeAgentUrl(server.port!);
trustFakeAgent();

const { channelEntry, readTlvServices } = await import("./scan");
const { nameTlvServices } = await import("./tlv-names");

const ONID = 0x000b;
const TLV_STREAM = 0xb111;
const SERVICE = 161;

const qc26 = new Uint8Array(
  await Bun.file(join(import.meta.dir, "fixtures/qc26-si.tlv")).arrayBuffer(),
);

/** 閉じないストリーム (選局したまま流れ続ける) */
function open(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
    },
  });
}

/** 合成の MH-SDT[actual] (自分の TLV ストリームの局名) */
const actual = concatBytes([
  ...signalingPackets(0x8004, [
    m2SectionMessage(
      mhSdtSection(TLV_STREAM, ONID, [
        { serviceId: SERVICE, name: "ＢＳでんぱ　４Ｋ" },
      ]),
    ),
  ]).map((bytes) => compressedIp(1, bytes)),
  tlvPacket(0xff, [0, 0]),
]);

describe("MH-SDT[actual] を受信できなかった 4K の局 (QC26 の録り)", () => {
  test("スキャンは TLV-NIT と PLT で自分の TLV ストリーム (0xB111) を見つけ、局 161 を仮の局名で入れる", async () => {
    const result = await readTlvServices(open(qc26), 500);
    expect(result.error).toBeNull();
    expect(result.unnamed).toBe(true);
    const entry = channelEntry(
      "CATV",
      "QC26",
      result.services!,
      result.caSystemIdsOf,
      "tlv",
      true,
    );
    expect(entry).toEqual({
      type: "CATV",
      channel: "QC26",
      networkId: ONID,
      transportStreamId: TLV_STREAM,
      remoteControlKeyId: null,
      transport: "tlv",
      services: [
        {
          serviceId: SERVICE,
          serviceType: 1,
          name: "名前の無い局 (161)",
          caSystemIds: [0x0005],
          epgReadable: true,
        },
      ],
    });
  });

  test("MH-SDT[other] (ほかの TLV ストリームの局名) は使わない", () => {
    const reader = new TlvServiceReader();
    reader.feed(qc26);
    expect(reader.transport).toBeNull();
    expect(reader.ownStream?.tlvStreamId).toBe(TLV_STREAM);
  });

  test("番組表の取得が MH-SDT[actual] を受信したら、控えの仮の局名を放送の局名にする", async () => {
    const scanned = await readTlvServices(open(qc26), 500);
    const qc26Entry = channelEntry(
      "CATV",
      "QC26",
      scanned.services!,
      scanned.caSystemIdsOf,
      "tlv",
      true,
    );
    const ts: AgentChannel = {
      type: "CATV",
      channel: "QC30",
      networkId: 4,
      transportStreamId: 0x4010,
      remoteControlKeyId: null,
      services: [{ serviceId: 101, serviceType: 1, name: "ＢＳでんぱ" }],
    };
    saved = [ts, qc26Entry];
    puts.length = 0;

    const reader = new TlvServiceReader();
    reader.feed(concatBytes([qc26, actual]));
    const sdt = reader.transport!;
    expect(sdt.tlvStreamId).toBe(TLV_STREAM);
    expect(
      await nameTlvServices(
        sdt.originalNetworkId,
        sdt.tlvStreamId,
        sdt.services,
      ),
    ).toBe(1);
    expect(puts.map((put) => put.scanned)).toEqual([["CATV"]]);
    expect(saved.find((c) => c.channel === "QC26")!.services).toEqual([
      {
        serviceId: SERVICE,
        serviceType: 1,
        name: "ＢＳでんぱ　４Ｋ",
        caSystemIds: [0x0005],
        epgReadable: true,
      },
    ]);
    // ほかの CATV のチャンネルはそのまま書き戻す
    expect(saved.find((c) => c.channel === "QC30")).toEqual(ts);
    // 仮の名前でなくなった局は書き換えない (もう一度受信しても書き戻さない)
    expect(
      await nameTlvServices(sdt.originalNetworkId, sdt.tlvStreamId, [
        { serviceId: SERVICE, name: "別の名前" },
      ]),
    ).toBe(0);
    expect(puts).toHaveLength(1);
  });
});
