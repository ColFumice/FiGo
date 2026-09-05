---
name: "figo-android-build"
description: "Builds and installs the FiGo Cocos Creator 3.8.8 Android game (cocos build -> targetSdk patch -> gradle assembleRelease -> adb install -r). Invoke whenever FiGo scripts/assets changed and a new APK must be deployed to the Lenovo ZUI tablet."
---

# FiGo Android 构建部署（本工程专用）

工程根目录：`d:\Project\A_New_Begin\FiGo`（Cocos Creator 3.8.8，竖屏 1840×2944，包名 com.figo.game，
设备：联想 ZUI 平板，adb 设备号 HA1W3W84）。

**用户要求：只负责构建并 `adb install -r` 安装到平板，不做截图/实测验证（用户自测）。**
但崩溃类问题可用 logcat 抓栈定位（用户认可这种诊断方式）。

## 构建链路（严格按序，PowerShell）

### 1. Cocos 构建
```powershell
$env:JAVA_HOME="D:\JDK17\jdk"
& "C:\ProgramData\cocos\editors\Creator\3.8.8\CocosCreator.exe" --project "d:\Project\A_New_Begin\FiGo" --build "platform=android;debug=false;configPath=d:\Project\A_New_Begin\FiGo\build_config.json"
```
- CLI 返回的退出码可能为空（编辑器进程分离），不要据此判断；以产物时间戳和下一步 gradle 成功为准。
- 产物 JS bundle：`build\android\data\assets\main\index.js`。

### 2. 必做：把 targetSdk 改回 34
每次 Cocos 构建都会把 `build\android\proj\gradle.properties` 重写为
`PROP_TARGET_SDK_VERSION=36`，必须在 gradle 前改回 **34**（Android 15/16 edge-to-edge 兼容问题）：
```powershell
$p = "d:\Project\A_New_Begin\FiGo\build\android\proj\gradle.properties"
(Get-Content $p) -replace 'PROP_TARGET_SDK_VERSION=36','PROP_TARGET_SDK_VERSION=34' | Set-Content $p -Encoding ascii
```
gradle 构建后记得检查用户在 IDE 打开了该文件时的状态无关紧要，以文件内容为准。

### 3. Gradle 打包（约 14s）
```powershell
$env:PATH="D:\JDK17\jdk\bin;$env:PATH"; $env:JAVA_HOME="D:\JDK17\jdk"
Set-Location "d:\Project\A_New_Begin\FiGo\build\android\proj"
.\gradlew.bat assembleRelease --no-daemon
```
- 必须用 D:\JDK17\jdk；Android Studio 自带 jbr 是 Java 25，Gradle 8.11.1 不兼容。
- 看到 `BUILD SUCCESSFUL` 即成功。

### 4. 安装到平板
```powershell
& "D:\Android_SDK\platform-tools\adb.exe" devices   # 确认 HA1W3W84 device 在线
& "D:\Android_SDK\platform-tools\adb.exe" install -r "d:\Project\A_New_Begin\FiGo\build\android\proj\build\FiGo\outputs\apk\release\FiGo-release.apk"
```
- `no devices/emulators found` → 平板未连接/USB 调试未就绪，让用户检查后重试（先 devices 再 install）。
- 输出 `Success` 即完成，告知用户可自测。

## 源码编辑防回退校验（本项目多次出现 Edit 报成功但改动丢失）

构建前用 Grep 复核关键改动行仍在 `assets\scripts\` 源码中；
构建后用 bundle 校验进包（release bundle 会压缩枚举字符串，按实际特征判断）：
```powershell
$raw = Get-Content -Raw "d:\Project\A_New_Begin\FiGo\build\android\data\assets\main\index.js"
$raw.Contains("persistGfx")   # 例：检查特征标识是否进包
```

## 崩溃诊断（仅当用户报告闪退时）

原生崩溃抓 crash 缓冲区，可符号化栈帧（RelWithDebInfo 的 libcocos.so 保留符号）：
```powershell
& "D:\Android_SDK\platform-tools\adb.exe" logcat -b crash -d -t 50
# 符号化（地址取自 backtrace pc 值）：
$sym = "D:\Android_SDK\ndk\23.2.8568313\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-symbolizer.exe"
$so  = "D:\Project\A_New_Begin\FiGo\build\android\proj\build\FiGo\intermediates\cxx\RelWithDebInfo\5te30711\obj\arm64-v8a\libcocos.so"
& $sym -e $so 0x<pc>
```
JS 异常在 release 不弹窗；logcat 主缓冲区过滤 `Cocos|JS:` 可见 `Cocos [ERROR]: JS: ...`。

## 已知本项目坑（改代码时避免重复踩）

- 原生端 cc.Graphics：几何仅在 fill()/stroke() 时上传；节点（含祖先面板）active=false→true 后
  原生 draw info 被清空不恢复 → 用 `Node.EventType.ACTIVE_CHANGED`（回调 `(node, active)`，
  递归激活时派发到子树每个节点）监听重绘；**ACTIVE_IN_HIERARCHY_CHANGED 只从被切 active 的根节点发出，子节点收不到**。
  统一用 FigoGame.persistGfx / BoardView.newGfxNode(repaint)。
- 同一节点只能有一个 UIRenderer（Graphics/Sprite/Label 三选一）；RenderEntity 存于 node.userData 单槽。
  **cc.EditBox.onEnable 会自动给自身节点 addComponent(Sprite)**（_ensureBackgroundSprite），
  与同节点 Graphics 冲突会导致原生 SIGSEGV（静态实体被误读为动态 vector）；
  EditBox 的背景 Graphics 必须放独立子节点。
- cc.Graphics 无 arc()/closePath()；圆角用 quadraticCurveTo。
- UIOpacity 挂 Graphics 节点会致不渲染；透明动画用 tween 纯对象 + onUpdate 改 color alpha。
- 不要 `import { Tween } from 'cc'`（release 包曾崩溃且 logcat 无文本）；保存 `.start()` 返回的 tween 实例调 `.stop()`。
- 设计分辨率 FIXED_HEIGHT=1280，平板 designW≈800；坐标 y=415 等为设计单位。
