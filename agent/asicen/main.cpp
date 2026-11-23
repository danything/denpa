// SPDX-License-Identifier: GPL-2.0-only
//
// denpa-asicen: denpa のチューナーエージェントが起動する、ASICEN 系の機材 (PX-W3U3 など) を扱う子プロセス。
//
// エージェント (MPL-2.0) とは別のプログラムで、やりとりするのは選局の要求・状態・TS だけ (docs/agent.md「asicen-userland の作り」)。
// 機材を開くのも USB を読み書きするのもこのプロセスで、asicen-userland の部品は denpa_asicen.cpp がつなぐ。
//
//   denpa-asicen --version          "denpa-asicen <プロトコル> asicen-userland <上流のバージョン>" を出して終わる
//   denpa-asicen --list-json        挿さっている機材を asicend --list-json と同じ JSON で出して終わる
//   denpa-asicen <機材の引数>        筐体を開いて、下のやりとりを始める。機材の引数は asicend と同じ
//                                   (--device usb:<ポート>[,<ポート>] か --fd <番号> [--fd <番号>]、--firmware <ファイル>、[--allow-lnb-power])
//   denpa-asicen --mock <受信機の数> 偽の機材で開く (テスト用に組んだものだけ)
//
// やりとり (プロトコル 1):
// - 子 → エージェント (標準出力): 8 バイトの見出し (種類 1 バイト・ストリーム 1 バイト・0 を 2 バイト・中身の長さ 4 バイト LE) と中身
//     'O' 開いた       中身は JSON {"model":"PX-W3U3","systems":[2,1,2,1],"lnb":true} (systems は受信機ごとの方式のビット)
//     'F' 開けない     中身は番号 (4 バイト LE) とメッセージ。送ったら終わる
//     'L' 流し込んだ   ファームウェア待ちの機材に流し込んだだけで開いていない (--fd のとき)。中身はメッセージ。送ったら終わる
//     'T' 選局の結果   中身は番号 (4 バイト LE。0 が成功)
//     'D' TS           中身は TS (188 バイトの倍数)
//     'E' ストリームの終わり 中身は理由 (4 バイト LE。上流の TunerStreamTerminal)
//     'S' 止めた       受信機を返し終えた
// - エージェント → 子 (標準入力): 1 行に 1 つの命令
//     tune <ストリーム> <受信機> <方式> <Hz> <TSID> <スロット> <LNB の電圧> <待つ ms>
//     stop <ストリーム>
//   標準入力が閉じたら (エージェントが閉じた・落ちた)、ストリームを全部止め、筐体を閉じて終わる
// - 上流の診断とこのプロセスのメッセージは標準エラーに出す (エージェントが記録に写す)

#include "denpa_asicen.h"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <csignal>
#endif

namespace {

constexpr int kProtocol = 1;

std::mutex output_gate;
std::atomic<bool> output_broken{false};

void put32(std::uint8_t* at, std::uint32_t value)
{
    at[0] = static_cast<std::uint8_t>(value);
    at[1] = static_cast<std::uint8_t>(value >> 8);
    at[2] = static_cast<std::uint8_t>(value >> 16);
    at[3] = static_cast<std::uint8_t>(value >> 24);
}

// 見出しと中身を 1 つにまとめて書く。エージェントが読まなくなったら (閉じた) 以後は書かない
void send(char kind, int stream, const void* body, std::size_t length)
{
    if (output_broken.load()) return;
    std::uint8_t header[8]{};
    header[0] = static_cast<std::uint8_t>(kind);
    header[1] = static_cast<std::uint8_t>(stream);
    put32(header + 4, static_cast<std::uint32_t>(length));
    std::lock_guard<std::mutex> lock(output_gate);
    if (std::fwrite(header, 1, sizeof(header), stdout) != sizeof(header) ||
        (length > 0U && std::fwrite(body, 1, length, stdout) != length) || std::fflush(stdout) != 0) {
        output_broken.store(true);
    }
}

void send_code(char kind, int stream, int value, const char* text = nullptr)
{
    std::vector<std::uint8_t> body(4U);
    put32(body.data(), static_cast<std::uint32_t>(value));
    if (text != nullptr) body.insert(body.end(), text, text + std::strlen(text));
    send(kind, stream, body.data(), body.size());
}

// 選局 1 回ぶん。選局から止めるまでを 1 つのスレッドで回す
struct Session final {
    std::atomic<bool> stop{false};
    std::thread worker;
};

// 受信機を取って選局し、TS を送り続ける。止める命令かストリームの終わりで受信機を返し、'S' を送る
void run(denpa_asicen_enclosure* enclosure, int id, int receiver, int system, std::uint64_t hz, std::uint16_t tsid,
         std::uint16_t slot, std::uint8_t lnb, std::uint32_t timeout_ms, Session* session)
{
    denpa_asicen_stream* stream = nullptr;
    const int tuned = denpa_asicen_tune(enclosure, receiver, system, hz, tsid, slot, lnb, timeout_ms, &stream);
    send_code('T', id, tuned);
    if (tuned != 0) {
        send('S', id, nullptr, 0U);
        return;
    }
    // 1 回に送る上限 (188 の倍数)
    std::vector<std::uint8_t> buffer(188U * 512U);
    while (!session->stop.load() && !output_broken.load()) {
        std::size_t length = 0U;
        int ended = 0;
        int terminal = 0;
        const int read = denpa_asicen_read(stream, buffer.data(), buffer.size(), 200U, &length, &ended, &terminal);
        if (read != 0) {
            std::fprintf(stderr, "stream %d: read failed: %s\n", id, denpa_asicen_error_name(read));
            send_code('E', id, 2);
            break;
        }
        if (length > 0U) send('D', id, buffer.data(), length);
        if (ended != 0) {
            send_code('E', id, terminal);
            break;
        }
    }
    denpa_asicen_stop(stream);
    send('S', id, nullptr, 0U);
}

// 数を読む (読めなければ false)
bool number(const char* text, unsigned long long limit, unsigned long long& value)
{
    if (text == nullptr || *text == '\0') return false;
    char* end = nullptr;
    value = std::strtoull(text, &end, 10);
    return end != nullptr && *end == '\0' && value <= limit;
}

// 標準入力の命令を読み、標準入力が閉じたら全部止めて戻る
void serve(denpa_asicen_enclosure* enclosure)
{
    std::map<int, std::unique_ptr<Session>> sessions;
    auto finish = [&sessions](int id) {
        auto found = sessions.find(id);
        if (found == sessions.end()) return;
        found->second->stop.store(true);
        if (found->second->worker.joinable()) found->second->worker.join();
        sessions.erase(found);
    };
    char line[256];
    while (std::fgets(line, sizeof(line), stdin) != nullptr) {
        std::vector<char*> words;
        for (char* word = std::strtok(line, " \r\n"); word != nullptr; word = std::strtok(nullptr, " \r\n"))
            words.push_back(word);
        if (words.empty()) continue;
        unsigned long long id = 0;
        if (words.size() < 2U || !number(words[1], 255U, id) || id == 0U) {
            std::fprintf(stderr, "unknown command: %s\n", words[0]);
            continue;
        }
        const int stream = static_cast<int>(id);
        if (std::strcmp(words[0], "stop") == 0 && words.size() == 2U) {
            finish(stream);
            continue;
        }
        unsigned long long receiver = 0, system = 0, hz = 0, tsid = 0, slot = 0, lnb = 0, timeout = 0;
        if (std::strcmp(words[0], "tune") != 0 || words.size() != 9U || !number(words[2], 255U, receiver) ||
            !number(words[3], 255U, system) || !number(words[4], ~0ULL, hz) || !number(words[5], 0xffffU, tsid) ||
            !number(words[6], 0xffffU, slot) || !number(words[7], 255U, lnb) || !number(words[8], 600000U, timeout)) {
            std::fprintf(stderr, "invalid command: %s\n", words[0]);
            if (std::strcmp(words[0], "tune") == 0) {
                send_code('T', stream, 1);
                send('S', stream, nullptr, 0U);
            }
            continue;
        }
        // 同じ番号が残っていれば先に止める (エージェントは止めてから使い回す)
        finish(stream);
        std::unique_ptr<Session> session(new Session());
        Session* raw = session.get();
        session->worker = std::thread(run, enclosure, stream, static_cast<int>(receiver), static_cast<int>(system),
                                      static_cast<std::uint64_t>(hz), static_cast<std::uint16_t>(tsid),
                                      static_cast<std::uint16_t>(slot), static_cast<std::uint8_t>(lnb),
                                      static_cast<std::uint32_t>(timeout), raw);
        sessions[stream] = std::move(session);
    }
    std::vector<int> ids;
    for (const auto& entry : sessions) ids.push_back(entry.first);
    for (const int id : ids) finish(id);
}

std::string escape(const char* text)
{
    std::string out;
    for (const char* at = text; *at != '\0'; ++at) {
        const unsigned char c = static_cast<unsigned char>(*at);
        if (c == '"' || c == '\\') out += '\\';
        if (c < 0x20U) continue;
        out += static_cast<char>(c);
    }
    return out;
}

// 開いた筐体の機種・受信機ごとの方式・LNB を 'O' で送る
void opened(const denpa_asicen_enclosure* enclosure)
{
    char model[128] = "";
    (void)denpa_asicen_model(enclosure, model, sizeof(model));
    std::string json = "{\"model\":\"" + escape(model) + "\",\"systems\":[";
    const int receivers = denpa_asicen_receivers(enclosure);
    for (int index = 0; index < receivers; ++index) {
        if (index > 0) json += ',';
        json += std::to_string(denpa_asicen_receiver_systems(enclosure, index));
    }
    json += "],\"lnb\":";
    json += denpa_asicen_lnb(enclosure) != 0 ? "true}" : "false}";
    send('O', 0, json.data(), json.size());
}

}  // namespace

int main(int argc, char** argv)
{
#if defined(_WIN32)
    (void)_setmode(_fileno(stdout), _O_BINARY);
    (void)_setmode(_fileno(stdin), _O_BINARY);
#else
    // エージェントが閉じたあとに書いても落ちずに、書けなかったことだけを受け取る
    std::signal(SIGPIPE, SIG_IGN);
#endif
    if (argc == 2 && std::strcmp(argv[1], "--version") == 0) {
        std::printf("denpa-asicen %d asicen-userland %s\n", kProtocol, denpa_asicen_version());
        return 0;
    }
    if (argc == 2 && std::strcmp(argv[1], "--list-json") == 0) {
        std::size_t length = 0U;
        int listed = denpa_asicen_list_json(nullptr, 0U, &length);
        std::vector<char> json(length + 1U);
        if (listed == 14) listed = denpa_asicen_list_json(json.data(), json.size(), &length);
        if (listed != 0) {
            std::fprintf(stderr, "list failed: %s\n", denpa_asicen_error_name(listed));
            return 1;
        }
        std::fwrite(json.data(), 1, length, stdout);
        std::fputc('\n', stdout);
        return 0;
    }

    denpa_asicen_enclosure* enclosure = nullptr;
    char message[1024] = "";
    int result = 0;
#ifdef DENPA_ASICEN_MOCK
    if (argc == 3 && std::strcmp(argv[1], "--mock") == 0) {
        result = denpa_asicen_open_mock(std::atoi(argv[2]), &enclosure);
    } else
#endif
    {
        result = denpa_asicen_open(argv + 1, argc - 1, &enclosure, message, sizeof(message));
    }
    if (result == DENPA_ASICEN_LOADED) {
        send('L', 0, message, std::strlen(message));
        return 0;
    }
    if (result != 0) {
        send_code('F', 0, result, message);
        return 1;
    }
    opened(enclosure);
    serve(enclosure);
    denpa_asicen_close(enclosure);
    return 0;
}
