# 路线 2：原生 App 壳（Capacitor）— Windows 环境安装与构建指南

> 目标：把你现有的「电子衣橱」网页，打包成**安卓 APK**，在手机上免远程服务器运行，AI 功能可用。
> 为什么需要这套环境：安卓 APK 必须用 Android SDK（含 Gradle）编译，本机（WorkBuddy 环境）没有 JDK/SDK，无法直接出 APK。以下步骤在你那台「其他 Windows 电脑」上执行。

---

## 一、为什么选路线 2（先理解原理）

当前网页： `前端 → Node 后端(/api/*) → DashScope`。浏览器内核有 CORS，网页不能直接连 DashScope，所以要有后端中转。

路线 2 用 **Capacitor 把网页包进原生 App**，关键是用 **Capacitor 原生桥（`@capacitor-community/http`，v8 包名为 `@capacitor/synapse`）** 发请求——原生层（Kotlin）不受浏览器 CORS 限制，能直接连 DashScope。架构变成：

```
App 内：  前端 → Capacitor 原生桥(无 CORS) → DashScope
               → Capacitor Filesystem(手机本地存衣橱/参考图)
               → Key 存 App 本地(设置页填 或 build 时注入)
```

**零远程服务器**，AI 照常跑，数据在手机上。已装好的依赖：`@capacitor/core`、`@capacitor/cli`、`@capacitor/android`、`@capacitor/filesystem`、`@capacitor/synapse`（HTTP 桥）。`capacitor.config.json` 已生成（`appId=com.wardrobe.app`，`webDir=dist`）。

---

## 二、在 Windows 上安装环境（你那台「其他电脑」）

### 1. 装 Node.js 22 LTS
- 下载 https://nodejs.org （选 LTS 22），安装时**勾选 "Add to PATH"**。
- 验证（重开终端）：
  ```powershell
  node -v      # 应显示 v22.x
  npm -v       # 应显示 10.x
  ```

### 2. 装 Android Studio
- 下载 https://developer.android.com/studio （Windows 版，约 1GB）。
- 安装向导里**务必勾选**：
  - ✅ Android SDK
  - ✅ Android SDK Platform
  - ⬜ Android Virtual Device（可选；用真机调试可不装，省空间）
- 默认安装到 `C:\Program Files\Android\Android Studio`。

### 3. 装 SDK 组件
- 打开 Android Studio → 右下角 **More Actions → SDK Manager**（或 Welcome 界面 Configure → SDK Manager）。
- **SDK Platforms** 标签页：勾 **Android 14 (API 34)**（或 API 35），Apply 安装。
- **SDK Tools** 标签页：勾
  - Android SDK Build-Tools
  - Android SDK Platform-Tools
  - Android SDK Command-line Tools (latest)
  - Apply 安装。

### 4. JDK 17+
- Android Studio 自带 Embedded JDK 17，无需额外装。
- 若想独立装：到 https://adoptium.net 下 Temurin 17（LTS），装好即可。

### 5. 配置环境变量（系统级）
- 此电脑 → 右键 → 属性 → 高级 → 环境变量。
- **新建系统变量**：
  - 变量名 `ANDROID_HOME`，值 `C:\Users\<你的用户名>\AppData\Local\Android\Sdk`
    （若 SDK 装在别处，填实际路径；可在 SDK Manager 里看到 "Android SDK Location"）
- 编辑 **Path**，新增两项：
  - `%ANDROID_HOME%\platform-tools`
  - `%ANDROID_HOME%\cmdline-tools\latest\bin`

### 6. 验证（重开 PowerShell）
```powershell
sdkmanager --version     # 能输出版本号即 OK
adb version              # 能输出版本号即 OK
java -version            # 应显示 17.x
```
三条都正常 = 环境就绪。

---

## 三、构建 APK（工程就绪后）

前提：代码已在这台电脑上（`git clone` 你的仓库，或用 `wardrobe-deploy.zip` 解压），且已 `npm install`。

```powershell
cd wardrobe
npm install            # 装依赖（含 Capicator）
npm run build          # 生成 dist/（前端产物）
npx cap add android    # 生成 android/ 原生工程（正常 Windows 一次成功）
npx cap sync           # 把 dist 同步进 android 工程
```

**构建 APK 两种方式：**

方式 A — 命令行：
```powershell
npx cap build android
```
产物：`android\app\build\outputs\apk\debug\app-debug.apk`

方式 B — Android Studio（推荐，可签名发布）：
```powershell
npx cap open android   # 用 Android Studio 打开工程
```
然后菜单 **Build → Generate Signed Bundle / APK → APK**，
- 没有签名密钥就点 **Create new** 生成一个（记住密码，release 上架要用）；
- 选 **release** 或 **debug**；
- 完成后在 `android\app\release\` 或 `android\app\build\outputs\apk\` 拿到 APK。

**装到手机：**
```powershell
adb install android\app\build\outputs\apk\debug\app-debug.apk
```
或把 APK 拷到手机存储，文件管理器里点击安装（需开「设置→安全→未知来源」）。

同事手机：USB 调试连上 `adb install` 即可；或你发 APK 文件给他，他点开安装。

---

## 四、路线 2 还需完成的代码改造（环境就绪后由我来做）

当前前端所有数据/AI 都走 `/api/*`（Node 后端）。路线 2 要改成 App 内本地执行，需改造：

1. **前端桥接层**：检测 `window.Capacitor` 是否存在，存在则把 `fetch('/api/...')` 改为
   - AI 类请求 → `CapacitorHttp`（原生桥，绕 CORS，直接连 DashScope）
   - 数据类请求 → `Capacitor Filesystem`（读写手机本地文件，替代服务器的 `data/` 目录）
2. **Key 管理**：Key 不再走远程 `/api/settings`，改为存 App 本地（设置页填，或 build 时写进 `assets`）。
3. **人体参考图 / 衣物图**：存手机沙盒（`Capacitor Filesystem`），不再依赖服务器磁盘。

改造后即为「零服务器、AI 可用、数据在手机」的真·App。这部分代码我在你环境装好后接着写并验证。

---

## 五、注意事项

- `android/` 是生成物，**不要 `git add` 提交它**（Capacitor 默认已忽略）。
- 本 WorkBuddy 环境里生成过一个 `android/` 残留目录，因沙箱 safe-delete 限制删不掉，**无视即可**；你机器上重新 `npx cap add android` 会生成干净版（那个 trash 权限 bug 是你机器上不会出现的）。
- 真机调试需开 **USB 调试**（设置→关于手机→连点版本号 7 次→返回→系统→开发者选项→USB 调试）；嫌麻烦就直接用同事手机 `adb install` 或传 APK 文件。
- 免费分发：debug APK 可直接发给同事安装；若要上架应用商店，需签名 release + 走商店审核（非必须）。
