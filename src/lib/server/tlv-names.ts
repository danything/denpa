/**
 * **MH-SDT[actual] を受信できなかった 4K の局 (TLV) の局名。**
 *
 * スキャンは、MH-SDT[actual] が待つ上限 (`scan.ts` の `TLV_TIMEOUT`) までに来なくても、TLV-NIT と PLT で分かる局を入れる
 * (`scan.readTlvServices`)。局名は MH-SDT[actual] にしか無いので、仮の名前 (`unnamedService`) を付けて預ける。
 * 番組表の取得がその TLV のチャンネルで MH-SDT[actual] を受信したら、エージェントの控えの仮の名前を放送の局名に書き換える
 * (`nameTlvServices`)。エージェントは控えを書き換えると通知 (`channels`) を出し、denpa はそれを合図に局を取り込み直す
 */
import { listAgents } from "./agents";
import { getChannels, putChannels } from "./tuner";

/** 仮の局名。`docs/writing.md` の「名前の無いルール」と同じ言い方に、見分けるための service_id を添える */
export function unnamedService(serviceId: number): string {
  return `名前の無い局 (${serviceId})`;
}

/**
 * 仮の名前 (`unnamedService`) の局を、MH-SDT[actual] で受信した局名にする。対象は全部のエージェントの、
 * original_network_id と tlv_stream_id が同じ CATV の TLV のチャンネル。仮の名前でない局 (スキャンで局名を受信した局) は変えない。
 * 書き換えたチャンネルのあるエージェントにだけ、そのエージェントの CATV の控えをまとめて預け直す
 *
 * @returns 書き換えた局の数
 */
export async function nameTlvServices(
  networkId: number,
  tlvStreamId: number,
  found: readonly { serviceId: number; name: string }[],
): Promise<number> {
  const names = new Map(
    found
      .filter((service) => service.name !== "")
      .map((service) => [service.serviceId, service.name]),
  );
  let renamed = 0;
  for (const agent of listAgents()) {
    const channels = await getChannels(agent);
    let changed = 0;
    const next = channels.map((channel) => {
      if (
        channel.type !== "CATV" ||
        channel.transport !== "tlv" ||
        channel.networkId !== networkId ||
        channel.transportStreamId !== tlvStreamId
      )
        return channel;
      return {
        ...channel,
        services: channel.services.map((service) => {
          const name = names.get(service.serviceId);
          if (
            name === undefined ||
            service.name !== unnamedService(service.serviceId)
          )
            return service;
          changed++;
          return { ...service, name };
        }),
      };
    });
    if (changed === 0) continue;
    await putChannels(
      next.filter((channel) => channel.type === "CATV"),
      ["CATV"],
      agent,
    );
    renamed += changed;
  }
  return renamed;
}

/** その TLV のチャンネルに、仮の名前の局があるか。番組表の取得が MH-SDT[actual] を読むかを決める */
export function hasUnnamed(channel: {
  services: readonly { serviceId: number; name: string }[];
}): boolean {
  return channel.services.some(
    (service) => service.name === unnamedService(service.serviceId),
  );
}
