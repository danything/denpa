package io.github.danything.denpa

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.IOException
import kotlin.concurrent.thread

/**
 * 常駐サービスが子プロセスとして起動する「部品」。エージェントと、bun で動かす denpa 本体 ([Server]) がある。
 *
 * - **`/system/bin/sh -c 'echo $$; exec "$0" "$@"'` で起動し、最初の行で PID を受け取る。** `Process.pid()` は minSdk 29 では使えない。
 *   exec は PID を変えないので、受け取った PID に [Os.kill] で SIGTERM を送れば部品に届く
 * - 標準出力と標準エラーは logcat に流す (タグは [name])
 * - 止めるのは [terminate] (SIGTERM を 1 回)。エージェントは 1 回目で録画が終わるまで待ち、2 回目で待たずに終わる (docs/agent.md)
 * - [directory] を渡すと、そこを作業ディレクトリにして起動する
 *
 * @param onExit 部品が終わったときに、読み出し側のスレッドから終了コードで呼ぶ
 */
internal class Part(
    val name: String,
    private val executable: File,
    private val arguments: List<String>,
    private val environment: Map<String, String>,
    private val directory: File?,
    private val onExit: (code: Int) -> Unit,
) {
    /** 動いている間の PID。終わったら 0 (終わったあとに同じ PID の別のプロセスへ送らないため) */
    @Volatile
    var pid = 0
        private set

    /** 起動して PID を受け取るまで待つ。起動できなければ IOException */
    fun start() {
        val command = listOf("/system/bin/sh", "-c", "echo \$\$; exec \"\$0\" \"\$@\"", executable.path) + arguments
        val process = ProcessBuilder(command)
            .redirectErrorStream(true)
            .directory(directory)
            .apply { environment().putAll(this@Part.environment) }
            .start()
        process.outputStream.close()
        val output = process.inputStream.bufferedReader()
        val first = output.readLine()
        pid = first?.trim()?.toIntOrNull() ?: run {
            process.destroy()
            throw IOException("$name の PID を受け取れませんでした (${first ?: "出力なし"})")
        }
        Log.i(name, "起動しました (PID $pid)")
        thread(name = "$name-output", isDaemon = true) {
            try {
                output.forEachLine { Log.i(name, it) }
            } catch (_: IOException) {
                // 終わったときに読み出しが切れることがある。終了コードは下で受け取る
            }
            val code = process.waitFor()
            pid = 0
            Log.i(name, "終了しました (終了コード $code)")
            onExit(code)
        }
    }

    /** SIGTERM を 1 回送る。動いていなければ何もしない。送れたら true */
    fun terminate(): Boolean {
        val target = pid
        if (target <= 0) return false
        return try {
            Os.kill(target, OsConstants.SIGTERM)
            true
        } catch (error: ErrnoException) {
            Log.w(name, "SIGTERM を送れませんでした (PID $target)", error)
            false
        }
    }
}
