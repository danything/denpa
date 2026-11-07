// denpa の様子と、それをメニューバーに出す文言。文言は Windows の通知領域のアプリ (tray/Denpa.Tray/Health.cs) とそろえる。

import Foundation

/// denpa の `GET /api/health` の答えのうち、メニューバーに出すもの。
/// 新しいバージョンがあるかは denpa が GitHub の releases/latest と見比べた結果 (src/lib/server/update.ts) をそのまま使い、ここでは比べない
public struct Health: Equatable {
    public let version: String
    /// 新しいバージョン (`v2.31.0` の形)。無ければ nil
    public let latest: String?
    /// 新しいバージョンのリリースのページ
    public let releaseURL: URL?
    public let recording: Int
    public let encoding: Int

    public init(version: String, latest: String?, releaseURL: URL?, recording: Int, encoding: Int) {
        self.version = version
        self.latest = latest
        self.releaseURL = releaseURL
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
            releaseURL: (update?["url"] as? String).flatMap(URL.init(string:)),
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

    /// 新しいバージョンのリリースのページを開く項目。
    /// 更新そのもの (install.sh を流す) は、本体を LaunchDaemon で動かす作り (#2219 の段階 3) に入れるときに足す
    public static func releaseItem(_ latest: String) -> String {
        "新しいバージョン \(latest) のリリースを開く"
    }
}
