package io.github.danything.denpa

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

/**
 * asicen-userland (PX-W3U3 などの ASICEN 系。試験的) をエージェントに使わせる準備 (docs/agent.md「asicen-userland の作り」)。
 *
 * - 実行ファイル (`libasicend.so`・`libasicenctl.so`) は APK の jniLibs に入っていて、nativeLibraryDir に展開される。エージェントがそこから起動する
 * - ファームウェアは実行しないので assets に入れ、ここで filesDir に書き出す (エージェントは asicend に `--firmware` でパスを渡す)
 * - ソケットの置き場は `<dataDir>/r`。asicend の制御ソケット (`r/asicen-userland/v1/<ポート>/control.sock`) が `sun_path` の 108 バイトに収まる短さにする
 *
 * CI で入れずに組んだ APK (手元で asicen-userland を置かずに組んだもの) では、エージェントは ASICEN の機材を挙げない
 */
internal object Asicen {
    private const val FIRMWARE_ASSET = "asicen/asicen-loader.bin"

    /** エージェントに渡す環境変数 (agent/Denpa.Agent/Asicen.cs の ASICEN_USERLAND_DIR・ASICEN_FIRMWARE・ASICEN_RUNTIME_DIR) */
    fun environment(context: Context, firmware: File?): Map<String, String> = buildMap {
        put("ASICEN_USERLAND_DIR", context.applicationInfo.nativeLibraryDir)
        put("ASICEN_RUNTIME_DIR", File(context.dataDir, "r").path)
        if (firmware != null) put("ASICEN_FIRMWARE", firmware.path)
    }

    /**
     * ファームウェアを assets から `filesDir/asicen/` に書き出す。中身が同じなら書き直さない (APK を更新したときだけ替わる)。
     * APK に入っていないか、書けなければ null
     */
    fun firmware(context: Context): File? {
        val bytes = try {
            context.assets.open(FIRMWARE_ASSET).use { it.readBytes() }
        } catch (_: FileNotFoundException) {
            return null
        }
        val file = File(context.filesDir, FIRMWARE_ASSET)
        return try {
            if (!file.isFile || !file.readBytes().contentEquals(bytes)) {
                file.parentFile?.mkdirs()
                val partial = File(file.path + ".tmp")
                partial.writeBytes(bytes)
                if (!partial.renameTo(file)) throw IOException("$partial を $file にできません")
            }
            file
        } catch (error: IOException) {
            Log.w(DenpaService.TAG, "ASICEN のファームウェアを書き出せません", error)
            null
        }
    }
}
