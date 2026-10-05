/*
 * 放送の MPEG-2 映像と AAC 音声を、ブラウザの中で解く (docs/stream.md §5.5)。
 *
 * **ブラウザには MPEG-2 の復号器が無い** (MSE も WebCodecs も mp2v を受け取らない)
 * ので、FFmpeg の mpeg2video を WebAssembly に組んで持ち込む。ここはその
 * 薄い口で、JS (src/lib/raw/worker.ts) から呼ぶ。
 *
 * 音 (AAC) も同じ FFmpeg の `aac` で解く (`aac_*`)。WebCodecs の AudioDecoder は
 * 安全な繋ぎ (https) でしか出てこず、iPhone の Safari には iOS 26 まで無いので、
 * それに頼ると LAN の http と古い iPhone で生の道が使えない。
 *
 * - `dec_push` … PES の中身 (ES) を渡す。**区切りは FFmpeg の parser に任せる** —
 *   放送はふつう 1 PES = 1 枚だが、決まりではない。PTS も一緒に渡し、
 *   parser が「どの絵のものか」を付け替える
 * - 解けた絵は**こちらで持っておく** (`queue`)。AVFrame は受け取るたびに使い回されるので、
 *   JS が見せる時刻まで待たせるには参照を移して取っておくしかない
 * - `dec_peek` / `dec_pop` … いちばん古い1枚を覗く・捨てる。表示順で並んでいる
 *   (B フレームの並べ替えは復号器が済ませている)
 *
 * スレッドも SIMD も使わない。スレッド版は COOP/COEP (crossOriginIsolated) が要り、
 * 実測でも 1 本で 1080i を実時間の 3 倍で解けたので、払う理由が無い (§5.5)。
 */
#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/samplefmt.h>

/** 待たせておく絵の上限。**溢れたら古いほうから捨てる** (JS 側が見せ遅れているだけなので) */
#define QUEUE 24

static AVCodecContext *ctx;
static AVCodecParserContext *parser;
static AVPacket *pkt;
static AVFrame *queue[QUEUE];
static int head, count;
/** 直近の dec_push に掛かった時間 (ms)。**解くのが間に合っているかの物差し** */
static double last_ms;
/** JS へ渡す1枚ぶんの控え (dec_peek) */
static int info[12];
static double info_pts;

static void clear_queue(void) {
    for (int i = 0; i < count; i++) av_frame_free(&queue[(head + i) % QUEUE]);
    head = 0;
    count = 0;
}

/**
 * 開く。**2回目以降は開き直し** — 局を変えたときに呼ぶ。参照の絵も待たせている絵も
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
 * 1 PES ぶんを丸ごと渡す想定。parser は絵の終わりを次の絵の頭で知るので、
 * 最後の1枚は次の PES が来たときに出てくる (1 コマ遅れる。貯めの中に収まる)
 */
EMSCRIPTEN_KEEPALIVE int dec_push(const uint8_t *data, int len, double pts) {
    double started = emscripten_get_now();
    int64_t stamp = pts < 0 ? AV_NOPTS_VALUE : (int64_t)pts;
    while (len > 0) {
        uint8_t *out = NULL;
        int size = 0;
        int used = av_parser_parse2(parser, ctx, &out, &size, data, len, stamp, stamp, 0);
        // 同じ PTS を2枚目に付けない。parser は渡された時刻を最初の絵に付ける
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
 * i 枚目 (0 がいちばん古い) の時刻。**見せる番が過ぎた絵を、覗かずに飛ばすため** —
 * 次の絵がもう番を迎えているなら、手前の絵は絵にする (テクスチャに上げる) だけ無駄
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
 * 音 (AAC)。**ADTS の1コマずつ渡して、その場で1コマ受け取る** — 区切りと時刻は
 * JS の AdtsSplitter (ts/pes.ts) が付けているので parser は組まない。ADTS の頭は
 * 復号器が自分で読む (extradata 無しで開くと ADTS として読む決まり)
 * ------------------------------------------------------------------------- */

/** 返せる面の数。AAC は 7.1 (8本) まで */
#define AAC_PLANES 8

static AVCodecContext *aac;
static AVPacket *aac_pkt;
static AVFrame *aac_frame;
/** JS へ渡す1コマぶんの控え (aac_push) */
static int aac_info[3 + AAC_PLANES];

/** 開く。**2回目以降は開き直し** — 局を変えた・標本化周波数や本数が変わったときに呼ぶ */
EMSCRIPTEN_KEEPALIVE int aac_open(void) {
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_AAC);
    if (codec == NULL) return -1;
    avcodec_free_context(&aac);
    aac = avcodec_alloc_context3(codec);
    if (aac == NULL) return -2;
    if (avcodec_open2(aac, codec, NULL) < 0) return -3;
    if (aac_pkt == NULL) aac_pkt = av_packet_alloc();
    if (aac_frame == NULL) aac_frame = av_frame_alloc();
    return aac_pkt != NULL && aac_frame != NULL ? 0 : -4;
}

/**
 * ADTS の1コマ (頭ごと) を解く。**返すのは解けた標本数** (0 は出てこなかった、負は壊れたコマ)。
 * 解けたものは `aac_peek` で読む:
 *
 *     [0] 本数 [1] 標本化周波数 [2] 標本数 [3..] 各面の番地 (float -1〜1、標本数ぶん)
 *
 * 面の並びは FFmpeg の決まり (5.1ch なら 前左・前右・中央・LFE・後左・後右)。
 * **次の aac_push までしか持たない** (同じ AVFrame を使い回す)
 */
EMSCRIPTEN_KEEPALIVE int aac_push(const uint8_t *data, int len) {
    if (aac == NULL) return -1;
    aac_pkt->data = (uint8_t *)data;
    aac_pkt->size = len;
    int sent = avcodec_send_packet(aac, aac_pkt);
    if (sent < 0) return sent;
    av_frame_unref(aac_frame);
    if (avcodec_receive_frame(aac, aac_frame) != 0) return 0;
    // `aac` は面ごとの float しか出さない (Web Audio がそのまま受け取る形)。違えば読み違えるので転ばせる
    if (aac_frame->format != AV_SAMPLE_FMT_FLTP) return -2;
    int channels = aac_frame->ch_layout.nb_channels;
    if (channels > AAC_PLANES) channels = AAC_PLANES;
    aac_info[0] = channels;
    aac_info[1] = aac_frame->sample_rate;
    aac_info[2] = aac_frame->nb_samples;
    for (int i = 0; i < channels; i++) aac_info[3 + i] = (int)(intptr_t)aac_frame->extended_data[i];
    return aac_frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE int *aac_peek(void) { return aac_info; }
