package io.github.danything.denpa

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings

/**
 * 画面の無いアクティビティ。アイコンとチューナーの挿入 (`USB_DEVICE_ATTACHED`) で起こされ、常駐サービスを始めて閉じる。
 *
 * アイコンから起こされたときだけ、通知の許可 (Android 13 から) と、最初の 1 回は省電力の対象から外すことを求める。
 * 挿入で起こされたときは何も求めない (挿すたびに画面を出さない)
 */
class StartActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Prefs.setStartOnBoot(this, true)
        startForegroundService(Intent(this, DenpaService::class.java))
        if (intent?.action != Intent.ACTION_MAIN) {
            finish()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            return
        }
        askBatteryOptimization()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        askBatteryOptimization()
    }

    /*
     * Doze の間もネットワークと partial wake lock を使えるよう、省電力の対象から外すよう求める (docs/install-android.md)。
     * いつ録画が始まるか分からず、LAN の端末からいつ開かれるかも分からないため。Play では配らないので、この求め方を使う
     */
    @SuppressLint("BatteryLife")
    private fun askBatteryOptimization() {
        val power = getSystemService(PowerManager::class.java)
        if (!power.isIgnoringBatteryOptimizations(packageName) && Prefs.firstBatteryOptimizationAsk(this)) {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
        finish()
    }
}
