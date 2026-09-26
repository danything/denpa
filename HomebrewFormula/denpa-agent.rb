# denpa のチューナーエージェントを macOS (Apple Silicon) で動かす。denpa 本体は
# Docker Desktop のまま、USB に触るエージェントだけをこちらで (docs/agent.md「macOS で動かす」)。
#
#   brew tap danything/denpa https://github.com/danything/denpa
#   brew install denpa-agent
#   brew services start denpa-agent
#
# url / sha256 / version はリリースのたびに release.yml が書き換える (.github/bump-pr.sh)。
# 中身は agent/macos/build.sh が束ねたもの。
class DenpaAgent < Formula
  desc "Tuner agent for denpa (USB tuners and B-CAS cards)"
  homepage "https://github.com/danything/denpa"
  url "https://github.com/danything/denpa/releases/download/v1.21.0/denpa-agent-1.21.0-darwin-arm64.tar.gz"
  version "1.21.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  # エージェント / libaribb25 / px4-userland / siano-userland (ファームウェアは別。docs/agent.md)
  license all_of: ["AGPL-3.0-or-later", "Apache-2.0", "GPL-2.0-only", "GPL-2.0-or-later"]

  depends_on arch: :arm64
  # px4d / siano-ts は /opt/homebrew/opt/libusb を引く (配布元の darwin 版がそう焼いてある)
  depends_on "libusb"
  depends_on :macos
  # libaribb25 はこの pcsc-lite に繋いで焼いてある。pcscd もこれを起こす
  depends_on "pcsc-lite"

  def install
    libexec.install Dir["*"]
    # 既定はここで決め、上書きは etc/denpa-agent.env に書く (brew services からも読む)。
    # pcsc-lite は keg-only なので pcscd は PATH に居ない。前に足す
    (bin/"denpa-agent").write <<~SH
      #!/bin/sh
      if [ -f "#{etc}/denpa-agent.env" ]; then set -a; . "#{etc}/denpa-agent.env"; set +a; fi
      : "${TUNERS_FILE:=#{var}/denpa-agent/tuners.json}"
      : "${CHANNELS_FILE:=#{var}/denpa-agent/channels.json}"
      : "${RECORDED_DIR:=#{var}/denpa-agent/recorded}"
      : "${PX4_USERLAND_DIR:=#{opt_libexec}/px4-userland}"
      : "${PX4_IFD:=#{opt_libexec}/px4-userland/ifd/px4-userland-ifd.bundle}"
      : "${PX4_RUNTIME_DIR:=#{var}/run/denpa-agent}"
      : "${SIANO_USERLAND_DIR:=#{opt_libexec}/siano-userland}"
      : "${PCSC_READER_CONF_DIR:=#{etc}/reader.conf.d}"
      export TUNERS_FILE CHANNELS_FILE RECORDED_DIR PX4_USERLAND_DIR PX4_IFD PX4_RUNTIME_DIR \\
        SIANO_USERLAND_DIR PCSC_READER_CONF_DIR
      PATH="#{Formula["pcsc-lite"].opt_sbin}:$PATH" exec "#{opt_libexec}/denpa-agent" "$@"
    SH
  end

  service do
    run opt_bin/"denpa-agent"
    keep_alive true
    log_path var/"log/denpa-agent.log"
    error_log_path var/"log/denpa-agent.log"
  end

  # 起こして口に当てる。libaribb25 が読めて (カードが無いと言うところまで進む)、
  # px4d / siano-ts が libusb を引けて (--list が通る) いればよい
  test do
    port = free_port
    ENV["AGENT_PORT"] = port.to_s
    ENV["TUNERS_FILE"] = (testpath/"tuners.json").to_s
    ENV["CHANNELS_FILE"] = (testpath/"channels.json").to_s
    ENV["RECORDED_DIR"] = testpath.to_s
    ENV["PX4_RUNTIME_DIR"] = (testpath/"run").to_s
    ENV["PCSC_READER_CONF_DIR"] = (testpath/"reader.conf.d").to_s
    log = testpath/"agent.log"
    pid = spawn bin/"denpa-agent", [:out, :err] => log.to_s
    begin
      tuners = ""
      30.times do
        tuners = shell_output("curl -fsS http://127.0.0.1:#{port}/denpa/tuners 2>&1 || true")
        break if tuners.include?("detected")

        sleep 1
      end
      assert_match '"detected":true', tuners
      assert_match "カードを読めません", shell_output("curl -sS http://127.0.0.1:#{port}/denpa/card/init")
      refute_match "挙げられません", log.read
    ensure
      Process.kill "TERM", pid
      Process.wait pid
      # 起こした pcscd を残さない (次に起こすエージェントが消えた置き場の pcscd を掴む)
      quiet_system "pkill", "-f", (testpath/"reader.conf.d").to_s
    end
  end
end
