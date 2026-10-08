#!/usr/bin/env python3
"""Prepare store links as checked-in static HTML; no runtime or build dependency."""

from __future__ import annotations

import argparse
import json
import re
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "docs/store-links.json"
INDEX = ROOT / "public/index.html"
IOS_BETA = "https://testflight.apple.com/join/bCPDwCsD"
ANDROID_BETA = "https://play.google.com/apps/testing/codes.julian.cantinarr"
ANDROID_STORE = "https://play.google.com/store/apps/details?id=codes.julian.cantinarr"


def validate(config: dict) -> None:
    if not isinstance(config, dict) or set(config) != {"ios", "android"}:
        raise ValueError("store config must contain exactly ios and android")
    for platform in ("ios", "android"):
        value = config[platform]
        if not isinstance(value, dict) or set(value) != {"released", "store_url"}:
            raise ValueError(f"{platform} must contain released and store_url")
        if type(value["released"]) is not bool:
            raise ValueError(f"{platform}.released must be true or false")
    ios_url = config["ios"]["store_url"]
    if ios_url is not None and (
        not isinstance(ios_url, str)
        or not re.fullmatch(r"https://apps\.apple\.com/app/id[1-9][0-9]*", ios_url)
    ):
        raise ValueError("ios.store_url must be a verified https://apps.apple.com/app/id<digits> URL or null")
    if config["ios"]["released"] and ios_url is None:
        raise ValueError("iOS launch is blocked until its exact App Store URL is verified")
    if config["android"]["store_url"] != ANDROID_STORE:
        raise ValueError("Android store URL must match the verified codes.julian.cantinarr package")


def link(url: str, label: str) -> str:
    return f'<a href="{escape(url, quote=True)}" target="_blank" rel="noopener">{escape(label)}</a>'


def block_pattern(name: str) -> str:
    return rf"(?P<start>^[ \t]*<!-- store-links:{name}:start -->\n).*?(?P<end>^[ \t]*<!-- store-links:{name}:end -->)"


def render(source: str, config: dict) -> str:
    validate(config)
    # Preserve the site's existing, locally owned badge artwork verbatim.
    hero = re.search(block_pattern("hero"), source, re.M | re.S)
    icons = re.findall(r'<svg class="store-mark"\s.*?</svg>', hero.group() if hero else "", re.S)
    if len(icons) != 2:
        raise ValueError("hero must contain exactly two existing store badge icons")

    ios_live, android_live = (config[key]["released"] for key in ("ios", "android"))
    urls = [config["ios"]["store_url"] if ios_live else IOS_BETA,
            ANDROID_STORE if android_live else ANDROID_BETA]
    subtitles = ["Download on the" if ios_live else "iPhone beta on",
                 "Get it on" if android_live else "Android beta on"]
    stores = ["App Store" if ios_live else "TestFlight", "Google Play"]
    badges = []
    for icon, url, subtitle, store, released in zip(icons, urls, subtitles, stores, (ios_live, android_live)):
        badges.append(
            f'        <a class="store" href="{escape(url, quote=True)}" target="_blank" rel="noopener">\n'
            f'          {icon}\n'
            f'          <span class="store-text"><span class="store-sub">{subtitle}</span><span class="store-big">{store}</span></span>\n'
            + ('' if released else '          <span class="store-chip">open</span>\n')
            + '        </a>\n'
        )
    if ios_live and android_live:
        note = ("Want early updates? Join the optional " + link(IOS_BETA, "iPhone beta")
                + " or " + link(ANDROID_BETA, "Android beta") + ".")
    elif ios_live:
        note = "Want early iPhone updates? Join the optional " + link(IOS_BETA, "iPhone beta") + "."
    elif android_live:
        note = "Want early Android updates? Join the optional " + link(ANDROID_BETA, "Android beta") + "."
    else:
        note = "The iPhone and Android betas are open to everyone. No invite needed."
    if not ios_live:
        note = "iOS is in App Store review. Try the iPhone and iPad beta on TestFlight. " + note
    ios_review = " iOS is in App Store review." if not ios_live else ""
    blocks = {
        "hero": '      <div class="stores rise d4">\n' + ''.join(badges) + '      </div>\n'
                + f'      <p class="stores-note rise d4">{note}</p>\n',
        "get": '    <p class="lede center reveal">Get Cantinarr on '
               + link(urls[0], "the App Store for iPhone and iPad" if ios_live else "TestFlight for iPhone and iPad (beta)")
               + " or " + link(urls[1], "Google Play for Android" + ("" if android_live else " (beta)"))
               + '.' + ios_review + ' Stand up the server with the compose file above, or try the demo first.</p>\n',
    }
    if android_live:
        blocks["android-dialog"] = (
            '    <p class="kicker">Android app</p>\n'
            '    <h2 class="modal-title" id="android-beta-title">Get Cantinarr on Google Play.</h2>\n'
            '    <p class="modal-body">The public Android app is available on Google Play. Beta testing is optional.</p>\n'
            f'    <a class="btn btn-gold" href="{ANDROID_STORE}" target="_blank" rel="noopener">Get on Google Play</a>\n'
            '    <p class="modal-fine">Want early updates? ' + link(ANDROID_BETA, "Join the Android beta")
            + '. Connect the app to your own Cantinarr server.</p>\n'
        )
    else:
        blocks["android-dialog"] = (
            '    <p class="kicker">Android beta</p>\n'
            '    <h2 class="modal-title" id="android-beta-title">The Android beta is open.</h2>\n'
            '    <p class="modal-body">Join the beta directly on Google Play, then install Cantinarr. No email or invitation needed.</p>\n'
            f'    <a class="btn btn-gold" href="{ANDROID_BETA}" target="_blank" rel="noopener">Join on Google Play</a>\n'
            '    <p class="modal-fine">The beta is free. Connect it to your own Cantinarr server.</p>\n'
        )
    for name, content in blocks.items():
        source, count = re.subn(block_pattern(name), lambda m: m["start"] + content + m["end"], source, flags=re.M | re.S)
        if count != 1:
            raise ValueError(f"expected exactly one store-links:{name} block, found {count}")
    return source


def check() -> list[str]:
    try:
        source = INDEX.read_text(encoding="utf-8")
        expected = render(source, json.loads(CONFIG.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        return [f"store links: {exc}"]
    if source != expected:
        return ["store links differ from docs/store-links.json; run python3 scripts/store_links.py --write"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="update the static homepage from the reviewed launch config")
    args = parser.parse_args()
    if args.write:
        try:
            output = render(INDEX.read_text(encoding="utf-8"), json.loads(CONFIG.read_text(encoding="utf-8")))
            INDEX.write_text(output, encoding="utf-8")
        except (OSError, ValueError) as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
    errors = check()
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    if not errors:
        print("Static store links match the reviewed launch config.")
    return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())
