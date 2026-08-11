export const config = {
    packageName: "jp.co.fanzagames.dotabyss_x_a",
    baseUrl: "https://cdn.jsdelivr.net/gh/liuyuns2/Dot-abyess-Lienchu-version@main/dotabyss-translation-client-version-s88037zz",
    fontAssetName: "notosanscjktc",
    // [bundle file name, asset name inside it].  build.py copies the bundle into
    // assets/bin/Data/Managed/, and Unity extracts that to
    // persistentDataPath/il2cpp/ on first run -- that is where it gets loaded from.
    // The bundle MUST be built for this game's Unity version; feeding it one from
    // another project made Unity abort inside LoadAsset.
    fontBundle: ["ttcuyuanj", "TTCuYuanJ SDF"] as [string, string],
    // Prefab labels are deserialised straight into TMP_Text.m_text, so the
    // property setter never fires for them.  Sweeping the live text components
    // is the only way to reach those, and it has to repeat because every screen
    // instantiates its own prefabs long after startup.
    refreshIntervalMs: 1500,
    translationFiles: [
        // Load the visible UI and character names before the large story files.
        // The game's required VPN disconnect changes Android's active network and
        // can abort a request that happens to be in flight at that exact moment.
        "static/zh_Hant.json",
        "ui_texts/zh_Hant.json",
        "names/zh_Hant.json",
        "add-on/equipment_combos/zh_Hant.json",
        "add-on/ui_misc/zh_Hant.json",
        "other/abyss_code/zh_Hant.json",
        "other/bar/zh_Hant.json",
        "other/dialogue/zh_Hant.json",
        "other/dictionary/zh_Hant.json",
        "other/equipment_effect/zh_Hant.json",
        "other/facility/zh_Hant.json",
        "other/materials/zh_Hant.json",
        "other/mission/zh_Hant.json",
        "other/system/zh_Hant.json",
        "other/ui_misc/zh_Hant.json",
        "novels_evs_all/zh_Hant.json",
        "novels_hmn_all/zh_Hant.json",
        "novels_hmr_all/zh_Hant.json",
        "novels_mas_all/zh_Hant.json",
        "novels_men_all/zh_Hant.json"
    ]
};
