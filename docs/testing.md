# Marketing Site Test Checklist

- [ ] `COPY-001` · P1 · UI: The homepage leads with media requests and server management. Verify the hero, page title, social descriptions, and JSON-LD agree; keep assistant and automation details after setup. Check all visible copy for em dashes, unsupported promises, and requester-facing implementation jargon. Inspect headline wrapping at phone and desktop widths and confirm the social image still matches the pitch.

- [ ] `REL-016` · P1 · LIVE: Verify the Documentation navigation/footer links and setup calls to action reach docs.cantinarr.com. After a documentation publication, check the custom domain, a nested guide, local search, a real 404, security headers, and the footer's exact source revision. Confirm `Deploy Docs` waits for green CI on the current core main SHA and skips an already published SHA. The documentation source remains in the core repository; this repository owns only its publication and marketing links.

- [ ] `REL-012` · P1 · UI — Validate the homepage, 404 page, and header policy at phone and desktop sizes; verify navigation, screenshots, self-host snippet, demo, store badges, privacy, and canonical links. At phone widths, the Menu control must expose Features, Self-host, Docs, Roadmap, Live demo, Discord, and GitHub; it must close after choosing a link, clicking outside, or pressing Escape. Store badges and final download links must match each platform's reviewed state in `docs/store-links.json`: beta destinations while `released` is false, public-store destinations only after verified production release. Unreleased platforms must keep explicit beta labels; released badges must not have an open-beta chip. Released Android acquisition links must not offer beta enrollment; intentional tester links stay in the release documentation. Landing on legacy `/#android-beta` must open the Android dialog with the appropriate primary destination and, after launch, no beta opt-in link. Verify initial focus, Esc/backdrop/Close, repeated opening, Back/Forward and hash changes; closing must drop the fragment so a reload does not reopen it. Other fragments (`#features`, `#get`) must remain plain anchors. Confirm no Android invite-only or email-for-access instructions remain. See [store launch preparation](store-launch.md) for the activation checklist and read-only cross-repository audit.
- [ ] `REL-013` · P1 · LIVE — Deploy `public/` through the Cloudflare workflow or manual Wrangler path; verify the `cantinarr` project, cache policy, assets, fonts, and live smoke without a build step.
- [ ] `REL-014` · P1 · SEC/UI — Run the static verifier, accessibility and keyboard checks, contrast and overflow review, and verify no secret, environment value, repo instruction, or local path enters `public/`. While iOS is awaiting review, confirm both the hero and download section explicitly say it is in App Store review and use TestFlight. Android's released state must use the public Google Play listing without beta wording or opt-in links.
- [ ] `REL-015` · P1 · BOARD — Exercise `/roadmap/`: status lanes and counts load, search finds open/planned/shipped ideas, issue/response/comment filters combine correctly, and Clear filters restores all results. Board view shows six per lane; list view shows twenty, with explicit Show more controls. Check separate up/down totals, vote switch/remove and back/forward refresh, local submission/moderation, unauthorized admin rejection, and shipped vote locks. Admin adds pending/declined lanes, pending-comment/contact filters, and Manage request disclosures. Verify metadata changes update filters without losing drafts.
- [ ] `REL-017` · P1 · BOARD — With a test `OPENAI_API_KEY`, submit clear in-scope and out-of-scope ideas and verify GPT-6 Luna automatically opens or declines them and records reasons in the admin queue. A partial overlap stays pending for human review; decline as a duplicate only when an existing item covers the entire request. Uncertain ideas and failed calls stay pending. Check that ntfy names the outcome (approved, denied, needs review, or review pending) once per completed attempt, that a later successful retry sends its final decision, and that a late AI result after an admin change does not claim an AI decision. Verify a failed review retries after the backoff on a later public or admin board load, an old pending idea gets reviewed on a board load, and unauthorized callers cannot see the decision reason. Without the key, submissions and manual moderation still work and ntfy says needs review.
- [ ] `REL-018` · P1 · BOARD — Open an item's comments, submit an anonymous comment, and confirm it stays private until approved from the admin page. Check pagination, pending counts, approval/deletion, a public Maintainer comment from admin, wrong-token rejection, and shipped-item comments. Save, edit, and clear the separate maintainer response: it must remain visible on the card with comments collapsed and must never become a comment. Saving one card must preserve drafts on others. Check long text, literal HTML, keyboard labels/focus, Turnstile expiry/retry, rate-limit errors, and no overflow at 320px, 390px, and desktop widths.

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

## Item comments and maintainer responses

Against the same disposable local server, run
`python3 scripts/smoke_board_comments.py`. It checks private pending comments,
approval/deletion, admin comments, independent maintainer response save/clear,
cursor reads, shipped-item discussion, authentication, and feature deletion.
It leaves an open item with approved discussion and a pinned response for UI QA.

Visitors can comment on open, planned, and shipped items without an account.
Comments have a 2,000-character limit, a hidden honeypot, a separate Turnstile
widget, and a salted IP-hash daily limit. They require manual admin approval;
Luna continues reviewing feature requests only. Public comment reads expose
only approved comments on public items. Authenticated admin reads include
pending comments and support discussions on private items. Reads are paginated
in ascending comment ID order, at most 50 at a time. IP hashes never appear in
either response. A deleted comment does not reset the posting rate limit.

The admin page can publish a comment labeled Maintainer and separately save,
edit, or clear the item's maintainer response. Responses live in their own
table and appear directly on the card above its comments disclosure. They do
not count as comments. Comment and response tables are created additively by
`ensureSchema`; existing features, votes, and reviews remain intact. Deleting
an item removes its discussion and response.

Inspect a public card with comments collapsed and expanded, submit a visitor
comment, approve it in admin, then reload the public discussion. Check admin
comment publication and the pinned response independently, including clearing
the response without changing the discussion. Save or moderate one card while
another contains a draft. Check long unbroken text and literal HTML at 320px,
390px, and desktop widths. Use keyboard controls and check visible focus,
status announcements, readable contrast, and reduced motion. Simulate a lost
POST reply: drafts must remain, with no automatic retry or duplicate post.
Run a configured Turnstile check in an authorized preview to confirm real
challenge success, expiry, and retry; bootstrap local tests have no CAPTCHA.

## GitHub issue links

Each admin card has an optional GitHub issue URL with Save issue, Remove issue,
and Open issue controls. Check add, replace, clear, reload, and status changes
while another card has unsaved issue/response/comment drafts. Saving a link must
not rebuild unrelated cards. Invalid input must preserve the draft and saved
link. The API accepts HTTPS issue URLs on `github.com` and removes pasted query
strings, trailing slashes, and comment anchors. It rejects other hosts, embedded
credentials, pull request URLs, and executable URL schemes.

Public cards with an issue show a small GitHub icon beside the title, including
shipped cards. Check its accessible name, tooltip, visible keyboard focus,
phone touch target, and new-tab destination. Unlinked cards have no icon. Long
titles must still wrap at 320px and 390px. The link remains available with the
comments collapsed. Existing response and comment controls remain independent.

`feature_issue_links` is created additively by `ensureSchema`; deleting a feature
removes its association. Both board reads include `githubIssueUrl`, empty when
unlinked. Only the authenticated admin `link_issue` action can change it. The
local comments smoke also exercises linking, replacement, validation, and
removal. Association is manual; issue existence, visibility, and status are not
queried or synchronized.

## Private requester contact details

The suggestion form accepts optional email (254 characters) and Discord username
(100 characters) fields. Either, both, or neither may be supplied; existing
clients that omit them still work. The form explains that only the admin can see
them and that they are used for questions about the idea. Invalid email,
non-string input, overlong values, and embedded control characters return a
field-specific error without echoing the value. Failed submissions preserve the
fields; a successful submission clears them with the rest of the form.

`feature_contacts` is created additively and saved in the same transaction as
the feature and rate-limit log. Only authenticated `/api/board/admin` reads
return `contactEmail` and `contactDiscord`, with `Cache-Control: no-store`.
Existing features return empty strings. The admin card shows supplied contacts
as plain text; check literal HTML and long values at phone and desktop widths.
Missing or incorrect tokens must not disclose them. Public board, comment,
vote, and submit responses, AI review input (including retries), and ntfy
notifications must contain neither the contact fields nor their values.
Deletion removes the private record along with the feature.

Run `node --test scripts/tests/test_board_contacts.mjs` for the privacy and
validation regression checks. In disposable local D1, submit an idea with both
fields, read it as admin, approve it, and confirm the public JSON and rendered
card contain neither contact. Repeat with blank fields and check deletion.

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
Only `open` and `planned` items accept votes. Default ranking uses upvotes, with downvotes and creation time breaking ties;
downvotes never subtract from a score. Newest, oldest, and title sorts are also available.

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
The homepage and public roadmap share the base typography, navigation, and
footer styles; roadmap layout lives in its own stylesheet. Admin and 404 keep
their existing styles. New
stylesheet and script filenames must change before a later deployed edit,
because `/static/*` responses are cached immutably.

Homepage and roadmap header/footer logos use the transparent Play Sun lockup.
Check that no charcoal tile appears behind the symbol, the yellow i-dot remains
visible, and the 40px header / 48px footer artwork keeps its natural proportions
at phone and desktop widths. Logo links retain the Cantinarr accessible name and
visible keyboard focus.

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

## Roadmap workspace

The public and admin pages use `board-view-v2.js` and
`board-workspace-v1.css` without a framework. Search covers title, details,
maintainer response, feature ID, and GitHub issue number (including `#123`).
It searches every status by default, including shipped and admin-only declined
ideas. Status and presence filters combine with search; the toolbar reports
shown, matching, and total counts. Private contact values are never searched,
placed in URLs, or saved as filter preferences.

Every visit defaults to status lanes on desktop and mobile, with six visible
cards per lane. A twenty-item list remains available through an explicit choice.
Search, status, presence filters, sort, display, expanded filter controls, and
paging reset on page load and Back/Forward restoration. Browsing preferences
are not stored between visits. This reset preserves drafts and active write
locks; the vote identity cookie and admin authentication are unchanged.
Show more reveals six additional cards in a lane or twenty in a list and focuses
the first revealed card. On narrow screens Board deliberately scrolls its lanes
horizontally; the document itself must not overflow. Status buttons offer direct
access to any lane. Card descriptions and titles expand together; maintainer
responses have their own visible preview and expansion control. The suggestion
form is a disclosure after the board, opened and focused by the header link.

Admin cards expose status, separate votes, and issue/response/comment/contact
presence before expansion. Manage request contains private contacts, status and
delete actions, issue and response editors, and lazy comments. A confirmed save
refreshes metadata-dependent filters. If that removes the focused card from the
results, focus returns to search. Missing/rejected credentials must remove all
cached private cards, hide controls, and clear drafts.

Use a disposable local D1 preview with every status and a mix of metadata. Check
1440px, 800px, 390px, and 320px, including open filters, long unbroken text,
expanded descriptions/responses, comment forms, and admin editors. Confirm no
document overflow, visible keyboard focus, Menu and Escape behavior, reduced
motion, and touch targets. Show more must expose hidden cards, and a search
must find matches beyond the initial page. Empty results must have a clear reset.

Filter, sort, and view changes retain exact card nodes, drafts, open discussions,
and in-flight write locks. Public Turnstile challenges are remounted after a
view change and are mounted only for visible open discussions. Test with a
simulated challenge in local browser QA; real Turnstile requires a separate
configured deployment check. No filter action may submit or replay a write.
Full server refreshes preserve drafts and wait for active writes to finish.

Run `node --test scripts/tests/test_board_*.mjs` for combined filters, pagination,
search across statuses, presence refresh, safe rendering, authentication and
write reconciliation. Run the static verifier and local API smoke above, then
browser-check voting, comment drafts, response/issue edits, status changes, and
auth loss. The browsing controls do not change API, moderation, vote, issue,
or contact-privacy semantics.
