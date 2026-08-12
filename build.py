#!/usr/bin/env python3
"""Build a private DotAbyss X (R18) Traditional-Chinese APK/XAPK.

The official Android release is split by ABI/asset pack.  APK input produces one
patched APK; XAPK input preserves and re-signs every split so Android accepts the
set.  Only arm64 is supported because the supplied Frida gadget must be arm64.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
R18_APP_ID = 771484
R18_PACKAGE = "jp.co.fanzagames.dotabyss_x_a"
ALL_AGES_PACKAGES = {"com.exnoa.abyss"}
# Entries this builder removes on purpose, so restore_lost_entries() does not
# put them back.
INTENTIONAL_REMOVALS = ("lib/armeabi-v7a/",)


def sdk_root() -> Path:
    configured = os.getenv("ANDROID_HOME") or os.getenv("ANDROID_SDK_ROOT")
    if configured:
        return Path(configured)
    return Path(os.getenv("LOCALAPPDATA", "")) / "Android/Sdk"


def latest_build_tools() -> Path | None:
    root = sdk_root() / "build-tools"
    if not root.is_dir():
        return None
    stable = [p for p in root.iterdir() if p.is_dir() and re.fullmatch(r"\d+(?:\.\d+)+", p.name)]
    return max(stable, key=lambda p: tuple(int(part) for part in p.name.split(".")), default=None)


def resolve_tools() -> dict[str, list[str]]:
    build_tools = latest_build_tools()
    local_apktool = ROOT / "tools/apktool.jar"
    npm = "npm.cmd" if os.name == "nt" else "npm"
    commands = {
        "npm": [npm],
        "java": ["java"],
        "keytool": ["keytool"],
        "apktool": ["java", "-jar", str(local_apktool)] if local_apktool.is_file() else ["apktool"],
        "aapt": [str(build_tools / "aapt.exe")] if build_tools else ["aapt"],
        "zipalign": [str(build_tools / "zipalign.exe")] if build_tools else ["zipalign"],
        "apksigner": [str(build_tools / "apksigner.bat")] if build_tools else ["apksigner"],
    }
    for name, command in commands.items():
        executable = command[0]
        if not Path(executable).is_file() and shutil.which(executable) is None:
            raise SystemExit(f"missing required tool: {name} ({executable})")
    return commands


def run(args: list[str], cwd: Path | None = None, capture: bool = False) -> str:
    print("+", " ".join(str(x) for x in args))
    result = subprocess.run(args, cwd=cwd, check=True, text=True,
                            capture_output=capture, encoding="utf-8", errors="replace")
    return result.stdout if capture else ""


def ensure_keystore(path: Path, password: str, tools: dict[str, list[str]]) -> None:
    if path.exists():
        return
    run(tools["keytool"] + [
        "-genkeypair", "-noprompt", "-keystore", str(path),
        "-storepass", password, "-keypass", password, "-alias", "dotabyss",
        "-keyalg", "RSA", "-keysize", "4096", "-validity", "10000",
        "-dname", "CN=DotAbyss Translation,OU=Personal Mod,O=Personal Mod,C=TW",
    ])


def patch_activity(decoded: Path) -> None:
    candidates = list(decoded.glob("smali*/com/unity3d/player/UnityPlayerActivity.smali"))
    if not candidates:
        raise SystemExit("UnityPlayerActivity.smali not found; unsupported APK layout")
    marker = 'const-string v0, "gadget"'
    for path in candidates:
        text = path.read_text(encoding="utf-8")
        if marker in text:
            return
        needle = "invoke-direct {p0}, Landroid/app/Activity;-><init>()V"
        if needle not in text:
            continue
        replacement = needle + (
            '\n\n    const-string v0, "gadget"'
            "\n\n    invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V"
        )
        path.write_text(text.replace(needle, replacement, 1), encoding="utf-8", newline="\n")
        return
    raise SystemExit("UnityPlayerActivity constructor pattern not found")


def apk_has_arm64(apk: Path) -> bool:
    with zipfile.ZipFile(apk) as archive:
        return any(name.startswith("lib/arm64-v8a/") for name in archive.namelist())


def inspect_apk(apk: Path, tools: dict[str, list[str]]) -> tuple[str, str, str | None]:
    badging = run(tools["aapt"] + ["dump", "badging", str(apk)], capture=True)
    package_line = re.search(r"^package: (.+)$", badging, re.MULTILINE)
    package_match = re.search(r"name='([^']+)'", package_line.group(1)) if package_line else None
    if not package_match:
        raise SystemExit(f"cannot read package metadata: {apk}")
    split_match = re.search(r"split='([^']+)'", package_line.group(1))
    label_match = re.search(r"^application-label:'([^']*)'", badging, re.MULTILINE)
    return (package_match.group(1), label_match.group(1) if label_match else "",
            split_match.group(1) if split_match else None)


def apk_version(apk: Path, tools: dict[str, list[str]]) -> str | None:
    badging = run(tools["aapt"] + ["dump", "badging", str(apk)], capture=True)
    match = re.search(r"versionName='([^']*)'", badging)
    return match.group(1) if match else None


def refuse_stale_reinject(patched: Path, tools: dict[str, list[str]]) -> str | None:
    """--reinject rebuilds on top of the previous patched APK, so after an official
    update it would silently ship the old game.  enforce_r18 only checks the package
    name and label, which cannot catch that.  Returns the game version so the caller
    can find the matching official APK."""
    current = apk_version(patched, tools)
    try:
        latest = latest_r18_info()["app_version_name"]
    except (OSError, SystemExit, ValueError) as error:
        print(f"warning: could not reach the DMM API to check for a newer game ({error})")
        return current
    if current and latest and current != latest:
        raise SystemExit(
            f"refusing --reinject: it would rebuild on the OLD game version.\n"
            f"  patched APK base : {current}\n"
            f"  latest official  : {latest}\n"
            f"Run a full build instead:  python build.py"
        )
    print(f"Game version {current} is current.")
    return current


def enforce_r18(apk: Path, tools: dict[str, list[str]]) -> str:
    package, label, split = inspect_apk(apk, tools)
    if split:
        raise SystemExit(f"R18 validation requires the base APK, got split={split}")
    print(f"Detected base APK: package={package}, label={label or '(unknown)'}")
    if package in ALL_AGES_PACKAGES:
        raise SystemExit("refusing all-ages DotAbyss package; this builder is R18/FANZA-only")
    if package != R18_PACKAGE:
        raise SystemExit(f"refusing non-R18 package: expected {R18_PACKAGE}, got {package}")
    if "ドットアビスX" not in label.replace(" ", ""):
        raise SystemExit(f"R18 package has unexpected application label: {label}")
    return package


def latest_r18_info() -> dict:
    url = f"https://api.store.games.dmm.com/freeapp/{R18_APP_ID}"
    request = urllib.request.Request(url, headers={"User-Agent": "DotAbyssX-zh-Hant-builder/1"})
    with urllib.request.urlopen(request, timeout=60) as response:
        info = json.load(response).get("free_appinfo")
    if not info or not info.get("is_adult"):
        raise SystemExit("DMM API did not return the adult DotAbyss X app")
    if info.get("package_name") != R18_PACKAGE:
        raise SystemExit(f"DMM R18 package changed unexpectedly: {info.get('package_name')}")
    return info


def download_latest_r18() -> Path:
    info = latest_r18_info()
    version = info["app_version_name"]
    destination = ROOT / "apk" / f"DotAbyssX-{version}-official.apk"
    if destination.is_file() and zipfile.is_zipfile(destination):
        print(f"Using cached official R18 APK: {destination}")
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(".apk.part")
    for attempt in range(12):
        offset = partial.stat().st_size if partial.exists() else 0
        headers = {"User-Agent": "DotAbyssX-zh-Hant-builder/1"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            request = urllib.request.Request(info["download_url"], headers=headers)
            with urllib.request.urlopen(request, timeout=180) as response:
                append = offset > 0 and response.status == 206
                mode = "ab" if append else "wb"
                with partial.open(mode) as output:
                    shutil.copyfileobj(response, output, length=1024 * 1024)
            if zipfile.is_zipfile(partial):
                os.replace(partial, destination)
                print(f"Downloaded official DotAbyss X {version}: {destination}")
                return destination
        except (OSError, TimeoutError) as error:
            print(f"download attempt {attempt + 1}/12 failed: {error}")
            time.sleep(3)
    raise SystemExit(f"official APK download did not complete: {partial}")


def inject_native(apk: Path, gadget: Path, script: Path, config: Path) -> None:
    temporary = apk.with_suffix(".injecting.apk")
    with zipfile.ZipFile(apk, "r") as source, zipfile.ZipFile(temporary, "w") as target:
        replaced = {
            "lib/arm64-v8a/libgadget.so",
            "lib/arm64-v8a/libgadget.js.so",
            "lib/arm64-v8a/libgadget.config.so",
        }
        for item in source.infolist():
            if item.filename not in replaced and not item.filename.startswith("META-INF/"):
                target.writestr(item, source.read(item.filename))
        target.write(gadget, "lib/arm64-v8a/libgadget.so")
        target.write(script, "lib/arm64-v8a/libgadget.js.so")
        target.write(config, "lib/arm64-v8a/libgadget.config.so")
    os.replace(temporary, apk)


def restore_lost_entries(official: Path, patched: Path) -> int:
    """Put back the res/ files apktool loses to Windows case-insensitivity.

    The official APK is resource-obfuscated (AndResGuard), so res/ holds short
    names that collide only in case: res/S0.png and res/s0.png are two unrelated
    drawables.  `apktool d -r` copies them out verbatim -- -r skips *decoding*,
    not extraction -- and on NTFS both land on one path, so `apktool b` can only
    put one back.  resources.arsc is preserved byte-for-byte and still points at
    the lost name, so Android raises Resources$NotFoundException the moment such
    a resource is inflated.  50 files went missing this way; drawable/dmmgames_logo
    lost its hdpi and xxhdpi variants, which crash-loops the DMM Store SDK splash
    on every xxhdpi device (Pixel 9a) while xhdpi devices never notice.

    Survivors are byte-identical to the originals -- verified by hash across all
    49 collision groups -- so the repair only ever adds entries back.
    """
    with zipfile.ZipFile(official) as source:
        originals = {i.filename: i for i in source.infolist() if not i.is_dir()}
        with zipfile.ZipFile(patched) as target:
            present = {i.filename for i in target.infolist()}
        lost = sorted(name for name in originals
                      if name not in present
                      and not name.startswith("META-INF/")
                      and not name.startswith(INTENTIONAL_REMOVALS))
        strays = [name for name in lost if not name.startswith("res/")]
        if strays:
            raise SystemExit(
                "the apktool round-trip dropped files outside res/, which this repair "
                f"does not cover: {', '.join(strays[:10])}")
        if not lost:
            print("Resource check: nothing lost in the apktool round-trip.")
            return 0
        with zipfile.ZipFile(patched, "a") as target:
            for name in lost:
                target.writestr(originals[name], source.read(name))
    print(f"Restored {len(lost)} res/ entries apktool lost to Windows case-insensitivity.")
    return len(lost)


def sign(apk: Path, keystore: Path, password: str, tools: dict[str, list[str]]) -> None:
    aligned = apk.with_suffix(".aligned.apk")
    run(tools["zipalign"] + ["-f", "-p", "4", str(apk), str(aligned)])
    os.replace(aligned, apk)
    run(tools["apksigner"] + [
        "sign", "--ks", str(keystore), "--ks-key-alias", "dotabyss",
        "--v4-signing-enabled", "false",
        "--ks-pass", f"pass:{password}", "--key-pass", f"pass:{password}", str(apk),
    ])
    run(tools["apksigner"] + ["verify", "--verbose", str(apk)])


def patch_base(base: Path, output: Path, decoded: Path, font_bundle: Path | None,
               tools: dict[str, list[str]]) -> None:
    run(tools["apktool"] + ["d", "-f", "-r", str(base), "-o", str(decoded)])
    patch_activity(decoded)
    armv7 = decoded / "lib/armeabi-v7a"
    if armv7.is_dir():
        shutil.rmtree(armv7)
    if font_bundle:
        destination = decoded / "assets/bin/Data/Managed" / font_bundle.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(font_bundle, destination)
    run(tools["apktool"] + ["b", str(decoded), "-f", "-o", str(output)])
    restore_lost_entries(base, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path,
                        help="official FANZA DotAbyss X APK/XAPK; omitted = download latest from DMM")
    parser.add_argument("--gadget", type=Path, default=ROOT / "frida/gadget-android-arm64.so")
    parser.add_argument("--font-bundle", type=Path, default=ROOT / "res/ttcuyuanj",
                        help="CJK font AssetBundle; copied to assets/bin/Data/Managed/, which "
                             "Unity extracts to persistentDataPath/il2cpp/ on first run. It must "
                             "be built for the game's own Unity version -- res/notosanscjktc is "
                             "Unity 2021.3.25f1 against a 6000.3.8f1 game and renders text blank.")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/DotAbyssX-R18-zh-Hant")
    parser.add_argument("--keystore", type=Path, default=ROOT / "dotabyss.keystore")
    parser.add_argument("--password", default="123456")
    parser.add_argument("--reinject", action="store_true",
                        help="input is an APK this builder already patched: refresh only the "
                             "gadget script and re-sign, skipping the slow apktool round-trip")
    args = parser.parse_args()

    tools = resolve_tools()
    if args.input is None and args.reinject:
        args.input = args.output.with_suffix(".apk")
    if args.input is None:
        args.input = download_latest_r18()
    if not args.input.is_file():
        raise SystemExit(f"input not found: {args.input}")
    if not args.gadget.is_file():
        raise SystemExit(f"Frida arm64 gadget not found: {args.gadget}")
    if args.font_bundle and not args.font_bundle.is_file():
        raise SystemExit(f"font bundle not found: {args.font_bundle}")

    run(tools["npm"] + ["run", "build"], cwd=ROOT)
    script = ROOT / "dist/libgadget.js.so"
    config = ROOT / "frida/libgadget.config.so"
    args.output.parent.mkdir(parents=True, exist_ok=True)

    if args.reinject:
        # The smali patch, armv7 removal and font copy are already baked into the
        # input, and none of them depend on the script, so only the gadget payload
        # has to be replaced.  Turns a ~20 minute rebuild into about a minute.
        enforce_r18(args.input, tools)
        version = refuse_stale_reinject(args.input, tools)
        output = args.output.with_suffix(".apk")
        if args.input.resolve() != output.resolve():
            shutil.copy2(args.input, output)
        inject_native(output, args.gadget, script, config)
        # A previous full build may have lost res/ entries to the case collision;
        # reinject inherits that damage, so repair it here too.
        official = ROOT / "apk" / f"DotAbyssX-{version}-official.apk" if version else None
        if official and official.is_file():
            restore_lost_entries(official, output)
        else:
            print(f"warning: {official} not available; cannot check for res/ entries "
                  f"lost to Windows case-insensitivity")
        ensure_keystore(args.keystore, args.password, tools)
        sign(output, args.keystore, args.password, tools)
        print(f"rebuilt (gadget script only): {output}")
        print("Same signature as before: `adb install -r` keeps the existing save data.")
        return

    with tempfile.TemporaryDirectory(prefix="dotabyss-build-") as temp_name:
        temp = Path(temp_name)
        is_xapk = args.input.suffix.lower() in {".xapk", ".apks", ".zip"}
        if is_xapk:
            with zipfile.ZipFile(args.input) as archive:
                archive.extractall(temp / "xapk")
            apks = list((temp / "xapk").glob("*.apk"))
            inspected = [(p, inspect_apk(p, tools)) for p in apks]
            base = next((p for p, (_, _, split) in inspected if not split), None)
            if base is None:
                raise SystemExit("base APK not found inside XAPK")
            enforce_r18(base, tools)
            arm64_split = next((p for p in apks if apk_has_arm64(p)), None)
            if arm64_split is None:
                raise SystemExit("XAPK does not contain an arm64-v8a split")
            patched_base = temp / "patched-base.apk"
            patch_base(base, patched_base, temp / "decoded-base", args.font_bundle, tools)
            shutil.copy2(patched_base, base)
            inject_native(arm64_split, args.gadget, script, config)
            ensure_keystore(args.keystore, args.password, tools)
            for apk in apks:
                sign(apk, args.keystore, args.password, tools)
            output = args.output.with_suffix(".xapk")
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                for path in (temp / "xapk").rglob("*"):
                    if path.is_file():
                        archive.write(path, path.relative_to(temp / "xapk"))
        else:
            enforce_r18(args.input, tools)
            if not apk_has_arm64(args.input):
                raise SystemExit("APK has no arm64-v8a native libraries; use the arm64 variant")
            output = args.output.with_suffix(".apk")
            patch_base(args.input, output, temp / "decoded-base", args.font_bundle, tools)
            inject_native(output, args.gadget, script, config)
            ensure_keystore(args.keystore, args.password, tools)
            sign(output, args.keystore, args.password, tools)

    print(f"built: {output}")
    print("The mod uses a different signature: uninstall the official app before installing it.")


if __name__ == "__main__":
    main()
