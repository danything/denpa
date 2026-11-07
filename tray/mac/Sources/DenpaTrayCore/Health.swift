// denpa の様子と、それをメニューバーに出す文言。文言は Windows の通知領域のアプリ (tray/Denpa.Tray/Health.cs) とそろえる。

import Foundation

/// denpa の `GET /api/health` の答えのうち、メニューバーに出すもの。
/// 新しいバージョンがあるかは denpa が GitHub の releases/latest と見比べた結果 (src/lib/server/update.ts) をそのまま使い、ここでは比べない
public struct Health: Equatable, Sendable {
    public let version: String
    /// 新しいバージョン (`v2.31.0` の形)。無ければ nil
    public let latest: String?
    public let recording: Int
    public let encoding: Int

    public init(version: String, latest: String?, recording: Int, encoding: Int) {
        self.version = version
        self.latest = latest
        self.recording = recording
        self.encoding = encoding
    }

    /// 読む。`ok` が true でなければ nil (動いていないのと同じに扱う)。
    /// 足りない項目は無いものとして読む (古い denpa には `encoding` が無い)
    public static func parse(_ data: Data) -> Health? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let ok = root["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue
        else { return nil }
        let update = root["update"] as? [String: Any]
        return Health(
            version: root["version"] as? String ?? "?",
            latest: update?["version"] as? String,
            recording: count(root["recording"]),
            encoding: count(root["encoding"])
        )
    }

    private static func count(_ value: Any?) -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFNumberGetTypeID() else { return 0 }
        return number.intValue
    }
}

public enum Words {
    /// メニューの先頭に出す 1 行 (選べない)。答えが無ければ、応答しないと出す
    public static func summary(_ health: Health?) -> String {
        guard let health else { return "denpa が応答しません" }
        var line = "denpa \(health.version)"
        if health.recording > 0 { line += "・録画中 \(health.recording) 本" }
        if health.encoding > 0 { line += "・エンコード中 \(health.encoding) 本" }
        return line
    }

    /// メニューの更新の項目
    public static func updateItem(_ latest: String) -> String {
        "\(latest) に更新…"
    }

    /// 更新を始める前に確かめる文。録画もエンコードもしていなければ nil (確かめずに始める)。
    /// 録画は止めない。install.sh が録画の終わりを待ってから入れ替える (mac_stop。本体は SIGTERM を受けると録画を待つ)。
    /// エンコードは待たずに止まり、起き直したあとで最初からやり直しになる (encoder.ts の requeueOrphanedJobs) ので、そう言って選んでもらう
    public static func askBeforeUpdate(_ health: Health) -> String? {
        if health.recording == 0 && health.encoding == 0 { return nil }
        var text = ""
        if health.recording > 0 { text += "録画中です (\(health.recording) 本)。録画が終わるまで待ってから入れ替えます。\n" }
        if health.encoding > 0 { text += "エンコード中です (\(health.encoding) 本)。更新するとエンコードを中断し、更新のあとで最初からやり直します。\n" }
        return text + "\n更新しますか"
    }
}

public enum Installer {
    /// 更新に流すシェルスクリプト (Terminal で開く .command)。入れたときと同じ install.sh の 1 行 (docs/install-mac.md)。
    /// sudo のパスワードを聞き、録画を待つ間の表示と結果を Terminal に出す。ブラウザは開かない。
    /// 読み込まれたら自分を消す。失敗したら Enter を押すまで閉じない
    public static let command = """
        #!/bin/bash
        # denpa-tray が書いた (denpa を更新するために Terminal で開く)
        rm -f "$0"
        curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | sudo bash -s -- --no-open || {
          echo
          read -r -p '更新できませんでした。Enter で閉じます'
        }

        """
}
