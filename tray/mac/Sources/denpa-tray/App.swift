// denpa-tray: denpa の様子を Mac のメニューバーに出す (NSStatusItem)。Windows の通知領域のアプリ (tray/Denpa.Tray) と同じことをする。
//
// 10 秒ごとに同じ Mac の denpa の http://127.0.0.1:3000/api/health を呼ぶ。答えれば電波塔のアイコン、答えなければ
// 斜線の入ったアイコンにする。新しいバージョンがあれば、アイコンの横に「更新」と出す。
// メニューは、様子の 1 行・denpa を開く・新しいバージョンのリリースを開く (あるときだけ)・終了。
//
// .app にせず実行ファイル 1 個で動かすので、Dock には出さない (accessory)。
// ログインで起こす LaunchAgent と、メニューから install.sh を流して更新するところは、本体を LaunchDaemon で動かす作り
// (#2219 の段階 3) に入れるときに足す。

import AppKit
import DenpaTrayCore

let healthURL = URL(string: "http://127.0.0.1:3000/api/health")!
let openURL = URL(string: "http://localhost:3000")!

@MainActor
final class Tray: NSObject, NSApplicationDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var health: Health?
    private var fetching = false
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
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let health = ok ? data.flatMap(Health.parse) : nil
            DispatchQueue.main.async {
                self.health = health
                self.fetching = false
                self.render()
            }
        }.resume()
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
            let release = NSMenuItem(title: Words.releaseItem(latest), action: #selector(openRelease), keyEquivalent: "")
            release.target = self
            menu.addItem(release)
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

    @objc private func openRelease() {
        if let url = health?.releaseURL { NSWorkspace.shared.open(url) }
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
