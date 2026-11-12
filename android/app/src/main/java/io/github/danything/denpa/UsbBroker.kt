package io.github.danything.denpa

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.File
import java.io.FileDescriptor
import java.io.IOException
import kotlin.concurrent.thread

/**
 * 許可を得て開いた USB の機材の fd を、エージェントの USB_BROKER のソケットへ送る (docs/agent.md「Android でアプリから USB を受け取る」)。
 *
 * - **待ち受けるのはエージェントで、こちらが繋ぐ。** 繋がるまで 1 秒ごとにやり直す。切れたら繋ぎ直す (エージェントを起動し直したときも同じ)
 * - **繋いだら、開いている機材を全部 `attached` で送り、最後に `synced` を送る。** エージェントは繋がるたびに前の機材を捨てるので、繋ぎ直したときも同じ
 * - **1 行は 1 回の write で送る。** `setFileDescriptorsForSend` のあと、行を 1 つの `ByteArray` にして書く。fd はその write に付く。
 *   分けて書くと、エージェントは fd を別の行のものとみる
 * - [UsbDeviceConnection] は機材が抜けるまで閉じない (閉じると送った fd の元も閉じる。エージェントの側は自分の写しを持つ)
 * - 挿さった・抜けたは `USB_DEVICE_ATTACHED`・`DETACHED` のブロードキャストで受ける。許可が無い機材は [UsbManager.requestPermission] で求める
 */
internal class UsbBroker(private val context: Context, private val socketFile: File, private val filter: DeviceFilter) {
    private val usb = context.getSystemService(UsbManager::class.java)

    /** 開いている機材 (`getDeviceName()` ごと)。[lock] の中で触る */
    private val opened = LinkedHashMap<String, Pair<UsbDevice, UsbDeviceConnection>>()

    /** 許可を求めた機材の名前 (抜けるまで求め直さない)。[lock] の中で触る */
    private val asked = HashSet<String>()

    /** 繋がっているソケット。[lock] の中で触る */
    private var connected: LocalSocket? = null
    private val lock = Any()

    @Volatile
    private var running = false
    private var connector: Thread? = null

    private val permission = "${context.packageName}.USB_PERMISSION"

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val device = deviceOf(intent) ?: return
            when (intent.action) {
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> offer(device)
                UsbManager.ACTION_USB_DEVICE_DETACHED -> close(device.deviceName)
                permission -> if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                    open(device)
                } else {
                    Log.i(TAG, "USB の機材の許可が得られませんでした: ${device.deviceName} (${id(device)})")
                }
            }
        }
    }

    // RECEIVER_NOT_EXPORTED は API 33 から意味を持つ。それより前の Android は知らない印を無視する
    @SuppressLint("InlinedApi")
    fun start() {
        running = true
        val actions = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(permission)
        }
        // 挿抜はシステムが、許可の結果はこのアプリの PendingIntent が送るので、ほかのアプリからは受けない
        context.registerReceiver(receiver, actions, Context.RECEIVER_NOT_EXPORTED)
        scan()
        connector = thread(name = "usb-broker", isDaemon = true) { connectLoop() }
    }

    fun stop() {
        running = false
        context.unregisterReceiver(receiver)
        synchronized(lock) {
            connected?.let(::closeQuietly)
            connected = null
            opened.values.forEach { it.second.close() }
            opened.clear()
            asked.clear()
        }
        connector?.interrupt()
    }

    /** 挿さっている機材を見直す (アイコンや挿入で常駐サービスが起こされたとき)。許可があれば開き、無ければ求める */
    fun scan() {
        usb.deviceList.values.forEach(::offer)
    }

    private fun offer(device: UsbDevice) {
        if (!filter.matches(device)) return
        if (usb.hasPermission(device)) {
            open(device)
            return
        }
        synchronized(lock) { if (!asked.add(device.deviceName)) return }
        Log.i(TAG, "USB の機材の許可を求めます: ${device.deviceName} (${id(device)})")
        val intent = Intent(permission).setPackage(context.packageName)
        // 結果はシステムが EXTRA_DEVICE と EXTRA_PERMISSION_GRANTED を足して送るので、書き足せる PendingIntent にする
        usb.requestPermission(device, PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_MUTABLE))
    }

    private fun open(device: UsbDevice) {
        synchronized(lock) {
            if (!running || device.deviceName in opened) return
            val connection = usb.openDevice(device)
            if (connection == null) {
                Log.w(TAG, "USB の機材を開けませんでした: ${device.deviceName} (${id(device)})")
                return
            }
            opened[device.deviceName] = device to connection
            Log.i(TAG, "USB の機材を開きました: ${device.deviceName} (${id(device)})")
            sendAttached(device, connection)
        }
    }

    private fun close(name: String) {
        synchronized(lock) {
            asked.remove(name)
            val (_, connection) = opened.remove(name) ?: return
            send(BrokerLines.detached(name), null)
            connection.close()
            Log.i(TAG, "抜かれた USB の機材を閉じました: $name")
        }
    }

    /** [lock] の中で呼ぶ */
    private fun sendAttached(device: UsbDevice, connection: UsbDeviceConnection) {
        val interfaces = (0 until device.configurationCount).flatMap { index ->
            val config = device.getConfiguration(index)
            // 代わりの設定 (alternate setting) は同じ番号で何度も出るので、番号ごとに 1 つにする
            (0 until config.interfaceCount).map { config.getInterface(it) }.distinctBy { it.id }
                .map { BrokerLines.Interface(config.id, it.id, it.interfaceClass) }
        }
        // シリアル番号は許可が無いと SecurityException になる。読めなければ書かない
        val line = BrokerLines.attached(
            device.deviceName, device.vendorId, device.productId,
            runCatching { device.serialNumber }.getOrNull(), device.manufacturerName, device.productName, interfaces,
        )
        // fromFd は複製を作る。送り終えたら複製だけを閉じる (元は UsbDeviceConnection が持つ)
        ParcelFileDescriptor.fromFd(connection.fileDescriptor).use { send(line, it.fileDescriptor) }
    }

    /**
     * 1 行を 1 回の write で送る。[fd] があればその write に SCM_RIGHTS で付ける。繋がっていなければ送らない
     * (繋いだときに開いている機材を全部送り直す)。書けなければ接続を捨てて繋ぎ直させる
     */
    fun send(line: ByteArray, fd: FileDescriptor?) {
        synchronized(lock) {
            val socket = connected ?: return
            try {
                if (fd != null) socket.setFileDescriptorsForSend(arrayOf(fd))
                socket.outputStream.write(line)
            } catch (error: IOException) {
                Log.w(TAG, "USB_BROKER に書けないため、繋ぎ直します", error)
                closeQuietly(socket)
                connected = null
            } finally {
                if (fd != null) runCatching { socket.setFileDescriptorsForSend(null) }
            }
        }
    }

    private fun connectLoop() {
        var logged = false
        while (running) {
            val socket = LocalSocket()
            try {
                socket.connect(LocalSocketAddress(socketFile.path, LocalSocketAddress.Namespace.FILESYSTEM))
            } catch (error: IOException) {
                closeQuietly(socket)
                // エージェントが待ち受けるまでは繋がらないのがふつうなので、続けて失敗しても 1 回だけ出す
                if (!logged) Log.i(TAG, "USB_BROKER (${socketFile.path}) に繋げないため、繋がるまでやり直します (${error.message})")
                logged = true
                if (!pause()) return
                continue
            }
            logged = false
            synchronized(lock) {
                if (!running) {
                    closeQuietly(socket)
                    return
                }
                connected = socket
                opened.values.forEach { (device, connection) -> sendAttached(device, connection) }
                send(BrokerLines.synced, null)
                Log.i(TAG, "USB_BROKER に繋ぎ、USB の機材を ${opened.size} 台送りました")
            }
            // エージェントからは何も送られてこない。切れたら read が -1 を返す
            try {
                while (socket.inputStream.read() >= 0) Unit
            } catch (_: IOException) {
                // 切れた
            }
            synchronized(lock) { if (connected === socket) connected = null }
            closeQuietly(socket)
            if (running) Log.i(TAG, "USB_BROKER の接続が切れたため、繋ぎ直します")
            if (!pause()) return
        }
    }

    /** 1 秒待つ。止められたら false */
    private fun pause(): Boolean = try {
        Thread.sleep(1000)
        running
    } catch (_: InterruptedException) {
        false
    }

    private fun closeQuietly(socket: LocalSocket) {
        runCatching { socket.shutdownInput() }
        runCatching { socket.close() }
    }

    @Suppress("DEPRECATION") // 型を渡す版は API 33 から
    private fun deviceOf(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }

    private fun id(device: UsbDevice) = "%04x:%04x".format(device.vendorId, device.productId)

    private companion object {
        const val TAG = "denpa"
    }
}
