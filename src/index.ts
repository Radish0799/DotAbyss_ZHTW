import "frida-il2cpp-bridge";
import { config } from "./config.js";
import { embeddedTranslationJson } from "./embedded-translations.js";

const androidLogWrite = (() => {
    try {
        const address = Module.findGlobalExportByName("__android_log_write");
        return address
            ? new NativeFunction(address, "int", ["int", "pointer", "pointer"])
            : null;
    } catch (_) {
        return null;
    }
})();

function nativeLog(message: string) {
    try {
        if (androidLogWrite) {
            androidLogWrite(4, Memory.allocUtf8String("DotAbyssHook"), Memory.allocUtf8String(message));
        }
    } catch (_) { /* diagnostic logging must never stop the hook */ }
}

const translations: Record<string, string> = {};
type DynamicTemplate = {
    pattern: RegExp;
    target: string;
    captureByToken: Map<string, number>;
};
const dynamicTemplates: DynamicTemplate[] = [];
const dynamicTemplateBuckets: Record<string, DynamicTemplate[]> = {};
const dynamicCache: Record<string, string> = {};
let tmpFont: Il2Cpp.Object | null = null;
let legacyFont: Il2Cpp.Object | null = null;
let fontBundle: Il2Cpp.Object | null = null;
let fontLoading = false;
let probed = false;
let translationsReady = false;
let fontState: "idle" | "loading" | "ready" | "failed" = "idle";
// Android 15 runs a MOVING collector (CollectorTypeCMC), so an Il2Cpp.Object
// kept across frames dangles the moment the GC relocates it -- that is what the
// "access violation" in get_isDone was.  A GCHandle tracks the object through
// moves; always go through .target and never cache the raw pointer.
let fontRequestRef: Il2Cpp.GCHandle | null = null;
let tmpFontRef: Il2Cpp.GCHandle | null = null;
let fontStep = "start";
// Keyed by font NAME, not handle: an address is not stable under a moving GC.
const patchedFonts = new Set<string>();
let replacementLogs = 0;
let unmatchedLogs = 0;
let sweeps = 0;
let novelHits = 0;
let mosaicHidden = 0;
let mosaicLogs = 0;
let allowStopVoice = 0;
const unmatchedTexts = new Set<string>();

function log(message: string) {
    console.log(`[dotabyss-hook] ${message}`);
    nativeLog(message);
    send({ type: "dotabyss-log", message });
}

function flatten(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (typeof child === "string") {
            if (child.length > 0) translations[key] = child;
        } else {
            flatten(child);
        }
    }
}

// Masterdata wraps every computed value in braces, in three shapes:
//   {[VALUE]} / {[DURATION]秒}   symbolic
//   {0}                          .NET-style UI parameter
//   {12.5%} {15.4秒} {110%}      the value itself, one dictionary entry per level
// The game substitutes them and strips the braces before display, so the runtime
// string reads "16.2%" where the key says "{12.5%}".  Only recognising the first
// two shapes left most ability descriptions unmatched -- which is why a single
// screen could show some abilities translated and others not.
const placeholderPattern = /\{\[[^}]+\}|\{[^{}\n]{1,24}\}/g;

// A key that is almost entirely placeholder compiles to something like
// /^([\s\S]+?)上昇$/, which would swallow unrelated strings.  Require enough
// literal text to anchor the match.
const MIN_TEMPLATE_LITERAL = 8;

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDynamicTemplates() {
    dynamicTemplates.length = 0;
    for (const key of Object.keys(dynamicTemplateBuckets)) delete dynamicTemplateBuckets[key];
    for (const [source, target] of Object.entries(translations)) {
        const matches = Array.from(source.matchAll(placeholderPattern));
        if (matches.length === 0) continue;
        let cursor = 0;
        let pattern = "^";
        let literalLength = 0;
        const captureByToken = new Map<string, number>();
        matches.forEach((match, index) => {
            const offset = match.index || 0;
            const literal = source.slice(cursor, offset);
            literalLength += literal.length;
            pattern += escapeRegex(literal);
            pattern += "([\\s\\S]+?)";
            if (!captureByToken.has(match[0])) captureByToken.set(match[0], index + 1);
            cursor = offset + match[0].length;
        });
        const trailing = source.slice(cursor);
        literalLength += trailing.length;
        if (literalLength < MIN_TEMPLATE_LITERAL) continue;
        pattern += escapeRegex(trailing) + "$";
        const template = { pattern: new RegExp(pattern), target, captureByToken };
        dynamicTemplates.push(template);
        const prefixLength = matches[0].index || 0;
        const prefix = source.slice(0, prefixLength);
        const bucketKey = prefix.length >= 2 ? prefix.slice(0, 2) : "";
        (dynamicTemplateBuckets[bucketKey] ||= []).push(template);
    }
    log(`compiled ${dynamicTemplates.length} dynamic translation templates`);
}

function applyAndroidOverrides() {
    for (const key of Object.keys(translations)) {
        translations[key] = translations[key].replace(/【水着】/g, "【泳裝】");
    }
    Object.assign(translations, {
        "基本情報": "基本資訊",
        "限界突破": "突破極限",
        "覚醒pt": "覺醒pt",
        "覚醒Pt": "覺醒Pt",
        "絆pt": "羈絆pt",
        "解放条件": "解鎖條件",
        "未解放": "未解鎖"
    });
}

function fetchJson(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        try {
            const system = Il2Cpp.domain.assembly("System").image;
            const webRequest = system.class("System.Net.WebRequest");
            const streamReader = Il2Cpp.corlib.class("System.IO.StreamReader");
            const request = webRequest.method<Il2Cpp.Object>("Create")
                .overload("System.String").invoke(Il2Cpp.string(url));
            const response = request.method<Il2Cpp.Object>("GetResponse").invoke();
            const stream = response.method<Il2Cpp.Object>("GetResponseStream").invoke();
            const reader = streamReader.new();
            reader.method(".ctor").overload("System.IO.Stream").invoke(stream);
            const raw = reader.method<Il2Cpp.String>("ReadToEnd").invoke().content;
            const parsed = JSON.parse(raw || "{}");
            resolve(parsed);
            try { reader.method("Close").invoke(); } catch (_) { /* GC fallback */ }
            try { response.method("Close").invoke(); } catch (_) { /* GC fallback */ }
        } catch (error) {
            reject(error);
        }
    });
}

async function loadTranslations() {
    send({ type: "dotabyss-diag", stage: "translation-load-start" });
    for (const [relative, raw] of embeddedTranslationJson) {
        try {
            flatten(JSON.parse(raw));
            log(`loaded embedded ${relative}; total=${Object.keys(translations).length}`);
        } catch (error) {
            console.error(`[dotabyss-hook] failed to load embedded ${relative}: ${error}`);
            nativeLog(`failed to load embedded ${relative}: ${error}`);
            send({ type: "dotabyss-error", stage: "translation-embedded", relative, error: String(error) });
        }
    }
    applyAndroidOverrides();
    buildDynamicTemplates();
    refreshExistingTexts("embedded-complete");
    // Only now may the font load start: it must not inflate the heap before the
    // one-shot sweep above has run.
    translationsReady = true;
}

// Deliberately NOT set_font: swapping a component's font would throw away the
// game's own styling.  Registering ours as a fallback fills only the glyphs the
// Japanese atlas is missing.
function applyFont(instance: Il2Cpp.Object, font: "tmp" | "legacy") {
    if (font !== "tmp") return;
    fontTick(instance);
}

function refreshExistingTexts(stage: string) {
    if (Object.keys(translations).length === 0) return;
    const started = Date.now();
    let scanned = 0;
    let matched = 0;
    for (const [assemblyName, className, font] of [
        ["Unity.TextMeshPro", "TMPro.TMP_Text", "tmp"],
        ["UnityEngine.UI", "UnityEngine.UI.Text", "legacy"]
    ] as [string, string, "tmp" | "legacy"][]) {
        try {
            const klass = Il2Cpp.domain.assembly(assemblyName).image.class(className);
            for (const instance of Il2Cpp.gc.choose(klass)) {
                scanned++;
                try {
                    const current = instance.method<Il2Cpp.String>("get_text").invoke();
                    if (!current.isNull()) {
                        const next = translated(current.content) || current.content;
                        if (next !== current.content) {
                            matched++;
                            // Write the translation, not the original: `.invoke()` runs the
                            // original implementation, so it never re-enters the setter hook.
                            instance.method("set_text").overload("System.String")
                                .invoke(Il2Cpp.string(next));
                            applyFont(instance, font);
                        } else {
                            reportUnmatched(current.content, `${className}.refresh`);
                        }
                    }
                } catch (_) { /* destroyed or version-specific component */ }
            }
        } catch (error) {
            send({ type: "dotabyss-error", stage: "text-refresh-class", className, error: String(error) });
        }
    }
    sweeps++;
    const elapsed = Date.now() - started;
    if (matched > 0 || sweeps % 40 === 1) {
        nativeLog(`text refresh ${stage} #${sweeps}; scanned=${scanned}; matched=${matched}; ${elapsed}ms`);
    }
    send({ type: "dotabyss-diag", stage: "text-refresh-complete", scanned, matched, elapsed });
}

// Prefab labels are deserialised straight into m_text, so no setter ever fires
// for them.  OnEnable does fire when a screen instantiates them, it runs on
// Unity's own thread, and it costs nothing while idle.
//
// Do NOT go back to polling Il2Cpp.gc.choose for this.  A 1.5 s sweep wedged the
// game within a minute on this device: gc.choose disables the IL2CPP GC and walks
// the heap holding the allocation lock, the walk grew from 72 ms to 406 ms as the
// UI populated, and Android 15's moving CMC collector does not tolerate it.
function hookEnable(className: string, assemblyName: string, font: "tmp" | "legacy") {
    let klass: Il2Cpp.Class;
    try {
        klass = Il2Cpp.domain.assembly(assemblyName).image.class(className);
    } catch (error) {
        log(`skip unavailable ${className}: ${error}`);
        return;
    }
    let method: Il2Cpp.Method;
    try {
        method = klass.method("OnEnable", 0);
    } catch (error) {
        log(`skip ${className}.OnEnable: ${error}`);
        return;
    }
    // A base-class OnEnable would fire for every Graphic, including Images that
    // have no text property, so only hook it where the class declares its own.
    if (method.class.name !== klass.name.split(".").pop()) {
        log(`skip ${className}.OnEnable: declared by ${method.class.name}`);
        return;
    }
    method.implementation = function () {
        this.method("OnEnable", 0).invoke();
        try {
            const current = this.method<Il2Cpp.String>("get_text").invoke();
            if (current.isNull()) return;
            const next = translated(current.content) || current.content;
            if (next !== current.content) {
                // `.invoke()` reaches the original setter, so pass the translation.
                this.method("set_text").overload("System.String").invoke(Il2Cpp.string(next));
            } else {
                reportUnmatched(current.content, `${className}.OnEnable`);
            }
            applyFont(this as Il2Cpp.Object, font);
        } catch (_) { /* component without a usable text property */ }
    };
    log(`hooked ${className}.OnEnable`);
}

// Story text is fed to TMP one character at a time, so it can never match there.
// Absf.Novel.NovelArgument.SetString is where each already-unquoted script field
// arrives -- past the CSV parser, so no quoting to respect, and before anything
// splits it for the typewriter.  Called once per field at parse time, not per frame.
function hookNovelText() {
    let klass: Il2Cpp.Class;
    try {
        klass = Il2Cpp.domain.assembly("Absf").image.class("Absf.Novel.NovelArgument");
    } catch (error) {
        log(`skip Absf.Novel.NovelArgument: ${error}`);
        return;
    }
    let method: Il2Cpp.Method;
    try {
        method = klass.method("SetString").overload("System.String");
    } catch (error) {
        log(`skip NovelArgument.SetString: ${error}`);
        return;
    }
    method.implementation = function (value: Il2Cpp.String) {
        if (value.isNull()) return this.method("SetString").overload("System.String").invoke(value);
        let next = value.content;
        try {
            next = translated(value.content) || value.content;
            if (next !== value.content) {
                if (++novelHits <= 25) {
                    nativeLog(`NOVEL "${value.content.slice(0, 40)}" -> "${next.slice(0, 40)}"`);
                }
            } else {
                reportUnmatched(value.content, "NovelArgument.SetString");
            }
        } catch (error) {
            nativeLog(`NOVEL translate failed: ${error}`);
        }
        return this.method("SetString").overload("System.String").invoke(Il2Cpp.string(next));
    };
    log("hooked Absf.Novel.NovelArgument.SetString");
}

// Live2D models carry the censorship overlay as ordinary drawables named
// Mosaic_* / MosaicInsted_*, so hiding them is just SetActive(false) after the
// model initialises.  Technique from anosu/DMM-Mod's disableMosaic().
// Runs on Unity's thread (Initialize is called by the game) and touches nothing
// until a Live2D scene actually loads.
function hookMosaic() {
    let klass: Il2Cpp.Class;
    try {
        klass = Il2Cpp.domain.assembly("Project").image.class("Project.Novel.NovelLive2DObject");
    } catch (error) {
        log(`skip Project.Novel.NovelLive2DObject: ${error}`);
        return;
    }
    let method: Il2Cpp.Method;
    try {
        method = klass.method("Initialize");
    } catch (error) {
        log(`skip NovelLive2DObject.Initialize: ${error}`);
        return;
    }
    method.implementation = function (...args: Il2Cpp.Parameter.Type[]) {
        const result = this.method("Initialize").invoke(...args);
        try {
            const drawables = this.method<Il2Cpp.Object>("GetDrawables").invoke();
            let hidden = 0;
            for (const drawable of drawables as unknown as Iterable<Il2Cpp.Object>) {
                const name = drawable.method<Il2Cpp.String>("get_name").invoke().content;
                if (!name) continue;
                if (name.startsWith("Mosaic_") || name.startsWith("MosaicInsted_")) {
                    drawable.method<Il2Cpp.Object>("get_gameObject").invoke()
                        .method("SetActive").invoke(false);
                    hidden++;
                }
            }
            mosaicHidden += hidden;
            if (hidden > 0 && mosaicLogs < 5) {
                mosaicLogs++;
                nativeLog(`MOSAIC hid ${hidden} drawable(s); total ${mosaicHidden}`);
            }
        } catch (error) {
            nativeLog(`MOSAIC failed: ${error}`);
        }
        return result;
    };
    log("hooked Project.Novel.NovelLive2DObject.Initialize");
}

// Skip the "this game plays voice" popup on startup by firing its OK callback
// as soon as the popup wires itself up.  From anosu/DMM-Mod's disableSoundCaution().
function hookSoundCaution() {
    let klass: Il2Cpp.Class;
    try {
        klass = Il2Cpp.domain.assembly("Project").image
            .class("Project.Notice.SoundCautionPopupController");
    } catch (error) {
        log(`skip SoundCautionPopupController: ${error}`);
        return;
    }
    try {
        klass.method("SetupPopupEvent").implementation = function () {
            try {
                this.field<Il2Cpp.Object>("_onClickOk").value.method("Invoke").invoke();
            } catch (error) {
                nativeLog(`SOUNDCAUTION failed: ${error}`);
            }
        };
        log("hooked Project.Notice.SoundCautionPopupController.SetupPopupEvent");
    } catch (error) {
        log(`skip SetupPopupEvent: ${error}`);
    }
}

// Voice lines get cut off because starting one stops the whole Voice category.
// Suppress that specific stop, except when we ourselves triggered it.
// From anosu/DMM-Mod's disableVoiceInterruption().
function hookVoiceInterruption() {
    let klass: Il2Cpp.Class;
    try {
        klass = Il2Cpp.domain.assembly("Project").image.class("Project.Novel.NovelSoundManager");
    } catch (error) {
        log(`skip NovelSoundManager: ${error}`);
        return;
    }
    try {
        const stop = klass.method("StopCategory");
        stop.implementation = function (category: number, flag: boolean) {
            // category 2 == Voice. Let it through only when re-entered from PlaySound.
            if (allowStopVoice > 0 || category !== 2 || flag) {
                return this.method("StopCategory").invoke(category, flag);
            }
        };
        const play = klass.method("PlaySound");
        play.implementation = function (sound: Il2Cpp.Object) {
            if (String(sound) === "Voice") {
                allowStopVoice++;
                try { this.method("StopCategory").invoke(2, false); } finally { allowStopVoice--; }
            }
            return this.method("PlaySound").invoke(sound);
        };
        log("hooked Project.Novel.NovelSoundManager (voice interruption)");
    } catch (error) {
        log(`skip NovelSoundManager hooks: ${error}`);
    }
}

// Tofu fix.  Three constraints came out of the failed attempts:
//   1. Do not read the 28 MB bundle synchronously -- LoadFromFileAsync survived
//      stripping, so hand the wait back to Unity instead of blocking a frame.
//   2. Do not start before the startup sweep has finished; a resident 28 MB
//      bundle pushed that one-shot gc.choose from 80 ms to 2806 ms.
//   3. Register as a *fallback*, never set_font -- a fallback is consulted only
//      for glyphs the Japanese atlas lacks, so the game keeps its styling.
// Driven entirely from set_text, i.e. Unity's own thread, with no timers.
// Attempt 5.  Every previous version kept an Il2Cpp object alive between calls
// -- an async request handle, then a GCHandle -- and every one of them faulted,
// because this device's collector moves objects underneath us.  So: keep NOTHING.
// Load the bundle, pull the asset, and register the fallback in a single
// synchronous pass driven by one set_text, then never touch any of it again.
//
// LoadFromMemory + the 1-arg LoadAsset are used because IL2CPP stripped the
// synchronous LoadFromFile, and passing a System.Type to LoadAsset faults.
// The ~28 MB read stalls one frame, which is why translationsReady gates it to
// after startup rather than during it.
// Technique taken from anosu/DMM-Mod, whose DotAbyss X build does this and works.
// Four things I had wrong, all of which this fixes:
//   * Unity extracts assets/bin/Data/Managed/* to persistentDataPath/il2cpp/, so
//     the bundle is at .../files/il2cpp/<name>, not .../files/<name>.
//   * Completion is delivered by an AsyncOperation `completed` delegate.  Unity
//     holds the delegate, so nothing has to survive in our own state across
//     frames -- which is what kept faulting under the moving collector.
//   * The asset is kept alive with hideFlags=HideAndDontSave + DontDestroyOnLoad,
//     Unity's own mechanism, instead of a GCHandle.
//   * LoadAssetAsync(name, type) works where the synchronous LoadAsset aborted.
function persistObject(asset: Il2Cpp.Object) {
    const core = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
    const hideFlags = core.class("UnityEngine.HideFlags").field("HideAndDontSave").value;
    asset.method("set_hideFlags").invoke(hideFlags);
    core.class("UnityEngine.Object").method("DontDestroyOnLoad").invoke(asset);
}

function completedDelegate(operation: Il2Cpp.Object, onDone: (op: Il2Cpp.Object) => void) {
    const action = Il2Cpp.corlib.class("System.Action`1")
        .inflate(Il2Cpp.domain.assembly("UnityEngine.CoreModule").image
            .class("UnityEngine.AsyncOperation"));
    const handler = Il2Cpp.delegate(action, (op: Il2Cpp.Object) => {
        try {
            op.method("remove_completed").invoke(handler);
            onDone(op);
        } catch (error) {
            fontState = "failed";
            nativeLog(`FONT FAILED at ${fontStep}: ${error}`);
        }
    });
    operation.method("add_completed").invoke(handler);
}

function fontTick(_component: Il2Cpp.Object) {
    if (!translationsReady || fontState !== "idle") return;
    fontState = "loading";
    try {
        fontStep = "persistentDataPath";
        const root = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image
            .class("UnityEngine.Application")
            .method<Il2Cpp.String>("get_persistentDataPath").invoke().content;
        const [bundleName, assetName] = config.fontBundle;
        // il2cpp/ is where Unity extracts assets/bin/Data/Managed/*, i.e. the
        // shipping location.  files/ is the only spot `adb push` can actually
        // write (il2cpp/ is drwxr-s--- and scoped storage drops the write while
        // still reporting success), so it doubles as the try-a-font path.
        const paths = [`${root}/il2cpp/${bundleName}`, `${root}/${bundleName}`];

        const attempt = (index: number) => {
            if (index >= paths.length) {
                fontState = "failed";
                nativeLog(`FONT FAILED: none of ${paths.join(" | ")} produced a bundle`);
                return;
            }
            const path = paths[index];
            nativeLog(`FONT trying ${path} -> "${assetName}"`);
            fontStep = "LoadFromFileAsync";
            const request = Il2Cpp.domain.assembly("UnityEngine.AssetBundleModule").image
                .class("UnityEngine.AssetBundle")
                .method<Il2Cpp.Object>("LoadFromFileAsync", 1).invoke(Il2Cpp.string(path));
            if (request.isNull()) { attempt(index + 1); return; }
            completedDelegate(request, op => {
                fontStep = "get_assetBundle";
                const bundle = op.method<Il2Cpp.Object>("get_assetBundle").invoke();
                if (bundle.isNull()) { attempt(index + 1); return; }
                onBundle(bundle, assetName, bundleName);
            });
        };
        attempt(0);
    } catch (error) {
        fontState = "failed";
        nativeLog(`FONT FAILED at ${fontStep}: ${error}`);
    }
}

function onBundle(bundle: Il2Cpp.Object, assetName: string, bundleName: string) {
    try {
            fontStep = "LoadAssetAsync";
            const fontClass = Il2Cpp.domain.assembly("Unity.TextMeshPro").image
                .class("TMPro.TMP_FontAsset");
            const assetOp = bundle.method<Il2Cpp.Object>("LoadAssetAsync", 2)
                .invoke(Il2Cpp.string(assetName), fontClass.type.object);
            completedDelegate(assetOp, done => {
                fontStep = "get_asset";
                const asset = done.method<Il2Cpp.Object>("get_asset").invoke();
                if (asset.isNull()) throw new Error(`no asset "${assetName}" in ${bundleName}`);
                fontStep = "persistObject";
                persistObject(asset);
                fontStep = "addToFallback";
                const list = Il2Cpp.domain.assembly("Unity.TextMeshPro").image
                    .class("TMPro.TMP_Settings")
                    .method<Il2Cpp.Object>("get_fallbackFontAssets").invoke();
                if (list.isNull()) throw new Error("TMP_Settings.fallbackFontAssets is null");
                list.method("Add").invoke(asset);
                bundle.method("Unload").invoke(false);
                fontState = "ready";
                nativeLog(`FONT OK: "${assetName}" from ${bundleName} added to TMP fallbacks`);
            });
    } catch (error) {
        fontState = "failed";
        nativeLog(`FONT FAILED at ${fontStep}: ${error}`);
    }
}

// TMP_Settings.fallbackFontAssets is a static property backed by
// TMP_Settings.instance, and this game ships no TMP_Settings asset -- reading it
// dereferenced null.  Each TMP_Text carries its own font asset though, and every
// TMP_FontAsset has its own fallbackFontAssetTable, so patch the fonts we
// actually meet.  There are only a handful, and the set keeps it to once each.
function patchFontFallback(component: Il2Cpp.Object) {
    if (fontState !== "ready") return;
    try {
        const ours = tmpFontRef?.target;
        if (ours == null || ours.isNull()) return;
        const font = component.method<Il2Cpp.Object>("get_font").invoke();
        if (font.isNull()) return;
        const key = font.method<Il2Cpp.String>("get_name").invoke().content || "(unnamed)";
        if (patchedFonts.has(key) || key.startsWith(config.fontAssetName)) return;
        patchedFonts.add(key);
        const table = font.method<Il2Cpp.Object>("get_fallbackFontAssetTable").invoke();
        if (table.isNull()) {
            nativeLog(`FONT fallback table null on ${key}`);
            return;
        }
        table.method("Add").invoke(ours);
        // TMP caches "this glyph is missing" per font, so the cache has to go or
        // characters already resolved as tofu stay tofu.
        try { font.method("ClearFallbackCharacterTable").invoke(); } catch (_) { /* older TMP */ }
        nativeLog(`FONT fallback added to font ${key} (${patchedFonts.size} patched)`);
    } catch (error) {
        nativeLog(`FONT fallback patch failed: ${error}`);
    }
}

// Pure reflection over two named classes: no asset is loaded, no game method is
// invoked, nothing becomes resident.  That matters because the previous attempt
// to find this API was bundled with a 28 MB LoadFromMemory that black-screened
// the game -- the reflection was never the expensive part.
//
// Wanted: TMP's fallback table.  Replacing a component's font would discard the
// game's styling, whereas a fallback is consulted only for glyphs the primary
// (Japanese) atlas lacks -- which is exactly the tofu case.
function tmpApiProbe() {
    try {
        const image = Il2Cpp.domain.assembly("Unity.TextMeshPro").image;
        for (const name of ["TMPro.TMP_Settings", "TMPro.TMP_FontAsset"]) {
            let klass: Il2Cpp.Class;
            try {
                klass = image.class(name);
            } catch (error) {
                nativeLog(`TMPAPI ${name} missing: ${error}`);
                continue;
            }
            for (const method of klass.methods) {
                if (!/allback/i.test(method.name)) continue;
                const params = method.parameters.map(p => p.type.name).join(", ");
                nativeLog(`TMPAPI ${name}.${method.name}(${params}) -> ${method.returnType.name}`);
            }
            for (const field of klass.fields) {
                if (!/allback/i.test(field.name)) continue;
                nativeLog(`TMPAPI ${name}.${field.name} : ${field.type.name}`);
            }
        }
        nativeLog("TMPAPI done");
    } catch (error) {
        nativeLog(`TMPAPI failed: ${error}`);
    }
}

// The game builds some strings by wrapping a title in 「」 and appending a fixed
// tail, then looks the whole thing up -- e.g.
//   「海辺のお姫様」<br>を再生します。よろしいですか？
// The dictionary carries 386 of these pre-composed, which means every new story
// needs another hand-written entry (AGENTS.md calls them "mixed keys").  Both
// halves are already translated on their own, so compose it here instead and
// every story works, including ones that do not exist yet.
//
// Requires BOTH halves to be real dictionary hits -- no partial guessing.
const composedPattern = /^「([^」]+)」(<br>|\\n|\n)?([\s\S]*)$/;

function translateComposed(text: string): string | null {
    const match = composedPattern.exec(text);
    if (!match) return null;
    const [, title, separator, tail] = match;
    const titleZh = translations[title];
    if (!titleZh) return null;
    if (tail.length === 0) return `「${titleZh}」`;
    const tailZh = translations[tail];
    if (!tailZh) return null;
    return `「${titleZh}」${separator || ""}${tailZh}`;
}

function templateLookup(text: string): string | null {
    const candidates = [
        ...(dynamicTemplateBuckets[text.slice(0, 2)] || []),
        ...(dynamicTemplateBuckets[""] || [])
    ];
    for (const template of candidates) {
        const match = template.pattern.exec(text);
        if (!match) continue;
        const result = template.target.replace(placeholderPattern, token => {
            const captureIndex = template.captureByToken.get(token);
            return captureIndex ? match[captureIndex] : token;
        });
        // A greedy capture can make a template echo its own input back. That is
        // not a translation, and accepting it would stop us trying the
        // tag-stripped form below.
        if (result === text) continue;
        send({ type: "dotabyss-template-replacement", before: text, after: result });
        return result;
    }
    return null;
}

function lookup(text: string): string | null {
    if (translations[text]) return translations[text];
    if (text.charCodeAt(0) === 0x300c) {
        const composed = translateComposed(text);
        if (composed !== null) return composed;
    }
    return templateLookup(text);
}

// TMP rich-text tags are the difference between the PC mod and this one.
// AbyssStaticFix rewrites masterdata *before* the game colourises it, so its keys
// match; we intercept *after*, so the incoming string carries tags the Japanese
// key never had -- e.g. 自身に<color=#FF5050>紋章：情熱</color>を【1】付与.
// Strip them and retry: the Traditional Chinese value already carries the correct
// colour tags itself (a project rule, see AGENTS.md), so the output stays right.
const richTextTag = /<\/?(?:color|b|i|u|s|size|sprite|link|align|font|mark|nobr)\b[^>]*>/gi;

function translated(text: string | null): string | null {
    if (text === null || text === "") return text;
    const cached = dynamicCache[text];
    if (cached !== undefined) return cached;

    let result = lookup(text);
    if (result === null && text.indexOf("<") !== -1) {
        const stripped = text.replace(richTextTag, "");
        if (stripped !== text) result = lookup(stripped);
    }
    if (result === null && text.includes("【水着】")) {
        result = text.replace(/【水着】/g, "【泳裝】");
    }
    if (result === null) return text;
    dynamicCache[text] = result;
    return result;
}

function reportUnmatched(text: string, source: string) {
    if (unmatchedLogs >= 600 || unmatchedTexts.has(text)) return;
    if (!/[\u3040-\u30ff]/u.test(text)) return;
    unmatchedTexts.add(text);
    unmatchedLogs++;
    send({ type: "dotabyss-unmatched", source, text });
    // A shipped APK runs the gadget in `script` mode with no client attached, so
    // `send()` goes nowhere. logcat is the only diagnostic channel on device.
    nativeLog(`UNMATCHED ${source} :: ${JSON.stringify(text)}`);
}

function failFont(error: unknown) {
    console.error(`[dotabyss-hook] font load failed: ${error}`);
    // logcat is the only channel that reaches us on a shipped build; a failure
    // that only goes to console.error/send() is a failure nobody ever sees.
    nativeLog(`FONTPROBE FAILED: ${error}`);
    send({ type: "dotabyss-error", stage: "font-load", error: String(error) });
    tmpFont = null;
    legacyFont = null;
    fontLoading = false;
}

// The game's TMP atlas is built for Japanese, so Chinese-only characters
// (妳, 吧, 嗎, 這, 麼 ...) render as tofu boxes.  Fixing that means loading the
// bundled notosanscjktc asset -- but nobody has ever confirmed where that bundle
// is readable from on device, and the old code guessed /data/local/tmp, which an
// unprivileged app cannot even traverse.
//
// So: probe first, report, and only then wire it up.  Everything here runs on
// Unity's own thread (it is driven from a hooked setter), never from a timer.
function fontProbe() {
    if (fontLoading) return;
    fontLoading = true;
    try {
        const application = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image
            .class("UnityEngine.Application");
        const readPath = (name: string) => {
            try {
                return application.method<Il2Cpp.String>(name).invoke().content || "(null)";
            } catch (error) {
                return `(${error})`;
            }
        };
        const dataPath = readPath("get_dataPath");
        const persistent = readPath("get_persistentDataPath");
        const streaming = readPath("get_streamingAssetsPath");
        nativeLog(`FONTPROBE dataPath=${dataPath}`);
        nativeLog(`FONTPROBE persistentDataPath=${persistent}`);
        nativeLog(`FONTPROBE streamingAssetsPath=${streaming}`);

        // IL2CPP strips overloads the game never calls: this build has no
        // synchronous LoadFromFile at all, only the async ones.  LoadFromMemory
        // did survive, so read the bytes ourselves and hand them over -- that
        // keeps the whole thing synchronous on Unity's thread, with no polling.
        const assetBundleClass = Il2Cpp.domain.assembly("UnityEngine.AssetBundleModule").image
            .class("UnityEngine.AssetBundle");
        const path = `${persistent}/${config.fontAssetName}`;
        const file = Il2Cpp.corlib.class("System.IO.File");
        let bytes: Il2Cpp.Array<number>;
        try {
            bytes = file.method<Il2Cpp.Array<number>>("ReadAllBytes").invoke(Il2Cpp.string(path));
        } catch (error) {
            nativeLog(`FONTPROBE cannot read ${path} :: ${error}`);
            return;
        }
        nativeLog(`FONTPROBE read    ${path} (${bytes.length} bytes)`);
        const bundle = assetBundleClass.method<Il2Cpp.Object>("LoadFromMemory")
            .overload("System.Byte[]").invoke(bytes);
        if (bundle.isNull()) {
            nativeLog("FONTPROBE LoadFromMemory returned null");
            return;
        }
        nativeLog("FONTPROBE LOADED via LoadFromMemory");
        fontBundle = bundle;

        // GetAllAssetNames was stripped, so use the names the reference project
        // ships the bundle with.  LoadAsset(String, Type) is the synchronous form
        // that survived; typeof(T) comes from the class's own type object.
        const tmpFontClass = Il2Cpp.domain.assembly("Unity.TextMeshPro").image.class("TMPro.TMP_FontAsset");
        const loadAsset = bundle.method<Il2Cpp.Object>("LoadAsset").overload("System.String", "System.Type");
        tmpFont = loadAsset.invoke(Il2Cpp.string(`${config.fontAssetName} SDF`), tmpFontClass.type.object);
        nativeLog(`FONTPROBE tmpFont  null=${tmpFont.isNull()}`);
        try {
            const fontClass = Il2Cpp.domain.assembly("UnityEngine.TextRenderingModule").image
                .class("UnityEngine.Font");
            legacyFont = loadAsset.invoke(Il2Cpp.string(config.fontAssetName), fontClass.type.object);
            nativeLog(`FONTPROBE legacy   null=${legacyFont.isNull()}`);
        } catch (error) {
            nativeLog(`FONTPROBE legacy failed: ${error}`);
        }

        // Replacing a component's font would also throw away the game's styling.
        // The right lever is TMP's fallback table, which is consulted only for
        // glyphs the primary atlas lacks -- exactly the tofu case.  Bounded to two
        // named classes, so this is nothing like the class-walk that froze us.
        for (const [label, klass] of [
            ["TMP_Settings", Il2Cpp.domain.assembly("Unity.TextMeshPro").image.class("TMPro.TMP_Settings")],
            ["TMP_FontAsset", tmpFontClass]
        ] as [string, Il2Cpp.Class][]) {
            for (const method of klass.methods) {
                if (!/allback/.test(method.name)) continue;
                nativeLog(`TMPAPI ${label}.${method.name}(${method.parameters.map(p => p.type.name).join(", ")}) -> ${method.returnType.name}`);
            }
            for (const field of klass.fields) {
                if (!/allback/.test(field.name)) continue;
                nativeLog(`TMPAPI ${label}.${field.name} : ${field.type.name}`);
            }
        }
    } catch (error) {
        failFont(error);
    }
}

// NEVER enumerate image.classes from a hooked method.  frida-il2cpp-bridge
// materialises the whole class array, and `Absf` is big enough that doing it on
// the render thread froze the game for minutes with no output at all -- the
// class list this replaced is already recorded in NOTES.md, so look names up
// directly instead.
//
// Story text reaches TMP one character at a time, so the only place it still
// exists as a whole line is upstream in Absf.Novel.  Dump the shape of the
// likely carriers so we can pick a hook point from evidence, not from a guess.
function dumpNovelMethods() {
    let image: Il2Cpp.Image;
    try {
        image = Il2Cpp.domain.assembly("Absf").image;
    } catch (error) {
        nativeLog(`NOVELM no Absf assembly: ${error}`);
        return;
    }
    for (const name of [
        "Absf.Novel.NovelCsvParser",
        "Absf.Novel.NovelArgument",
        "Absf.Novel.NovelArguments",
        "Absf.Novel.NovelScriptCommands",
        "Absf.Novel.NovelViewBase",
        "Absf.Novel.NovelScript"
    ]) {
        try {
            const klass = image.class(name);
            let count = 0;
            for (const method of klass.methods) {
                if (++count > 40) break;
                const params = method.parameters.map(p => `${p.type.name} ${p.name}`).join(", ");
                nativeLog(`NOVELM ${name}.${method.name}(${params}) -> ${method.returnType.name}`);
            }
            for (const field of klass.fields) {
                nativeLog(`NOVELF ${name}.${field.name} : ${field.type.name}`);
            }
        } catch (error) {
            nativeLog(`NOVELM ${name} :: ${error}`);
        }
    }
}

function hookTextSetter(className: string, assemblyName: string, font: "tmp" | "legacy") {
    let klass: Il2Cpp.Class;
    try {
        klass = Il2Cpp.domain.assembly(assemblyName).image.class(className);
    } catch (error) {
        log(`skip unavailable ${className}: ${error}`);
        return;
    }
    const setter = klass.method("set_text").overload("System.String");
    setter.implementation = function (value: Il2Cpp.String) {
        // The font probe used to run from here.  It is disabled: LoadFromMemory
        // succeeds, but LoadAsset(String, Type) faults ("breakpoint triggered"),
        // and merely keeping the 28 MB bundle resident pushed the one-shot startup
        // sweep from 80 ms to 2806 ms and left the game on a black screen.
        if (font === "tmp") fontTick(this as Il2Cpp.Object);
        if (value.isNull()) {
            this.method("set_text").overload("System.String").invoke(value);
            return;
        }
        const next = translated(value.content) || value.content;
        if (next !== value.content && replacementLogs < 30) {
            replacementLogs++;
            send({ type: "dotabyss-replacement", before: value.content, after: next });
        }
        if (next === value.content) reportUnmatched(value.content, `${className}.set_text`);
        this.method("set_text").overload("System.String").invoke(Il2Cpp.string(next));
        applyFont(this as Il2Cpp.Object, font);
    };
    log(`hooked ${className}.set_text`);
}

function hookTmpSetTextMethods() {
    const klass = Il2Cpp.domain.assembly("Unity.TextMeshPro").image.class("TMPro.TMP_Text");

    try {
        const method = klass.method("SetText").overload("System.String");
        method.implementation = function (value: Il2Cpp.String) {
            if (value.isNull()) {
                this.method("SetText").overload("System.String").invoke(value);
                return;
            }
            const next = translated(value.content) || value.content;
            if (next !== value.content) nativeLog(`TMP SetText translated: ${value.content.slice(0, 80)}`);
            this.method("SetText").overload("System.String").invoke(Il2Cpp.string(next));
        };
        log("hooked TMPro.TMP_Text.SetText(System.String)");
    } catch (error) {
        log(`skip TMP_Text.SetText(String): ${error}`);
    }

    try {
        const method = klass.method("SetText").overload("System.String", "System.Boolean");
        method.implementation = function (value: Il2Cpp.String, syncTextInputBox: boolean) {
            if (value.isNull()) {
                this.method("SetText").overload("System.String", "System.Boolean")
                    .invoke(value, syncTextInputBox);
                return;
            }
            const next = translated(value.content) || value.content;
            if (next !== value.content) nativeLog(`TMP SetText(bool) translated: ${value.content.slice(0, 80)}`);
            this.method("SetText").overload("System.String", "System.Boolean")
                .invoke(Il2Cpp.string(next), syncTextInputBox);
        };
        log("hooked TMPro.TMP_Text.SetText(System.String,System.Boolean)");
    } catch (error) {
        log(`skip TMP_Text.SetText(String,Boolean): ${error}`);
    }

    try {
        const method = klass.method("SetTextInternal").overload("System.String");
        method.implementation = function (value: Il2Cpp.String) {
            if (value.isNull()) {
                this.method("SetTextInternal").overload("System.String").invoke(value);
                return;
            }
            const next = translated(value.content) || value.content;
            if (next !== value.content) nativeLog(`TMP SetTextInternal translated: ${value.content.slice(0, 80)}`);
            this.method("SetTextInternal").overload("System.String").invoke(Il2Cpp.string(next));
        };
        log("hooked TMPro.TMP_Text.SetTextInternal(System.String)");
    } catch (error) {
        log(`skip TMP_Text.SetTextInternal(String): ${error}`);
    }
}

function main() {
    nativeLog("autonomous script evaluated");
    send({ type: "dotabyss-diag", stage: "bundle-start" });
    Il2Cpp.perform(() => {
        send({ type: "dotabyss-diag", stage: "il2cpp-perform-enter" });
        log("injector started");
        hookTextSetter("TMPro.TMP_Text", "Unity.TextMeshPro", "tmp");
        hookTextSetter("UnityEngine.UI.Text", "UnityEngine.UI", "legacy");
        hookTmpSetTextMethods();
        hookEnable("TMPro.TextMeshProUGUI", "Unity.TextMeshPro", "tmp");
        hookEnable("TMPro.TextMeshPro", "Unity.TextMeshPro", "tmp");
        hookEnable("UnityEngine.UI.Text", "UnityEngine.UI", "legacy");
        hookNovelText();
        hookMosaic();
        hookSoundCaution();
        hookVoiceInterruption();
        tmpApiProbe();
        send({
            type: "dotabyss-diag",
            stage: "assembly-names",
            assemblies: Il2Cpp.domain.assemblies.map(assembly => assembly.name)
        });
        // Unity 6 requires a separate main-thread font loading path; keep the
        // translation hook independent so a font failure cannot disable it.
        setTimeout(() => { loadTranslations(); }, 4000);
    }).catch(error => nativeLog(`Il2Cpp.perform failed: ${error}`));
}

// Rebuilding the 230 MB APK for every script tweak is far too slow, so an
// operator can drop a freshly compiled bundle next to the game's own save data
// and have it run instead.  Deleting that file restores the embedded script.
const overridePath = `/storage/emulated/0/Android/data/${config.packageName}/files/dotabyss-hook.js`;
const globals = globalThis as Record<string, unknown>;

// frida-compile emits a Frida bundle, not plain JS: "📦\n<bytes> /src/index.js\n✄\n<source>".
// The gadget's own loader understands that; eval() does not, and feeding it the
// raw file throws SyntaxError.  Unwrap the payload, and only for a single-module
// bundle -- with several modules the sections are concatenated and the entry
// point is not simply "everything after the first separator".
function readOverrideSource(): string | null {
    const raw = (File as unknown as { readAllText(path: string): string }).readAllText(overridePath);
    if (!raw || raw.trim().length === 0) return null;
    if (!raw.startsWith("\u{1F4E6}")) return raw;
    const cut = raw.search(/[✂-✄]\n/);
    if (cut < 0) throw new Error("bundle has no payload separator");
    const entries = raw.slice(2, cut).trim().split("\n").filter(line => line.length > 0);
    if (entries.length !== 1) throw new Error(`cannot unwrap ${entries.length}-module bundle`);
    return raw.slice(cut + 2);
}

function bootstrap() {
    if (globals.__dotabyssHookBooted) return;
    if (!globals.__dotabyssHookOverrideTried) {
        globals.__dotabyssHookOverrideTried = true;
        try {
            const source = readOverrideSource();
            if (source !== null) {
                nativeLog(`loading override script ${overridePath} (${source.length} chars)`);
                // The override is the same kind of bundle, so its own bootstrap()
                // sees __dotabyssHookOverrideTried and goes straight to main().
                (0, eval)(source);
                if (globals.__dotabyssHookBooted) {
                    nativeLog("override script took over");
                    return;
                }
                // Falling through here means the embedded script runs instead, so
                // say so loudly: a silent fallback once made a fixed script look
                // like it had shipped when the old one was still running.
                nativeLog("OVERRIDE FAILED: script loaded but did not take over; running EMBEDDED script");
            }
        } catch (error) {
            // No override file is the normal case, so do not shout about it --
            // a "FAILED" line on every boot trains you to ignore the one that
            // matters.  Anything other than "not there" stays loud.
            const missing = /No such file|not found|ENOENT/i.test(String(error));
            nativeLog(missing
                ? "no override script; running embedded script"
                : `OVERRIDE FAILED (${error}); running EMBEDDED script`);
        }
    }
    globals.__dotabyssHookBooted = true;
    main();
}

bootstrap();
