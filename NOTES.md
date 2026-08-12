# 工作筆記（給維護者／後續 session 讀）

> **日常更新流程請看 `更新流程.md`**，本檔只記技術細節與踩過的坑。
>
> 字型：`res/ttcuyuanj`（Unity 6000.3.8f1，與遊戲相符）。
> 使用者已確認該字型由 Unity 提供、可自由使用。
> `res/notosanscjktc` 是 Unity 2021.3.25f1、來自 TSKHook，**不能用**——
> 版本不合會讓文字渲染成空白（不是方框），詳見五之三。

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
  （`tools/generate-embedded-translations.mjs` → `src/embedded-translations.ts`，約 17 MB），
  因為這遊戲啟動時要求日本 VPN、之後又必須斷線，網路請求會在斷線瞬間中斷。

## 二、字典結構

`dist/translation-upstream/dotabyss-translation-client-version-s88037zz/`

- `static/`、`ui_texts/`、`names/`、`other/*`、`add-on/*` → 扁平 `{日文: 中文}`
- `novels_*_all/` → **巢狀** `{劇情ID: {日文: 中文}}`，`flatten()` 會遞迴攤平
- 換行在字典裡是 `<br>`，全形空白是 `　`
- 攤平後共 **87264** 筆

## 三、實機現況（2026-08-11）

裝置：OPPO CPH2695 / Android 15，已安裝 `dist/DotAbyssX-R18-zh-Hant.apk`（1.7.0）。

**會翻譯的**：角色名、稱號、技能／能力說明、對話框按鈕（取消／播放）、
道具名樣板（`ランク4のコモン ウィンドマント` → `普通風之披風 Rank4`）。

**不會翻譯的**：畫面上的靜態標籤 —
`パラメータ`、`レベルアップ`、`アビリティ強化`、`ホーム`、`パーティ`、`ショップ`、
`ガチャ`、`クエスト`、`お気に入り登録`、`表示切替`、`キャンペーン`、`コスチューム`、
`スキル`、`チャージ`、`所持`、`プロフィール`、`贈る`…

## 四、靜態標籤為什麼沒翻（根因）

這些字串**字典裡全都有**（已用 `probe.py` 驗證：`パラメータ`→`參數`、
`ホーム`→`首頁`、`ガチャ`→`轉蛋`、`お気に入り登録`→`登錄最愛`…）。
沒生效的原因有兩個，都在 `src/index.ts`：

1. **它們不走 `set_text`。** prefab 上的固定標籤是 Unity 反序列化直接寫進
   `m_text` 欄位的，屬性 setter 從來不會被呼叫，所以 setter hook 抓不到。
   唯一能補的是掃描場上活著的 text component（`Il2Cpp.gc.choose`）。

2. **既有的掃描只跑一次，而且寫回原文。**
   `refreshExistingTexts()` 算出 `next` 之後，卻呼叫
   `set_text.invoke(Il2Cpp.string(current.content))` —— 傳的是**原文**。
   在 frida-il2cpp-bridge 裡，`.implementation` 內／外用 `.invoke()` 走的是
   **原始實作**（TSK 的 `this.method('OnEnable').invoke()` 也是靠這個語意才不會無限遞迴），
   所以這行等於把日文原封不動寫回去，整個 refresh 是空轉。
   而且它只在翻譯載入完成時跑一次（開場約 40 秒，還停在標題畫面），
   之後開的每一個畫面都掃不到。

→ 修法：把寫回值改成 `next`，並改用 **`OnEnable` hook**（不是週期性掃描，原因見下節）。

## 四之二、🩸 不要用 `Il2Cpp.gc.choose` 做週期性掃描（2026-08-11 事故）

我第一版的修法是每 1.5 秒跑一次 `refreshExistingTexts()`。**這會把遊戲整個卡死。**

`Il2Cpp.gc.choose` 會呼叫 `il2cpp_gc_disable()` 並在持有 allocation lock 的狀態下走一次
heap。實測單次成本隨 UI 元件增加而爆炸：

```
14:34:41 text refresh embedded-complete #1; scanned=31; matched=7;  81ms
14:34:49 text refresh periodic          #6; scanned=39; matched=1;  72ms
14:35:16 text refresh periodic         #24; scanned=72; matched=6; 406ms   ← 然後就沒有下一筆了
```

兩次實測（我自動跑一次、使用者手動跑一次）都在掃描迴圈啟動後約 **40 秒**整個
process 凍結：

```
SurfaceView[...UnityPlayerActivity] didn't commit buffer within 3000ms
ANR ... Reason: Input dispatching timed out ... Waited 5001ms for MotionEvent
Killing <pid> (adj 0): user request after error
```

注意 ANR 的觸發者是**觸控**，但觸控只是把已經死掉的狀態揭露出來——畫面在被點之前
就已經停止更新，連 Frida 執行緒自己的 log 也一起停了。

這台是 Android 15，log 開頭寫著 `Using generational CollectorTypeCMC GC`——**會搬移
物件的** concurrent mark-compact 收集器。從 Frida 執行緒反覆鎖住配置、又跨執行緒
呼叫 `set_text`，撐不過去。改動前的版本（只在啟動時掃一次）可以正常玩到主畫面。

**結論**：`gc.choose` 只能在啟動時跑**一次**當作補掃，絕對不要放進計時器。
要抓後續畫面的靜態標籤，用 `OnEnable` hook——它由 Unity 自己的執行緒呼叫，
閒置時零成本。

## 五、劇情文字沒翻（2026-08-11 已用實機資料確認）

**結論：遊戲是「一個字一個 TMP_Text」在畫劇情文字。** 不是前綴漸增，是逐字拆開。

實機 logcat（`dist/run4-logcat.txt`，14:46:56）：

```
UNMATCHED TMPro.TMP_Text.set_text :: "き"
UNMATCHED TMPro.TMP_Text.set_text :: "ゃ"
UNMATCHED TMPro.TMP_Text.set_text :: "あ"
UNMATCHED TMPro.TMP_Text.set_text :: "ち"
UNMATCHED TMPro.TMP_Text.set_text :: "び"
UNMATCHED TMPro.TMP_Text.set_text :: "た"
UNMATCHED TMPro.TMP_Text.set_text :: "ぁ"
```

那正是 `きゃあ～！　ちびたぁ～～～！` 被拆成單字。所以**在 `set_text` 這一層永遠
不可能命中整句**，字典裡的 key 是整句，進來的是一個字。

→ 要翻劇情，必須往上一層攔：找決定「這一行要顯示什麼」的元件（Absf/Absl 裡的
劇情播放器），在它拿到整行時替換，而不是在 TMP 這層。這還沒做。

**這也解釋了為什麼 UI 能翻、劇情不能翻**——UI 是整串進 `set_text`，劇情是逐字。

### 同一輪撈到的其他未命中（屬於翻譯資料缺口，不是程式問題）

```
"真夏の直感"                                    技能名，字典只有「…的最大等級提高到{0}！」
"【発動条件】通常攻撃を2回\n【効果】…"           能力描述
"「海辺のお姫様」<br>を再生します。よろしいですか？"  ← 組合式 mixed key
```

最後那條正是 `AGENTS.md`「Mixed keys are real keys」講的東西：遊戲先翻好標題、
組成整句、再查一次。要補就得把**這個組合後的完整字串**原樣存進字典。

## 五之二、劇情的 hook 點（2026-08-11 實機 dump 確認）

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

⚠️ 尚未實機驗證。已編進 `dist/DotAbyssX-R18-zh-Hant.apk`（15:13 那版），
成功時 logcat 會有 `NOVEL "日文…" -> "中文…"`。

## 五之三、字型／方框字（2026-08-11 實機 dump 確認）

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

所以可行路徑是：`System.IO.File.ReadAllBytes(persistentDataPath + "/notosanscjktc")`
→ `AssetBundle.LoadFromMemory(bytes)` → `LoadAsset("notosanscjktc SDF", typeof(TMP_FontAsset))`。
**已實測 `LoadFromMemory` 成功載入 28228663 bytes 的 bundle。**

字型檔目前是 `adb push` 到 `persistentDataPath` 的，**不在 APK 裡**：

```
adb push res/notosanscjktc /storage/emulated/0/Android/data/jp.co.fanzagames.dotabyss_x_a/files/notosanscjktc
```

正式版要自帶的話得另想辦法（APK 內的 assets 不能用 `File.ReadAllBytes` 讀，
`dataPath` 指向的是 base.apk 檔案本身）。一個可行方向是把字型以 **STORED（不壓縮）**
放進 APK，再由 hook 自己解析 zip central directory 取 bytes——不需要 inflate。

### 🩸 字型探測目前是**關閉**的（2026-08-11 17:27 實測失敗）

在 `set_text` 裡跑字型載入的那一版，遊戲開機就黑畫面。logcat：

```
FONTPROBE LOADED via LoadFromMemory
FONTPROBE FAILED: Error: breakpoint triggered          ← LoadAsset 原生層爆掉
text refresh embedded-complete #1; scanned=31; matched=7; 2806ms   ← 原本只要 80ms
```

兩個問題：

1. `LoadAsset(String, Type)` 用 `klass.type.object` 當 `typeof(T)` 傳進去會觸發
   原生錯誤（`breakpoint triggered`），還沒找到正確傳法。
2. 光是讓那包 28 MB bundle 常駐，就把啟動時那次一次性 `gc.choose` 補掃
   從 **80ms 拖到 2806ms**——heap 變大，掃描成本跟著漲。這也再次印證四之二。

`fontProbe()` 現在只留定義、**沒有任何呼叫點**。要重做的話，
**不要放在啟動路徑上**，也不要放在 `set_text` 裡。

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

```
FONT FAILED: Error: access violation accessing 0x0
```

那是**靜態**屬性，底層讀 `TMP_Settings.instance`，而這遊戲沒有內建 TMP_Settings
資產 → instance 是 null。**改走每個 `TMP_FontAsset` 自己的
`fallbackFontAssetTable`**，字型從元件的 `get_font()` 拿。

加完 fallback 要呼叫 `font.ClearFallbackCharacterTable()`，
否則 TMP 快取的「這個字找不到」結果會讓已判定成方框的字一直是方框。

⚠️ **不要直接 `set_font` 換掉元件字型**，那會連遊戲的描邊樣式一起換掉。
`hookTextSetter` 裡原本就有一段 `set_font(selectedFont)`，在 `tmpFont` 永遠是 null
的年代它是死的；一旦字型真的載入成功，它會**把每個元件的字型整包換掉**。
已改成呼叫 `applyFont()` → `patchFontFallback()`。
正解是加進 TMP 的 **fallback 表**（只有主圖集缺字時才會用到），
但 `TMP_Settings` / `TMP_FontAsset` 的 fallback API 還沒 dump 到，
15:13 那版有加 `TMPAPI` 探測，跑一次就會印出來。

## 五之四、🩸 三次凍結，三個不同原因（都是我造成的）

| # | 原因 | 症狀 | 教訓 |
|---|---|---|---|
| 1 | 每 1.5 秒 `Il2Cpp.gc.choose` 掃描 | 迴圈啟動後約 40 秒 ANR | GC 掃描只能一次性，見四之二 |
| 2 | override 用 `eval()` 吃 frida bundle | SyntaxError → 靜靜跑回舊腳本 | 見第七節 |
| 3 | 在 hook 裡跑 `image.classes` | 主執行緒卡死數分鐘、**完全無輸出** | 見下 |

第三個：`frida-il2cpp-bridge` 的 `image.classes` 會**把整個 image 的類別全部
具現化成 JS 物件**。`Absf` 大到在 render thread 上做這件事會卡好幾分鐘，
畫面全黑、logcat 一行都沒有。**永遠不要在 hook 裡列舉 `image.classes`**，
要什麼類別就用 `image.class("完整名稱")` 直接查。

會「完全無輸出」還有第二層原因：`failFont()` 當時只有 `console.error` 和 `send()`，
兩個在 script 模式都送不出去，例外就這樣人間蒸發。**現在已加 nativeLog。**

## 五之四之二、🩸 跨專案抄 hook 前，一定要先 dump 目標的方法簽章

2026-08-12。我把 anosu/DMM-Mod 的 `disableVoiceInterruption()` 照抄過來，
沒查證簽章就上機 → **劇情語音整個消失，播一段後跳錯誤**。

從裝置 dump 出來的實際簽章：

```
PlaySound(Absf.SoundCategory category, System.String cueSheetName,
          System.String cueId, System.Single playbackVolume, System.Boolean loop)
          -> Absf.Cri.ICriSoundPlayback
StopCategory(System.Int32 nCategory, System.Boolean playFade) -> System.Void
```

**`PlaySound` 有五個參數，我當成一個在轉發**，後面四個（cue 名稱、cue ID、
音量、循環旗標）全是垃圾值。這才是聲音消失的原因。

順帶一提，我當時「推測」是 `StopCategory` 的回傳值被吞掉 —— **推測是錯的**，
它本來就是 `void`。這也是為什麼要 dump 而不是推理。

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

## 五之五、工具坑：`Select-String` 在這個檔案上會給假陰性

`dist/libgadget.js.so` 是 33 MB 而且幾乎是單行。PowerShell 的
`Select-String -SimpleMatch` 對它會**漏報**（實測 `NovelArgument.SetString` 明明在
檔案裡卻回報找不到，改用 ripgrep 一查有 5 處）。驗證 bundle 內容一律用 ripgrep。

## 六、技能名缺翻譯（非程式問題）

`灼熱サマー`、`海辺の焼き入れ`、`真夏の直感` 在字典裡只有
「"…"的最大等級提高到{0}！」這種句子，沒有單獨的名稱條目。
這是上游翻譯資料的缺口，要回 `Dot-abyess-Lienchu-version` 補。

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

## 九、啟動儀式（每次開遊戲都要）

見 README「手機實測重啟流程」。重點：Planet VPN 連 `Japan - Osaka` →
等畫面顯示 `You are protected` → 開遊戲 → 等紫色 `LOADING` 出現後 8～11 秒、
且還沒到 `GAME START` 時，從通知列按 `Disconnect`。
