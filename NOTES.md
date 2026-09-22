# 工作筆記（給維護者／後續 session 讀）

> **日常更新流程請看 `更新流程.md`**，本檔只記技術細節與踩過的坑。
>
> 字型：`res/ttcuyuanj`（Unity 6000.3.8f1，與遊戲相符）。
> 使用者已確認該字型由 Unity 提供、可自由使用。
> `res/notosanscjktc` 是 Unity 2021.3.25f1、來自 TSKHook，**不能用**——
> 版本不合會讓文字渲染成空白（不是方框），詳見第五節。

## 〇、本機工具版本（2026-09-13 換機後重裝）

換機時這些全都不在 git 裡，得自己補。版本記在這裡，免得下次又要試。

| 工具 | 版本 | 位置 |
| --- | --- | --- |
| Frida Gadget | **17.18.0** android-arm64 | `frida/gadget-android-arm64.so` |
| apktool | **2.12.1** | `tools/apktool.jar` |
| JDK | Temurin 21.0.12.1+1 | `D:/TWSK/tools/jdk-21`（`JAVA_HOME`）|
| Android Build Tools | 34.0.0 | `D:/TWSK/tools/android-sdk`（`ANDROID_HOME`）|
| platform-tools | adb 1.0.41 | 同上的 `platform-tools/`，已在 PATH |
| gh | 2.100.0 | `D:/TWSK/tools/gh/bin` |

Gadget 選 17.x 是因為 `frida-il2cpp-bridge` 0.12.2 與 `@types/frida-gum` ^19 對應的是
Frida 17 的 gum API；換大版號要連著這兩個一起看。

apktool 停在 **2.x 線**（最新的 2.12.1），不是當時已經發布的 3.0.3。這專案出貨過的
APK 都是 2.x 編的，而 apktool 大版號會動到資源 round-trip 的行為——本檔第九節那個
「Windows 大小寫不敏感吃掉 res/ 檔案」的修補正是針對 2.x 的行為寫的。要升 3.x
請當成一次獨立的、需要實機驗證的改動，不要在補裝環境時順手換掉。

Build Tools 的 zip 解開來叫 `android-14`，**必須改名成 `34.0.0`**：
`build.py` 的 `latest_build_tools()` 用 `\d+(?:\.\d+)+` 比對資料夾名，
不合就整個略過、退回去找 PATH 上的 `aapt`，然後報「missing required tool」。

**簽章金鑰（2026-09-13 換過一次）。** 原本的 `dotabyss.keystore` 在換機時遺失、無法重建，
於是用新金鑰重編 v1.10.1。兩把的憑證 SHA-256：

| | 憑證 SHA-256 |
| --- | --- |
| 現行（2026-09-13 起） | `AD:8F:85:14:26:1D:9D:15:17:50:A0:F8:A0:37:00:36:A7:03:B8:48:8B:C4:01:B8:7F:5F:2F:EA:AE:93:C4:26` |
| 舊（已遺失，2026-09-13 以前發的版本） | `5E:A9:75:1B:93:70:03:55:63:B5:10:A2:1D:52:43:65:E2:26:D1:AC:68:82:2D:D2:DD:0B:B0:28:3B:DA:0E:95` |

舊金鑰簽的 APK 無法被新版覆蓋更新。舊指紋是從舊 v1.10.1 release 的 APK 讀出來的；
萬一哪天找回舊 keystore，用它就能認出是不是那一把。

---

## 一、TSK 與 DotAbyss 的方法差異

兩者共用同一套「把 Frida Gadget 塞進官方 APK」的骨架：

| 步驟 | TSKHook-frida | DotAbyssHook-frida |
| --- | --- | --- |
| 取得官方 APK | DMM `freeapp/705566` | DMM `freeapp/771484`（R18，`jp.co.fanzagames.dotabyss_x_a`）|
| 解包 | `apktool d -f -r` | 同（`tools/apktool.jar`）|
| 注入 | `lib/arm64-v8a/libgadget{.so,.js.so,.config.so}` | 同 |
| 啟動 gadget | patch `UnityPlayerActivity.<init>` 加 `System.loadLibrary("gadget")` | 同 |
| 移除 armv7 | 有 | 有 |
| 重簽 | `tsk.keystore` | `dotabyss.keystore`，另加 `zipalign` + `apksigner verify` |

真正不一樣的是**遊戲引擎**，所以 hook 內容完全重寫：

- TSK 用 **Utage** 視覺小說引擎，可以精準 hook `Utage.AdvPage.get_NameText`、
  `Utage.AdvDataManager.DownloadChaperKeyFileUsed` 等具名 API，並依章節 label 抓對應字典。
- DotAbyss 是自家 Unity 6 專案（組件 `Absf`、`Absl.*`、`Project`），沒有等價的公開 API。
  因此改用**通用 setter hook**：`TMPro.TMP_Text.set_text` 與 `UnityEngine.UI.Text.set_text`，
  對整份扁平化字典做精確 key 查表，另加 `{[VALUE]}` / `{0}` 佔位符的樣板比對。
- 翻譯資料 TSK 走 CDN 即時下載；DotAbyss 改成 **編譯期內嵌**
  （`tools/generate-embedded-translations.mjs` → `src/embedded-translations.ts`，約 18 MB），
  因為這遊戲啟動時要求日本 VPN、之後又必須斷線，網路請求會在斷線瞬間中斷。

## 二、字典結構

`../../Dot-abyess-Lienchu-version/dotabyss-translation-client-version-s88037zz/`
（相對本專案；就是 `generate-embedded-translations.mjs` 解析到的那個位置）

- `static/`、`ui_texts/`、`names/`、`other/*`、`add-on/*` → 扁平 `{日文: 中文}`
- `novels_*_all/` → **巢狀** `{劇情ID: {日文: 中文}}`，`flatten()` 會遞迴攤平
- 換行在字典裡是 `<br>`，全形空白是 `　`
- 攤平後共 **87642** 筆（2026-08-20 官方更新後）

## 三、prefab 靜態標籤為什麼要靠 `OnEnable`（已修，別改回去）

`パラメータ`、`ホーム`、`ガチャ`、`お気に入り登録` 這類畫面上的固定標籤，
**字典裡全都有**，但一度整批沒生效。兩個根因都值得記住，因為現在的寫法就是為了它們：

1. **它們不走 `set_text`。** prefab 上的固定標籤是 Unity 反序列化直接寫進
   `m_text` 欄位的，屬性 setter 從來不會被呼叫，所以 setter hook 抓不到。
   現在靠 `TMP_Text.OnEnable` hook 補——由 Unity 自己的執行緒在畫面實體化 prefab
   時呼叫，閒置時零成本。

2. **`.invoke()` 走的是原始實作。**
   當初 `refreshExistingTexts()` 算出 `next` 之後卻呼叫
   `set_text.invoke(Il2Cpp.string(current.content))`，傳的是**原文**。
   在 frida-il2cpp-bridge 裡，`.implementation` 內／外用 `.invoke()` 一律走
   **原始實作**（`this.method('OnEnable').invoke()` 也是靠這個語意才不會無限遞迴），
   所以那行等於把日文原封不動寫回去，整個 refresh 是空轉。
   **要讓翻譯生效就得傳 `next`**，這個陷阱在任何一個 hook 裡都一樣。

## 三之二、🩸 不要用 `Il2Cpp.gc.choose` 做週期性掃描（2026-08-11 事故）

每 1.5 秒跑一次 `refreshExistingTexts()` 會把遊戲整個卡死，兩次實測都在掃描迴圈啟動後
約 **40 秒** ANR 被系統殺掉。

`Il2Cpp.gc.choose` 會呼叫 `il2cpp_gc_disable()` 並在持有 allocation lock 的狀態下走一次
heap，單次成本隨 UI 元件增加而爆炸：**81ms（31 個元件）→ 406ms（72 個）**，然後就沒有
下一筆了。這台是 Android 15，用的是**會搬移物件的** `CollectorTypeCMC`；從 Frida 執行緒
反覆鎖住配置、又跨執行緒呼叫 `set_text`，撐不過去。

注意畫面在被點之前就已經停止更新（連 Frida 自己的 log 也停了），ANR 只是觸控把死掉的
狀態揭露出來——**不要因為 ANR 說是 input timeout 就去查觸控**。

**結論**：`gc.choose` 只能在啟動時跑**一次**當作補掃，絕對不要放進計時器。
要抓後續畫面的靜態標籤，用 `OnEnable` hook——它由 Unity 自己的執行緒呼叫，閒置時零成本。

## 四、劇情文字為什麼不能在 `set_text` 這層翻（已修，hook 點在 `NovelArgument.SetString`）

**遊戲是「一個字一個 TMP_Text」在畫劇情文字。** 不是前綴漸增，是逐字拆開。

實機 logcat 是一連串 `UNMATCHED TMPro.TMP_Text.set_text :: "き"` / `"ゃ"` / `"あ"`…，
正是 `きゃあ～！　ちびたぁ～～～！` 被一個字一個字送進來。所以**在 `set_text` 這一層
永遠不可能命中整句**，字典裡的 key 是整句，進來的是一個字。

→ 所以必須往上一層攔，在元件拿到整行時替換。**這也解釋了為什麼 UI 能翻、劇情不能翻**
——UI 是整串進 `set_text`，劇情是逐字。

順帶一提，同一輪撈到的
`"「海辺のお姫様」<br>を再生します。よろしいですか？"` 正是 `AGENTS.md`
「Mixed keys are real keys」講的東西：遊戲先翻好標題、組成整句、再查一次。
要補就得把**這個組合後的完整字串**原樣存進字典。

## 四之二、劇情的 hook 點：`NovelArgument.SetString`

`Absf.Novel` 就是劇情引擎。實機 dump 出來的關鍵 API：

```
Absf.Novel.NovelScriptCommands.InitCsv(System.String csv) -> System.Void
Absf.Novel.NovelCsvParser.Parse(System.String csv) -> List<List<System.String>>
Absf.Novel.NovelArgument.SetString(System.String val) -> Absf.Novel.NovelArgument
Absf.Novel.NovelArgument.GetString() -> System.String
Absf.Novel.NovelArguments.GetString(System.Int32 index, System.String defaultvalue)
```

整份劇情腳本是 **CSV 字串**，從 `InitCsv` 進來，經 `NovelCsvParser` 拆欄位，
每個欄位再進 `NovelArgument.SetString`。

**選 `NovelArgument.SetString` 當 hook 點**，理由：

- 在 CSV 解析**之後**，所以不必處理引號跳脫（在 `InitCsv` 動手要自己處理 CSV 引號，
  譯文含逗號就會炸）
- 在逐字拆解**之前**，整句還完整
- 每個欄位只在載入時呼叫一次，不是每幀

已實機驗證並長期運作中。logcat 開機時應有 `hooked Absf.Novel.NovelArgument.SetString`。

## 四之三、🩸 字典裡的「單字 key」會在劇情裡炸開（2026-09-22 修）

第四節說「劇情逐字進 `set_text`，所以永遠不可能命中」——**那句話有例外**。
逐字進來的是**已經翻好的中文**，而字典裡真的有長度為 1 的 key，於是命中了。

**而且逐字渲染不只有劇情。** 2026-09-22 使用者第二張截圖是**主畫面的角色語音對白**
（`m_part_voices/text` 那一類，城鎮背景、沒有 AUTO／SKIP），`拳` 一樣疊成上下兩層。
所以判斷「這裡會不會踩到」不能用「是不是 Absf.Novel」，要用「字串長度是不是 1」。

實例（使用者回報的畫面）：`人家絕～對會徹底掌握傳說中的法杖！！`
渲染成 `…傳說中的法[空格]！！`，而 `法` 浮在那個空格上方、`杖` 浮在下方。

原因：`static/zh_Hant.json` 的 `m_jobs/name` 有 `"杖": "法杖"`。
劇情把 `杖` 這一個字送進一個**一個字寬**的 TMP_Text，hook 換成兩個字，
TMP 折行成兩行，垂直置中 → 第一行在上、第二行在下，中間那格看起來是空的。

對著出貨資料數過，會踩到的單字 key 與劇情中出現次數：

| key | 值 | 劇情中出現 |
|---|---|---|
| `杖` | `法杖` | 222 次 / 59 篇 |
| `拳` | `拳套` | 80 次 / 53 篇 |
| `豆` | `豆子` | 11 次 / 9 篇 |
| `虫` | `蟲子` | 0 |
| `円` | `日圓` | 0 |
| `銃` | `槍` | 0（長度不變，無害）|
| `猫` | `貓` | 0（長度不變，無害）|

**修法**：`translated()` 開頭攔截 `text.length === 1`，只放行「換完還是一個字」的
替換（`銃→槍`、`猫→貓` 撐不破格子，而且在劇情裡本來就是正確的繁中）。
代價是 UI 的兵種標籤顯示「杖」「拳」而不是「法杖」「拳套」——兩者都讀得通。

**不要改回去用「白名單特定字」**：這條是通則，日後 masterdata 再加任何單字 key
都會自動被擋住；列舉法只會在下一次改版又漏掉。

**守門有效的時候完全看不出來，所以兩個地方都會把它擋下來的 key 唸出來**——
不然下一個人（或下一個我）會把它當成沒用的程式碼刪掉：

- `npm run build` 會印 `single-char keys suppressed at runtime (N)`，
  一行一個 key，附「在出貨劇情文字裡出現幾次」。新的危險 key 一進 masterdata 就看得到，
  不必等玩家傳截圖。
- 開機 logcat 會印 `single-char keys suppressed (N): 杖->法杖 拳->拳套 …`。
  要判斷「手上這包 APK 有沒有帶修正」就看這一行。

**也不要反過來去改劇情那一句**。畫面上疊在一起的是 `static/` 的 key 造成的，
改劇情譯文只會讓同一個字在別的 53 篇裡繼續疊。

**PC 版沒有這個問題**，所以別拿 Windows 端的行為來推翻這節：`AbyssStaticFix` 是直接
改寫 masterdata，`static/` 在那邊不會變成執行期查表。這是 Android 專有的失效模式。

## 五、字型／方框字（2026-08-11 實機 dump 確認）

方框字的原因：遊戲的 TMP 圖集是為**日文**建的，中日共用漢字都在，
**中文特有字不在**。實例：`讓我見識一下□的本事□！`，字典原文是
`讓我見識一下妳的本事。`，缺的是 `妳`。字典裡這類字量很大：
`這` 19934、`麼` 11552、`你` 9320、`吧` 7112、`嗎` 6717、`妳` 2349。

實機探測結果：

```
FONTPROBE dataPath=/data/app/~~xxx/…/base.apk          ← APK 本身，不是目錄
FONTPROBE persistentDataPath=/storage/emulated/0/Android/data/<pkg>/files
FONTPROBE streamingAssetsPath=jar:file:///…/base.apk!/assets
```

**這個 build 完全沒有同步的 `AssetBundle.LoadFromFile`**——IL2CPP 把遊戲沒用到的
overload 剝掉了。只剩：

```
LoadFromFileAsync(System.String)             ← 非同步
LoadFromMemory(System.Byte[])                ← 同步，可用 ✅
LoadAsset(System.String, System.Type)        ← 同步，可用 ✅
GetAllAssetNames                             ← 已被剝掉 ❌
```

所以走的路徑是：`File.ReadAllBytes` → `AssetBundle.LoadFromMemory(bytes)`
→ 單參數版 `LoadAsset("<bundle 名> SDF")`。
（`LoadAsset(String, Type)` 用 `klass.type.object` 當 `typeof(T)` 傳進去會觸發原生
`breakpoint triggered`，所以刻意用單參數多載。）

**字型現在隨 APK 出貨**：`res/ttcuyuanj` 在完整重建時被複製到
`assets/bin/Data/Managed/`，Unity 第一次啟動會把它解到 `persistentDataPath/il2cpp/`，
hook 就從那裡讀。找不到時會退去找 `.../files/<name>`，所以開發期 `adb push` 一份到
後者也能蓋過去。成功時 logcat 印
`FONT OK: "TTCuYuanJ SDF" from ttcuyuanj added to TMP fallbacks`。

⚠️ 這條路徑只有**完整重建**才會進 APK，`--reinject` 不碰 assets。

### 🩸 別把字型載入放在啟動路徑或 `set_text` 裡

早期在 `set_text` 裡載字型的那一版，遊戲開機就黑畫面：光是讓那包 28 MB bundle
常駐，就把啟動時那次一次性 `gc.choose` 補掃從 **80ms 拖到 2806ms**——heap 變大，
掃描成本跟著漲。這再次印證三之二。

### 🩸 移動式 GC：**絕對不要跨呼叫保存 `Il2Cpp.Object`**

```
FONT FAILED at get_isDone: Error: access violation accessing 0x6ff5f50818
```

我把 `LoadFromFileAsync` 回傳的 `AssetBundleCreateRequest` 存進變數、下次
`set_text` 再拿出來用 —— 但 Android 15 的 `CollectorTypeCMC` **會搬移物件**，
存下來的指標下一幀就失效。

**正解**：用 `obj.ref(false)` 取得 `Il2Cpp.GCHandle`，之後一律走 `handle.target`
重新解析位址；用完 `handle.free()`。

同理，**不能拿 `obj.handle.toString()` 當 Map/Set 的 key**——位址會變。
要用穩定的東西，例如 `get_name()`。

### 🩸 `TMP_Settings.fallbackFontAssets` 在這款遊戲上會 null deref

那是**靜態**屬性，底層讀 `TMP_Settings.instance`，而這遊戲沒有內建 TMP_Settings 資產
→ instance 是 null（`access violation accessing 0x0`）。**改走每個 `TMP_FontAsset`
自己的 `fallbackFontAssetTable`**，字型從元件的 `get_font()` 拿。

加完 fallback 要呼叫 `font.ClearFallbackCharacterTable()`，否則 TMP 快取的
「這個字找不到」結果會讓已判定成方框的字一直是方框。

⚠️ **不要直接 `set_font` 換掉元件字型**，那會連遊戲的描邊樣式一起換掉。正解是加進
fallback 表（只有主圖集缺字時才會用到），也就是現在的 `applyFont()` → `patchFontFallback()`。

## 六、🩸 三次凍結，三個不同原因（都是我造成的）

| # | 原因 | 症狀 | 教訓 |
|---|---|---|---|
| 1 | 每 1.5 秒 `Il2Cpp.gc.choose` 掃描 | 迴圈啟動後約 40 秒 ANR | GC 掃描只能一次性，見三之二 |
| 2 | override 用 `eval()` 吃 frida bundle | SyntaxError → 靜靜跑回舊腳本 | 見第七節 |
| 3 | 在 hook 裡跑 `image.classes` | 主執行緒卡死數分鐘、**完全無輸出** | 見下 |

第三個：`frida-il2cpp-bridge` 的 `image.classes` 會**把整個 image 的類別全部
具現化成 JS 物件**。`Absf` 大到在 render thread 上做這件事會卡好幾分鐘，
畫面全黑、logcat 一行都沒有。**永遠不要在 hook 裡列舉 `image.classes`**，
要什麼類別就用 `image.class("完整名稱")` 直接查。

會「完全無輸出」還有第二層原因：`failFont()` 當時只有 `console.error` 和 `send()`，
兩個在 script 模式都送不出去，例外就這樣人間蒸發。**現在已加 nativeLog。**

## 六之二、🩸 跨專案抄 hook 前，一定要先 dump 目標的方法簽章

2026-08-12。我把 anosu/DMM-Mod 的 `disableVoiceInterruption()` 照抄過來，
沒查證簽章就上機 → **劇情語音整個消失，播一段後跳錯誤**。

從裝置 dump 出來的實際簽章：

```
PlaySound(Absf.SoundCategory category, System.String cueSheetName,
          System.String cueId, System.Single playbackVolume, System.Boolean loop)
          -> Absf.Cri.ICriSoundPlayback
StopCategory(System.Int32 nCategory, System.Boolean playFade) -> System.Void
```

**`PlaySound` 有五個參數，抄來的版本當成一個在轉發**，後面四個全是垃圾值——
這才是聲音消失的原因。（當時還「推測」問題出在 `StopCategory` 的回傳值被吞掉，
但它本來就是 `void`。這就是為什麼要 dump 而不是推理。）

參考專案的程式碼可以借「作法」，但**簽章一定要對目標自己驗**：
兩個遊戲即使系出同源，方法多載也可能不同。

現在 `hookVoiceInterruption()` 的寫法：

- 用 `klass.method(name, 參數數量)` 指定多載，不靠猜
- 五個參數原封不動全部轉發
- Voice 分類同時接受字串 `"Voice"` 與數值 `2`（IL2CPP 列舉在 JS 端的樣子還沒確認，
  所以兩種都收，並印出前三次實際值）
- **失敗即放棄**：hook 內任何例外都會設 `voiceSuppressionOff`、之後一律走原始行為。
  寧可功能不生效，也不要弄壞遊戲既有行為。

### 附帶：logcat 緩衝區預設不夠大

這遊戲的 log 量大到預設緩衝區只留得住**約 90 秒**，開機時印的
`injector started` / `hooked …` / `SNDAPI …` 會在你查詢前就被沖掉。
診斷開機階段前先跑：

```bash
adb logcat -G 32M
```

## 六之三、工具坑：`Select-String` 在這個檔案上會給假陰性

`dist/libgadget.js.so` 是 33 MB 而且幾乎是單行。PowerShell 的
`Select-String -SimpleMatch` 對它會**漏報**（實測 `NovelArgument.SetString` 明明在
檔案裡卻回報找不到，改用 ripgrep 一查有 5 處）。驗證 bundle 內容一律用 ripgrep。

## 七、開發迴圈

重建一次 APK 要重打包 230 MB 再讓使用者手動安裝，太慢。
已確認 `adb` 可以寫入 `/storage/emulated/0/Android/data/jp.co.fanzagames.dotabyss_x_a/files/`
（實測 `WRITE_OK`），所以內嵌腳本啟動時會先找該目錄下的
`dotabyss-hook.js`，有就改跑它。之後迭代只要：

```
npm run build
adb push dist/libgadget.js.so /storage/emulated/0/Android/data/jp.co.fanzagames.dotabyss_x_a/files/dotabyss-hook.js
```

再重開遊戲即可，不必重包 APK。刪掉該檔就回到內嵌版本。

### 🩸 override 的坑：frida-compile 產的不是純 JS

`dist/libgadget.js.so` 開頭是 `f0 9f 93 a6`（📦），格式是 Frida bundle：

```
📦
33198341 /src/index.js
✄
<實際的 JS>
```

gadget 自己的載入器看得懂，**但 `eval()` 看不懂**，會丟 `SyntaxError: unexpected character`。
第一版的 override 就是直接 `eval(raw)`，於是每次都失敗、靜靜地退回內嵌腳本——
結果是「我以為修好推上去了，實際上跑的還是舊的壞腳本」，白白浪費一整輪實測。
現在 `readOverrideSource()` 會剝掉 bundle 標頭，而且失敗時印
`OVERRIDE FAILED ... running EMBEDDED script`（大寫，好 grep）。

**教訓**：任何「安靜退回舊版」的後備路徑都必須大聲喊出來，否則它會偽裝成成功。
每次推 override 之後，都要先在 logcat 確認 `override script took over` 再下結論。

## 八、實機診斷指令

```
adb logcat -c
adb logcat -s DotAbyssHook:*
```

`gadget` 是 `type: script` 模式（不開 port），所以 `tools/live_attach.py`
需要另外改成 listen 模式的 config 才能用；平常診斷請直接看 logcat。

## 九、🩸 apktool 在 Windows 上弄丟大小寫衝突的資源（2026-08-12 事故）

**症狀**：別人的 Pixel 9a 一直閃退，這台 OPPO 完全正常。hook 本身沒問題，
崩潰堆疊落在 DMM Store SDK 的 Activity：`InflateException` → `Resources$NotFoundException:
File res/S0.png` → 檔案不存在。

**根因**：官方 APK 做過資源混淆（AndResGuard），`res/` 底下是 `S0.png`、`s0.png` 這種
只差大小寫的短名，在 Android 上是兩個**完全無關**的資源。apktool 把它們解到 NTFS 上，
兩個名字撞成同一個路徑，回包時只剩一個；`resources.arsc` 原封不動保留、還指著消失的
那個名字。實測掉了 **50 個檔案**（49 個碰撞組），存活的內容都是對的，所以修復純粹是補回去。

**為什麼只有他的手機掛**：`drawable/dmmgames_logo` 三個密度變體掉了兩個，只剩 xhdpi。
Pixel 9a 落在 xxhdpi 桶 → 解析到掉了的那個 → 閃退；這台是 xhdpi 桶，永遠踩不到。
**Android 不會因為「檔案不存在」就退回別的密度**——資源表查詢本身已經成功了，
它只是打不開那個檔。另外還有 26 個資源三個密度全滅（DMM 連線逾時畫面、輸入框游標等），
任何機器走到那條路徑就炸。

**修法**：`build.py` 的 `restore_lost_entries()` —— 回包後、簽名前，把「官方 APK 有、
產出沒有」的條目原封不動塞回去（排除 `META-INF/` 與刻意刪掉的 `lib/armeabi-v7a/`）。
全新建置與 `--reinject` 都會補，所以舊的壞 APK 直接 `--reinject` 一分鐘就能修好。
掉的若是 `res/` 以外的東西，它會直接 `SystemExit` 而不是默默放行。

**教訓**：「在我機器上正常」對**密度／語系／夜間模式**相關的資源問題完全沒有證明力，
因為每台機器解析到的檔案不一樣。回包後比對 zip 條目清單是零成本的，每次都該做。
