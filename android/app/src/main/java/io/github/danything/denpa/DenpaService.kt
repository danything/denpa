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
 * 常駐サービス (種類は connectedDevice)。部品 ([Part]) を子プロセスとして起動し、通知を出し続ける。部品はエージェントと、
 * APK にサーバが入っていれば bun で動かすサーバ ([Server]。2 段目のリリースの APK には入っていない)。
 *
 * - **動いている間は partial wake lock を持ち続ける。** 別の機械の denpa がいつ選局を求めるか分からず、画面を消すと CPU が止まって録画が欠けるため
 * - **部品が自分で終わったら、待ってから起動し直す。** 通知の「終了」のあとは起動し直さない
 * - **「終了」は部品のそれぞれに SIGTERM を 1 回送り、すべて終わったら常駐サービスを止める。** 録画中ならエージェントは録画が終わるまで待ち、そのあいだ通知は「録画が終わったら終了します」にして、
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

    private lateinit var agent: Slot

    /** 動かす部品。エージェントと、APK にサーバが入っていればそれも ([Server]) */
    private lateinit var slots: List<Slot>

    /** 動いているエージェントの PID (動いていなければ 0)。debug の受け口が使う */
    internal val agentPid: Int get() = agent.part?.pid ?: 0

    private var status: AgentStatus? = null
    private var stopping = false
    private var shown: String? = null

    /** [Part.start] に渡すもの。起動するたびに作る */
    private class Launch(val arguments: List<String>, val environment: Map<String, String>, val directory: File? = null)

    /**
     * 部品 1 つ分の起動と起動し直し。状態は [worker] のスレッドで触る。
     * 自分で終わったら (落ちたら) 5 秒から 1 分 (倍々) 待って起動し直し、1 分より長く動いてから終わったら 5 秒に戻す。「終了」のあとは起動し直さない
     *
     * @param label 記録の文に入れる名前 (エージェント・サーバ)
     * @param tag 部品の出力を流す logcat のタグ
     * @param prepare 起動する前に呼ぶ ([worker] のスレッド)。IOException なら起動せず、待ってからやり直す
     */
    private inner class Slot(
        val label: String,
        val tag: String,
        val executable: File,
        val prepare: () -> Launch,
    ) {
        @Volatile
        var part: Part? = null
            private set
        var restarting = false
            private set
        private var startedAt = 0L
        private var backoff = RESTART_MIN

        fun start() {
            restarting = false
            if (stopping || part != null) return
            if (!executable.canExecute()) {
                Log.e(TAG, "${label}がありません: $executable")
                refresh()
                return
            }
            val next = try {
                val launch = prepare()
                Part(tag, executable, launch.arguments, launch.environment, launch.directory) { code -> worker.post { onExit(code) } }
                    .also { it.start() }
            } catch (error: IOException) {
                Log.e(TAG, "${label}を起動できませんでした", error)
                scheduleRestart()
                return
            }
            part = next
            startedAt = SystemClock.elapsedRealtime()
            refresh()
        }

        private fun onExit(code: Int) {
            part = null
            if (this === agent) status = null
            if (stopping) {
                Log.i(TAG, "${label}が終了しました (終了コード $code)")
                if (slots.all { it.part == null }) finish()
                return
            }
            // 長く動いてから異常終了したなら、すぐ起動し直す。続けて終了するなら間を延ばす
            if (SystemClock.elapsedRealtime() - startedAt > RESTART_MAX) backoff = RESTART_MIN
            Log.w(TAG, "${label}が終了しました (終了コード $code)。${backoff / 1000} 秒後に起動し直します")
            scheduleRestart()
        }

        private fun scheduleRestart() {
            restarting = true
            refresh()
            worker.postDelayed({ start() }, backoff)
            backoff = (backoff * 2).coerceAtMost(RESTART_MAX)
        }
    }

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
        agent = Slot("エージェント", AGENT_TAG, agentFile) { Launch(emptyList(), agentEnvironment()) }
        slots = listOfNotNull(agent, serverSlot())
        for (slot in slots) worker.post { slot.start() }
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
                // アイコンか挿入で起こされた。終了の途中なら取りやめ、まだ動いている部品は終わったら起動し直す。もう終わった部品はすぐ起動する
                if (stopping) {
                    stopping = false
                    Prefs.setStartOnBoot(this, true)
                    for (slot in slots) if (slot.part == null && !slot.restarting) slot.start()
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
        // 止めると決める前にシステムに止められたときも、部品を残さない
        for (slot in slots) slot.part?.terminate()
        worker.removeCallbacksAndMessages(null)
        thread.quitSafely()
        if (wakeLock.isHeld) wakeLock.release()
        super.onDestroy()
    }

    /** 部品に共通の環境変数。置き場 (`DENPA_HOME`) はエージェントとサーバで同じ */
    private fun baseEnvironment(): Map<String, String> = mapOf(
        "DENPA_HOME" to home.path,
        "TMPDIR" to cacheDir.path,
        "HOME" to filesDir.path,
    )

    private fun agentEnvironment(): Map<String, String> {
        val config = File(home, "config").apply { mkdirs() }
        val media = File(home, "media").apply { mkdirs() }
        return baseEnvironment() + mapOf(
            "TUNERS_FILE" to File(config, "tuners.json").path,
            "CHANNELS_FILE" to File(config, "channels.json").path,
            "MEDIA_DIR" to media.path,
            "USB_BROKER" to File(dataDir, "u").path,
            "AGENT_PORT" to AGENT_PORT.toString(),
        ) + Asicen.environment(this, asicenFirmware)
    }

    /** ASICEN のファームウェアを書き出した先 (最初にエージェントを起動するときに書き出す)。APK に入っていなければ null */
    private val asicenFirmware by lazy { Asicen.firmware(this) }

    /**
     * bun で動かすサーバの部品 ([Server])。APK の assets にサーバが入っていなければ null (2 段目のリリースの APK)。
     * 起動するたびに assets を書き出し (APK が同じなら書き直さない)、`bun --version` を記録に出す
     */
    private fun serverSlot(): Slot? {
        if (!Server.bundled(this)) return null
        return Slot("サーバ", Server.TAG, Server.bun(this)) {
            val entry = Server.extract(this, home)
            Log.i(Server.TAG, "bun ${Server.version(Server.bun(this)) ?: "(--version に答えません)"}")
            Launch(listOf(entry.path), baseEnvironment() + ("PORT" to Server.PORT.toString()), entry.parentFile)
        }
    }

    /** 部品がすべて終わった (「終了」のあと)。常駐サービスを止める */
    private fun finish() {
        Log.i(TAG, "部品がすべて終了したため、常駐サービスを止めます")
        // 様子の読み取りと起動し直しの待ちが通知を出し直さないよう、先に止める
        worker.removeCallbacksAndMessages(null)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** 通知の「終了」。部品のそれぞれに SIGTERM を 1 回送る。止めたら次の端末の起動では始めない */
    private fun requestStop() {
        Prefs.setStartOnBoot(this, false)
        stopping = true
        val sent = slots.filter { it.part?.terminate() == true }
        if (sent.isEmpty()) {
            // どれも起動し直す前の待ちのあいだ。止めるものが無い
            finish()
            return
        }
        Log.i(TAG, "通知の「終了」で、${sent.joinToString("・") { it.label }}に SIGTERM を送りました")
        refresh()
    }

    /** 録画を待っているあいだの「すぐ終了」。2 回目の SIGTERM で、エージェントは録画を待たずに終わる */
    private fun stopNow() {
        if (!stopping) return requestStop()
        if (agent.part?.terminate() == true) Log.i(TAG, "通知の「すぐ終了」で、エージェントにもう一度 SIGTERM を送りました")
    }

    private val poll = object : Runnable {
        override fun run() {
            if (agent.part != null) {
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
            agent.restarting -> getString(R.string.state_restarting)
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
            .apply { environment().putAll(agentEnvironment()) }
            .start()
        process.outputStream.close()
        // 標準エラー (鍵を作ったなどの記録) は logcat に流す。終わるか destroy で切れたら、このスレッドも終わる
        thread(name = "denpa-agent-pair", isDaemon = true) {
            runCatching { process.errorStream.bufferedReader().forEachLine { Log.i(AGENT_TAG, it) } }
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

        /** エージェントの出力を流す logcat のタグ */
        const val AGENT_TAG = "denpa-agent"
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
