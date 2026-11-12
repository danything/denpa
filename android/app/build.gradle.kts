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

/*
 * エージェントに入っているもののライセンスの文書。APK の `assets/licenses/` に入れる (docs/licenses.md「Android のアプリ」)。
 * Siano のファームウェアの許諾 (LICENCE.siano) はリポジトリから取る。OpenSSL の LICENSE は、エージェントを組んだ CI が
 * `android/agent-licenses/` (`DENPA_AGENT_LICENSES` で替えられる) に置く
 */
val agentLicenses = System.getenv("DENPA_AGENT_LICENSES")?.takeIf { it.isNotEmpty() }
    ?: rootProject.layout.projectDirectory.dir("agent-licenses").asFile.path
val sianoLicence = rootProject.layout.projectDirectory.file("../agent/Denpa.Agent/firmware/LICENCE.siano")

/*
 * asicen-userland (ASICEN 系。試験的) の置き場。CI が .github/asicen-android.sh で、上流の Android 版を `jniLibs/<ABI>/libasicend.so`・
 * `libasicenctl.so` に、ファームウェアを `assets/asicen/` に、ライセンスの文書とソースの入手先を `assets/licenses/asicen-userland/` に並べる。
 * 既定は android/asicen-userland/ (リポジトリには入れない)。`DENPA_ASICEN` で別の置き場を渡せる。無ければ入れずに組む (ASICEN の機材は使えない)
 */
val asicen = System.getenv("DENPA_ASICEN")?.takeIf { it.isNotEmpty() }
    ?: rootProject.layout.projectDirectory.dir("asicen-userland").asFile.path

/*
 * bun (2 段目から。サーバを動かす) の置き場。CI が .github/bun-android.sh で、公式の Android 版を `jniLibs/<ABI>/libbun.so` に、
 * ライセンスの文書を `assets/licenses/bun/` に並べる。既定は android/bun/ (リポジトリには入れない)。`DENPA_BUN` で別の置き場を渡せる。
 * 無ければ入れずに組む (サーバは起動しない)
 */
val bun = System.getenv("DENPA_BUN")?.takeIf { it.isNotEmpty() }
    ?: rootProject.layout.projectDirectory.dir("bun").asFile.path

/** ライセンスの文書を `licenses/` に並べた assets の置き場を作る */
abstract class LicenseAssets : DefaultTask() {
    @get:InputFiles
    abstract val sources: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @TaskAction
    fun copy() {
        val dir = output.get().asFile.resolve("licenses")
        dir.deleteRecursively()
        dir.mkdirs()
        sources.files.filter { it.isFile }.forEach { it.copyTo(dir.resolve(it.name)) }
    }
}

val licenseAssets = tasks.register<LicenseAssets>("licenseAssets") {
    sources.from(sianoLicence, fileTree(agentLicenses))
}

/*
 * リリースの署名の鍵。リリースの CI だけが secrets から渡す (.github/workflows/android.yml)。**鍵が同じでないと上書きで入れられない** ので、
 * 一度決めた鍵を使い続ける。denpa-tv とは別の鍵 (docs/development.md「Android のアプリ」)。
 * 渡されないとき (PR の CI・手元) は、release も debug の鍵で署名する
 */
val releaseKeystore = System.getenv("DENPA_ANDROID_KEYSTORE")?.takeIf { it.isNotEmpty() }

android {
    namespace = "io.github.danything.denpa"
    // いまの最新の安定版 (Android 17 の 37.2)。targetSdk は小数を持てないので 37
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "io.github.danything.denpa"
        // foregroundServiceType が入った API 29 (Android 10)。bun の Android 版 (3 段目) も API 28 を求める
        minSdk = 29
        targetSdk = 37
        versionName = denpaVersion
        versionCode = denpaVersionCode
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("DENPA_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DENPA_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("DENPA_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName(if (releaseKeystore != null) "release" else "debug")
            // R8 で縮める。リフレクションで引くクラスは無く、マニフェストの部品は AGP の規則が残すので、規則は足さない
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    packaging {
        jniLibs {
            /*
             * **エージェントは入れるときに nativeLibraryDir へ展開させる** (extractNativeLibs)。Android 10 からはアプリのデータの置き場のファイルを
             * 実行できず、nativeLibraryDir のものは実行できる。APK の中に置いたままでは exec できない
             */
            useLegacyPackaging = true
            /*
             * bun は公式の配布物のまま入れる (SHA-256 で確かめたものと同じ中身にする)。113 MB を llvm-strip に通す時間もかからない。
             * APK の中では圧縮される (useLegacyPackaging のとき jniLibs は deflate で入る) ので、APK に増えるのは arm64 で約 49 MB。
             * 端末には展開した 113 MB が置かれる。展開しないと exec できないので、ここは縮められない
             */
            keepDebugSymbols += "**/libbun.so"
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
        variant.sources.jniLibs?.addStaticSourceDirectory("$asicen/jniLibs")
        variant.sources.jniLibs?.addStaticSourceDirectory("$bun/jniLibs")
        variant.sources.assets?.addGeneratedSourceDirectory(licenseAssets, LicenseAssets::output)
        variant.sources.assets?.addStaticSourceDirectory("$asicen/assets")
        variant.sources.assets?.addStaticSourceDirectory("$bun/assets")
    }
}

dependencies {
    testImplementation(libs.junit)
    testImplementation(libs.org.json)
}
