# 貢献の手引き

興味を持ってくれてありがとうございます。denpa は個人の録画環境のために
作られているので、大きな方針は README と [docs/](../docs/) にある設計文書が
基準になります。

## Issue

- **バグ報告**は再現手順とログを添えてください。録画・チューナー周りは
  環境依存が強いので、チューナーの種類・OS・denpa のバージョンが分かると
  早く辿れます。
- **機能要望**は「何がしたいか」から書いてください。実装方法の提案より、
  困りごとのほうが議論しやすいです。

## Pull Request

1. まず Issue で相談してもらえると無駄がありません (方針に合わないものを
   作り込んでしまう前に)。
2. リント・型・単体・E2E が通ることを確かめてください。**ホストに bun は要らず、
   全部コンテナの中で回します** (下記)。
3. コードのコメント・コミットメッセージは日本語で、**なぜそうしたか**を
   書く流儀に合わせてください (既存コードを見れば雰囲気が分かります)。

マージした PR を書いてくれた人は、README の「謝辞」に名前を載せます。

## 開発環境

```sh
docker compose up                           # 開発サーバ(:5173) + 偽エージェント(:25252)
docker compose run --rm unit                # 単体テスト
docker compose run --rm e2e                 # E2E (Playwright)
docker compose run --rm unit bun run lint   # リント + フォーマット確認
docker compose run --rm unit bun run check  # 型 (svelte-check)
```

チューナー実機が無くても、E2E は偽のエージェント (`tests/fake`) で動きます。
テストの方針や DB の列の足し方は [docs/development.md](../docs/development.md) に。
