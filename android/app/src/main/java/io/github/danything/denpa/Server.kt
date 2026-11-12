package io.github.danything.denpa

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.res.AssetManager
import android.os.Build
import android.util.Log
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * bun で動かすサーバ (2 段目から。3 段目で denpa 本体になる)。常駐サービスがエージェントと同じく部品 ([Part]) として起動する。
 *
 * - bun は APK の jniLibs に `libbun.so` として入っていて、nativeLibraryDir に展開される (.github/bun-android.sh)
 * - 動かすファイルは APK の assets の `server/` に、Mac の配布物と同じ並び (`app/server.js` が入口) で入れる。
 *   assets のままでは bun が読めないので、起動の前に `DENPA_HOME/server/<versionCode>-<更新した時刻>/` へ書き出す ([extract])
 * - **assets に `server/` が無ければ起動しない。** 2 段目のリリースの APK には denpa 本体が入っていない。
 *   debug の APK には、エミュレータで確かめるための小さなサーバ (src/debug/assets/server/) が入る
 * - 置き場 (`DENPA_HOME`)・`HOME`・`TMPDIR` はエージェントと同じ。待ち受けるのは [PORT] (denpa の既定の 3000)。出力はエージェントと同じく logcat に流す (タグは [TAG])
 * - ffmpeg・ffprobe も jniLibs に `libffmpeg.so`・`libffprobe.so` として入っている (.github/ffmpeg-android.sh)。そのパスを denpa と同じ環境変数
 *   (`FFMPEG`・`FFPROBE`) で渡す ([tools])。libav* の共有ライブラリは、実行ファイルの RUNPATH (`$ORIGIN`) で同じ置き場から読まれる
 */
internal object Server {
    const val TAG = "denpa-server"
    const val BUN_LIBRARY = "libbun.so"
    const val FFMPEG_LIBRARY = "libffmpeg.so"
    const val FFPROBE_LIBRARY = "libffprobe.so"
    const val PORT = 3000
    private const val ASSETS = "server"
    private const val ENTRY = "app/server.js"

    fun bun(context: Context) = File(context.applicationInfo.nativeLibraryDir, BUN_LIBRARY)

    /** ffmpeg・ffprobe のパスを渡す環境変数。APK に入っていないもの (ffmpeg を置かずに組んだ APK) は渡さない */
    fun tools(context: Context): Map<String, String> = listOf("FFMPEG" to FFMPEG_LIBRARY, "FFPROBE" to FFPROBE_LIBRARY)
        .map { (name, library) -> name to File(context.applicationInfo.nativeLibraryDir, library) }
        .filter { (_, file) -> file.isFile }
        .associate { (name, file) -> name to file.path }

    /** APK の assets に動かすファイルが入っているか */
    fun bundled(context: Context): Boolean = !context.assets.list(ASSETS).isNullOrEmpty()

    /**
     * assets の `server/` を `<home>/server/<versionCode>-<更新した時刻>/` に書き出し、入口のファイルを返す。
     * 書き出しは `.tmp` の置き場に書いてから名前を替えるので、途中で止まっても次の起動でやり直す。ほかの置き場 (古い APK のもの) は消す。
     * debug の APK は versionCode が変わらないので、更新した時刻も名前に入れる
     */
    fun extract(context: Context, home: File): File {
        val info = packageInfo(context)
        val key = "${info.longVersionCode}-${info.lastUpdateTime}"
        val root = File(home, "server")
        val dir = File(root, key)
        if (!dir.isDirectory) {
            val partial = File(root, "$key.tmp")
            partial.deleteRecursively()
            copy(context.assets, ASSETS, partial)
            if (!partial.renameTo(dir)) throw IOException("$partial を $dir にできません")
            Log.i(TAG, "APK のサーバを $dir に書き出しました")
        }
        root.listFiles()?.filter { it.name != key }?.forEach { it.deleteRecursively() }
        val entry = File(dir, ENTRY)
        if (!entry.isFile) throw IOException("$entry がありません")
        return entry
    }

    /** `bun --version` の出力 (起動したときに記録に出す)。終わらないか失敗したら null */
    fun version(bun: File): String? {
        val process = ProcessBuilder(bun.path, "--version").redirectErrorStream(true).start()
        process.outputStream.close()
        if (!process.waitFor(10, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            return null
        }
        val output = process.inputStream.bufferedReader().readText().trim()
        return output.takeIf { process.exitValue() == 0 }
    }

    private fun packageInfo(context: Context): PackageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, 0)
        }

    /** assets の [path] の中身を [to] に写す。list が空ならファイルとして開く (assets はディレクトリかを直接は教えない) */
    private fun copy(assets: AssetManager, path: String, to: File) {
        val children = assets.list(path).orEmpty()
        if (children.isEmpty()) {
            to.parentFile?.mkdirs()
            assets.open(path).use { input -> to.outputStream().use { input.copyTo(it) } }
            return
        }
        to.mkdirs()
        for (child in children) copy(assets, "$path/$child", File(to, child))
    }
}
