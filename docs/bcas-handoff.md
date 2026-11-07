# B-CAS 契約確認の引き継ぎ書

更新: 2026-11-07

この文書は、B-CAS の契約確認・復号テスト・期限切れ通知の作業を別の AI や
開発者へ引き継ぐためのもの。仕様・実測・複数 PR の方針は
[bcas-contracts.md](bcas-contracts.md) に詳しく書いてある。こちらは
「いま何がどこまで終わっていて、次に何をするか」を短くまとめる。

関連: danything/denpa#2221、PR #2231、Antigravity の引継書
(`b664cd3a-7fb6-4bb2-b304-db32cf5243f6/handoff.md`)

## 0. 最初に守ること

- 絵文字は UI・通知・コード・ログ・文書で使わない。
- 用語は「期限切れ」で統一する (「次期 Kw」は使わない)。
- 変更したら次を通す。
  - `TZ=Asia/Tokyo npx -y bun test --isolate src packages scripts`
  - `npx -y bun run check`
  - `npx -y bun run lint`
- 上流 PR の範囲を壊さない。EMM・期限切れ通知・バッジは feature 枝に残す。

## 1. リポジトリと枝

- 作業場所: `/home/kuni/dev/denpa`
- 枝: `feat/bcas-keep-emm-expiry`
- remote:
  - `origin` = `danything/denpa` (push は 403 で不可)
  - `myfork` = `haruki0420/denpa` (push はここ)
- 上流 `origin/main` の先頭: `8c6dca1e`
- 上流 main には EMM・期限切れ通知・バッジ・`contract_warning` は入っていない。
  それらはこの feature 枝にある。
- 配備に使うのは `feat/bcas-keep-emm-expiry` だけ。
  `feat/bcas-batch-decode` は別途配備しない (一括復号はこの枝に cherry-pick 済み)。

主なコミット:

| コミット   | 内容                                             |
| ---------- | ------------------------------------------------ |
| `192c8d4f` | 未確認の有料局をまとめて復号テストする           |
| `1a7b7840` | 契約確認・7 日前通知の現状と複数 PR 方針を文書化 |
| `758fc3e9` | 0xCB の有無を生の EIT で確認した結果             |
| `38a1c1d4` | 事業者単位で契約期限を表示する考え方             |
| `4a209a1f` | BS10 をジャパネットとして整理                    |
| `aebc0563` | ジャパネットを BS10 と BS10 プレミアムへ整理     |
| `9754c252` | スターチャンネルの CS 放送の現状                 |
| `f66f3492` | Kw の配布と契約管理の単位を区別                  |

`192c8d4f` までは `myfork` に push 済み。それより後の文書コミットは、
この引き継ぎ書を足したあとに push する。

作業ツリーには `Dockerfile.agent.custom` と `Dockerfile.denpa.custom` が
未追跡で残っている。これは kuni1 で使うカスタムビルド用で、コミットしない。

## 2. 実装済みのこと

### 2.1 契約確認

- EPG 収集時に、有料番組の EIT から CA契約情報記述子 (0xCB) の
  `contract_verification_info` を `programs.contract_verification` に保存する。
- `checkContracts()` が局ごとの最新の有料番組から 0xCB を拾い、B-CAS カードへ
  `0x90 0x3C` を送る。今日と 7 日後の日付で返り値を聞く。
- 結果を `card_contracts` の `state`、`valid_until`、`code`、`decode_ok`、
  `decoded_at` に保存する。
  - 今日も 7 日後も有効: `subscribed`
  - 今日有効で 7 日以内に切れる: `subscribed` のまま `valid_until` を記録
  - 今日無効で 30 日以内に切れた: `expired`
  - それ以外: `unsubscribed`
- 0xCB が無い局は実ストリームの復号テストにフォールバックする。
  31 日以内に復号成功していれば `subscribed`、そうでなければ `unsubscribed`。

### 2.2 復号テスト

- 実際に選局し、TS のスクランブル制御ビットを見て復号できるか確かめる。
- 無料番組中はスクランブルが掛からず契約と取り違えるため対象外。
- 結果は 31 日間だけ契約中の根拠にする (`DECODE_VALID_MS`)。
- 1 局ずつのテストに加えて、同じ物理チャンネルの局を 1 回の選局でまとめて
  確かめる一括テストがある。
  - `testDecodeUnconfirmed()`
  - `recordDecode()`
  - `testDecodeAll()`
  - UI: `ContractDialog.svelte` のボタン

### 2.3 期限切れの表示と通知

- `expired` の局は予約・番組表で「期限切れ」バッジを出す。
- 自動録画の対象から外す。
- `scheduler.tick()` が `CONTRACT_SCAN_INTERVAL` (既定 12 時間) または深夜 JST 03:00 に `scanContracts()` を呼ぶ。
- 前回の状態と比べて **新たに `expired` になった局** に `contract.expired` Webhook を送る。
- `subscribed` かつ `valid_until` が 7 日以内の局に **`contract.expiring` (期限切れ予告) Webhook** を送る。
- `contract_notifications` テーブルに記録し、同一期限に対する二重通知を防ぐ。

### 2.4 EMM

- `0x90 0x36` で EMM を受信してカードを更新する処理がある。
- これは鍵の更新であり、契約の有無・期限を読み出すものではない。
- 契約判定とは別の PR に分ける方針。

## 3. kuni1 での実測結果

### 3.1 一括復号テスト

- 60 局成功 / 0 失敗
- 22 回の選局
- 約 20.5 秒

### 3.2 0xCB の有無

生の EIT を denpa と同じ `EpgReader` で数えた結果。

| 物理チャンネル | 局                | イベント数 | 0xCB あり |
| -------------- | ----------------- | ---------: | --------: |
| BS05:17488     | WOWOW ライブ      |        117 |        97 |
| BS05:17489     | WOWOW シネマ      |        193 |        38 |
| BS03:16432     | WOWOW プライム    |        147 |       133 |
| BS03:17969     | BS アニマックス   |        236 |         0 |
| BS15:16626     | BS10 プレミアム   |        201 |         0 |
| BS15:18675     | BS10 (無料)       |         91 |         0 |
| BS21:18256     | WOWOW プラス      |        252 |         0 |
| BS23:18288     | ディズニー ch     |        256 |         0 |
| CS02:24608     | 4 局              |        423 |         0 |
| CS04:28736     | 4 局              |        125 |         0 |
| CS06:28768     | 8 局              |        875 |         0 |
| CS10:24736     | スカチャン 1      |         65 |        65 |
| CS10:24736     | 衛星劇場ほか 4 局 |        251 |         0 |

分かったこと:

- **0xCB を流さない局は実在する。** 同じ CS10 の中でスカチャン 1 だけが
  0xCB を出し、同居局は出さない。読み取り漏れではない。
- **DB に 0 件でも、生の EIT にはあることがある。** WOWOW ライブがこれで、
  機能追加前の番組行が残っていて EPG 再取得待ちだった。
- 調査では「DB に無い」と「生の EIT に無い」を必ず分ける。

## 4. 7 日後判定の可否

| 契約管理     | 対象                                    | 0xCB                  | 7 日後判定 |
| ------------ | --------------------------------------- | --------------------- | ---------- |
| WOWOW        | プライム / ライブ / シネマ              | あり                  | できる     |
| WOWOW        | プラス                                  | なし (スカパー! 経由) | できない   |
| ジャパネット | BS10 プレミアム (BS201)                 | なし                  | できない   |
| スカパー!    | スカチャン 1                            | あり                  | できる     |
| スカパー!    | CS02/04/06、CS10 の同居局、その他有料局 | なし                  | できない   |

- 7 日後の電波・ECM を今復号することはできない。未来の鍵はまだ届いていない。
- できるのは「7 日後の日付でカードが有効か」を `0x90 0x3C` に聞くことだけ。
- 0xCB が無い局は、復号テストで「いま」しか分からない。
- 無料お試し期間中は、いま復号できても正規契約とは限らない。

## 5. 用語の整理

- **Km**: マスター鍵。B-CAS カードごとに固有。
- **Kw**: ワーク鍵。EMM に載って契約事業者から配られる。ECM を復号する鍵。
- **Ks**: スクランブル鍵。ECM に載る。映像・音声を復号する鍵。
- **EMM**: 契約情報と Kw を運ぶ個別情報。契約事業者ごとに送られる。
- **ECM**: Ks を運ぶ共通情報。スクランブルされた番組ごとに流れる。
- **0xCB**: EIT の CA契約情報記述子。`contract_verification_info` を含む。
- **`0x90 0x3C`**: 契約確認コマンド。0xCB の verificationData と日付を渡す。
- **`0x90 0x34`**: ECM を渡して復号鍵を得るコマンド。
- **`0x90 0x36`**: EMM を受信してカードを更新するコマンド。

注意:

- 「Kw を配っているのは WOWOW・ジャパネット・スカパーだけ」は正確ではない。
  Kw は EMM に載って各契約事業者から配られる。
- 3 つに集約されるのは **契約を管理している単位 (課金単位)**。
  kuni1 で受信できる有料局は、WOWOW (直契約)、ジャパネット (直契約)、
  スカパー! (プラットフォーム経由) の 3 つに整理できる可能性が高い。
- スカパー! は 1 契約で全チャンネルが見られるわけではなく、チャンネル単位・
  パック単位で契約が分かれる。
- 事業者名は変わる。コードに固定せず、設定または DB の対応表で持つ。

## 6. スターチャンネルとジャパネット

- 旧スターチャンネルは 2024-08-01 にジャパネットブロードキャスティングへ
  吸収合併された。
- BS は 2025-01-10 に「BS10 スターチャンネル」、2025-10-01 に
  「BS10 プレミアム (BS201)」へ改称した。
- BS10 (Ch.200) は無料局。有料なのは BS10 プレミアムだけ。
- BS10 と BS10 プレミアムはどちらも 0xCB を出さない。
- CS のスターチャンネルは、110 度 CS の 4K (CS881) が 2024-03-31 に終了。
  スカパー!プレミアムサービス Ch.625 は別衛星で denpa では受信できない。
  どちらも独立した契約事業者ではない。
- したがって denpa の契約判定では、BS201 の BS10 プレミアムだけを見ればよい。

出典:

- Wikipedia `BS10` / `BS10プレミアム`
- ジャパネット 2024-08-22 のニュースリリース
- スカパーJSAT「4K チャンネル終了のお知らせ」
- AV Watch 2024-03-01

## 7. まだ無いものと次の PR

### PR A: 状態モデルの整理と「未確認」表示 (実装完了)

- `card_contracts.state` に `unknown` を追加。
- 判定根拠 `source` (`eit_ca` / `decode` / `manual`) を追加。
- 0xCB が無く復号テスト未実施の局を「未確認」と判定・記録。
- `ContractDialog.svelte` で「契約中」「期限切れ」「未確認」「未契約」の表示と判定元（カード判定 / 復号テスト）を整理。

### PR B: 7 日前通知と深夜スキャン (実装完了)

- `subscribed` かつ `valid_until` が 7 日以内の局を検知。
- `contract.expiring` イベントを追加し、Discord などへ「7 日後に期限切れ」予告を送信。
- `contract_notifications` テーブルに記録し、同一期限での重複通知を抑止。
- 深夜 (JST 03:00) を跨いだタイミングでの定期スキャン実行を追加。
- 0xCB が無い局は 7 日後判定の対象外（復号テスト有効期限に基づく）。

### PR C: 契約確認方式の抽象化と拡張 (次)

- `ContractChecker` のような形で、EIT 0xCB、復号テスト、ECM 確認、
  手動設定を同じ結果にまとめる。
- EIT の 0xCB 収集範囲を広げ、局ごとに「使える方式」を記録する。
- エージェントの ECM 応答コードを API に出し、復号テストの短縮版を作る。
- 判定の優先順位を決める。例: カードの 0x3C > ECM/復号 > 手動 > 未確認。
- 7 日後を聞けない局は、この PR では「未確認」のままにする。

### PR D: 手動設定と除外

- 自動判定できない局に「契約中」「対象外」「未確認」を設定できるようにする。
- 設定した局は自動判定で上書きしない。
- 録画ルールとの関係 (契約中とみなすか) を明確にする。

### 別 PR: EMM 自動更新

- すでに feature 枝にある EMM 受信・`0x90 0x36` 更新は、契約判定とは別の PR にする。
- 上流 main には入れず、必要なら単独で提案する。

## 8. 検証

この引き継ぎ書を書いた時点の結果:

- `TZ=Asia/Tokyo npx -y bun test --isolate src packages scripts`
  - 3104 pass / 0 fail / 14081 expect() calls
- `npx -y bun run check`
  - svelte-check 0 errors / 0 warnings
- `npx -y bun run lint`
  - pass

注意:

- この環境では `bun` が PATH に無いので `npx -y bun` を使う。
- `bun test` は TZ を指定しないと UTC で走る。JST の 00:00-09:00 の間は
  `src/lib/server/clips.test.ts` の日付テストが 1 件落ちる既知の環境依存がある。
  `TZ=Asia/Tokyo` を付ければ通る。今回の変更とは無関係。

## 9. kuni1 の確認環境

- `ssh kuni1`
- compose: `/home/kuni/denpa/compose.yml` と `compose.override.yml`
- worktree: `/home/kuni/.cache/denpa-work`
- DB: `/data/denpa.db` (コンテナ内)
- イメージ:
  - app: `denpa:feat-bcas` (`75ae348c7bfa` を最後に配備)
  - agent: `denpa-agent:feat-bcas` (`83d72baed776`、ファーム v2)
- `DENPA_VERSION: v2.31.1`
- `docker compose restart` ではイメージが差し替わらない。
  必ず `--force-recreate` を使う。
- 生 EIT の一時計測スクリプトは `/tmp/opencode/eit-probe.ts` に置いた。
  リポジトリには入れていない。再計測するなら同じ `EpgReader` を使う。

## 10. 関連ファイル

- `docs/bcas-contracts.md`: 仕様・実測・複数 PR 方針の本体
- `src/lib/server/contracts.ts`: `checkContracts`, `testDecode`,
  `testDecodeUnconfirmed`, `recordDecode`, 7 日後判定
- `src/lib/server/scheduler.ts`: `scanContracts`, 12 時間ごとの契約スキャン,
  `contract.expired` 通知
- `src/lib/server/webhook.ts`: `notifyContractExpired`, `contract.expired`
- `packages/arib/src/eit.ts`: 0xCB の解析 (EIT[p/f] と EIT[schedule] の両方)
- `src/lib/server/epg.ts`: `contract_verification` の保存と `COALESCE` 更新
- `src/lib/server/schema.ts`: `card_contracts` の `state`, `valid_until`,
  `decode_ok`, `decoded_at`
- `src/routes/settings/reception/ContractDialog.svelte`: 契約確認・EMM・
  一括復号の UI
- `src/routes/settings/reception/tuners.server.ts`: `checkContracts`,
  `testDecode`, `testDecodeAll`, `receiveEmm` の actions
- `src/lib/server/contracts.test.ts`: 一括復号・契約判定のテスト
- `src/lib/server/scheduler-contracts.test.ts`: 期限切れスキャンと通知のテスト
- `src/lib/server/webhook.test.ts`: `contract.expired` のテスト
- `agent/Denpa.Agent/BCas.cs`: `0x90 0x3C` (契約確認)、
  `0x90 0x34` (ECM)、`0x90 0x36` (EMM)

## 11. 決めること

1. 7 日前通知の event 名を `contract.expiring` にするか。
2. 通知を 7 日前の 1 回だけにするか、3 日前・前日にも出すか。
3. 深夜実行の時刻を固定するか、`CONTRACT_SCAN_INTERVAL` の延長で済ませるか。
4. `state` に `unknown` を足すか、`confirmed` を別に持つか。
5. 0xCB が無い局を手動設定できるようにするか。
6. 事業者単位の期限表示を入れるか。入れるなら「代表局で確認」と明記する。
