# DotAbyssHook-frida

《ドットアビスX》FANZA Android 版的非官方繁體中文翻譯 Hook。

## 下載

### [前往 Releases 下載最新版 APK](../../releases/latest)

請在最新版 Release 的 **Assets** 區域下載 `DotAbyssX-R18-zh-Hant.apk`。APK 不會提交進 Git 原始碼；每個版本會以 GitHub Release 附件提供。

## 安裝

1. 先綁定遊戲帳號並備份資料。
2. 移除手機上的官方 FANZA 版。由於漢化版使用不同簽章，無法直接覆蓋官方版。
3. 從 [Releases](../../releases) 下載 APK，允許瀏覽器或檔案管理器「安裝未知的應用程式」後安裝。

官方遊戲更新後，舊漢化 APK 可能無法繼續使用，請回到 Releases 下載對應的新版本。

## 目前狀態

- 已於官方 FANZA 版 `1.7.0` 實機驗證 UI、角色名、靜態標籤、劇情與中文字型。
- 支援官方 arm64 APK，以及包含 arm64 split 的 XAPK。

## 從原始碼建置

### 前置需求

- Node.js 20 或相容版本
- Python 3
- Java JDK（包含 `java`、`keytool`）
- Android SDK Build Tools（`aapt`、`zipalign`、`apksigner`）
- apktool
- arm64 Frida Gadget
- 與遊戲 Unity 版本相容的中文字型 AssetBundle

安裝 Node.js 與 Python 套件：

```powershell
npm install
python -m pip install -r requirements.txt
```

把必要的本機檔案放到以下位置：

```text
frida/gadget-android-arm64.so
frida/libgadget.config.so
tools/apktool.jar
res/ttcuyuanj
```

翻譯資料夾可透過 `DOTABYSS_TRANSLATIONS` 指定；資料夾內必須包含 `static/zh_Hant.json` 等翻譯檔：

```powershell
$env:DOTABYSS_TRANSLATIONS = "C:\path\to\dotabyss-translation-client-version-s88037zz"
```

### 建置最新版

不指定輸入時，建置器會從 DMM API 取得最新 FANZA 年齡限制版 APK：

```powershell
python build.py
```

也可使用已下載的官方 APK 或 XAPK：

```powershell
python build.py --input C:\path\to\DotAbyssX-R18.apk
python build.py --input C:\path\to\DotAbyssX-R18.xapk
```

輸出位置：

```text
dist/DotAbyssX-R18-zh-Hant.apk
dist/DotAbyssX-R18-zh-Hant.xapk
```

若只更新翻譯或 Hook，且官方遊戲版本沒有變更，可快速重新注入：

```powershell
python build.py --reinject
```

建置器會檢查套件名稱、arm64 架構及官方版本，接著執行 apktool 重封裝、Frida Gadget 注入、`zipalign` 與 `apksigner` 簽署。更完整的維護步驟請參閱 [`更新流程.md`](更新流程.md)。

## 專案結構

```text
src/                 Frida／TypeScript Hook 原始碼
tools/               翻譯產生器與本機建置工具
frida/               Gadget 設定與本機 Gadget 二進位檔
res/                 中文字型 AssetBundle
apk/                 官方輸入 APK（不提交）
dist/                建置輸出（不提交）
build.py             APK／XAPK 建置與簽署腳本
```