# Marketing Site Test Checklist

- [ ] `COPY-001` · P1 · UI: The homepage leads with media requests and server management. Verify the hero, page title, social descriptions, and JSON-LD agree; keep assistant and automation details after setup. Check all visible copy for em dashes, unsupported promises, and requester-facing implementation jargon. Inspect headline wrapping at phone and desktop widths and confirm the social image still matches the pitch.

- [ ] `REL-016` · P1 · LIVE: Verify the Documentation navigation/footer links and setup calls to action reach docs.cantinarr.com. After a documentation publication, check the custom domain, a nested guide, local search, a real 404, security headers, and the footer's exact source revision. Confirm `Deploy Docs` waits for green CI on the current core main SHA and skips an already published SHA. The documentation source remains in the core repository; this repository owns only its publication and marketing links.

- [ ] `REL-012` · P1 · UI — Validate the homepage, 404 page, and header policy at phone and desktop sizes; verify navigation, screenshots, self-host snippet, demo, store badges, privacy, and canonical links. At phone widths, the Menu control must expose Features, Self-host, Docs, Roadmap, Live demo, Discord, and GitHub; it must close after choosing a link, clicking outside, or pressing Escape. Store badges and final download links must match each platform's reviewed state in `docs/store-links.json`: beta destinations while `released` is false, public-store destinations only after verified production release. Unreleased platforms must keep explicit beta labels; released badges must not have an open-beta chip. Once either platform is released, optional beta links remain clearly secondary. Landing on legacy `/#android-beta` must open the Android dialog with the appropriate primary destination and, after launch, an optional tester link. Verify initial focus, Esc/backdrop/Close, repeated opening, Back/Forward and hash changes; closing must drop the fragment so a reload does not reopen it. Other fragments (`#features`, `#get`) must remain plain anchors. Confirm no Android invite-only or email-for-access instructions remain. See [store launch preparation](store-launch.md) for the activation checklist and read-only cross-repository audit.
- [ ] `REL-013` · P1 · LIVE — Deploy `public/` through the Cloudflare workflow or manual Wrangler path; verify the `cantinarr` project, cache policy, assets, fonts, and live smoke without a build step.
- [ ] `REL-014` · P1 · SEC/UI — Run the static verifier, accessibility and keyboard checks, contrast and overflow review, and verify no secret, environment value, repo instruction, or local path enters `public/`. While iOS is awaiting review, confirm both the hero and download section explicitly say it is in App Store review and use TestFlight. Android's released state must use the public Google Play listing and retain an optional beta link.
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
