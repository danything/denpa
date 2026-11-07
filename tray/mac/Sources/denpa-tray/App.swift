// denpa-tray: denpa の様子を Mac のメニューバーに出す (NSStatusItem)。Windows の通知領域のアプリ (tray/Denpa.Tray) と同じことをする。
// install.sh が /Library/LaunchAgents に載せ、誰がログインしても起動する。
//
// 10 秒ごとに同じ Mac の denpa の http://127.0.0.1:3000/api/health を呼ぶ。答えれば電波塔のアイコン、答えなければ
// 斜線の入ったアイコンにする。新しいバージョンがあれば、アイコンの横に「更新」と出す。
// メニューは、様子の 1 行・denpa を開く・新しいバージョンへの更新 (あるときだけ)・終了。
//
// 更新は勝手に始めない。人がメニューから選んだら、install.sh の 1 行を書いた .command を Terminal で開く
// (sudo のパスワードは Terminal で聞く)。録画中・エンコード中なら先に確かめる (Words.askBeforeUpdate)。
// install.sh は録画の終わりを待ってから、このアプリごと入れ替えて起動し直す。
//
// .app にせず実行ファイル 1 個で動かすので、Dock には出さない (accessory)。

import AppKit
import DenpaTrayCore

let healthURL = URL(string: "http://127.0.0.1:3000/api/health")!
let openURL = URL(string: "http://localhost:3000")!

/// 様子を取得する。答えなければ nil。結果はメインスレッドで返す
func fetchHealth(_ done: @escaping @MainActor (Health?) -> Void) {
    var request = URLRequest(url: healthURL)
    request.timeoutInterval = 3
    URLSession.shared.dataTask(with: request) { data, response, _ in
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        let health = ok ? data.flatMap(Health.parse) : nil
        Task { @MainActor in done(health) }
    }.resume()
}

@MainActor
final class Tray: NSObject, NSApplicationDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var health: Health?
    private var fetching = false
    /// 更新の前に様子を取得し直している間。二重に確かめない
    private var updating = false
    /// 最後にメニューに出した様子。変わらなければメニューを作り直さない (開いている最中に差し替えない)
    private var shown: Health?

    func applicationDidFinishLaunching(_: Notification) {
        render()
        fetch()
        Timer.scheduledTimer(timeInterval: 10, target: self, selector: #selector(fetch), userInfo: nil, repeats: true)
    }

    @objc private func fetch() {
        if fetching { return }
        fetching = true
        fetchHealth { health in
            self.health = health
            self.fetching = false
            self.render()
        }
    }

    private func render() {
        guard let button = item.button else { return }
        if item.menu != nil, shown == health { return }
        shown = health
        let symbol = health == nil ? "antenna.radiowaves.left.and.right.slash" : "antenna.radiowaves.left.and.right"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: Words.summary(health))
        image?.isTemplate = true
        button.image = image
        button.imagePosition = .imageLeading
        button.title = health?.latest == nil ? "" : "更新"
        button.toolTip = Words.summary(health)

        let menu = NSMenu()
        menu.autoenablesItems = false
        let summary = NSMenuItem(title: Words.summary(health), action: nil, keyEquivalent: "")
        summary.isEnabled = false
        menu.addItem(summary)
        menu.addItem(.separator())
        let open = NSMenuItem(title: "denpa を開く", action: #selector(openDenpa), keyEquivalent: "")
        open.target = self
        open.isEnabled = health != nil
        menu.addItem(open)
        if let latest = health?.latest {
            let update = NSMenuItem(title: Words.updateItem(latest), action: #selector(update), keyEquivalent: "")
            update.target = self
            menu.addItem(update)
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "終了", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
    }

    @objc private func openDenpa() {
        NSWorkspace.shared.open(openURL)
    }

    /// 更新する。確かめる前に様子を取得し直す (メニューを開いている間に録画やエンコードが始まることがある。
    /// 答えなければ、メニューを開いたときの様子で確かめる)。取得はバックグラウンドで、その間もメニューは動く
    @objc private func update() {
        guard let opened = health, !updating else { return }
        updating = true
        fetchHealth { latest in
            self.updating = false
            self.confirmAndUpdate(latest ?? opened)
        }
    }

    private func confirmAndUpdate(_ now: Health) {
        if let question = Words.askBeforeUpdate(now) {
            let alert = NSAlert()
            alert.messageText = "denpa の更新"
            alert.informativeText = question
            alert.addButton(withTitle: "更新")
            alert.addButton(withTitle: "取消")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() != .alertFirstButtonReturn { return }
        }
        // Terminal で開く。.command は Terminal が開く種類で、Terminal を操作する許可は要らない
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("denpa-update.command")
        do {
            try Installer.command.write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        } catch {
            return
        }
        NSWorkspace.shared.open(script)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

// main.swift の上の段に書くと main actor の外として扱われ、@MainActor の Tray を作れない。@main の main() から起こす
@main
enum App {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let tray = Tray()
        app.delegate = tray
        app.run()
    }
}
