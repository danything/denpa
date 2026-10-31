#!/bin/sh
# ---------------------------------------------------------------------------
# Talos Linux の 1 台に denpa を立てる。**ISO で起こしたまっさらな機械に、OS の設定から denpa まで 1 行で。**
# docs/install-talos.md。
#
#   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/talos/install.sh | sh -s -- --node 192.168.1.50
#       ディスクの一覧を番号で出し、選んだディスクに入れて denpa まで (yes と打つまで消さない)
#   curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/talos/install.sh | sh -s -- --node 192.168.1.50 --disk /dev/nvme0n1
#       聞かずにそのディスクに入れる (端末の無いところから流すとき)
#
#   --node IP        Talos の ISO で起こした機械の IP (起動画面に出る)。必須
#   --disk PATH      入れるディスク (/dev/sda・/dev/nvme0n1 など)。**中身は消える**。渡さなければ番号で選ぶ
#   --trusted CIDR   ログインなしで通すネットワーク (カンマ区切り。既定は 192.168.0.0/16,10.0.0.0/8。docs/auth.md)
#
# 流すのは操作する側の機械 (Linux・Mac)。Talos の機械には何も入れない (シェルが無い)。
# 要るのは curl と helm。talosctl は下のバージョンのものを置き場に取ってきて使う。
#
# やること: schematic.yaml を Image Factory に送って ID を受け取る → talosctl gen secrets / gen config
# (patch.yaml を重ねる) → apply-config --insecure (ディスクに入れて再起動) → bootstrap → health →
# kubeconfig → helm で denpa の chart。もう一度流すと、済んだところは飛ばす (秘密は作り直さない)。
#
# 置き場: ~/denpa-talos (DENPA_TALOS_HOME で変えられる)
#   secrets.yaml      クラスタの CA と鍵。**失くすと機械を入れ直すしかない。どこかに控えておく**
#   controlplane.yaml machine config (secrets.yaml と patch.yaml から作る)
#   talosconfig       talosctl の資格情報。`export TALOSCONFIG=~/denpa-talos/talosconfig`
#   kubeconfig        kubectl と helm の資格情報
#   values.yaml       denpa の chart の値。無いときだけ作り、あれば触らない (手を入れるならここ)
#   bin/talosctl
#
# 環境変数: DENPA_TALOS_HOME、DENPA_TALOS_SRC (schematic.yaml と patch.yaml を取ってくる先。
# 既定は main。ディレクトリを渡すとそこから読む。CI と開発用)
# ---------------------------------------------------------------------------
set -eu

# Talos は PT3 のドライバ (dvb-pt3) が入った v1.15 の alpha に乗せる。正式リリースが出たらそちらへ。
# renovate: datasource=github-releases depName=siderolabs/talos
TALOS_VERSION=v1.15.0-alpha.2
# gen config の既定は talosctl と組の Kubernetes で、alpha の talosctl だと Kubernetes も alpha になるので留める
# renovate: datasource=github-releases depName=kubernetes/kubernetes extractVersion=^v(?<version>.*)$
KUBERNETES_VERSION=1.37.2
# 画面を開く NodePort (http://<IP>:30300)。NodePort は 30000〜32767 からしか選べない
NODE_PORT=30300

SRC="${DENPA_TALOS_SRC:-https://raw.githubusercontent.com/danything/denpa/main/talos}"
DIR="${DENPA_TALOS_HOME:-$HOME/denpa-talos}"
CLUSTER=denpa

NODE=""
DISK=""
TRUSTED="192.168.0.0/16,10.0.0.0/8"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() {
	printf '\033[31mエラー: %s\033[0m\n' "$*" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case "$1" in
	--node)
		NODE="${2:-}"
		shift 2
		;;
	--disk)
		DISK="${2:-}"
		shift 2
		;;
	--trusted)
		TRUSTED="${2:-}"
		shift 2
		;;
	*) die "知らない引数です: $1 (使えるのは --node・--disk・--trusted)" ;;
	esac
done
[ -n "$NODE" ] || die "--node に、Talos の ISO で起こした機械の IP を渡してください"

command -v curl >/dev/null 2>&1 || die "curl が要ります"
command -v helm >/dev/null 2>&1 || die "helm が要ります。https://helm.sh/docs/intro/install/ で入れてから、もう一度流してください"

mkdir -p "$DIR/bin"
umask 077

# 取ってくる (SRC が URL ならダウンロード、ディレクトリならコピー)
fetch() {
	case "$SRC" in
	http://* | https://*) curl -fsSL "$SRC/$1" -o "$2" ;;
	*) cp "$SRC/$1" "$2" ;;
	esac
}

# --- talosctl --------------------------------------------------------------
# 入れる Talos と同じバージョンを使う (gen config が作るドキュメントの形がバージョンで変わる)。
# 中身はリリースの sha256sum.txt で確かめる
TALOSCTL="$DIR/bin/talosctl"
if [ ! -x "$TALOSCTL" ] || ! "$TALOSCTL" version --client --short 2>/dev/null | grep -q "$TALOS_VERSION"; then
	case "$(uname -s)" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	*) die "流せるのは Linux か Mac です" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) die "知らないアーキテクチャです: $(uname -m)" ;;
	esac
	say "talosctl $TALOS_VERSION を取ってきます"
	base="https://github.com/siderolabs/talos/releases/download/$TALOS_VERSION"
	curl -fsSL "$base/talosctl-$os-$arch" -o "$TALOSCTL.tmp"
	want=$(curl -fsSL "$base/sha256sum.txt" | awk -v f="talosctl-$os-$arch" '$2 == f { print $1 }')
	if command -v sha256sum >/dev/null 2>&1; then
		got=$(sha256sum "$TALOSCTL.tmp" | awk '{ print $1 }')
	else
		got=$(shasum -a 256 "$TALOSCTL.tmp" | awk '{ print $1 }')
	fi
	[ -n "$want" ] && [ "$want" = "$got" ] || die "talosctl のハッシュが合いません (取り損ねたか、すり替わっています)"
	chmod +x "$TALOSCTL.tmp"
	mv "$TALOSCTL.tmp" "$TALOSCTL"
fi
talosctl() { "$TALOSCTL" "$@"; }

export TALOSCONFIG="$DIR/talosconfig"

# --- machine config と、ディスクへのインストール ------------------------------
# 機械がメンテナンスモード (ISO で起きて、設定を待っている) なら、--insecure で話せる
if talosctl get disks --insecure -n "$NODE" -e "$NODE" >/dev/null 2>&1; then
	# 入れられるディスク (読み取り専用と光学ドライブを除く) を「パス<TAB>大きさ<TAB>型番<TAB>繋ぎ方」で1行ずつ。
	# talosctl の YAML (DiskSpec の dev_path・pretty_size・model・transport・readonly・cdrom) を読む。
	# ISO を書き込んだ USB メモリも並ぶので、繋ぎ方 (usb・nvme・sata) を添えて見分けられるようにする
	disks=$(talosctl get disks --insecure -n "$NODE" -e "$NODE" -o yaml | awk '
		function flush() {
			if (path != "" && ro != "true" && cd != "true") printf "%s\t%s\t%s\t%s\n", path, size, model, tr
			path = ""; size = ""; model = ""; tr = ""; ro = ""; cd = ""
		}
		/^---/ || /^node:/ { flush() }
		$1 == "dev_path:" { path = $2 }
		$1 == "pretty_size:" { $1 = ""; size = substr($0, 2) }
		$1 == "model:" { $1 = ""; model = substr($0, 2) }
		$1 == "transport:" { tr = $2 }
		$1 == "readonly:" { ro = $2 }
		$1 == "cdrom:" { cd = $2 }
		END { flush() }
	')
	[ -n "$disks" ] || die "$NODE に入れられるディスクが見つかりません"
	if [ -n "$DISK" ]; then
		printf '%s\n' "$disks" | cut -f1 | grep -qx "$DISK" ||
			die "$NODE に $DISK はありません。あるのは: $(printf '%s\n' "$disks" | cut -f1 | tr '\n' ' ')"
	elif (exec </dev/tty) 2>/dev/null; then
		# curl | sh で流すと標準入力はこのスクリプトそのものなので、答えは端末 (/dev/tty) から読む
		say "$NODE のディスクです。入れる先を番号で選んでください (中身は消えます)"
		printf '%s\n' "$disks" | awk -F '\t' '{ printf "  %d) %s  %s  %s  %s\n", NR, $1, $2, $3, $4 }'
		printf '番号: '
		read -r pick </dev/tty
		DISK=$(printf '%s\n' "$disks" | awk -F '\t' -v n="$pick" 'NR == n { print $1 }')
		[ -n "$DISK" ] || die "番号が合いません: $pick"
		printf '%s の中身を消して Talos を入れます。よければ yes と打ってください: ' "$DISK"
		read -r answer </dev/tty
		[ "$answer" = yes ] || die "やめました"
	else
		# 端末が無い (CI や、ほかのスクリプトから流した) ときは一覧だけ出して止まる
		say "$NODE のディスクです。入れる先を --disk で渡して、もう一度流してください (中身は消えます)"
		printf '%s\n' "$disks" | awk -F '\t' '{ printf "  %s  %s  %s  %s\n", $1, $2, $3, $4 }'
		exit 1
	fi

	say "Image Factory で schematic の ID を受け取ります"
	fetch schematic.yaml "$DIR/schematic.yaml"
	fetch patch.yaml "$DIR/patch.yaml"
	id=$(curl -fsS -X POST --data-binary "@$DIR/schematic.yaml" https://factory.talos.dev/schematics |
		sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p')
	[ -n "$id" ] || die "Image Factory から schematic の ID を受け取れませんでした"

	if [ ! -f "$DIR/secrets.yaml" ]; then
		say "クラスタの秘密を作ります ($DIR/secrets.yaml。控えておいてください)"
		talosctl gen secrets -o "$DIR/secrets.yaml"
	fi

	say "machine config を作ります"
	talosctl gen config "$CLUSTER" "https://$NODE:6443" \
		--with-secrets "$DIR/secrets.yaml" \
		--kubernetes-version "$KUBERNETES_VERSION" \
		--install-disk "$DISK" \
		--install-image "factory.talos.dev/metal-installer/$id:$TALOS_VERSION" \
		--config-patch "@$DIR/patch.yaml" \
		--with-docs=false --with-examples=false \
		-t controlplane,talosconfig -o "$DIR" --force
	talosctl validate --config "$DIR/controlplane.yaml" --mode metal >/dev/null
	talosctl config endpoint "$NODE"
	talosctl config node "$NODE"

	say "$DISK に Talos を入れます。入れ終わると機械が再起動します"
	talosctl apply-config --insecure -n "$NODE" -e "$NODE" -f "$DIR/controlplane.yaml"
elif [ -f "$TALOSCONFIG" ] && talosctl version -n "$NODE" -e "$NODE" >/dev/null 2>&1; then
	# 手元の資格情報で話せる = この置き場で入れた機械。以降は --node の機械に向ける
	say "$NODE には入れてあります。インストールは飛ばします"
	talosctl config endpoint "$NODE"
	talosctl config node "$NODE"
else
	die "$NODE に繋がりません。Talos の ISO で起こして、起動画面に出る IP を --node に渡してください"
fi

# --- Kubernetes ------------------------------------------------------------
# 再起動して apid が答えるまで数分かかる。それまでは bootstrap が失敗するので待つ
say "Kubernetes を起こします (再起動を待つので、数分かかります)"
tries=0
until out=$(talosctl bootstrap 2>&1); do
	case "$out" in
	*AlreadyExists* | *"already exists"*) break ;;
	esac
	tries=$((tries + 1))
	[ "$tries" -lt 120 ] || die "bootstrap が通りません: $out"
	sleep 10
done

say "ノードと Kubernetes が揃うのを待ちます"
talosctl health --wait-timeout 30m

talosctl kubeconfig "$DIR/kubeconfig" --force >/dev/null

# --- denpa -----------------------------------------------------------------
if [ ! -f "$DIR/values.yaml" ]; then
	cat >"$DIR/values.yaml" <<EOF
# denpa の chart の値 (talos/install.sh が作った。あれば触らない)。一覧と意味は charts/denpa/values.yaml
denpa:
  # ログインなしで通すネットワーク (docs/auth.md)
  trustedNetworks: "$TRUSTED"
service:
  # 前段を置かずに http://$NODE:$NODE_PORT で開く
  type: NodePort
  nodePort: $NODE_PORT
# ArgoCD のフックなので、helm で入れるときは使わない
prepull:
  enabled: false
EOF
fi

say "denpa を入れます (イメージを引くので数分かかります)"
helm upgrade --install denpa oci://ghcr.io/danything/charts/denpa \
	--kubeconfig "$DIR/kubeconfig" --namespace denpa \
	-f "$DIR/values.yaml" --wait --timeout 20m

say "できました: http://$NODE:$NODE_PORT"
echo "  secrets.yaml (クラスタの秘密) は $DIR にあります。失くすと入れ直すしかないので控えておいてください"
echo "  talosctl: export TALOSCONFIG=$DIR/talosconfig    kubectl: export KUBECONFIG=$DIR/kubeconfig"
