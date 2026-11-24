$ErrorActionPreference = "Stop"

# Android Studio 同梱 JDK 21 と Android SDK を自動設定
if (-not $env:JAVA_HOME) {
  $jbr = "C:\Program Files\Android\Android Studio\jbr"
  if (Test-Path $jbr) {
    $env:JAVA_HOME = $jbr
    $env:Path = "$jbr\bin;$env:Path"
  }
}

if (-not $env:ANDROID_HOME) {
  $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
  if (Test-Path $sdk) {
    $env:ANDROID_HOME = $sdk
    $env:ANDROID_SDK_ROOT = $sdk
    $env:Path = "$sdk\platform-tools;$env:Path"
  }
}

Write-Host "[1/4] Building web assets for Capacitor..." -ForegroundColor Cyan
npm run build:native
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[2/4] Syncing Capacitor Android project..." -ForegroundColor Cyan
npx cap sync android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[3/4] Building Android Debug APK..." -ForegroundColor Cyan
Push-Location android
try {
  .\gradlew.bat assembleDebug
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

$apkPath = "android\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $apkPath)) {
  Write-Error "APK not found at $apkPath"
  exit 1
}

Write-Host "[4/4] Checking USB-connected Android device..." -ForegroundColor Cyan
$devicesOutput = adb devices
$connected = $devicesOutput | Select-String -Pattern "\tdevice$"
if (-not $connected) {
  Write-Host "USB 接続された Android 端末が見つかりませんでした。" -ForegroundColor Yellow
  Write-Host "端末の「USBデバッグ」をONにして接続後、もう一度 npm run android:usb を実行してください。" -ForegroundColor Yellow
  Write-Host "生成済みAPK: $apkPath" -ForegroundColor Green
  exit 0
}

Write-Host "Installing APK to connected device..." -ForegroundColor Cyan
adb install -r $apkPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Launching BrainAtlas on device..." -ForegroundColor Cyan
adb shell am start -n com.pvvermouth.brainatlas/.MainActivity
Write-Host "Done!" -ForegroundColor Green
