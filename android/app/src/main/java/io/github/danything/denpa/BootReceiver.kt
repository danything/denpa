package io.github.danything.denpa

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 端末の起動 (`BOOT_COMPLETED`) とアプリの更新 (`MY_PACKAGE_REPLACED`) で、前に動いていれば常駐サービスを始める。
 * 通知の「終了」で止めていたら始めない ([Prefs.startOnBoot])。connectedDevice は Android 15 でも `BOOT_COMPLETED` から始められる
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!Prefs.startOnBoot(context)) {
            Log.i(DenpaService.TAG, "通知の「終了」で止めたため、${intent.action} では始めません")
            return
        }
        try {
            context.startForegroundService(Intent(context, DenpaService::class.java))
        } catch (error: IllegalStateException) {
            // Android 12 からの、後ろから常駐を始められないとき (BOOT_COMPLETED と MY_PACKAGE_REPLACED は除かれているはず)。アプリを異常終了させずに記録だけ残す
            Log.w(DenpaService.TAG, "${intent.action} で常駐サービスを始められませんでした", error)
        }
    }
}
