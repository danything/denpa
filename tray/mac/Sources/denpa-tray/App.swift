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
// **エージェントだけ入れたとき** (install.sh --agent-only) は、引数 `--agent-only <TUNERS_FILE>` で起こされる。
// denpa はこの Mac にいないので、10 秒ごとにエージェント (127.0.0.1:25252) へ TLS で繋ぎ、証明書が返るかだけを見る
// (組んでいないので API は呼べない)。メニューは、応答するかの 1 行・登録用の URL を表示…・終了。
// 「登録用の URL を表示…」は、sudo denpa-agent --pair を書いた .command を Terminal で開き、URL と QR を出す (Pairing.command)。
//
// .app にせず実行ファイル 1 個で動かすので、Dock には出さない (accessory)。

import AppKit
import DenpaTrayCore
import Network
import Security

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

/// エージェントが応答するか。TLS で繋ぎ、エージェントの証明書が返れば応答したとみなす。エージェントはクライアント証明書を求めるので、
/// 証明書を持たないこちらとの握手はそのあと断られるが、それは見ない (組んでいないので API は呼べない)。結果はメインスレッドで返す
func probeAgent(_ done: @escaping @MainActor (Bool) -> Void) {
    let probe = AgentProbe(done)
    let tls = NWProtocolTLS.Options()
    // 証明書を受け取ったら、確かめずに通す (見たいのは返ってくるかだけ)
    sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, _, complete in
        probe.answered = true
        complete(true)
    }, probe.queue)
    let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Pairing.port)!, using: NWParameters(tls: tls))
    probe.connection = connection
    connection.stateUpdateHandler = { state in
        switch state {
        case .ready, .failed, .waiting, .cancelled: probe.finish()
        default: break
        }
    }
    connection.start(queue: probe.queue)
    probe.queue.asyncAfter(deadline: .now() + 3) { probe.finish() }
}

/// 1 回の probeAgent の様子。触るのは queue の上だけ
final class AgentProbe: @unchecked Sendable {
    let queue = DispatchQueue(label: "denpa-tray.agent")
    var answered = false
    var connection: NWConnection?
    private var done: (@MainActor (Bool) -> Void)?

    init(_ done: @escaping @MainActor (Bool) -> Void) {
        self.done = done
    }

    /// 1 回だけ結果を返し、繋ぎを閉じる
    func finish() {
        guard let done else { return }
        self.done = nil
        connection?.cancel()
        let answered = self.answered
        Task { @MainActor in done(answered) }
    }
}

/// エージェントだけ入れたときの TUNERS_FILE (無ければ空)。引数 `--agent-only` が無ければ nil (denpa を見る)
let agentOnly: String? = {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.first == "--agent-only" else { return nil }
    return arguments.count > 1 ? arguments[1] : ""
}()

@MainActor
final class Tray: NSObject, NSApplicationDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var health: Health?
    private var fetching = false
    /// 更新の前に様子を取得し直している間。二重に確かめない
    private var updating = false
    /// 最後にメニューに出した様子。変わらなければメニューを作り直さない (開いている最中に差し替えない)
    private var shown: Health?
    /// エージェントが最後に応答したか (agentOnly のとき)。nil はまだ見ていない
    private var agentUp: Bool?
    private var shownAgent: Bool??

    func applicationDidFinishLaunching(_: Notification) {
        render()
        fetch()
        Timer.scheduledTimer(timeInterval: 10, target: self, selector: #selector(fetch), userInfo: nil, repeats: true)
    }

    @objc private func fetch() {
        if fetching { return }
        fetching = true
        if agentOnly != nil {
            probeAgent { answered in
                self.agentUp = answered
                self.fetching = false
                self.renderAgent()
            }
            return
        }
        fetchHealth { health in
            self.health = health
            self.fetching = false
            self.render()
        }
    }

    private func render() {
        if agentOnly != nil { return renderAgent() }
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

    /// エージェントだけ入れたときのアイコンとメニュー。応答するかの 1 行・登録用の URL を表示…・終了
    private func renderAgent() {
        guard let button = item.button else { return }
        if item.menu != nil, shownAgent == .some(agentUp) { return }
        shownAgent = .some(agentUp)
        let answering = agentUp ?? false
        let symbol = answering ? "antenna.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: AgentWords.summary(answering))
        image?.isTemplate = true
        button.image = image
        button.title = ""
        button.toolTip = AgentWords.summary(answering)

        let menu = NSMenu()
        menu.autoenablesItems = false
        let summary = NSMenuItem(title: AgentWords.summary(answering), action: nil, keyEquivalent: "")
        summary.isEnabled = false
        menu.addItem(summary)
        menu.addItem(.separator())
        let pair = NSMenuItem(title: AgentWords.pairItem, action: #selector(showPairUrl), keyEquivalent: "")
        pair.target = self
        menu.addItem(pair)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "終了", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
    }

    /// 登録用の URL と QR を出す。同じ bin/ の denpa-agent を sudo で流す .command を Terminal で開く (sudo のパスワードは Terminal で聞く)
    @objc private func showPairUrl() {
        let agent = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
            .deletingLastPathComponent().appendingPathComponent("denpa-agent").path
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("denpa-pair.command")
        do {
            try Pairing.command(agent: agent, tunersFile: agentOnly).write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        } catch {
            return
        }
        NSWorkspace.shared.open(script)
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
