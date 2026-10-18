# PT2・PT3・PX-BCUD (Linux DVB)

Linux の DVB ドライバで動くチューナーです。**Linux だけで使えます** (Mac と Windows には DVB がありません)。
地上波か衛星かは、デバイスに聞いて自動で見分けます。
denpa が使える内蔵のカードリーダーは無いので、USB のカードリーダーを別に挿します ([tuners.md](tuners.md#カードリーダー))。

チューナーの一覧は [tuners.md](tuners.md)、エージェントの中でどう扱っているかは [agent.md](agent.md#デバイスを開いたままチャンネルを変える)。

## 機材とドライバ

| 機材 | 使うドライバ |
| --- | --- |
| PT2 / PT3 (Earthsoft) | mainline の `earth_pt1` / `earth_pt3` |
| PX-BCUD (ISDB-S / USB) | mainline (Linux 4.7 以降) |
| PX-S1UD (ISDB-T / USB) | mainline の Siano `smsusb` + `smsdvb`。ホストに firmware `isdbt_rio.inp` が要る。smsusb を blacklist すれば、ホストに何も入れない siano-userland でも使えます ([tuner-px-s1ud.md](tuner-px-s1ud.md)) |

手元で確かめている機材は PT3 です。PT3 は1枚で `/dev/dvb` にアダプタが4つ出ます。

## 入れ方

1. **ホストでドライバを読み込みます。** どれも mainline のカーネルに入っているドライバです。
   `/dev/dvb/adapter0` などが出ていれば準備はできています
2. **denpa を入れます** ([install.md](install.md#1行で入れる))。compose.prod.yml・`denpa-aio`・Helm は、
   どれも `/dev/dvb` をディレクトリごと渡してあります。compose.prod.yml と `denpa-aio` の手順は
   DVB のデバイス (212) を開く許可も付けてあるので、挿し直しても再起動は要りません
3. **設定の「チューナー」で確かめ、「チャンネル」でスキャンします。** 見つかったチューナーと種別が並びます

## 設定

- **設定の `device` は `/dev/dvb/adapterN/frontendM`** です。刺さっていれば自動で組み立てるので、普段は書きません
- **衛星のアンテナに電源を送るなら、「チューナーの設定」の LNB で 15V を選びます。**
  DVB には 18V (`SEC_VOLTAGE_18`) を指示します (11V は 13V。recisdb と同じ対応)
- **一度選局したチューナーは、エージェントを止めるまで開いたままにします。** チャンネルは開いたまま切り替えます

## うまくいかないとき

- 設定の「チューナー」に出てこない — ホストに `/dev/dvb/adapter*` があるか、コンテナに `/dev/dvb` を渡しているかを見ます
- 選局はできるのに映らない (スクランブルのまま) — カードリーダーを見ます ([tuners.md](tuners.md#直らないとき))。
  `denpa-agent --tune ... --decode` で、選局と復号を1回だけ試せます (同じ節)

動いた/動かなかったを [Issue](https://github.com/danything/denpa/issues) で教えてもらえると助かります。
