/* SPDX-License-Identifier: GPL-2.0-only */
/*
 * denpa のチューナーエージェントが同じプロセスから呼ぶ asicen-userland の入口 (C の関数だけ)。
 *
 * asicen-userland (https://github.com/Khronos31/asicen-userland。GPL-2.0) の部品を、上流のデーモン (asicend) と
 * 同じ組み方でつなぎ、ソケットの代わりに関数で出す。上流にライブラリの API (L3) はまだ無いので、ここで包む。
 * 作りは docs/agent.md「asicen-userland の作り」。この層は GPL-2.0-only (agent/asicen/COPYING)。
 *
 * 決まり:
 * - 戻り値の int は 0 が成功、それ以外は dtv-userland-core の Error の番号 (TIMEOUT 6、USB_IO 7、DISCONNECTED 8 など)。
 *   名前は denpa_asicen_error_name で引く
 * - ABI は DENPA_ASICEN_ABI で見分ける。関数や意味を変えたら上げる (呼ぶ側は合わなければ使わない)
 * - 同じストリームの read と stop を同時に呼ばない (呼ぶ側の決まり)。ほかの組み合わせは同時に呼んでよい
 */
#ifndef DENPA_ASICEN_H
#define DENPA_ASICEN_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(__GNUC__)
#define DENPA_ASICEN_API __attribute__((visibility("default")))
#else
#define DENPA_ASICEN_API
#endif

#define DENPA_ASICEN_ABI 1

/* denpa_asicen_open の戻り値。ファームウェア待ちの機材に流し込んだだけで、開いてはいない (--fd のとき。つながり直した機材を開き直す) */
#define DENPA_ASICEN_LOADED 200

/* denpa_asicen_receiver_systems のビット */
#define DENPA_ASICEN_ISDB_T 1
#define DENPA_ASICEN_ISDB_S 2

typedef struct denpa_asicen_enclosure denpa_asicen_enclosure;
typedef struct denpa_asicen_stream denpa_asicen_stream;

DENPA_ASICEN_API int denpa_asicen_abi(void);

/* 組み込んだ asicen-userland のバージョン ("1.0.0") */
DENPA_ASICEN_API const char* denpa_asicen_version(void);

/* Error の番号の名前 ("TIMEOUT")。DENPA_ASICEN_LOADED は "LOADED" */
DENPA_ASICEN_API const char* denpa_asicen_error_name(int code);

/*
 * 挿さっている ASICEN の機材を、asicend --list-json と同じ JSON (userland.discovery 1) で返す (libusb で並べる。Android では並べられない)。
 * 書いた長さ (終わりの NUL を含まない) を *length に入れる。capacity が足りなければ要る長さを入れて BUFFER_TOO_SMALL (14)
 */
DENPA_ASICEN_API int denpa_asicen_list_json(char* output, size_t capacity, size_t* length);

/*
 * 筐体を開く。args は asicend と同じ機材の引数 (先頭はプログラム名を置かずに、引数だけ):
 *   --device usb:<ポート>[,<ポート>] --firmware <ファイル> [--allow-lnb-power]
 *   --fd <番号> [--fd <番号>] --firmware <ファイル> [--allow-lnb-power]
 * ファームウェア待ちの機材には流し込み、つながり直すのを待ってから開く。--fd は流し込んだあとの機材を追えないので、
 * 流し込んだら DENPA_ASICEN_LOADED を返す。fd は呼ぶ側のもので、閉じない (開いている間は複製を持つ)。
 * 失敗したときは理由を message に書く (英語。上流の診断と同じ言い方)
 */
DENPA_ASICEN_API int denpa_asicen_open(const char* const* args, int count, denpa_asicen_enclosure** enclosure,
                                       char* message, size_t message_capacity);

/* 開いた筐体の機種の名前 ("PX-W3U3") */
DENPA_ASICEN_API int denpa_asicen_model(const denpa_asicen_enclosure* enclosure, char* output, size_t capacity);

/* 受信機の数 (番号は 0 から) */
DENPA_ASICEN_API int denpa_asicen_receivers(const denpa_asicen_enclosure* enclosure);

/* 受信機が受けられる方式 (DENPA_ASICEN_ISDB_T・DENPA_ASICEN_ISDB_S のビット) */
DENPA_ASICEN_API int denpa_asicen_receiver_systems(const denpa_asicen_enclosure* enclosure, int receiver);

/* LNB の給電を操作できる機種か (1 / 0) */
DENPA_ASICEN_API int denpa_asicen_lnb(const denpa_asicen_enclosure* enclosure);

/*
 * 受信機を取り、選局して同期を待ち、TS を流し始める。
 * system は DENPA_ASICEN_ISDB_T か DENPA_ASICEN_ISDB_S。衛星は tsid か slot のどちらかを渡し、使わないほうは 0xffff。
 * lnb_voltage は 0 か 15 (衛星だけ。--allow-lnb-power で開き、LNB を操作できる機種のとき)。
 * 失敗したら取ったものを戻して番号を返す (同期しなければ TIMEOUT)
 */
DENPA_ASICEN_API int denpa_asicen_tune(denpa_asicen_enclosure* enclosure, int receiver, int system, uint64_t frequency_hz,
                                       uint16_t tsid, uint16_t slot, uint8_t lnb_voltage, uint32_t timeout_ms,
                                       denpa_asicen_stream** stream);

/*
 * TS を読む。capacity は 188 の倍数 (1,048,476 まで)。timeout_ms まで待って来なければ *length は 0。
 * 流れが終わったら *ended を 1 にし、理由を *terminal に入れる (TunerStreamTerminal: 1 読むのが遅い、2 USB の失敗、
 * 3 同期の失敗、4 ブリッジの失敗、5 止めた、6 切断)
 */
DENPA_ASICEN_API int denpa_asicen_read(denpa_asicen_stream* stream, uint8_t* output, size_t capacity, uint32_t timeout_ms,
                                       size_t* length, int* ended, int* terminal);

/* ストリームを止め、受信機を返し、解放する */
DENPA_ASICEN_API void denpa_asicen_stop(denpa_asicen_stream* stream);

/* 筐体を閉じる (機材を後片付けして手放す)。残ったストリームがあれば、それを止めたときに閉じ終える */
DENPA_ASICEN_API void denpa_asicen_close(denpa_asicen_enclosure* enclosure);

#ifdef DENPA_ASICEN_MOCK
/*
 * 偽の機材で開く (テスト用の組み方だけにある)。上流の模擬 (MockTunerBackend) の前に、null パケットを出す取り込みを付け、
 * エンジンと HardwareStreamService は本物を使う。receivers は 1 (地上波と衛星を 1 つで)・2・4 (衛星と地上波の組)
 */
DENPA_ASICEN_API int denpa_asicen_open_mock(int receivers, denpa_asicen_enclosure** enclosure);
#endif

#ifdef __cplusplus
}
#endif

#endif
