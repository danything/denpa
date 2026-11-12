// メニューバーのアプリが denpa の `/api/health` をどう読み、更新の前に何を確かめるか。文言は Windows (tray/Denpa.Tray.Tests) と同じものを見る

import DenpaTrayCore
import XCTest

final class HealthTests: XCTestCase {
    private func parse(_ json: String) -> Health? {
        Health.parse(Data(json.utf8))
    }

    func test新しいバージョンと録画とエンコードの本数を読む() {
        let health = parse("""
            {"ok":true,"version":"v2.30.0","update":{"version":"v2.31.0","url":"https://github.com/danything/denpa/releases/tag/v2.31.0"},
             "services":12,"recording":1,"encoding":2}
            """)
        XCTAssertEqual(health, Health(version: "v2.30.0", latest: "v2.31.0", recording: 1, encoding: 2))
    }

    func test新しいバージョンが無ければnil() {
        let health = parse(#"{"ok":true,"version":"v2.30.0","update":null,"services":0,"recording":0,"encoding":0}"#)
        XCTAssertEqual(health, Health(version: "v2.30.0", latest: nil, recording: 0, encoding: 0))
    }

    func test古いdenpaのencodingの無い答えも読む() {
        let health = parse(#"{"ok":true,"version":"v2.29.0","update":null,"services":0,"recording":3}"#)
        XCTAssertEqual(health, Health(version: "v2.29.0", latest: nil, recording: 3, encoding: 0))
    }

    func testokでない答えと読めない答えは動いていないことにする() {
        XCTAssertNil(parse(#"{"ok":false,"version":"v2.30.0"}"#))
        XCTAssertNil(parse(#"{"ok":1,"version":"v2.30.0"}"#))
        XCTAssertNil(parse(#"{"version":"v2.30.0"}"#))
        XCTAssertNil(parse("[]"))
        XCTAssertNil(parse("<html>"))
        XCTAssertNil(parse(""))
    }

    func test様子の1行() {
        XCTAssertEqual(Words.summary(nil), "denpa が応答しません")
        XCTAssertEqual(Words.summary(Health(version: "v2.30.0", latest: nil, recording: 0, encoding: 0)), "denpa v2.30.0")
        XCTAssertEqual(
            Words.summary(Health(version: "v2.30.0", latest: nil, recording: 1, encoding: 2)),
            "denpa v2.30.0・録画中 1 本・エンコード中 2 本"
        )
    }

    func test更新の項目() {
        XCTAssertEqual(Words.updateItem("v2.31.0"), "v2.31.0 に更新…")
    }

    func test録画もエンコードもしていなければ確かめずに更新する() {
        XCTAssertNil(Words.askBeforeUpdate(Health(version: "v2.30.0", latest: "v2.31.0", recording: 0, encoding: 0)))
    }

    func test録画中とエンコード中は確かめる() {
        XCTAssertEqual(
            Words.askBeforeUpdate(Health(version: "v2.30.0", latest: "v2.31.0", recording: 1, encoding: 0)),
            "録画中です (1 本)。録画が終わるまで待ってから入れ替えます。\n\n更新しますか"
        )
        XCTAssertEqual(
            Words.askBeforeUpdate(Health(version: "v2.30.0", latest: "v2.31.0", recording: 0, encoding: 1)),
            "エンコード中です (1 本)。更新するとエンコードを中断し、更新のあとで最初からやり直します。\n\n更新しますか"
        )
        XCTAssertEqual(
            Words.askBeforeUpdate(Health(version: "v2.30.0", latest: "v2.31.0", recording: 1, encoding: 2)),
            "録画中です (1 本)。録画が終わるまで待ってから入れ替えます。\n"
                + "エンコード中です (2 本)。更新するとエンコードを中断し、更新のあとで最初からやり直します。\n\n更新しますか"
        )
    }

    func test更新は入れたときと同じinstall_shをブラウザを開かずにsudoで流す() {
        XCTAssertTrue(Installer.command.hasPrefix("#!/bin/bash\n"))
        XCTAssertTrue(Installer.command.contains(
            "curl -fsSL https://raw.githubusercontent.com/danything/denpa/main/install.sh | sudo bash -s -- --no-open"
        ))
    }
    func testエージェントだけのときは応答するかを出す() {
        XCTAssertEqual(AgentWords.summary(true), "エージェントが応答しています")
        XCTAssertEqual(AgentWords.summary(false), "エージェントが応答しません")
    }

    func test登録用のURLはTUNERS_FILEを渡してsudoでdenpa_agentのpairを流す() {
        let command = Pairing.command(
            agent: "/Library/Application Support/denpa/bin/denpa-agent",
            tunersFile: "/Users/o'neil/denpa/config/tuners.json"
        )
        XCTAssertTrue(command.hasPrefix("#!/bin/bash\n"))
        XCTAssertTrue(command.contains(
            "sudo env TUNERS_FILE='/Users/o'\''neil/denpa/config/tuners.json' '/Library/Application Support/denpa/bin/denpa-agent' --pair\n"
        ))
        // TUNERS_FILE を渡されていなければ書かない (エージェントの既定の置き場)
        XCTAssertTrue(Pairing.command(agent: "/bin/denpa-agent", tunersFile: nil).contains("sudo '/bin/denpa-agent' --pair\n"))
    }
}
