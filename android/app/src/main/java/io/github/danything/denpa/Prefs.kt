package io.github.danything.denpa

import android.content.Context

/**
 * 覚えておく操作。設定の画面は作らず、最後の操作を覚える (docs/install-android.md)
 *
 * - `startOnBoot`: 端末の起動とアプリの更新のあとに常駐サービスを始めるか。アイコンかチューナーの挿入で始めたら true、通知の「終了」で止めたら false
 * - `askedBatteryOptimization`: 省電力の対象から外すよう、もう求めたか (求めるのは最初の 1 回だけ)
 */
internal object Prefs {
    private fun of(context: Context) = context.getSharedPreferences("denpa", Context.MODE_PRIVATE)

    fun startOnBoot(context: Context): Boolean = of(context).getBoolean("startOnBoot", false)

    fun setStartOnBoot(context: Context, value: Boolean) = of(context).edit().putBoolean("startOnBoot", value).apply()

    /** まだ求めていなければ true を返し、求めたことを覚える */
    fun firstBatteryOptimizationAsk(context: Context): Boolean {
        val prefs = of(context)
        if (prefs.getBoolean("askedBatteryOptimization", false)) return false
        prefs.edit().putBoolean("askedBatteryOptimization", true).apply()
        return true
    }
}
