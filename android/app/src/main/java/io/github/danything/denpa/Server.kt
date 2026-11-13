package io.github.danything.denpa

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

/**
 * denpa 本体。bun で動かし、常駐サービスがエージェントと同じく部品 ([Part]) として起動する。
 *
 * - bun は APK の jniLibs に `libbun.so` として入っていて、nativeLibraryDir に展開される (.github/bun-android.sh)
 * - 動かすファイルは APK の assets の `server.zip` に、Mac の配布物と同じ並び (`app/`・`font/`・`mpeg2/`。Dockerfile の `native-files` 段) で入れる。
 *   **1 つの zip にするのは、AGP が assets の `_` で始まるディレクトリ (SvelteKit の `_app/`) を APK に入れないため。**
 *   assets のままでは bun が読めないので、起動の前に `DENPA_HOME/server/<versionCode>-<更新した時刻>/` へ書き出す ([extract])
 * - **assets に `server.zip` が無ければ起動しない。** 手元で denpa 本体を置かずに組んだ APK は、エージェントだけが動く
 * - 環境変数は Mac の `denpa.sh` (install.sh) と同じ並び ([environment])。ffmpeg・ffprobe は jniLibs の `libffmpeg.so`・`libffprobe.so` を
 *   `FFMPEG`・`FFPROBE` で渡す ([tools])。libav* の共有ライブラリは、実行ファイルの RUNPATH (`$ORIGIN`) で同じ置き場から読まれる
 * - 人が足す環境変数は、外部ストレージのアプリの置き場の `denpa.env` に書く ([userEnvironment])。アプリが決めるものはそちらより勝つ
 * - 出力はエージェントと同じく logcat に流す (タグは [TAG])
 */
internal object Server {
    const val TAG = "denpa-server"
    const val BUN_LIBRARY = "libbun.so"
    const val FFMPEG_LIBRARY = "libffmpeg.so"
    const val FFPROBE_LIBRARY = "libffprobe.so"
    const val PORT = 3000
    private const val ARCHIVE = "server.zip"
    private const val ENTRY = "app/server.js"
    private const val ENV_FILE = "denpa.env"

    /** denpa.env が無いときに書く中身。Mac の install.sh と同じ既定 (ENCODE_CONCURRENCY は実機で決めるまで既定のまま) */
    private val ENV_DEFAULT = """
        |# denpa 本体の環境変数 (docs/config.md)。アプリは無いときだけ作り、あとは触らない。
        |# 直したら、通知の「終了」のあとホーム画面の「denpa」で始め直す。置き場・ffmpeg・エージェントの宛先・ポートはアプリが決めるので、書いても効かない
        |TZ=Asia/Tokyo
        |# 誰を通すか (docs/auth.md)。127.0.0.0/8 と ::1 はこの端末のブラウザ
        |TRUSTED_NETWORKS=127.0.0.0/8,::1/128,192.168.0.0/16,10.0.0.0/8
        |
    """.trimMargin()

    fun bun(context: Context) = File(context.applicationInfo.nativeLibraryDir, BUN_LIBRARY)

    /** ffmpeg・ffprobe のパスを渡す環境変数。APK に入っていないもの (ffmpeg を置かずに組んだ APK) は渡さない */
    fun tools(context: Context): Map<String, String> = listOf("FFMPEG" to FFMPEG_LIBRARY, "FFPROBE" to FFPROBE_LIBRARY)
        .map { (name, library) -> name to File(context.applicationInfo.nativeLibraryDir, library) }
        .filter { (_, file) -> file.isFile }
        .associate { (name, file) -> name to file.path }

    /** APK の assets に denpa 本体が入っているか */
    fun bundled(context: Context): Boolean = context.assets.list("").orEmpty().contains(ARCHIVE)

    /**
     * assets の `server.zip` を `<home>/server/<versionCode>-<更新した時刻>/` に書き出し、その置き場 (`app/`・`font/`・`mpeg2/` の親) を返す。
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
            val started = SystemClock.elapsedRealtime()
            val files = context.assets.open(ARCHIVE).use { unzip(it, partial) }
            if (!partial.renameTo(dir)) throw IOException("$partial を $dir にできません")
            Log.i(TAG, "APK の denpa を $dir に書き出しました ($files ファイル、${SystemClock.elapsedRealtime() - started} ミリ秒)")
        }
        root.listFiles()?.filter { it.name != key }?.forEach { it.deleteRecursively() }
        if (!File(dir, ENTRY).isFile) throw IOException("${File(dir, ENTRY)} がありません")
        return dir
    }

    /** 入口のファイル ([extract] が返した置き場の中) */
    fun entry(dir: File) = File(dir, ENTRY)

    /**
     * denpa に渡す環境変数。[base] (置き場・HOME・TMPDIR) に人が足したもの ([user]) を重ね、アプリが決めるものを最後に重ねる。
     * 並びは Mac の `denpa.sh` と同じ。エージェントは同じ端末なので 127.0.0.1 で繋ぎ、合言葉 ([token]) は URL の `#pair=` で渡す
     */
    fun environment(
        context: Context,
        home: File,
        dir: File,
        token: String,
        agentPort: Int,
        base: Map<String, String>,
        user: Map<String, String>,
    ): Map<String, String> = base + user + mapOf(
        "NODE_ENV" to "production",
        "DENPA_VERSION" to denpaVersion(packageInfo(context).versionName),
        "DENPA_DB" to File(home, "data/denpa.db").path,
        "MEDIA_DIR" to File(home, "media").path,
        // エージェントには MEDIA_DIR だけを渡す。元の TS とエンコード済みの置き場も MEDIA_DIR の下に固定し、本体とエージェントで食い違わないようにする
        "RAW_DIR" to File(home, "media/raw").path,
        "ENCODED_DIR" to File(home, "media/encoded").path,
        "MPEG2_DIR" to File(dir, "mpeg2").path,
        "FONT_DIR" to File(dir, "font").path,
        "TUNER_AGENT_URL" to "https://127.0.0.1:$agentPort#pair=$token",
        "PORT" to PORT.toString(),
        // 変換のキャッシュを書かない (Mac の denpa.sh・コンテナと同じ。展開した置き場は更新のたびに替わる)
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH" to "0",
    ) + tools(context)

    /** リリースの APK (versionName が `2.43.0` の形) は `v2.43.0`、手元と CI の APK は `dev` (更新の通知を出さない) */
    fun denpaVersion(versionName: String?): String =
        if (versionName != null && Regex("""^\d+\.\d+\.\d+$""").matches(versionName)) "v$versionName" else "dev"

    /**
     * 人が足す環境変数 (外部ストレージのアプリの置き場の `denpa.env`。`adb push` で書ける)。無ければ既定を書いてから読む。
     * 外部ストレージが使えなければ既定の中身を使う。
     *
     * **Android 10 では読まずに既定の中身を使う。** Android 10 は、ストレージの権限を持つ古い作りのアプリ (requestLegacyExternalStorage) が
     * ほかのアプリの `Android/data/` にも書けるので、`TRUSTED_NETWORKS` を書き換えられて denpa を開けられてしまうため
     */
    fun userEnvironment(context: Context): Map<String, String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.i(TAG, "Android 10 では $ENV_FILE を読まず、既定の中身を使います")
            return parseEnvironment(ENV_DEFAULT)
        }
        val text = try {
            context.getExternalFilesDir(null)?.let { dir ->
                val file = File(dir, ENV_FILE)
                if (!file.isFile) file.writeText(ENV_DEFAULT)
                file.readText()
            } ?: ENV_DEFAULT
        } catch (error: IOException) {
            Log.w(TAG, "$ENV_FILE を読めないため、既定の中身を使います", error)
            ENV_DEFAULT
        }
        return parseEnvironment(text)
    }

    /** 1 行に `KEY=値`。空の行と `#` で始まる行は飛ばす (Mac の denpa.sh と同じ読み方。値の空白や記号はそのまま) */
    fun parseEnvironment(text: String): Map<String, String> = text.lineSequence()
        .map { it.trimEnd('\r') }
        .filter { it.isNotBlank() && !it.startsWith("#") && it.indexOf('=') > 0 }
        .associate { it.substringBefore('=') to it.substringAfter('=') }

    /**
     * エージェントと組む合言葉 (`config/tls/pair-token`)。無ければ作る (32 バイトの乱数を base64url で。install.sh と同じ)。
     * エージェントも同じファイルを読むので、denpa とエージェントが同じ合言葉を使う
     */
    fun pairToken(home: File): String {
        val file = File(home, "config/tls/pair-token")
        file.takeIf { it.isFile }?.readText()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        file.parentFile?.mkdirs()
        val partial = File(file.path + ".new")
        partial.writeText(token + "\n")
        if (!partial.renameTo(file)) throw IOException("$partial を $file にできません")
        return token
    }

    /** `GET /api/health` が 200 を返すか (通知に出す)。様子の読み取りと同じスレッドで呼ぶので、繋ぐのと読むのをそれぞれ 1 秒で諦める */
    fun healthy(): Boolean = try {
        Socket().use { socket ->
            socket.connect(InetSocketAddress("127.0.0.1", PORT), 1_000)
            socket.soTimeout = 1_000
            socket.getOutputStream().write("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n".toByteArray())
            socket.getInputStream().bufferedReader().readLine()?.split(' ')?.getOrNull(1) == "200"
        }
    } catch (_: IOException) {
        false
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

    /** zip を [to] に展開し、書いたファイルの数を返す。[to] の外を指す名前は断る */
    private fun unzip(input: InputStream, to: File): Int {
        to.mkdirs()
        val root = to.canonicalFile
        var files = 0
        ZipInputStream(input.buffered()).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val target = File(root, entry.name).canonicalFile
                if (!target.path.startsWith(root.path + File.separator)) throw IOException("${entry.name} は置き場の外を指しています")
                if (entry.isDirectory) {
                    target.mkdirs()
                    continue
                }
                target.parentFile?.mkdirs()
                target.outputStream().use { zip.copyTo(it, 64 * 1024) }
                files++
            }
        }
        return files
    }
}
