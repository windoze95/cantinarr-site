import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('docs_release', Path(__file__).parents[1] / 'docs_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

SHA = 'a' * 40
GREEN = {'head_sha': SHA, 'head_branch': 'main', 'event': 'push', 'name': 'CI',
         'status': 'completed', 'conclusion': 'success',
         'head_repository': {'full_name': 'windoze95/cantinarr'}}


class DocumentationPublicationTests(unittest.TestCase):
    def test_only_exact_current_main_push_is_evidence(self):
        self.assertTrue(release.has_green_ci(SHA, [GREEN]))
        for key, value in [('head_sha', 'b' * 40), ('head_branch', 'feature'),
                           ('event', 'pull_request'), ('name', 'Docker'),
                           ('status', 'in_progress'), ('conclusion', 'failure'),
                           ('head_repository', {'full_name': 'contributor/cantinarr'})]:
            with self.subTest(key=key):
                self.assertFalse(release.has_green_ci(SHA, [dict(GREEN, **{key: value})]))
        self.assertFalse(release.has_green_ci(SHA, []))

    def test_preview_failed_or_old_deployments_do_not_suppress_publication(self):
        deployment = {'environment': 'production', 'latest_stage': {'status': 'success'},
                      'deployment_trigger': {'metadata': {'commit_hash': SHA}}}
        self.assertTrue(release.already_published(SHA, {'canonical_deployment': deployment}))
        self.assertFalse(release.already_published('b' * 40, {'canonical_deployment': deployment}))
        self.assertFalse(release.already_published(SHA, {'latest_deployment': deployment}))
        self.assertFalse(release.already_published(SHA, {'canonical_deployment': None}))
        for key, value in [('environment', 'preview'), ('latest_stage', {'status': 'failure'})]:
            changed = copy.deepcopy(deployment)
            changed[key] = value
            self.assertFalse(release.already_published(SHA, {'canonical_deployment': changed}))

    def test_refs_are_not_accepted_as_commit_hashes(self):
        self.assertEqual(release.verified_sha(SHA), SHA)
        for value in ['main', 'aaaaaaa', SHA + '\nready=true', None]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    release.verified_sha(value)


if __name__ == '__main__':
    unittest.main()
