# Marketing Site Test Checklist

- [ ] `COPY-001` · P1 · UI: The homepage leads with media requests and server management. Verify the hero, page title, social descriptions, and JSON-LD agree; keep assistant and automation details after setup. Check all visible copy for em dashes, unsupported promises, and requester-facing implementation jargon. Inspect headline wrapping at phone and desktop widths and confirm the social image still matches the pitch.

- [ ] `REL-016` · P1 · LIVE: Verify the Documentation navigation/footer links and setup calls to action reach docs.cantinarr.com. After a documentation publication, check the custom domain, a nested guide, local search, a real 404, security headers, and the footer's exact source revision. Confirm `Deploy Docs` waits for green CI on the current core main SHA and skips an already published SHA. The documentation source remains in the core repository; this repository owns only its publication and marketing links.

- [ ] `REL-012` · P1 · UI — Validate the homepage, 404 page, and header policy at phone and desktop sizes; verify navigation, screenshots, self-host snippet, demo, store badges, privacy, and canonical links. At phone widths, the Menu control must expose Features, Self-host, Docs, Roadmap, Live demo, Discord, and GitHub; it must close after choosing a link, clicking outside, or pressing Escape. Store badges and final download links must match each platform's reviewed state in `docs/store-links.json`: beta destinations while `released` is false, public-store destinations only after verified production release. Unreleased platforms must keep explicit beta labels; released badges must not have an open-beta chip. Released Android acquisition links must not offer beta enrollment; intentional tester links stay in the release documentation. Landing on legacy `/#android-beta` must open the Android dialog with the appropriate primary destination and, after launch, no beta opt-in link. Verify initial focus, Esc/backdrop/Close, repeated opening, Back/Forward and hash changes; closing must drop the fragment so a reload does not reopen it. Other fragments (`#features`, `#get`) must remain plain anchors. Confirm no Android invite-only or email-for-access instructions remain. See [store launch preparation](store-launch.md) for the activation checklist and read-only cross-repository audit.
- [ ] `REL-013` · P1 · LIVE — Deploy `public/` through the Cloudflare workflow or manual Wrangler path; verify the `cantinarr` project, cache policy, assets, fonts, and live smoke without a build step.
- [ ] `REL-014` · P1 · SEC/UI — Run the static verifier, accessibility and keyboard checks, contrast and overflow review, and verify no secret, environment value, repo instruction, or local path enters `public/`. While iOS is awaiting review, confirm both the hero and download section explicitly say it is in App Store review and use TestFlight. Android's released state must use the public Google Play listing without beta wording or opt-in links.
- [ ] `REL-015` · P1 · BOARD — Exercise `/roadmap/`: the list loads, the Shipped heading shows a prominent count matching the visible shipped items, separate Up and Down controls show independent totals (never a net score), selecting the opposite switches the anonymous vote, selecting the active direction clears it, and selection/totals survive a reload and back/forward navigation, a submission passes Turnstile and lands in the pending queue, admin approve/decline/status/delete flows work at `/roadmap/admin.html`, rate limits return friendly errors, and a wrong admin token is rejected. On the admin page, pending ideas appear first in age order, planned and open ideas by upvotes with both totals visible, then declined ideas; shipped ideas are collapsed under a prominent count. Already accepted ideas without a Luna review record do not say they are awaiting review. Check the count and Shipped disclosure at phone widths.
- [ ] `REL-017` · P1 · BOARD — With a test `OPENAI_API_KEY`, submit clear in-scope and out-of-scope ideas and verify GPT-6 Luna automatically opens or declines them and records reasons in the admin queue. A partial overlap stays pending for human review; decline as a duplicate only when an existing item covers the entire request. Uncertain ideas and failed calls stay pending. Check that ntfy names the outcome (approved, denied, needs review, or review pending) once per completed attempt, that a later successful retry sends its final decision, and that a late AI result after an admin change does not claim an AI decision. Verify a failed review retries after the backoff on a later public or admin board load, an old pending idea gets reviewed on a board load, and unauthorized callers cannot see the decision reason. Without the key, submissions and manual moderation still work and ntfy says needs review.

## Local directional-vote checks

Run `node --test scripts/tests/test_board_*.mjs` for moderation, old-schema
upgrade/data preservation, directional writes, idempotent retries, concurrent
requests and rate-limit races, transaction rollback, compatibility, client
repeated taps, lost replies, malformed responses, and history restoration.
The Verify Site workflow runs these tests on Node 25.

For the HTTP integration smoke, use a **disposable local D1 state directory**:

1. Put `ADMIN_TOKEN=local-roadmap-qa` and an empty `TURNSTILE_SITE_KEY=` in the
   ignored `.dev.vars` file. Do not copy production secrets. No AI or notification
   keys are needed. The smoke uses the bootstrap moderation path.
2. Run `npx wrangler pages dev public --ip 127.0.0.1 --port 8791
   --persist-to .wrangler/local-roadmap` (one command).
3. Run `python3 scripts/smoke_board_votes.py`. If the local admin token differs,
   set `BOARD_TEST_ADMIN_TOKEN` in the environment. The script refuses remote
   hosts, creates one local suggestion, approves it, and checks repeats,
   concurrent votes, switching/removal, cookie-backed reads, independent
   public/admin totals, unauthorized admin access, and the shipped vote lock.
   It leaves one open fixture with 1 upvote and 1 downvote for visual inspection.
4. Inspect `/roadmap/` and `/roadmap/admin.html` at phone and desktop widths.
   Test keyboard focus, repeated taps while a request is pending, switch/remove,
   reload and back/forward, long titles, readable contrast and no horizontal
   overflow. Both buttons lock while a vote is in flight. A failed reply refreshes
   the item from the server; if that refresh also fails, voting stays locked until
   reload. Check a real rate-limit error as well as the automated failure cases.

## Schema and API compatibility

`ensureSchema` in `functions/api/board/_util.js` creates or upgrades the schema
on first use. Existing `votes` rows gain `direction TEXT NOT NULL DEFAULT 'up'`
with a check restricting values to `up` or `down`. The upgrade only adds this
column: feature IDs, voter IDs, salted IP hashes and timestamps stay intact.
Concurrent initialization is coalesced per binding; different worker isolates
recheck the column after an upgrade race. Failed initialization can retry.
Test the upgrade against an old-schema fixture locally before an authorized
release. Do not run a remote migration or rewrite live votes for draft PR QA.

New POST `/api/board/vote` requests send `{ "id": 123, "vote": "up" }`,
`"down"`, or `null` to clear. These are desired states, so repeating a request
cannot insert duplicates or accidentally toggle back. The UI maps the active
button to `null` and the opposite button to its direction. D1 executes the
status/rate guard, mutation and count read in one transaction. Switching keeps
the original row's IP hash and timestamp; clearing deletes that vote row.
Only `open` and `planned` items accept votes. Public ranking and admin sorting
continue to use upvotes; downvotes never subtract from that order.

Public and admin reads return `upvotes` and `downvotes`; public reads and vote
responses also return the caller's `vote` (`up`, `down`, or `null`). Public GET
establishes the anonymous cookie before controls become available. Identity
remains cookie-based, not an account or a guarantee of one vote per human.
Legacy `{ "id": 123 }` POSTs retain upvote-toggle behavior for cached pages.
Legacy `votes` and `voted` response fields mean **upvotes only** and **selected
upvote only**, never total participation or net score. Old cached pages show
only upvotes until reloaded. Production data is not downgraded or rebuilt.

## Text-browser edition

`/text/` is a separate, static HTML edition for Lynx, w3m, Links, and browsers
with CSS or JavaScript disabled. It includes product information, a complete
Compose example, reviewed app destinations, and project links. Keep its store
links and beta labels in sync with `docs/store-links.json` when a platform's
release state changes. `python3 scripts/verify_site.py` checks its navigation,
setup, store destinations, and absence of visual or script dependencies.

Serve `public/` with `python3 -m http.server 8790 --directory public`, then run
`lynx -dump -width=80 http://127.0.0.1:8790/text/` or
`w3m -dump -cols 80 http://127.0.0.1:8790/text/`. Inspect heading order, numbered
links, setup commands, and Compose indentation. Check a narrower terminal too.
In an interactive terminal browser, follow the section links, return to the top,
and follow the homepage link. The graphical homepage must expose a direct
Text edition link and remain readable with JavaScript disabled. The demo/app
and roadmap board are JavaScript applications; the text page explains this
before sending users to them. Terminal support covers the marketing page and
setup instructions, not a terminal UI for the app or voting API.

## Media shelf and request walkthrough

Serve `public/` locally. Check the homepage at 1440, 800, 390, and 320 pixels,
plus a short landscape viewport. The illustrated jackets link to the matching
media sections; on phones the shelf scrolls horizontally. Main-page scrolling
stays native. At the start of Browse, the phone and request slip must already
be visible beside the first chapter. Follow all three steps while scrolling
down and back up; check the actual panel position as well as the active label.
Browse, Request, and Ready links jump to their narrative steps,
and the highlighted link, example request status, and progress line agree with
the visible step. The final app view shows the title and availability controls.
The request slip demonstrates the flow alongside real app screens.

Check reduced motion (no shelf movement, smooth scrolling, or fades), JavaScript
disabled (headings, navigation, disclosure content, setup, and downloads remain
usable), keyboard focus, Menu close on Escape/outside click/link selection,
clipboard success and denied access, and the legacy `/#android-beta` dialog.
On short screens the product view scrolls normally instead of staying fixed.
The homepage stylesheet is isolated from roadmap/admin/404 styling. New
stylesheet and script filenames must change before a later deployed edit,
because `/static/*` responses are cached immutably.

## Native apps and push preview

The opening must name the native iPhone/iPad/Android apps and show their two
store badges before the media shelf. Their destinations and release labels
still come from `docs/store-links.json`. Keep the generated `hero` region in
the opening and the generated `get` links at the bottom.

Scroll Browse, Request, Ready, and back. The notification appears only at Ready,
using the app's movie-available wording, and leaves when returning to Request.
Browse and Request keep the Discover screen; Ready shows the Available screen.
Check the notification does not cover the Available control, touch targets,
or narrative copy at desktop and phone widths. With reduced motion it appears
without sliding or fading. No notification permission prompt or external push
request is part of this website preview.

## Mobile shelf scroll

On a phone, scroll the page down past the opening. The shelf moves from Movies
and TV shows to Books and Music, with both final jackets visible before the
shelf passes the navigation. Scroll back up to reverse it. The page keeps its
normal vertical scrolling and the desktop shelf keeps its existing movement.

A vertical touch that starts over the shelf must keep this behavior. A
horizontal swipe, horizontal or Shift-wheel gesture, or keyboard focus within
the shelf gives the visitor manual horizontal control for the rest of the visit;
later page scrolling must not pull it back. Reduced motion and JavaScript off
keep the manual horizontal shelf. Check 390px and 320px, no document overflow,
and resize across the 800px breakpoint.

Run `node --test scripts/tests/test_shelf_scroll.mjs` for progress, reversing,
manual takeover, and desktop/reduced-motion boundaries.
