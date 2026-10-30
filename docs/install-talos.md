# Talos Linux に入れる

**PT3 を挿した機械を Talos Linux の 1 台のクラスタにして、denpa まで 1 行で立てます。**
Talos は Kubernetes を動かすためだけの OS で、シェルも SSH も無く、設定は全部 machine config (YAML) で渡します。
ほかの入れ方は [install.md](install.md)。

> [!WARNING]
> **実機で確かめていません。** PT3 のドライバが入っているのは Talos の alpha (v1.15.0-alpha.2) です。
> 確かめたのは、machine config が `talosctl validate` を通ること、chart が `helm template` で描けることまでです
> ([下記](#確かめたこと確かめていないこと))。動いた・動かなかったを [Issue](https://github.com/danything/denpa/issues) で教えてください。

## Talos で PT3 が使えるわけ

| いつから                                                                            | 何が                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [v1.15.0-alpha.1](https://github.com/siderolabs/talos/releases/tag/v1.15.0-alpha.1) | Talos のカーネルで `CONFIG_DVB_PT3` を有効にした ([siderolabs/pkgs@e7b09e2](https://github.com/siderolabs/pkgs/commit/e7b09e28164e85ab448e47e073864ee6fef09975)。amd64 だけ)                               |
| v1.15.0-alpha.1                                                                     | そのモジュールを配る system extension `siderolabs/dvb-pt3` ([siderolabs/extensions の dvb/pt3](https://github.com/siderolabs/extensions/tree/main/dvb/pt3))。Image Factory の公式の extension に並んでいる |
| [v1.15.0-alpha.2](https://github.com/siderolabs/talos/releases/tag/v1.15.0-alpha.2) | カーネルが求めたモジュールを Talos が読む (On-demand Kernel Module Loading)。earth-pt3 が読む復調とチューナーのモジュールを、順番を気にせず読めるようになった                                              |

PT3 のモジュールは Talos の標準のイメージには入っておらず、extension を足したイメージにだけ載ります。
**Image Factory (<https://factory.talos.dev>) に「dvb-pt3 を足す」という schematic を送ると、それを足したイメージの ID が返ります。**
dvb-pt3 は `earth-pt3` を読まないよう blacklist して配るので、machine config の `KernelModuleConfig` で名前を挙げて読ませます。

alpha.1 にもドライバは入っていますが、復調とチューナーのモジュールを読む順番が狂うと `earth-pt3` が失敗します。
**そのため alpha.2 以降を使います。**

## 用意するもの

- **入れる機械** — amd64 で、PT3 と USB のカードリーダーを挿したもの ([tuners.md](tuners.md#要るもの))。
  ディスクは 1 台で 120GB 以上 (OS とイメージに 64GB、残りを録画と DB に。[下記](#machine-config-の中身))。**中身は消えます**
- **操作する機械** — Linux か Mac で、`curl` と [`helm`](https://helm.sh/docs/intro/install/) が入っているもの。
  `talosctl` は install.sh が合うバージョンを取ってきます
- 同じ LAN に置き、入れる機械に IP が DHCP で振られること

## 入れ方

1. **ISO で起こします。** dvb-pt3 を足したイメージです (Secure Boot は切っておく。Secure Boot 用の ISO は UEFI に鍵を登録しないと起きません)

   ```text
   https://factory.talos.dev/image/cbd251ee8e65601a45b4cd4b3edf3adc3e70037bb293b4e52e4ae1248d0942f2/v1.15.0-alpha.2/metal-amd64.iso
   ```

   USB メモリに書いて起こすと、画面に IP が出て設定を待つ状態 (メンテナンスモード) になります。
   この ID は [talos/schematic.yaml](../talos/schematic.yaml) を Image Factory に送ったときのものです

2. **IP を渡して流します。** ディスクの一覧が出て止まります

   ```sh
   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/talos/install.sh | sh -s -- --node 192.168.1.50
   ```

3. **入れるディスクを足して、もう一度流します。** OS の設定からディスクへのインストール、Kubernetes、denpa まで進みます (20 分ほど)

   ```sh
   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/talos/install.sh | sh -s -- --node 192.168.1.50 --disk /dev/nvme0n1
   ```

4. **`http://<IP>:30300` を開きます。** あとは [README](../README.md#3-開く) と同じです

| 利用者が決めるもの     | 渡し方                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 機械の IP              | `--node`。ISO の起動画面に出るもの。固定したいなら DHCP のほうで同じ IP を振る                                                                                     |
| 入れるディスク         | `--disk`。`--node` だけで流すと一覧が出る                                                                                                                          |
| ログインなしで通す範囲 | `--trusted` (既定は `192.168.0.0/16,10.0.0.0/8`。compose と同じ)。会社や VPN の網が 10.0.0.0/8 に重なるなら自分の LAN だけに絞る。あとから変えるなら `values.yaml` |

install.sh がやること (もう一度流すと、済んだところは飛ばします):

1. `talos/schematic.yaml` を Image Factory に送り、インストールのイメージ (`factory.talos.dev/metal-installer/<ID>:v1.15.0-alpha.2`) を決める
2. `talosctl gen secrets` でクラスタの秘密を作る (初回だけ)
3. `talosctl gen config` に [talos/patch.yaml](../talos/patch.yaml) を重ね、`talosctl validate` で確かめる
4. `talosctl apply-config --insecure` でディスクに入れる (機械が再起動する)
5. `talosctl bootstrap` で Kubernetes を起こし、`talosctl health` で揃うのを待つ
6. `talosctl kubeconfig` で資格情報を取り、`helm upgrade --install` で denpa の chart を入れる
   (`service.type=NodePort`。前段を置かずに `http://<IP>:30300` で開く)

| 置き場 (`~/denpa-talos`。`DENPA_TALOS_HOME` で変えられる) | 中身                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `secrets.yaml`                                            | クラスタの CA と鍵。**失くすと機械を入れ直すしかありません。どこかに控えておきます**                              |
| `controlplane.yaml`                                       | machine config (`secrets.yaml` と `patch.yaml` から作る)                                                          |
| `talosconfig`                                             | talosctl の資格情報 (`export TALOSCONFIG=~/denpa-talos/talosconfig`)                                              |
| `kubeconfig`                                              | kubectl と helm の資格情報 (`export KUBECONFIG=~/denpa-talos/kubeconfig`)                                         |
| `values.yaml`                                             | denpa の chart の値。無いときだけ作り、あれば触りません。手を入れるならここ ([install.md](install.md#誰を通すか)) |
| `bin/talosctl`                                            | 入れる Talos と同じバージョンの talosctl                                                                          |

## machine config の中身

[talos/patch.yaml](../talos/patch.yaml) は `talosctl gen config` が作る設定に重ねるパッチです。秘密は持ちません。
Talos 1.15 の machine config は種類ごとのドキュメントの束で、v1alpha1 の古い書き方 (`machine.kernel.modules`・
`machine.install`・`allowSchedulingOnControlPlanes`) は使いません。

| ドキュメント                                          | やること                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KernelModuleConfig` (`earth-pt3`)                    | PT3 のドライバを読む。復調とチューナーのモジュールは earth-pt3 が求めたときに Talos が読む                                                                                           |
| `KubeNodeConfig`                                      | control-plane の NoSchedule を外して、1 台に denpa を載せる (taints はパッチで消せないので、ドキュメントごと消して labels だけ書き戻す)                                              |
| `VolumeConfig` (`EPHEMERAL`)                          | OS の領域 (`/var`。イメージやログ) を 64GiB で止める。既定ではディスクを全部取ってしまう                                                                                             |
| `UserVolumeConfig` (`local-path-provisioner`)         | 残りを録画と DB の置き場に (`/var/mnt/local-path-provisioner`)。別のディスクに置くなら `diskSelector` を変える                                                                       |
| `KubeInlineManifestConfig` (`local-path-provisioner`) | Talos には PVC を作るものが無いので、[local-path-provisioner](https://github.com/rancher/local-path-provisioner) を入れる。既定の StorageClass で、PVC を消しても中身は残す (Retain) |
| `KubeInlineManifestConfig` (`denpa-namespace`)        | `denpa` の namespace を Pod Security Admission の privileged で作る。Talos の既定は baseline で、tuner-agent の privileged と hostPath (`/dev/dvb`・`/dev/bus`) が通らない           |

インストール先のディスクとイメージは install.sh が `--install-disk` と `--install-image` で渡し、
Kubernetes のバージョンは留めます (alpha の talosctl の既定だと Kubernetes も alpha になるため)。
ディスクの割り方は、まだ切っていないときにしか効きません。入れたあとに変えるなら入れ直します。

Intel の GPU でエンコードするなら、`talos/schematic.yaml` に `siderolabs/i915` を足して ID を作り直します
(`curl -X POST --data-binary @schematic.yaml https://factory.talos.dev/schematics`)。無ければソフトウェアでエンコードします。

## 確かめたこと・確かめていないこと

| 確かめたこと                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ |
| Image Factory の v1.15.0-alpha.1 と alpha.2 に `siderolabs/dvb-pt3` が並んでいて、schematic の ID と ISO が取れる  |
| talosctl v1.15.0-alpha.2 で `gen config` にパッチを重ね、`talosctl validate --mode metal` を通る (CI でも毎回見る) |
| 重ねたあとの設定に NoSchedule が残らず、インストールのイメージとディスクが入っている                               |
| local-path-provisioner と namespace のマニフェストが Kubernetes のスキーマに合う                                   |
| `helm template` で、NodePort の Service と `TRUSTED_NETWORKS` が描ける                                             |
| install.sh が talosctl を取ってきてハッシュを確かめ、繋がらない IP では止まる                                      |

**実機では何も確かめていません。** PT3 が `/dev/dvb` に出ること、ディスクへのインストールから bootstrap・helm までの通し、
ディスクの割り方、NodePort で接続元の IP が届くこと、カードリーダーが見えることは、動かした人の報告を待っています。

## 上げ方・外し方

- **denpa を上げる** — 同じ 1 行をもう一度流します (`helm upgrade --install`。`values.yaml` はそのまま)
- **Talos を上げる** — install.sh の `TALOS_VERSION` が新しくなったら、同じ schematic の ID でイメージを替えます。
  機械は再起動します

  ```sh
  export TALOSCONFIG=~/denpa-talos/talosconfig
  ~/denpa-talos/bin/talosctl upgrade --image factory.talos.dev/metal-installer/<ID>:<新しいバージョン>
  ```

- **外す** — `talosctl reset` でディスクを消して、メンテナンスモードに戻します。録画も消えます

## うまくいかないとき

```sh
export TALOSCONFIG=~/denpa-talos/talosconfig
talosctl dmesg | grep -i -E 'pt3|tc90522|modprobe'   # ドライバを読めたか (Talos が読んだモジュールも出る)
talosctl ls /dev/dvb                                   # PT3 1 枚でアダプタが 4 つ
talosctl ls /var/mnt/local-path-provisioner            # PVC ごとのディレクトリ
```

- `/dev/dvb` が無い — tuner-agent の Pod が `hostPath` の `Directory` を待って起きません。dmesg を見ます
- denpa の画面が 403 — 開いた端末の IP が `values.yaml` の `trustedNetworks` に入っているかを見て、
  直したら 1 行をもう一度流します
- ほかは [tuner-pt3.md](tuner-pt3.md#うまくいかないとき) と [install.md](install.md#うまくいかないとき)
