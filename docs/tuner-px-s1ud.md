# PX-S1UD (siano-userland)

**地上波だけ**の USB チューナーで、1 台で 1 チャンネルを取ります。
denpa が使える内蔵のカードリーダーは無いので、USB のカードリーダーを別に挿します ([tuners.md](tuners.md#カードリーダー))。
Linux (DVB でも siano-userland でも)・Mac (Apple Silicon)・Windows (x64) で使えます。

チューナーの一覧は [tuners.md](tuners.md)。エージェントの中でどう扱っているかは [agent.md](agent.md#siano-userland-の作り)。

[Amazon で見る (広告)](https://www.amazon.co.jp/dp/B006RQLNES?tag=doa08-22)

PX-S1UD は mainline の `smsusb` + `smsdvb` で Linux DVB になるので、DVB でも使えます
(ホストに `isdbt_rio.inp` が要る)。別に
[siano-userland](https://github.com/Khronos31/siano-userland) の `siano-ts` を
**エージェントのイメージに同梱**しています (`agent/Dockerfile`)。libusb だけで USB を
扱い、ファームウェアも配布アーカイブに入っているので、ホストに何も入れずに動きます。

**カーネルが使っている機材には触りません。** 作者自身が「動いている smsusb から
切り替えるのは安全と判定していない」と書いており (unbind の境目でカーネルの異常を観測)、
DVB で動いている S1UD を奪うのは論外です。siano-ts 自身も、
カーネルのドライバが使っているデバイスを断ります (終了コード 4。Khronos31/siano-userland#9)。

**カーネル 6.6 以降の DVB では、受信している間ずっとカーネルの警告がログに出続けます** (`smsdvb` の統計を書くたびに `sysfs_emit_at` の WARN)。
ログが数百 GB まで増えてディスクを埋めた報告があります (Ubuntu の Launchpad #2162139)。統計のファイル (`CONFIG_SMS_SIANO_DEBUGFS`) を
有効にして組んだカーネル (Ubuntu など) で起きます。直すパッチは linux-media に送ってあり、取り込まれるまでは
下の手順で siano-userland に切り替えると避けられます。

| 機材の様子                                                                  | 使うドライバ                            |
| --------------------------------------------------------------------------- | --------------------------------------- |
| smsusb が使っている (`/dev/dvb` に出ている)                                 | DVB (`DvbTuner`)。siano-ts は起動しない |
| どのドライバにも繋がっていない (smsusb を blacklist した・モジュールが無い) | siano-userland (`SianoTuner`)           |

siano-userland で使うなら、ホストで `smsusb` / `smsdvb` / `smsmdtv` を blacklist して
再起動します (挿したまま unbind するのは上の理由で勧めません)。
**siano-userland で使ったときの選局は、実機で試せていません** (動いた/動かなかったは Issue へ)。

```sh
printf 'blacklist smsusb\nblacklist smsdvb\nblacklist smsmdtv\n' | sudo tee /etc/modprobe.d/denpa-siano.conf
sudo reboot
```

## 設定

- **設定の `device` は `siano:<USB のポート>`** (`siano:1-2`)。S1UD にはシリアルが
  無いので、挿したポートで見分けます。挿さっていれば組み立てるので
  (`SianoUserland.Detect`)、普通は書きません。ポートを変えたら組み直します
- **siano-ts の標準出力の pipe を広げるには `CAP_SYS_RESOURCE` を渡します** (compose の `cap_add`、HA のアドオンの
  `privileged: [SYS_RESOURCE]`)。無いと上限 (`pipe-max-size`、既定 1MB) までしか広げられず、
  さらに uid ごとの pipe の合計が上限 (`pipe-user-pages-soft`、既定 64MB) を超えていると
  **1MB も断られて数 KB のまま**になります (読む側が少し止まると TS を落とす)。Home Assistant OS の
  アドオンは、ホスト中の root と uid 0 を分け合うのでこれに当たります。広げられなかったときは
  記録にいまの深さと理由が出ます (`ChildTs.WidenPipe`)。px4-userland の機材には要りません
- **地上波だけ。** 衛星は siano-ts を起動する前に断ります
- **実機に当てていません。** siano-userland 側で実機確認済みなのは PX-S1UD (`3275:0080`) だけで、
  `187f:0600` / `187f:0302` はあちらでも未検証です

## エージェントが USB を直に持つ (実機で確かめていない)

**エージェントの環境変数に `SIANO_NATIVE=1` を付けると、siano-ts を起動せずに、エージェントが USB を直に持って PX-S1UD を動かします。**
付けなければ、今までどおり siano-userland を使います。この実装は実機で確かめていないので、既定にはしていません。
中の作りは [agent.md](agent.md#siano-の機材を直に持つ作り-実機で確かめていない)。

- 設定の `device` は同じ `siano:<USB のポート>` です。環境変数を付け外しするだけで切り替わり、設定は書き換えません
- 対象は PX-S1UD (`3275:0080`) と、Siano の RIO の標準の ID (`187f:0600`) です。`187f:0302` は対象にしていません (公開の資料で扱いが食い違うため)
- ファームウェアは siano-userland と同じ `isdbt_rio.inp` (イメージの `/opt/siano-userland/firmware/`。場所は `SIANO_FIRMWARE`) を、機材に入っていないときだけ送ります
- カーネルのドライバが使っている機材には触りません (上と同じ。blacklist の手順も同じ)。Windows はドライバを WinUSB にします
- 受信の状態と C/N (dB) と強度 (dBm) を、機材の統計の応答から出します。C/N と強度の欄の位置は公開の資料 1 つだけによるもので、値が正しいかは確かめていません
- 地上波だけです。ワンセグだけの受信、PID の絞り込みはしません
- 別のモードのファームウェアが動いている機材は、挿し直しを求めて断ります

### 実機で確かめる順

実機が手に入ったら、この順に確かめます。どれも `SIANO_NATIVE=1` を付け、Linux で smsusb などを blacklist してから行います。
記録の行は、そのポートで初めて開いたときに 1 回だけ出ます (エージェントを起動し直すとまた出ます)。

1. 自動検出に `PLEX PX-S1UD <ポート>` が 1 台だけ出る (`SIANO_NATIVE` を外したときと同じ `siano:<ポート>` で、2 台にならない)
2. `denpa-agent --tune siano:<ポート> T27` を、挿した直後の機材で流す。記録の次の行を控える
   - 「端点:」の行。バルク IN のアドレスと最大パケット長 (推定は `0x81`・512)、バルク OUT が `0x02` か
   - 「バージョンの応答 (開いたとき)」の行。モードが 255 か、対応モードのビット、ROM のバージョンの値
   - 「ファームウェアを送りました」の行 (358 個、かかった時間) と、「バージョンの応答 (ファームウェアを送ったあと)」の行。モードが 6 になるか 255 のままか
   - モードの初期化に機材が応答するか (応答しなければ「モードの初期化に機材が応答しません」で止まる)
3. 同期するか。同期までの時間と、「統計の応答」の行 (番号が 654 か 616 か、中身の長さ)。同期しなければ「ロックしませんでした (統計の要求 n 回、応答 m 回)」の応答の数
4. TS が流れるか。「TS のメッセージ」の行 (中身の長さが 188 の倍数か、先頭が `0x47` か)。`--seconds 30` を付けた `--tune` の出力で、約 65 MB、同期バイトの割合が 100%、連続性の飛びが 0 か
5. 「中身が転送の途中から始まるメッセージ」「扱わないメッセージ」「壊れたメッセージ」の行が出るか (出たら番号と長さを控える)
6. もう一度 `--tune` を流す (挿したまま)。バージョンの応答のモードが 6 で、ファームウェアを送らずに選局できるか
7. `--tune siano:<ポート> T27,T22,T27` で、開いたまま選局し直せるか。放送の無いチャンネルで、10 秒ほどで「同期しませんでした」になり、次のチャンネルを選局できるか
8. 常駐させて、設定の画面に C/N と強度が出るか。値がほかのチューナーや siano-userland のときの映りと矛盾しないか
9. 受信中に抜く。記録に「抜かれました」が出るまでの時間。挿し直して、次の選局で受信できるか
10. 10 分以上の録画で、連続性の飛びと「TS を捨てています」の行が無いか。ここまで通ったら Windows (WinUSB) と macOS でも 1〜4 を流す (USB の層の `Pipes`・`ClearHalt`・`ReadTransfer` は、Windows と macOS では 1 度も動かしていない)
