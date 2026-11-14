package io.github.danything.denpa

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.util.Log

/**
 * MediaCodec のハードウェアのエンコーダの名前を集め、denpa 本体に `MEDIACODEC_ENCODERS` で渡す (docs/encode.md「Android でエンコードする」)。
 *
 * - denpa (hwenc.ts の `probeAndroid`) は、ここで渡した名前を ffmpeg の `-codec_name` に指定して試す。FFmpeg は名前が無ければ MIME の種類で選び、
 *   ハードウェアのエンコーダが無い端末ではソフトウェアの `c2.android.*` を開いてしまうため
 * - NDK でエンコーダの一覧を引けるのは API 36 からなので、アプリが `MediaCodecList` で集める。`isHardwareAccelerated` と `isAlias` は API 29 から
 *   (アプリの minSdk は 29)
 * - コーデックごとに、`MediaCodecList` の並び (端末が勧める順) で先のものを 1 つ選ぶ。別名 (`isAlias`) は外す
 * - 見つからなくても空のまま渡す。`denpa.env` に書いたものはアプリが上書きする
 */
internal object Encoders {
    const val ENV = "MEDIACODEC_ENCODERS"

    /** denpa のコーデックの名前 → MediaCodec の MIME の種類 */
    private val MIMES = listOf("h264" to "video/avc", "hevc" to "video/hevc", "av1" to "video/av01")

    /** denpa に渡す環境変数。一覧を読めなければ空 */
    fun environment(): Map<String, String> {
        val found = try {
            hardware(MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.toList())
        } catch (error: RuntimeException) {
            Log.w(Server.TAG, "MediaCodec のエンコーダの一覧を読めないため、ハードウェアのエンコーダを渡しません", error)
            emptyList()
        }
        val value = format(found)
        Log.i(Server.TAG, "MediaCodec のハードウェアのエンコーダ: ${value.ifEmpty { "なし" }}")
        return mapOf(ENV to value)
    }

    /** コーデックごとに、ハードウェアのエンコーダを 1 つ (`h264` と名前の組) */
    private fun hardware(infos: List<MediaCodecInfo>): List<Pair<String, String>> = MIMES.mapNotNull { (codec, mime) ->
        infos.firstOrNull { info ->
            info.isEncoder && info.isHardwareAccelerated && !info.isAlias &&
                info.supportedTypes.any { it.equals(mime, ignoreCase = true) }
        }?.let { codec to it.name }
    }

    /** `h264=c2.qti.avc.encoder,hevc=c2.qti.hevc.encoder` の形 (hwenc.ts の `parseMediacodecEncoders` が読む) */
    fun format(found: List<Pair<String, String>>): String = found.joinToString(",") { (codec, name) -> "$codec=$name" }
}
