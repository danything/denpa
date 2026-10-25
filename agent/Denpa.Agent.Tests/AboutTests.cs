using Denpa.Agent;

namespace Denpa.Agent.Tests;

/*
 * `GET /denpa/about`。返す形は conformance.test.ts が本物に当てるので、こちらは
 * **バージョンをどこから知るか**と、macOS の CCID ドライバの見分け方を見る。
 */
public class AboutTests
{
    [Test]
    public async Task 中に持っているバージョンを先に使う()
    {
        await Assert.That(About.ResolveVersion("v1.2.3", "v9.9.9")).IsEqualTo("v1.2.3");
    }

    [Test]
    public async Task 中身が_dev_なら環境変数で知る()
    {
        // Linux のイメージ: main で組んだ実行ファイルに、リリースで DENPA_VERSION を足す
        await Assert.That(About.ResolveVersion("dev", "v1.2.3")).IsEqualTo("v1.2.3");
        await Assert.That(About.ResolveVersion(null, " v1.2.3 ")).IsEqualTo("v1.2.3");
    }

    [Test]
    public async Task どちらも無ければ_dev()
    {
        await Assert.That(About.ResolveVersion("dev", null)).IsEqualTo("dev");
        await Assert.That(About.ResolveVersion("dev", "")).IsEqualTo("dev");
        await Assert.That(About.ResolveVersion(null, null)).IsEqualTo("dev");
    }

    [Test]
    public async Task SDK_が足すコミットは落とす()
    {
        await Assert.That(About.ResolveVersion("v1.2.3+abc123", null)).IsEqualTo("v1.2.3");
        await Assert.That(About.ResolveVersion("dev+abc123", "v1.2.3")).IsEqualTo("v1.2.3");
    }

    [Test]
    public async Task OS_と_arch_は決まった名前で返す()
    {
        await Assert.That(About.Os).IsEqualTo(
            OperatingSystem.IsMacOS() ? "macos" : OperatingSystem.IsWindows() ? "windows" : "linux");
        await Assert.That(About.Arch is "x64" or "arm64").IsTrue();
        var json = About.ToJson();
        await Assert.That(json["version"]!.GetValue<string>()).IsEqualTo(About.Version);
        await Assert.That(json["runtime"]!.GetValue<string>().Length).IsGreaterThan(0);
        // ccidDriver は macOS だけ
        await Assert.That(json["ccidDriver"] is null).IsEqualTo(!OperatingSystem.IsMacOS());
    }

    [Test]
    public async Task useIFDCCID_が_1_なら従来の_ifd_ccid()
    {
        await Assert.That(PcscLink.CcidDriverFrom(0, "1\n")).IsEqualTo("ifd-ccid");
    }

    [Test]
    public async Task useIFDCCID_が_0_か無ければ_Apple_の標準のもの()
    {
        await Assert.That(PcscLink.CcidDriverFrom(0, "0")).IsEqualTo("apple");
        // 鍵が無いと defaults は 1 で終わる
        await Assert.That(PcscLink.CcidDriverFrom(1, "The domain/default pair of (…, useIFDCCID) does not exist")).IsEqualTo("apple");
        await Assert.That(PcscLink.CcidDriverFrom(-1, "timeout")).IsEqualTo("apple");
    }
}
