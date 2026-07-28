<#
 路线2 一键构建脚本：在【已安装 Android Studio + Android SDK】的 Windows 电脑上运行
 用途：把电子衣橱网页包成安卓 APK（免远程服务器、AI 可用、数据在手机本地）
 作者：WorkBuddy

 前置（需你手动完成，GUI 操作）：
   1. 装 Node.js 22 LTS（勾选 Add to PATH）：https://nodejs.org
   2. 装 Android Studio：https://developer.android.com/studio
      - 国内下载慢/被墙时，用清华镜像：https://mirrors.tuna.tsinghua.edu.cn/AndroidStudio/
   3. Android Studio 首次启动 → SDK Manager → 勾选安装：
      - Android SDK Platform 34（或 35）
      - Android SDK Build-Tools（最新）
      - Android SDK Platform-Tools
      - （可选）在 SDK Manager 的 "SDK Update Sites" 把 Google 源换成国内镜像以加速：
          https://mirrors.ustc.edu.cn/android/repository/
   4. 设系统环境变量 ANDROID_HOME = 你的 SDK 路径（默认 C:\Users\<你>\AppData\Local\Android\Sdk）
   5. 把 %ANDROID_HOME%\platform-tools 加到 PATH

 运行：在本文件所在目录（wardrobe/）右键 → 使用 PowerShell 运行
#>

$ErrorActionPreference = "Stop"
$proj = Split-Path $MyInvocation.MyCommand.Path
Set-Location $proj
Write-Output "==> 工作目录: $proj"

# ---------- 1. JDK ----------
Write-Output "`n[1/6] 检查 JDK ..."
$javaOK = $false
if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME/bin/java.exe")) {
  $javaOK = $true
  Write-Output "    已检测到 JAVA_HOME=$env:JAVA_HOME"
} elseif (Get-Command java -ErrorAction SilentlyContinue) {
  $javaOK = $true
  $env:JAVA_HOME = (Split-Path (Split-Path (Get-Command java).Source))
  Write-Output "    已检测到 java，JAVA_HOME=$env:JAVA_HOME"
}
if (-not $javaOK) {
  Write-Output "    未找到 JDK，尝试 winget 安装 Microsoft OpenJDK 17 ..."
  winget install Microsoft.OpenJDK.17 --accept-package-agreements --accept-source-agreements --scope user
  # 重新定位
  $p = Get-ChildItem "$env:LOCALAPPDATA\Programs\Microsoft" -Recurse -Filter java.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { Write-Output "JDK 安装后仍找不到 java.exe，请手动安装并设 JAVA_HOME"; exit 1 }
  $env:JAVA_HOME = (Resolve-Path (Join-Path $p.DirectoryName "..")).Path
  [Environment]::SetEnvironmentVariable("JAVA_HOME", $env:JAVA_HOME, "User")
}
& "$env:JAVA_HOME/bin/java" -version 2>&1 | Select-Object -First 1

# ---------- 2. Android SDK ----------
Write-Output "`n[2/6] 检查 Android SDK ..."
$sdk = $env:ANDROID_HOME
if (-not $sdk) {
  $guess = "$env:LOCALAPPDATA\Android\Sdk"
  if (Test-Path $guess) { $sdk = $guess; $env:ANDROID_HOME = $sdk }
}
$hasSdkManager = $sdk -and ((Test-Path "$sdk/cmdline-tools") -or (Test-Path "$sdk/tools/bin/sdkmanager"))
$hasPlatform = Test-Path "$sdk/platforms/android-34" -or (Test-Path "$sdk/platforms/android-35")
$hasBuildTools = Test-Path "$sdk/build-tools"
if (-not ($sdk -and $hasSdkManager -and $hasPlatform -and $hasBuildTools)) {
  Write-Output "!! 未检测到完整的 Android SDK（platform / build-tools / cmdline-tools）。"
  Write-Output "   请先打开 Android Studio → SDK Manager 安装："
  Write-Output "     - Android SDK Platform 34 或 35"
  Write-Output "     - Android SDK Build-Tools（最新）"
  Write-Output "     - Android SDK Platform-Tools"
  Write-Output "   并设环境变量 ANDROID_HOME=$sdk（默认 C:\Users\<你>\AppData\Local\Android\Sdk）"
  Write-Output "   装好后重新运行本脚本。"
  exit 1
}
Write-Output "    ANDROID_HOME=$sdk OK (platform/build-tools/cmdline-tools 均存在)"

# ---------- 3. 依赖安装 ----------
Write-Output "`n[3/6] npm install ..."
if (-not (Test-Path node_modules)) { npm install } else { Write-Output "    node_modules 已存在，跳过" }

# ---------- 4. 构建前端 ----------
Write-Output "`n[4/6] npm run build（生成 dist/）..."
npm run build
if (-not (Test-Path dist/index.html)) { Write-Output "build 失败，未生成 dist/index.html"; exit 1 }

# ---------- 5. Capacitor 生成安卓工程 ----------
Write-Output "`n[5/6] Capacitor 生成安卓工程 ..."
if (-not (Test-Path android)) {
  npx cap add android
} else {
  Write-Output "    android/ 已存在，跳过 cap add"
}
# 把 Gradle 分发源换成腾讯云镜像（国内可达，否则从官方下 gradle 会卡住）
$wrapper = "android/gradle/wrapper/gradle-wrapper.properties"
if (Test-Path $wrapper) {
  $txt = Get-Content $wrapper -Raw
  if ($txt -match "services\.gradle\.org/distributions/gradle-([\d.]+)-bin\.zip") {
    $ver = $Matches[1]
    $new = "https\://mirrors.cloud.tencent.com/gradle/gradle-$ver-bin.zip"
    $txt = $txt -replace "https\://services\.gradle\.org/distributions/gradle-$ver-bin\.zip", $new
    Set-Content $wrapper $txt -NoNewline
    Write-Output "    Gradle 分发源已改为腾讯云镜像: $new"
  }
}
npx cap sync android

# ---------- 6. 构建 APK ----------
Write-Output "`n[6/6] cap build android（产出 debug APK）..."
npx cap build android

# 找出产物
$apk = Get-ChildItem -Path android -Recurse -Filter "*.apk" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Output "`n========================================="
if ($apk) {
  Write-Output "✅ APK 构建完成："
  Write-Output "   $($apk.FullName)"
  Write-Output "   用数据线连手机 → 打开 USB 调试 → 运行："
  Write-Output "   adb install -r `"$($apk.FullName)`""
  Write-Output "   或把该 APK 拷到手机点开安装。"
} else {
  Write-Output "⚠️ 未自动定位到 APK，请到 android/app/build/outputs/apk/ 下查找。"
}
Write-Output "========================================="
