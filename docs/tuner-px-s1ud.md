# PX-S1UD (siano-userland)

チューナーの一覧は [tuners.md](tuners.md)。エージェントの中でどう扱っているかは [agent.md](agent.md#siano-userland-の作り)。

PX-S1UD は mainline の `smsusb` + `smsdvb` で Linux DVB になるので、DVB でも使えます
(ホストに `isdbt_rio.inp` が要る)。別に
[siano-userland](https://github.com/Khronos31/siano-userland) の `siano-ts` を
**エージェントのイメージに同梱**しています (`agent/Dockerfile`)。libusb だけで USB を
扱い、ファームウェアも配布アーカイブに入っているので、ホストに何も入れずに動きます。

**カーネルが使っている機材には触りません。** 作者自身が「動いている smsusb から
切り替えるのは安全と判定していない」と書いており (unbind の境目でカーネルの異常を観測)、
DVB で動いている S1UD を奪うのは論外です。siano-userland 0.1.8 からは
siano-ts 自身が、カーネルのドライバが使っているデバイスを断ります (終了コード 4。
以前は黙って奪っていた。Khronos31/siano-userland#9)。

| 機材の様子 | 使うドライバ |
| --- | --- |
| smsusb が使っている (`/dev/dvb` に出ている) | DVB (`DvbTuner`)。siano-ts は起こさない |
| どのドライバにも繋がっていない (smsusb を blacklist した・モジュールが無い) | siano-userland (`SianoTuner`) |

siano-userland で使うなら、ホストで `smsusb` / `smsdvb` / `smsmdtv` を blacklist して
再起動します (挿したまま unbind するのは上の理由で勧めません)。
**siano-userland で使ったときの選局は、実機で試せていません** (動いた/動かなかったは Issue へ)。

```sh
printf 'blacklist smsusb\nblacklist smsdvb\nblacklist smsmdtv\n' | sudo tee /etc/modprobe.d/denpa-siano.conf
sudo reboot
```

## 設定

- **設定の `device` は `siano:<USB のポート>`** (`siano:1-2`)。S1UD にはシリアルが
  無いので、挿したポートで見分けます。刺さっていれば組み立てるので
  (`SianoUserland.Detect`)、普通は書きません。ポートを変えたら組み直します
- **siano-ts の標準出力の pipe を広げるには `CAP_SYS_RESOURCE` を渡します** (compose の `cap_add`、HA のアドオンの
  `privileged: [SYS_RESOURCE]`)。無いと上限 (`pipe-max-size`、既定 1MB) までしか広げられず、
  さらに uid ごとの pipe の合計が上限 (`pipe-user-pages-soft`、既定 64MB) を超えていると
  **1MB も断られて数 KB のまま**になります (読む側が少し止まると TS を落とす)。Home Assistant OS の
  アドオンは、ホスト中の root と uid 0 を分け合うのでこれに当たります。広げられなかったときは
  記録にいまの深さと理由が出ます (`ChildTs.WidenPipe`)。px4-userland の機材には要りません
- **地上波だけ。** 衛星は siano-ts を起こす前に断ります
- **実機に当てていません。** siano-userland 側で実機確認済みなのは PX-S1UD (`3275:0080`) だけで、
  `187f:0600` / `187f:0302` はあちらでも未検証です
