// swift-tools-version:5.9
// Mac のメニューバーに出す denpa のアイコン (denpa-tray)。Windows の通知領域のアプリ (tray/Denpa.Tray) と同じことをする。
//
// - DenpaTrayCore: denpa の /api/health を読み、メニューに出す文言を作る。AppKit に触らないのでテストできる
// - denpa-tray: NSStatusItem を出す実行ファイル。.app にせず実行ファイル 1 個で配る (エージェントと同じ tar.gz に入れる)
//
//   swift test --package-path tray/mac
//   swift build -c release --package-path tray/mac
import PackageDescription

let package = Package(
    name: "denpa-tray",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "DenpaTrayCore"),
        .executableTarget(name: "denpa-tray", dependencies: ["DenpaTrayCore"]),
        .testTarget(name: "DenpaTrayCoreTests", dependencies: ["DenpaTrayCore"]),
    ]
)
