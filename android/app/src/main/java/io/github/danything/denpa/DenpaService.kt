package io.github.danything.denpa

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PersistableBundle
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 常駐サービス (種類は connectedDevice)。部品 ([Part]) を子プロセスとして起動し、通知を出し続ける。1 段目の部品はエージェントだけ。
 *
 * - **動いている間は partial wake lock を持ち続ける。** 別の機械の denpa がいつ選局を求めるか分からず、画面を消すと CPU が止まって録画が欠けるため
 * - **エージェントが自分で終わったら、待ってから起動し直す。** 通知の「終了」のあとは起動し直さない
 * - **「終了」は SIGTERM を 1 回送る。** 録画中ならエージェントは録画が終わるまで待ち、そのあいだ通知は「録画が終わったら終了します」にして、
 *   ボタンを「すぐ終了」(2 回目の SIGTERM) に替える
 * - 通知の本文 (チューナーの台数・録画中か) は、エージェントの `GET /denpa/tuners` を 10 秒ごとに読んで決める ([AgentClient])
 * - 状態はどれも [worker] のスレッドで触る
 */
class DenpaService : Service() {
    private lateinit var worker: Handler
    private lateinit var thread: HandlerThread
    private lateinit var wakeLock: PowerManager.WakeLock
    private lateinit var home: File
    private lateinit var client: AgentClient
    private lateinit var agentFile: File

    internal var broker: UsbBroker? = null
        private set

    private var agent: Part? = null
    private var status: AgentStatus? = null
    private var stopping = false
    private var restarting = false
    private var startedAt = 0L
    private var backoff = RESTART_MIN
    private var shown: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        thread = HandlerThread("denpa").apply { start() }
        worker = Handler(thread.looper)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.channel_description)
                setShowBadge(false)
            },
        )
        home = File(filesDir, "denpa")
        client = AgentClient(File(home, "config/tls"), AGENT_PORT)
        agentFile = File(applicationInfo.nativeLibraryDir, AGENT_LIBRARY)
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "denpa:agent")
        acquireWakeLock()
        broker = UsbBroker(this, File(dataDir, "u"), DeviceFilter.load(this)).also { it.start() }
        worker.post { startAgent() }
        worker.post(poll)
    }

    // 動いている間はずっと持つ (止めるのは onDestroy)。時間で切ると、別の機械の denpa からの選局を受けられなくなる
    @SuppressLint("WakelockTimeout")
    private fun acquireWakeLock() = wakeLock.acquire()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 呼ばれるたびに通知を出し直す (Android 14 からは指で消せる。アイコンを押すとまた出る)
        try {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } catch (error: IllegalStateException) {
            // Android 12 からは、後ろにいるときに常駐を始められない (システムに終了されたあとに START_STICKY で起動し直されたときなど)。次のアイコンか挿入を待つ
            Log.w(TAG, "常駐サービスを始められないため止めます", error)
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_STOP -> worker.post { requestStop() }
            ACTION_STOP_NOW -> worker.post { stopNow() }
            ACTION_COPY_URL -> worker.post { copyPairUrl() }
            else -> worker.post {
                // アイコンか挿入で起こされた。終了の途中なら取りやめ、エージェントが終わったら起動し直す
                if (stopping) {
                    stopping = false
                    Prefs.setStartOnBoot(this, true)
                    refresh()
                }
                broker?.scan()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        instance = null
        broker?.stop()
        broker = null
        // 止めると決める前にシステムに止められたときも、エージェントを残さない
        agent?.terminate()
        worker.removeCallbacksAndMessages(null)
        thread.quitSafely()
        if (wakeLock.isHeld) wakeLock.release()
        super.onDestroy()
    }

    private fun environment(): Map<String, String> {
        val config = File(home, "config").apply { mkdirs() }
        val media = File(home, "media").apply { mkdirs() }
        return mapOf(
            "DENPA_HOME" to home.path,
            "TUNERS_FILE" to File(config, "tuners.json").path,
            "CHANNELS_FILE" to File(config, "channels.json").path,
            "MEDIA_DIR" to media.path,
            "USB_BROKER" to File(dataDir, "u").path,
            "AGENT_PORT" to AGENT_PORT.toString(),
            "TMPDIR" to cacheDir.path,
            "HOME" to filesDir.path,
        )
    }

    private fun startAgent() {
        restarting = false
        if (stopping) return
        if (!agentFile.canExecute()) {
            Log.e(TAG, "エージェントがありません: $agentFile")
            refresh()
            return
        }
        val part = Part("denpa-agent", agentFile, environment()) { code -> worker.post { onAgentExit(code) } }
        try {
            part.start()
        } catch (error: IOException) {
            Log.e(TAG, "エージェントを起動できませんでした", error)
            scheduleRestart()
            return
        }
        agent = part
        startedAt = SystemClock.elapsedRealtime()
        refresh()
    }

    private fun onAgentExit(code: Int) {
        agent = null
        status = null
        if (stopping) {
            Log.i(TAG, "エージェントが終了したため、常駐サービスを止めます (終了コード $code)")
            // 様子の読み取りが通知を出し直さないよう、先に止める
            worker.removeCallbacksAndMessages(null)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        // 長く動いてから異常終了したなら、すぐ起動し直す。続けて終了するなら間を延ばす
        if (SystemClock.elapsedRealtime() - startedAt > RESTART_MAX) backoff = RESTART_MIN
        Log.w(TAG, "エージェントが終了しました (終了コード $code)。${backoff / 1000} 秒後に起動し直します")
        scheduleRestart()
    }

    private fun scheduleRestart() {
        restarting = true
        refresh()
        worker.postDelayed({ startAgent() }, backoff)
        backoff = (backoff * 2).coerceAtMost(RESTART_MAX)
    }

    /** 通知の「終了」。止めたら次の端末の起動では始めない */
    private fun requestStop() {
        Prefs.setStartOnBoot(this, false)
        stopping = true
        val part = agent
        if (part == null || !part.terminate()) {
            // 起動し直す前の待ちのあいだ。止めるものが無い
            worker.removeCallbacksAndMessages(null)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        Log.i(TAG, "通知の「終了」で、エージェントに SIGTERM を送りました")
        refresh()
    }

    /** 録画を待っているあいだの「すぐ終了」。2 回目の SIGTERM で、エージェントは録画を待たずに終わる */
    private fun stopNow() {
        if (!stopping) return requestStop()
        if (agent?.terminate() == true) Log.i(TAG, "通知の「すぐ終了」で、エージェントにもう一度 SIGTERM を送りました")
    }

    private val poll = object : Runnable {
        override fun run() {
            if (agent != null) {
                status = try {
                    client.status()
                } catch (error: Exception) {
                    Log.d(TAG, "エージェントの GET /denpa/tuners を取得できませんでした: $error")
                    null
                }
            }
            refresh()
            worker.postDelayed(this, POLL_INTERVAL)
        }
    }

    /** 通知の本文が変わったときだけ出し直す */
    private fun refresh() {
        val next = text()
        if (next == shown) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
    }

    private fun text(): String {
        val current = status
        return when {
            !agentFile.canExecute() -> getString(R.string.state_missing_agent)
            stopping && current?.recording == true -> getString(R.string.state_stopping_after_recording)
            stopping -> getString(R.string.state_stopping)
            restarting -> getString(R.string.state_restarting)
            current == null -> getString(R.string.state_starting)
            current.recording -> getString(R.string.state_recording)
            else -> getString(R.string.state_tuners, current.tuners)
        }
    }

    private fun notification(): Notification {
        val body = text()
        shown = body
        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(body)
            .setOngoing(true)
            .setShowWhen(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        if (stopping) {
            builder.addAction(action(ACTION_STOP_NOW, R.string.action_stop_now))
        } else {
            builder.addAction(action(ACTION_STOP, R.string.action_stop))
            builder.addAction(action(ACTION_COPY_URL, R.string.action_copy_url))
        }
        return builder.build()
    }

    private fun action(name: String, label: Int): Notification.Action {
        val intent = PendingIntent.getService(
            this, name.hashCode(), Intent(this, DenpaService::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Action.Builder(null, getString(label), intent).build()
    }

    /**
     * 通知の「URL をコピー」。`--pair` で URL を読み、機械の名前を LAN のアドレスに替えてクリップボードに渡す。
     * 合言葉が入るので通知の本文には出さず、クリップボードには機密の印を付ける
     */
    private fun copyPairUrl() {
        val url = try {
            pairUrl()
        } catch (error: Exception) {
            Log.w(TAG, "denpa と組む URL を取得できませんでした", error)
            null
        }
        val address = PairUrl.lanAddress(getSystemService(ConnectivityManager::class.java))
        val result = when {
            url == null -> R.string.url_failed
            address == null -> R.string.url_no_address
            else -> PairUrl.withHost(url, address)?.let { copy(it); R.string.url_copied } ?: R.string.url_failed
        }
        // Android 13 からはシステムがコピーしたことを出すので、重ねない
        if (result != R.string.url_copied || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Handler(Looper.getMainLooper()).post { Toast.makeText(this, result, Toast.LENGTH_LONG).show() }
        }
    }

    private fun pairUrl(): String? {
        val process = ProcessBuilder(agentFile.path, "--pair")
            .apply { environment().putAll(this@DenpaService.environment()) }
            .start()
        process.outputStream.close()
        // 標準エラー (鍵を作ったなどの記録) は logcat に流す。終わるか destroy で切れたら、このスレッドも終わる
        thread(name = "denpa-agent-pair", isDaemon = true) {
            runCatching { process.errorStream.bufferedReader().forEachLine { Log.i("denpa-agent", it) } }
        }
        // 出力は URL の 1 行だけでパイプに収まるので、終わるのを先に待ってから読む (止まったまま worker を塞がない)
        if (!process.waitFor(10, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            return null
        }
        if (process.exitValue() != 0) return null
        return process.inputStream.bufferedReader().readLine()
    }

    private fun copy(url: String) {
        val clip = ClipData.newPlainText(getString(R.string.app_name), url)
        // ClipDescription.EXTRA_IS_SENSITIVE (API 33)。古い Android は読まずに捨てる
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        Handler(Looper.getMainLooper()).post { getSystemService(ClipboardManager::class.java).setPrimaryClip(clip) }
    }

    internal companion object {
        const val TAG = "denpa"
        const val CHANNEL = "agent"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "io.github.danything.denpa.STOP"
        const val ACTION_STOP_NOW = "io.github.danything.denpa.STOP_NOW"
        const val ACTION_COPY_URL = "io.github.danything.denpa.COPY_URL"

        /** APK の jniLibs に入れるエージェントの名前 (中身は実行ファイル。nativeLibraryDir に展開される) */
        const val AGENT_LIBRARY = "libdenpa_agent.so"
        const val AGENT_PORT = 25252
        const val POLL_INTERVAL = 10_000L
        const val RESTART_MIN = 5_000L
        const val RESTART_MAX = 60_000L

        /** 動いている常駐サービス (debug の受け口が使う) */
        @Volatile
        var instance: DenpaService? = null
            private set
    }
}
