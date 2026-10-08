import copy
import importlib.util
import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("store_links", Path(__file__).parents[1] / "store_links.py")
links = importlib.util.module_from_spec(spec)
spec.loader.exec_module(links)


class StoreLinkTests(unittest.TestCase):
    def setUp(self):
        self.source = links.INDEX.read_text(encoding="utf-8")
        self.config = json.loads(links.CONFIG.read_text(encoding="utf-8"))
        self.config["ios"]["released"] = False
        self.config["android"]["released"] = False

    def region(self, output, name):
        return re.search(links.block_pattern(name), output, re.M | re.S).group()

    def test_checked_in_homepage_matches_config(self):
        self.assertEqual(links.check(), [])

    def test_all_independent_launch_states(self):
        for ios_live in (False, True):
            for android_live in (False, True):
                with self.subTest(ios=ios_live, android=android_live):
                    config = copy.deepcopy(self.config)
                    config["ios"]["released"] = ios_live
                    config["android"]["released"] = android_live
                    output = links.render(self.source, config)
                    hero = self.region(output, "hero")
                    primary = re.findall(r'<a class="store" href="([^"]+)"', hero)
                    self.assertEqual(primary, [config["ios"]["store_url"] if ios_live else links.IOS_BETA,
                                               links.ANDROID_STORE if android_live else links.ANDROID_BETA])
                    self.assertEqual(hero.count('class="store-chip"'), 2 - int(ios_live) - int(android_live))
                    get = self.region(output, "get")
                    self.assertEqual(re.findall(r'<a href="([^"]+)"', get), primary)
                    self.assertEqual(get.count("(beta)"), 2 - int(ios_live) - int(android_live))
                    for region in (hero, get):
                        self.assertEqual("iOS is in App Store review." in region, not ios_live)
                    dialog = self.region(output, "android-dialog")
                    expected_android = links.ANDROID_STORE if android_live else links.ANDROID_BETA
                    self.assertIn(f'class="btn btn-gold" href="{expected_android}"', dialog)
                    self.assertIn(links.ANDROID_BETA, dialog)
                    if ios_live or android_live:
                        self.assertIn(links.IOS_BETA, hero)
                        self.assertIn(links.ANDROID_BETA, hero)
                        self.assertIn("optional", hero)
                    note = re.search(r'<p class="stores-note rise d4">(.*?)</p>', hero).group(1)
                    if ios_live and not android_live:
                        self.assertNotIn(links.ANDROID_BETA, note)
                    if android_live and not ios_live:
                        self.assertNotIn(links.IOS_BETA, note)
                    self.assertIn('id="android-beta"', output)
                    self.assertIn('id="android-beta-title"', output)
                    self.assertEqual(links.render(output, config), output)

    def test_switching_back_to_beta_restores_beta_copy(self):
        live = copy.deepcopy(self.config)
        for value in live.values():
            value["released"] = True
        output = links.render(links.render(self.source, live), self.config)
        self.assertEqual(output, links.render(self.source, self.config))
        self.assertNotIn(links.ANDROID_STORE, output)
        self.assertNotIn(self.config["ios"]["store_url"], output)

    def test_unknown_ios_url_can_only_stay_in_beta(self):
        self.config["ios"]["store_url"] = None
        self.assertIn(links.IOS_BETA, links.render(self.source, self.config))
        self.config["ios"]["released"] = True
        with self.assertRaisesRegex(ValueError, "iOS launch is blocked"):
            links.render(self.source, self.config)

    def test_invalid_urls_and_flags_fail_closed(self):
        invalid_ios = ["", "https://apps.apple.com/app/idTODO", "http://apps.apple.com/app/id6744379934",
                       links.IOS_BETA, "https://apps.apple.com.evil.example/app/id6744379934",
                       'https://apps.apple.com/app/id6744379934" onclick="alert(1)', 6744379934]
        for url in invalid_ios:
            with self.subTest(url=url):
                config = copy.deepcopy(self.config)
                config["ios"]["store_url"] = url
                with self.assertRaises(ValueError):
                    links.render(self.source, config)
        for url in [links.ANDROID_BETA, links.ANDROID_STORE + ".wrong", None]:
            config = copy.deepcopy(self.config)
            config["android"]["store_url"] = url
            with self.assertRaises(ValueError):
                links.render(self.source, config)
        for flag in ["false", "true", 0, 1, None]:
            for platform in ("ios", "android"):
                config = copy.deepcopy(self.config)
                config[platform]["released"] = flag
                with self.assertRaises(ValueError):
                    links.render(self.source, config)

    def test_malformed_config_fails_with_readable_error(self):
        for config in [[], None, {}, {"ios": None, "android": None},
                       dict(self.config, unexpected=True)]:
            with self.subTest(config=config), self.assertRaises(ValueError):
                links.render(self.source, config)

    def test_missing_or_duplicate_regions_fail_closed(self):
        for name in ("hero", "get", "android-dialog"):
            region = self.region(self.source, name)
            for source in (self.source.replace(region, ""), self.source + "\n" + region):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    links.render(source, self.config)

    def test_unrelated_content_and_existing_artwork_are_preserved(self):
        config = copy.deepcopy(self.config)
        for value in config.values():
            value["released"] = True
        output = links.render(self.source, config)
        def strip_regions(source):
            for name in ("hero", "get", "android-dialog"):
                source = re.sub(links.block_pattern(name), "", source, flags=re.M | re.S)
            return source
        self.assertEqual(strip_regions(output), strip_regions(self.source))
        self.assertEqual(re.findall(r'<svg.*?</svg>', output, re.S), re.findall(r'<svg.*?</svg>', self.source, re.S))

    def test_drift_is_reported_without_writing_files(self):
        source = self.source.replace("Get Cantinarr on ", "Wrong copy ")
        with patch.object(Path, "read_text", side_effect=[source, json.dumps(self.config)]):
            self.assertEqual(len(links.check()), 1)


if __name__ == "__main__":
    unittest.main()
