/*
 * 放送の MPEG-2 映像と AAC 音声を、ブラウザの中でデコードする (docs/stream.md#放送そのままmpeg-2を送る)。
 *
 * **ブラウザには MPEG-2 のデコーダが無い** (MSE も WebCodecs も mp2v を受け取らない)
 * ので、FFmpeg の mpeg2video を WebAssembly に組んで持ち込む。ここはその
 * 薄いラッパーで、JS (src/lib/raw/worker.ts) から呼ぶ。
 *
 * 音 (AAC) も同じ FFmpeg の `aac` でデコードする (`aac_open` / `audio_push`)。WebCodecs の AudioDecoder は
 * 安全な繋ぎ (https) でしか出てこず、iPhone の Safari には iOS 26 より前には無いので、
 * それに頼ると LAN の http と古い iPhone で元のTSをそのまま再生する経路が使えない。画面の canvas で描く経路 (fMP4) の
 * Opus も同じ API でデコードする (`opus_open`)。
 *
 * - `dec_push` … PES の中身 (ES) を渡す。**区切りは FFmpeg の parser に任せる** —
 *   放送はふつう 1 PES = 1 枚だが、決まりではない。PTS も一緒に渡し、
 *   parser が「どのフレームのものか」を付け替える
 * - デコードできたフレームは**こちらで持っておく** (`queue`)。AVFrame は受け取るたびに使い回されるので、
 *   JS が見せる時刻まで待たせるには参照を移して取っておくしかない
 * - `dec_peek` / `dec_pop` … いちばん古い1枚を覗く・捨てる。表示順で並んでいる
 *   (B フレームの並べ替えはデコーダが済ませている)
 *
 * スレッドは使わない。スレッドを使うビルドは COOP/COEP (crossOriginIsolated) が要る (docs/stream.md#放送そのままmpeg-2を送る)。
 * SIMD はコンパイラに任せて使う (Dockerfile の `mpeg2wasm` 段)
 */
#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/mem.h>
#include <libavutil/samplefmt.h>
#include <string.h>

/** 待たせておくフレームの上限。**溢れたら古いほうから捨てる** (JS 側が見せ遅れているだけなので) */
#define QUEUE 24

static AVCodecContext *ctx;
static AVCodecParserContext *parser;
static AVPacket *pkt;
static AVFrame *queue[QUEUE];
static int head, count;
/** 直近の dec_push に掛かった時間 (ms)。**デコードするのが間に合っているかの物差し** */
static double last_ms;
/**
 * B フレーム (参照されないコマ) をデコードしないか (`dec_skip`)。**間に合わないときだけ** JS が立てる —
 * 動きは 1 秒 10〜15 コマに落ちるが、紙芝居になって飛び越し走査のフィールドの順番が崩れるよりは見やすい
 */
static int skip_nonref;
/** JS へ渡す1枚ぶんの控え (dec_peek) */
static int info[12];
static double info_pts;

static void clear_queue(void) {
    for (int i = 0; i < count; i++) av_frame_free(&queue[(head + i) % QUEUE]);
    head = 0;
    count = 0;
}

/**
 * 開く。**2回目以降は開き直し** — 局を変えたときに呼ぶ。参照フレームも待たせているフレームも
 * parser の持ち越しも捨てる (`avcodec_flush_buffers` だけだと parser に前の局の切れ端が残る)
 */
EMSCRIPTEN_KEEPALIVE int dec_open(void) {
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_MPEG2VIDEO);
    if (codec == NULL) return -1;
    clear_queue();
    if (parser != NULL) av_parser_close(parser);
    avcodec_free_context(&ctx);
    parser = av_parser_init(codec->id);
    ctx = avcodec_alloc_context3(codec);
    if (parser == NULL || ctx == NULL) return -2;
    ctx->pkt_timebase = (AVRational){1, 90000};
    /*
     * **規格どおりでなくてよい速さの工夫を許す** (`AV_CODEC_FLAG2_FAST`)。MPEG-2 では、ブロックを読むときの
     * 不一致の補正 (mismatch control) を省くやり方を使う。見た目の差は出ない
     */
    ctx->flags2 |= AV_CODEC_FLAG2_FAST;
    ctx->skip_frame = skip_nonref ? AVDISCARD_NONREF : AVDISCARD_DEFAULT;
    if (avcodec_open2(ctx, codec, NULL) < 0) return -3;
    if (pkt == NULL) pkt = av_packet_alloc();
    return 0;
}

static void receive(void) {
    for (;;) {
        AVFrame *frame = av_frame_alloc();
        if (frame == NULL) return;
        if (avcodec_receive_frame(ctx, frame) != 0) {
            av_frame_free(&frame);
            return;
        }
        if (count == QUEUE) {
            av_frame_free(&queue[head]);
            head = (head + 1) % QUEUE;
            count--;
        }
        queue[(head + count) % QUEUE] = frame;
        count++;
    }
}

/**
 * ES を渡す。`pts` は 90kHz (無ければ負)。**返すのは待っている枚数。**
 *
 * 1 PES ぶんを丸ごと渡す想定。parser はフレームの終わりを次のフレームの頭で知るので、
 * 最後の1枚は次の PES が来たときに出てくる (1 コマ遅れる。貯めの中に収まる)
 */
EMSCRIPTEN_KEEPALIVE int dec_push(const uint8_t *data, int len, double pts) {
    double started = emscripten_get_now();
    int64_t stamp = pts < 0 ? AV_NOPTS_VALUE : (int64_t)pts;
    while (len > 0) {
        uint8_t *out = NULL;
        int size = 0;
        int used = av_parser_parse2(parser, ctx, &out, &size, data, len, stamp, stamp, 0);
        // 同じ PTS を2枚目に付けない。parser は渡された時刻を最初のフレームに付ける
        stamp = AV_NOPTS_VALUE;
        data += used;
        len -= used;
        if (size > 0) {
            pkt->data = out;
            pkt->size = size;
            pkt->pts = parser->pts;
            pkt->dts = parser->dts;
            if (avcodec_send_packet(ctx, pkt) == 0) receive();
        }
        if (used == 0 && size == 0) break;
    }
    last_ms = emscripten_get_now() - started;
    return count;
}

/** B フレームを飛ばすか (`skip_nonref`)。開いたあとにも効く (次に渡すコマから) */
EMSCRIPTEN_KEEPALIVE void dec_skip(int on) {
    skip_nonref = on;
    if (ctx != NULL) ctx->skip_frame = on ? AVDISCARD_NONREF : AVDISCARD_DEFAULT;
}

EMSCRIPTEN_KEEPALIVE int dec_count(void) { return count; }
EMSCRIPTEN_KEEPALIVE double dec_last_ms(void) { return last_ms; }

/**
 * いちばん古い1枚を覗く。**無ければ NULL。**
 *
 *     [0] 幅 [1] 高さ [2..4] 各面の行の幅 (linesize) [5..7] 各面の番地
 *     [8] 印 (1: インタレ, 2: 上が先) [9,10] 画素の縦横比 [11] 色の決まり (AVColorSpace)
 *
 * 時刻は `dec_peek_pts` (90kHz。無ければ負)
 */
EMSCRIPTEN_KEEPALIVE int *dec_peek(void) {
    if (count == 0) return NULL;
    const AVFrame *f = queue[head];
    info[0] = f->width;
    info[1] = f->height;
    for (int i = 0; i < 3; i++) {
        info[2 + i] = f->linesize[i];
        info[5 + i] = (int)(intptr_t)f->data[i];
    }
    info[8] = ((f->flags & AV_FRAME_FLAG_INTERLACED) ? 1 : 0) | ((f->flags & AV_FRAME_FLAG_TOP_FIELD_FIRST) ? 2 : 0);
    info[9] = f->sample_aspect_ratio.num;
    info[10] = f->sample_aspect_ratio.den;
    info[11] = f->colorspace;
    int64_t pts = f->pts != AV_NOPTS_VALUE ? f->pts : f->best_effort_timestamp;
    info_pts = pts == AV_NOPTS_VALUE ? -1 : (double)pts;
    return info;
}

EMSCRIPTEN_KEEPALIVE double dec_peek_pts(void) { return info_pts; }

/**
 * i 枚目 (0 がいちばん古い) の時刻。**見せる番が過ぎたフレームを、覗かずに飛ばすため** —
 * 次のフレームがもう番を迎えているなら、手前のフレームは画像にする (テクスチャに上げる) だけ無駄
 */
EMSCRIPTEN_KEEPALIVE double dec_pts_at(int i) {
    if (i < 0 || i >= count) return -1;
    const AVFrame *f = queue[(head + i) % QUEUE];
    int64_t pts = f->pts != AV_NOPTS_VALUE ? f->pts : f->best_effort_timestamp;
    return pts == AV_NOPTS_VALUE ? -1 : (double)pts;
}

/** いちばん古い1枚を捨てる。**見せ終わったか、見せずに飛ばすとき** */
EMSCRIPTEN_KEEPALIVE void dec_pop(void) {
    if (count == 0) return;
    av_frame_free(&queue[head]);
    head = (head + 1) % QUEUE;
    count--;
}

/* ---------------------------------------------------------------------------
 * 音 (AAC と Opus)。**1コマずつ渡して、その場で1コマ受け取る** — 区切りと時刻は JS が
 * 付けているので parser は組まない。
 *
 * - AAC (`aac_open`) … 放送の ADTS をそのまま渡す (packages/arib/src/pes.ts の AdtsSplitter が切る)。
 *   ADTS の頭はデコーダが自分で読む (extradata 無しで開くと ADTS として読む決まり)。
 *   画面の canvas で描く経路の fMP4 の AAC は、JS が頭を組んで付けてから渡す
 *   (ts/fmp4.ts の `adtsHeader`)
 * - Opus (`opus_open`) … AV1 と組んで送られてくる fMP4 の Opus。設定 (OpusHead) を
 *   extradata として渡して開く (ts/fmp4.ts の `opusHead` が dOps から書き換える)
 *
 * どちらも同じ1つのデコーダの置き場 (`audio`) に開き直し、`audio_push` でデコードする
 * ------------------------------------------------------------------------- */

/** 返せる面の数。AAC は 7.1 (8本) まで */
#define AUDIO_PLANES 8

static AVCodecContext *audio;
static AVPacket *audio_pkt;
static AVFrame *audio_frame;
/** JS へ渡す1コマぶんの控え (audio_push) */
static int audio_info[3 + AUDIO_PLANES];

static int audio_open(enum AVCodecID id, const uint8_t *extra, int len) {
    const AVCodec *codec = avcodec_find_decoder(id);
    if (codec == NULL) return -1;
    avcodec_free_context(&audio);
    audio = avcodec_alloc_context3(codec);
    if (audio == NULL) return -2;
    if (len > 0) {
        // デコーダは extradata の後ろに詰め物 (0) があることを当てにして読む
        audio->extradata = av_mallocz(len + AV_INPUT_BUFFER_PADDING_SIZE);
        if (audio->extradata == NULL) return -2;
        memcpy(audio->extradata, extra, len);
        audio->extradata_size = len;
    }
    if (avcodec_open2(audio, codec, NULL) < 0) return -3;
    if (audio_pkt == NULL) audio_pkt = av_packet_alloc();
    if (audio_frame == NULL) audio_frame = av_frame_alloc();
    return audio_pkt != NULL && audio_frame != NULL ? 0 : -4;
}

/** AAC を開く。**2回目以降は開き直し** — 局を変えた・標本化周波数や本数が変わったときに呼ぶ */
EMSCRIPTEN_KEEPALIVE int aac_open(void) { return audio_open(AV_CODEC_ID_AAC, NULL, 0); }

/** Opus を開く。`extra` は OpusHead (19 バイト〜)。開き直しも同じ */
EMSCRIPTEN_KEEPALIVE int opus_open(const uint8_t *extra, int len) {
    return audio_open(AV_CODEC_ID_OPUS, extra, len);
}

/**
 * 1コマデコードする。**返すのはデコードできた標本数** (0 は出てこなかった、負は壊れたコマ)。
 * デコードできたものは `audio_peek` で読む:
 *
 *     [0] 本数 [1] 標本化周波数 [2] 標本数 [3..] 各面の番地 (float -1〜1、標本数ぶん)
 *
 * 面の並びは FFmpeg の決まり (5.1ch なら 前左・前右・中央・LFE・後左・後右)。
 * **次の audio_push までしか持たない** (同じ AVFrame を使い回す)
 */
EMSCRIPTEN_KEEPALIVE int audio_push(const uint8_t *data, int len) {
    if (audio == NULL) return -1;
    audio_pkt->data = (uint8_t *)data;
    audio_pkt->size = len;
    int sent = avcodec_send_packet(audio, audio_pkt);
    if (sent < 0) return sent;
    av_frame_unref(audio_frame);
    if (avcodec_receive_frame(audio, audio_frame) != 0) return 0;
    // `aac` も `opus` も面ごとの float で出す (Web Audio がそのまま受け取る形)。違えば読み違えるので転ばせる
    if (audio_frame->format != AV_SAMPLE_FMT_FLTP) return -2;
    int channels = audio_frame->ch_layout.nb_channels;
    if (channels > AUDIO_PLANES) channels = AUDIO_PLANES;
    audio_info[0] = channels;
    audio_info[1] = audio_frame->sample_rate;
    audio_info[2] = audio_frame->nb_samples;
    for (int i = 0; i < channels; i++) audio_info[3 + i] = (int)(intptr_t)audio_frame->extended_data[i];
    return audio_frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE int *audio_peek(void) { return audio_info; }
