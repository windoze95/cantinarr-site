#!/usr/bin/env python3
"""Verify the standalone static site without network access or dependencies."""

from __future__ import annotations

import json
import re
import struct
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
EXPECTED_TOP_LEVEL = {"404.html", "_headers", "index.html", "site.css", "static"}
REQUIRED_INDEX_META = {
    "description",
    "og:description",
    "og:image",
    "og:image:alt",
    "og:image:height",
    "og:image:width",
    "og:title",
    "og:type",
    "og:url",
    "twitter:card",
    "twitter:description",
    "twitter:image",
    "twitter:image:alt",
    "twitter:title",
    "viewport",
}
FORBIDDEN_PUBLIC_PATTERNS = {
    "Cloudflare API token name": re.compile(r"CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)"),
    "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    "local user path": re.compile(r"/(?:Users|home)/[^/\s]+/"),
}


class SiteHTMLParser(HTMLParser):
    def __init__(self, source: Path) -> None:
        super().__init__(convert_charrefs=True)
        self.source = source
        self.references: list[str] = []
        self.ids: set[str] = set()
        self.meta: dict[str, str] = {}
        self.canonical: str | None = None
        self.lang: str | None = None
        self.title_parts: list[str] = []
        self.in_title = False
        self.h1_count = 0
        self.errors: list[str] = []

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        attrs = {key.lower(): value or "" for key, value in attrs_list}
        tag = tag.lower()

        if tag == "html":
            self.lang = attrs.get("lang")
        if tag == "title":
            self.in_title = True
        if tag == "h1":
            self.h1_count += 1
        if "id" in attrs:
            self.ids.add(attrs["id"])

        if tag in {"a", "link"} and "href" in attrs:
            self.references.append(attrs["href"])
        if tag in {"img", "script", "source"} and "src" in attrs:
            self.references.append(attrs["src"])

        if tag == "img" and "alt" not in attrs:
            self.errors.append(f"{self.source}: image is missing an alt attribute")

        if tag == "a" and attrs.get("target") == "_blank":
            rel = set(attrs.get("rel", "").split())
            if "noopener" not in rel:
                self.errors.append(
                    f"{self.source}: target=_blank link is missing rel=noopener: {attrs.get('href', '')}"
                )

        if tag == "meta":
            key = attrs.get("name") or attrs.get("property")
            if key:
                self.meta[key] = attrs.get("content", "")

        if tag == "link" and "canonical" in attrs.get("rel", "").split():
            self.canonical = attrs.get("href")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)

    @property
    def title(self) -> str:
        return "".join(self.title_parts).strip()


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def local_target(source: Path, raw: str, errors: list[str]) -> tuple[Path | None, str]:
    if not raw or raw.startswith(("mailto:", "tel:", "data:")):
        return None, ""

    parsed = urlsplit(raw)
    if parsed.scheme:
        if parsed.scheme != "https":
            fail(errors, f"{source}: external URL must use HTTPS: {raw}")
        return None, parsed.fragment
    if parsed.netloc:
        fail(errors, f"{source}: protocol-relative URL is not allowed: {raw}")
        return None, parsed.fragment
    if not parsed.path:
        return source, parsed.fragment

    decoded = unquote(parsed.path)
    target = PUBLIC / decoded.lstrip("/") if decoded.startswith("/") else source.parent / decoded
    target = target.resolve()
    try:
        target.relative_to(PUBLIC.resolve())
    except ValueError:
        fail(errors, f"{source}: local reference escapes public/: {raw}")
        return None, parsed.fragment

    if target == PUBLIC.resolve() or target.is_dir():
        target = target / "index.html"
    if not target.exists():
        fail(errors, f"{source}: missing local target for {raw}: {target.relative_to(ROOT)}")
        return None, parsed.fragment
    return target, parsed.fragment


def png_dimensions(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"not a PNG: {path}")
    return struct.unpack(">II", header[16:24])


def verify() -> list[str]:
    errors: list[str] = []
    if not PUBLIC.is_dir():
        return ["public/ is missing"]

    top_level = {path.name for path in PUBLIC.iterdir()}
    if top_level != EXPECTED_TOP_LEVEL:
        fail(
            errors,
            f"public/ top-level entries differ: expected {sorted(EXPECTED_TOP_LEVEL)}, got {sorted(top_level)}",
        )

    for path in PUBLIC.rglob("*"):
        if path.is_symlink():
            fail(errors, f"public/ must not contain symlinks: {path.relative_to(ROOT)}")

    documents: dict[Path, SiteHTMLParser] = {}
    for html_path in sorted(PUBLIC.glob("*.html")):
        text = html_path.read_text(encoding="utf-8")
        parser = SiteHTMLParser(html_path)
        parser.feed(text)
        parser.close()
        documents[html_path.resolve()] = parser
        errors.extend(parser.errors)

        if parser.lang != "en":
            fail(errors, f"{html_path}: html lang must be en")
        if not parser.title:
            fail(errors, f"{html_path}: title is missing")
        if parser.h1_count != 1:
            fail(errors, f"{html_path}: expected exactly one h1, found {parser.h1_count}")

        for block in re.findall(
            r"<script\b[^>]*\btype=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
            text,
            flags=re.IGNORECASE | re.DOTALL,
        ):
            try:
                json.loads(block)
            except json.JSONDecodeError as exc:
                fail(errors, f"{html_path}: invalid JSON-LD: {exc}")

    index = documents.get((PUBLIC / "index.html").resolve())
    if index:
        missing_meta = REQUIRED_INDEX_META - set(index.meta)
        if missing_meta:
            fail(errors, f"index.html: missing metadata: {sorted(missing_meta)}")
        if index.canonical != "https://cantinarr.com/":
            fail(errors, f"index.html: canonical URL is {index.canonical!r}")

        og_url = index.meta.get("og:image", "")
        og_path = PUBLIC / urlsplit(og_url).path.lstrip("/")
        if og_path.is_file():
            try:
                width, height = png_dimensions(og_path)
                declared = (
                    int(index.meta.get("og:image:width", "0")),
                    int(index.meta.get("og:image:height", "0")),
                )
                if declared != (width, height):
                    fail(errors, f"index.html: OG dimensions {declared} do not match {(width, height)}")
            except (ValueError, OSError) as exc:
                fail(errors, f"index.html: cannot validate OG image: {exc}")
        else:
            fail(errors, f"index.html: OG image does not resolve inside public/: {og_url}")

    not_found = documents.get((PUBLIC / "404.html").resolve())
    if not_found and not_found.meta.get("robots") != "noindex":
        fail(errors, "404.html: robots metadata must be noindex")

    for source, parser in documents.items():
        for raw in parser.references:
            target, fragment = local_target(source, raw, errors)
            if target and fragment and target.suffix == ".html":
                target_doc = documents.get(target.resolve())
                if target_doc and fragment not in target_doc.ids:
                    fail(errors, f"{source}: missing fragment target: {raw}")

    css_url_pattern = re.compile(r"url\(([^)]+)\)")
    for css_path in sorted(PUBLIC.glob("*.css")):
        css = css_path.read_text(encoding="utf-8")
        for match in css_url_pattern.finditer(css):
            raw = match.group(1).strip().strip("\"'")
            local_target(css_path.resolve(), raw, errors)

    for path in PUBLIC.rglob("*"):
        if not path.is_file() or path.suffix.lower() in {".png", ".woff2"}:
            continue
        text = path.read_text(encoding="utf-8")
        for label, pattern in FORBIDDEN_PUBLIC_PATTERNS.items():
            if pattern.search(text):
                fail(errors, f"{path.relative_to(ROOT)}: contains forbidden {label}")

    font_licenses = {
        "fraunces-var.woff2": ROOT / "LICENSES/Fraunces-OFL.txt",
        "schibsted-var.woff2": ROOT / "LICENSES/SchibstedGrotesk-OFL.txt",
        "plexmono-400.woff2": ROOT / "LICENSES/IBMPlexMono-OFL.txt",
        "plexmono-600.woff2": ROOT / "LICENSES/IBMPlexMono-OFL.txt",
    }
    for font_name, license_path in font_licenses.items():
        if (PUBLIC / "static/fonts" / font_name).is_file() and not license_path.is_file():
            fail(errors, f"missing bundled-font license: {license_path.relative_to(ROOT)}")

    return errors


def main() -> int:
    errors = verify()
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    files = sum(1 for path in PUBLIC.rglob("*") if path.is_file())
    print(f"Verified {files} public files: references, metadata, JSON-LD, OG image, and secret boundary are valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
