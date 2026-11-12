plugins {
    alias(libs.plugins.android.application)
}

/*
 * バージョン。タグ (v2.41.0) から CI が `DENPA_VERSION` で渡す。手元では 0.0.0-dev。
 * versionCode は「メジャー×1000000 + マイナー×1000 + パッチ」(2.41.0 → 2041000)。上書きで入れるには前より大きい数が要る
 */
val denpaVersion = System.getenv("DENPA_VERSION")?.removePrefix("v")?.takeIf { it.isNotEmpty() } ?: "0.0.0-dev"
val denpaVersionCode = Regex("""^(\d+)\.(\d+)\.(\d+)""").find(denpaVersion)?.destructured
    ?.let { (major, minor, patch) -> major.toInt() * 1_000_000 + minor.toInt() * 1_000 + patch.toInt() }
    ?.takeIf { it > 0 } ?: 1

/*
 * エージェント (Native AOT の実行ファイル) の置き場。`<ABI>/libdenpa_agent.so` の形で置く (CI が android.yml で置く)。
 * 既定は android/agent-libs/ (リポジトリには入れない)。`DENPA_AGENT_LIBS` で別の置き場を渡せる
 */
val agentLibs = System.getenv("DENPA_AGENT_LIBS")?.takeIf { it.isNotEmpty() }
    ?: rootProject.layout.projectDirectory.dir("agent-libs").asFile.path

android {
    namespace = "io.github.danything.denpa"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.danything.denpa"
        // foregroundServiceType が入った API 29 (Android 10)。bun の Android 版 (3 段目) も API 28 を求める
        minSdk = 29
        targetSdk = 37
        versionName = denpaVersion
        versionCode = denpaVersionCode
    }

    packaging {
        jniLibs {
            /*
             * **エージェントは入れるときに nativeLibraryDir へ展開させる** (extractNativeLibs)。Android 10 からはアプリのデータの置き場のファイルを
             * 実行できず、nativeLibraryDir のものは実行できる。APK の中に置いたままでは exec できない
             */
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        warningsAsErrors = false
        abortOnError = true
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.jniLibs?.addStaticSourceDirectory(agentLibs)
    }
}

dependencies {
    testImplementation(libs.junit)
    testImplementation(libs.org.json)
}
