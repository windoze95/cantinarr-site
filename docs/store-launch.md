# Store launch links

This is launch preparation only. Both `released` flags in
[`store-links.json`](store-links.json) stay `false` while the apps are in beta and
Apple review is pending. Do not merge or deploy a public-store cutover during the
code freeze. The flags control marketing links, not store releases or tester
enrollment.

## Verified destinations

| Platform | Public-store destination | Identity evidence |
| --- | --- | --- |
| iPhone / iPad | <https://apps.apple.com/app/id6744379934> | Actual [successful TestFlight distribution job](https://github.com/windoze95/cantinarr/actions/runs/34771870828/job/103765493180) resolves bundle `codes.julian.cantinarr` to app `6744379934` |
| Android | <https://play.google.com/store/apps/details?id=codes.julian.cantinarr> | [Android publishing configuration](https://github.com/windoze95/cantinarr/blob/ea19d63ec849108d35fec26d5659ca7901f81580/app/android/fastlane/Fastfile#L3) and the Google Play listing identify `codes.julian.cantinarr` |

These are verified app identities, not confirmation that production is available.
On 2026-09-30 the Play listing was readable but its release notes still said
`beta`; the App Store URL could not be validated publicly. A visible Play listing
can also belong to open testing. Confirm actual production availability for an
ordinary non-tester account before changing either flag.

The intentional opt-in destinations remain:

- iPhone / iPad: <https://testflight.apple.com/join/bCPDwCsD>
- Android: <https://play.google.com/apps/testing/codes.julian.cantinarr>

## When a store release is actually available

1. Confirm review/release completion, supported regions and install availability
   with a non-tester account. Recheck the app identity and store URL. A successful
   upload, beta build or review approval alone is not public availability.
2. In `docs/store-links.json`, set `released` to `true` only for the confirmed
   platform. The two platforms can launch independently. Keep an unavailable
   platform in beta; never substitute a placeholder URL.
3. Run `python3 scripts/store_links.py --write`, then review the resulting
   `public/index.html` diff. This updates both hero badges, the final download
   sentence, optional beta links, and the legacy Android dialog together.
4. Run `python3 scripts/verify_site.py`,
   `python3 -m unittest discover -s scripts/tests -v` and
   `node --test scripts/tests/test_board_review.mjs`. Inspect phone and desktop
   layouts and the dialog flows described in [the test checklist](testing.md).
5. Commit the config and generated HTML in the same reviewed PR. Obtain launch
   approval before merging. This repository deploys changes under `public/` on
   merge to `main`.
6. After the authorized deployment, verify the live CTAs, store availability and
   legacy fragment. Rollback means restoring that platform's `released: false`,
   regenerating the HTML, testing and reviewing the resulting change.

The site remains plain static HTML with no build step or runtime configuration
request. The preparation script runs only when changing store state. Its output
is checked in; `verify_site.py` rejects config/HTML drift. No new runtime files,
remote scripts, packages, framework or deployment behavior are introduced.

## Surface inventory

### Owned by this marketing-site PR

- `public/index.html`: hero badge destinations, store names and beta chips;
  supporting copy; final download links and copy; the `#android-beta` dialog
- `docs/testing.md`: current-state and launch-state smoke expectations
- `scripts/verify_site.py`: static link/config consistency guard

Keep `/#android-beta` working. Existing apps still link to it. Before the Android
release it opens the current beta dialog; after release it opens a public-store
download dialog with a clearly secondary optional beta link. Its ID, close
button, focus behavior, Escape/backdrop handling and fragment cleanup remain.

### Read-only audit: separate future work in the core repository

No core code or documentation is changed by this PR. Revisit these when planning
the post-review launch; this list does not authorize a campaign or another PR.

- [Root README beta badges and install links](https://github.com/windoze95/cantinarr/blob/ea19d63ec849108d35fec26d5659ca7901f81580/README.md#L17-L18), plus [the app section](https://github.com/windoze95/cantinarr/blob/ea19d63ec849108d35fec26d5659ca7901f81580/README.md#L53-L56)
- [Public apps guide](https://github.com/windoze95/cantinarr/blob/ea19d63ec849108d35fec26d5659ca7901f81580/docs-site/src/content/docs/use/apps.md#L3-L18)
- [Public update guide](https://github.com/windoze95/cantinarr/blob/ea19d63ec849108d35fec26d5659ca7901f81580/docs-site/src/content/docs/install/updates.md#L51-L65)
- [Phone-app sheet destinations](https://github.com/windoze95/cantinarr/blob/ea19d63ec849108d35fec26d5659ca7901f81580/app/lib/core/widgets/phone_apps_sheet.dart#L9-L10) and [beta-only subtitles](https://github.com/windoze95/cantinarr/blob/ea19d63ec849108d35fec26d5659ca7901f81580/app/lib/core/widgets/phone_apps_sheet.dart#L71-L82)
- [App README description of the phone-app sheet](https://github.com/windoze95/cantinarr/blob/ea19d63ec849108d35fec26d5659ca7901f81580/app/README.md#L225)

The documentation source lives in `windoze95/cantinarr/docs-site/`, even though
this repository publishes docs.cantinarr.com. Updating this site alone does not
change those guides or the app's iOS link.

No beta links or beta-only copy were found in `windoze95/cantinarr-unraid` at
`4aba08d61ac2c987220722c8a068e497f7efeae3`. Its [template](https://github.com/windoze95/cantinarr-unraid/blob/4aba08d61ac2c987220722c8a068e497f7efeae3/templates/cantinarr.xml#L11-L15)
consumes the core README, so that is an indirect surface to recheck later.
Operational beta workflows, release documentation, and hidden settings-search
aliases remain valid for ongoing testing and should not be blindly replaced.

User beta-to-production communications are deferred until after Apple review.
