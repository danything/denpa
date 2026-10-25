# Mac に入れる

**Apple Silicon の Mac なら、Linux と同じ1行で denpa ごと立ち上がってブラウザが開きます**
(入口の `install.sh` は1つで、OS を見て振り分ける)。Mac 用は v1.23.0 からで、
それより前のバージョンは入れられません (install.sh がそう言って止まる)。

```sh
curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | bash
```

**エージェントは Mac の上でそのまま、denpa 本体は Docker で動かします。** Mac の Docker
(Docker Desktop / OrbStack / colima) はコンテナに USB を渡せないので、エージェントは
コンテナに入れられません。denpa のコンテナからは
`host.docker.internal` でエージェントを呼びます (`compose.mac.yml`。
compose.prod.yml から tuner-agent を外したもの)。

1. **エージェント** — 最新のリリースから取り、LaunchAgent
   (`~/Library/LaunchAgents/io.github.danything.denpa-agent.plist`) に載せます。
   ログインで起き、落ちたら起き直し、止めるときは録画の終わりを待ちます
   (launchd に殺されないよう、待ちの上限を 6 時間より長くしてある)
2. **denpa 本体** — エージェントと同じバージョンの compose.mac.yml を `~/denpa/compose.yml` に置いて
   `docker compose up -d`。答えたらブラウザで開きます (`--no-open` で開かない)。genkan が動いているか
   80・443 が空いていれば、Linux と同じく `http://denpa.localhost` で開けるようにします ([install.md](install.md#1行で入れる))

- **要るのは Docker だけ。** px4-userland / siano-userland の Mac 用は libusb を中に抱えている
  (px4-userland 0.1.7・siano-userland 0.1.9 から) ので、Homebrew は要りません。
  Docker は勝手に入れません。無い・起きていないときはエージェントだけ入れ、
  Docker Desktop か OrbStack を入れる (起こす) よう言って終わります。入れたらもう一度流す
- 入れるのは全部ユーザーの下で、sudo は要りません
- エージェントの tar.gz は、出所の証明でも確かめられます ([配布物を確かめる](install.md#配布物を確かめる))

| 置き場                                       | 中身                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/denpa/` (`DENPA_HOME`)                    | Linux と同じ置き場。`compose.yml` (上げ直すたびに上書き)・`compose.override.yml` (手を入れるならここ。無いときだけ雛形を作る)・`config/` (エージェントの `tuners.json` / `channels.json`) |
| `~/Library/Application Support/denpa-agent/` | エージェント・px4-userland・siano-userland (プログラムだけ)                                                                                                                               |
| `~/Movies/denpa/recorded`                    | 元のTS。エージェントとコンテナの両方に見せる (掛かったまま録れたものを後から復号するとき、denpa は相対パスで要求し、エージェントが直に読み書きする)                                       |
| `~/Movies/denpa/library`                     | 出来上がった録画 (Finder から見える)                                                                                                                                                      |
| Docker のボリューム `denpa_denpa-data`       | DB。SQLite の錠は Mac から見せたフォルダ越しだと当てにならないので、名前付きボリュームに                                                                                                  |
| `~/Library/Logs/denpa-agent.log`             | エージェントのログ                                                                                                                                                                        |

- もう一度流せば上げ直し (エージェントも denpa のイメージも最新のリリースへ)。
  消すときは `… | bash -s -- --uninstall`。エージェント・LaunchAgent・キャッシュを外し、
  コンテナを畳みます。`~/denpa` (compose と設定)・録画・DB は残し、消し方を言います (Linux と同じ)
- denpa 本体は別の Linux で動かし、Mac にはエージェントだけ置くなら `… | bash -s -- --no-docker`。
  denpa の `TUNER_AGENT_URL` に `http://<Mac の名前>.local:25252` を書きます
  ([別の所に置く](agent.md#エージェントは別イメージ別プロセス)のと同じ構成)。
  エージェントは認証を持たないので、その Mac の 25252 には世帯の外から届かないようにします
  ([エージェントは認証を持たない](agent.md#エージェントは認証を持たない))
- **誰を通すか** (`TRUSTED_NETWORKS`) は compose.prod.yml と同じ `192.168.0.0/16,10.0.0.0/8` です。Mac のブラウザから
  localhost で入ったときの送信元は Docker の作りで変わり、Docker Desktop なら `192.168.65.x` なので通ります。
  断られたら、画面に出る接続元を compose.override.yml の `TRUSTED_NETWORKS` に足します

LaunchAgent の環境変数は、コンテナ既定の置き場を Mac の置き場に向け直すものです
(`AGENT_PORT` (25252 のまま) `TUNERS_FILE` `CHANNELS_FILE` `PX4_USERLAND_DIR` `PX4_FIRMWARE` `PX4_RUNTIME_DIR`
`SIANO_USERLAND_DIR` `SIANO_FIRMWARE` `RAW_DIR`)。`PX4_RUNTIME_DIR` を
`~/Library/Caches/denpa-agent` と短くしているのは、px4d の制御ソケットのパスが macOS では
104 バイトまでだからです。IT930x のファームウェアはコンテナと同じく PLEX のドライバから
手元で切り出します (ハッシュ3つで確かめる)。
denpa も Docker で動かすときは、もう1つ `AGENT_HOST=127.0.0.1` を書き、エージェントを Mac のループバックでだけ
待ち受けさせます (認証を持たないため)。コンテナの denpa は `host.docker.internal` 越しにそこへ繋ぎます。
`--no-docker` では書きません (別の機械の denpa から繋ぐため)。

**Linux と違うところ。**

- **チューナーは px4-userland と siano-userland の機材だけ。** macOS には DVB が無いので、
  PT2/PT3 のような PCI の機材は使えません
- **カードリーダー**: px4-userland の内蔵リーダーはそのまま (px4d に聞く)。USB のリーダーは
  usbfs を直接扱えないので、**macOS 標準の PC/SC (PCSC.framework) 越し**に扱います
  (`Pcsc.cs`)。`denpa-agent --card` はそのリーダーを並べます ([読めないとき](#カードが読めないとき))。動いている間はリーダーを
  排他で使うので、他のアプリはカードを使えません
- pipe を広げられない (`F_SETPIPE_SZ` が無い) ので、siano-ts から受ける溜めは Linux より浅い
  (px4d から受ける溜めは pipe を使わないので、Linux と同じ 8MB)
- **Apple Silicon だけ** (Intel Mac 用の px4-userland / siano-userland が無い)
- **Mac の実機でチューナーとカードを繋いで確かめたことはまだありません。** CI でビルドして起こし、
  入れ方を最後まで流すところまで (`.github/workflows/test.yml` の `agent-macos`。
  Mac のランナーには Docker が無いので、compose.mac.yml は Linux のジョブ (`install-linux`) で書き方だけ見る)

## カードが読めないとき

**macOS の標準の CCID ドライバ (Apple のもの) では、B-CAS カードに繋がらないリーダーがあります。**
IDBridge CT30 で、従来のドライバ (ifd-ccid) に切り替えたら読めるようになった、という報告があります
(こちらの実機では確かめていません)。切り替えはシステムの設定なので、エージェントもインストーラも勝手には変えません。

```sh
# 従来のドライバに切り替える。カードを挿したままリーダーを抜き差しすると効く (サービスの再起動だけでは効かない)
sudo defaults write /Library/Preferences/com.apple.security.smartcard useIFDCCID -bool yes
# 標準のドライバに戻す
sudo defaults write /Library/Preferences/com.apple.security.smartcard useIFDCCID -bool no
```

ほかのスマートカード (仕事の IC カードなど) の動きも変わりうるので、読めなかったときだけ切り替えてください。
今どちらのドライバかは `denpa-agent --card` のリーダーの一覧のあと (「CCID ドライバ: …」の行) と、denpa の設定の「その他」→「バージョンと環境」の「CCID ドライバ」に出ます。

**なぜ読めないか (推測)。** B-CAS カードは specific mode で、ATR の直後から TA1 の速さで話します。
Gemalto PC Twin の系統のリーダー (IDBridge CT30 もこの系統) はそれを自分では読まず、ドライバが速さを
設定する必要があります (Linux のエージェントはそうしている。`Ccid.cs`)。従来のドライバはこれをしますが、
Apple のドライバはソースが公開されておらず、ここが違うのかは確かめられていません。Sequoia で
「Gemplus USB SmartCard Reader」が Apple のドライバだと `Card is unresponsive` になり、従来のドライバで直った、
という報告もあります ([Ludovic Rousseau's blog](https://blog.apdu.fr/posts/2024/10/macos-sequoia-and-smart-cards-status/))。
Apple のドライバには速さの設定 (`AllowAlternativeFiDi`。`man SmartCardServices`) もありますが、これは速さを
カードと決め直すカード (negotiable mode) 向けで、B-CAS のような specific mode のカードには効かない見込みです。

繋がらないときは、ログの PC/SC のエラー番号 (`0x8010…`) と `denpa-agent --card` の出力を
[Issue](https://github.com/danything/denpa/issues) に貼ってもらえると、ドライバを切り替えずに読めるようにできるかを調べられます。
