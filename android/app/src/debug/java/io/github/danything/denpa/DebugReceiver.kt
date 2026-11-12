package io.github.danything.denpa

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileInputStream
import kotlin.concurrent.thread

/**
 * debug の APK にだけ入る、エミュレータで確かめるための受け口 (.github/android-app-smoke.sh)。`adb shell am broadcast` で送る。
 * エミュレータには USB の機材を挿せず、通知のボタンも押せないので、その代わりをする
 *
 * - `ATTACH_FILE`: USB の機材の代わりに、ファイルの fd を付けた `attached` と `synced` を、本物と同じ [UsbBroker.send] で送る。
 *   ID は extra の `vendor`・`product` (`--ei`) で、無ければ 1234:5678 (どの機種でもないので、チューナーには出ない)。
 *   名前は `/dev/bus/usb/001/004`
 * - `PRESS_STOP`: 通知の「終了」のボタンの PendingIntent を、そのまま送る
 * - `KILL_AGENT`: エージェントに SIGKILL を送る (異常終了の代わり。API 29 の run-as はアプリの子プロセスを kill できない)
 * - `RUN_BUN`: `DENPA_HOME/smoke/` の JavaScript (extra の `script`) を、denpa 本体と同じくアプリの子プロセスの bun で流す。
 *   環境変数は常駐サービスが bun に渡すもの ([DenpaService.bunEnvironment])、引数は nativeLibraryDir と作業場所 (`smoke/work`)。
 *   標準出力・標準エラー・終了コードを、スクリプトの隣の `<script>.stdout`・`.stderr`・`.exit` に書く (smoke が run-as で読む)
 */
class DebugReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ATTACH_FILE -> attachFile(context, intent.getIntExtra("vendor", 0x1234), intent.getIntExtra("product", 0x5678))
            PRESS_STOP -> pressStop(context)
            KILL_AGENT -> DenpaService.instance?.agentPid?.takeIf { it > 0 }?.let {
                Os.kill(it, OsConstants.SIGKILL)
                Log.i(TAG, "エージェントに SIGKILL を送りました (PID $it)")
            }
            RUN_BUN -> runBun(context, intent.getStringExtra("script") ?: return)
        }
    }

    private fun attachFile(context: Context, vendor: Int, product: Int) {
        val broker = DenpaService.instance?.broker ?: run { Log.w(TAG, "常駐サービスが動いていません"); return }
        // デバイスディスクリプタ (18 バイト) の形にしておく。エージェントは名前からポートを作り、中身は開くときまで読まない
        val file = File(context.cacheDir, "fake-device.bin")
        file.writeBytes(byteArrayOf(0x12, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x40, 0x34, 0x12, 0x78, 0x56, 0x00, 0x01, 0x01, 0x02, 0x03, 0x01))
        FileInputStream(file).use { stream ->
            broker.send(BrokerLines.attached("/dev/bus/usb/001/004", vendor, product, null, null, null, emptyList()), stream.fd)
        }
        broker.send(BrokerLines.synced, null)
        Log.i(TAG, "ファイルの fd を付けた attached を送りました")
    }

    private fun runBun(context: Context, name: String) {
        val service = DenpaService.instance ?: run { Log.w(TAG, "常駐サービスが動いていません"); return }
        val dir = File(context.filesDir, "denpa/smoke")
        val script = File(dir, name)
        // 置き場の外のファイルは流さない
        if (script.parentFile?.canonicalFile != dir.canonicalFile || !script.isFile) {
            Log.w(TAG, "$script がありません")
            return
        }
        val work = File(dir, "work").apply { mkdirs() }
        val exit = File(dir, "$name.exit").apply { delete() }
        val process = ProcessBuilder(Server.bun(context).path, script.path, context.applicationInfo.nativeLibraryDir, work.path)
            .directory(dir)
            .redirectOutput(File(dir, "$name.stdout"))
            .redirectError(File(dir, "$name.stderr"))
            .apply { environment().putAll(service.bunEnvironment()) }
            .start()
        process.outputStream.close()
        Log.i(TAG, "bun で $name を流します")
        thread(name = "denpa-debug-bun", isDaemon = true) {
            val code = process.waitFor()
            exit.writeText("$code\n")
            Log.i(TAG, "bun で流した $name が終わりました (終了コード $code)")
        }
    }

    private fun pressStop(context: Context) {
        val label = context.getString(R.string.action_stop)
        val action = context.getSystemService(NotificationManager::class.java).activeNotifications
            .firstOrNull { it.id == DenpaService.NOTIFICATION_ID }?.notification?.actions
            ?.firstOrNull { it.title?.toString() == label }
            ?: run { Log.w(TAG, "通知に「$label」のボタンがありません"); return }
        action.actionIntent.send()
        Log.i(TAG, "通知の「$label」を押しました")
    }

    private companion object {
        const val TAG = "denpa"
        const val ATTACH_FILE = "io.github.danything.denpa.debug.ATTACH_FILE"
        const val PRESS_STOP = "io.github.danything.denpa.debug.PRESS_STOP"
        const val KILL_AGENT = "io.github.danything.denpa.debug.KILL_AGENT"
        const val RUN_BUN = "io.github.danything.denpa.debug.RUN_BUN"
    }
}
