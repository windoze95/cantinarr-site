# Agent Instructions

Operating manual for contributors and agents working on the Cantinarr marketing site.

## Collaboration

- Do not agree by default. Push back when a request would weaken the pitch, misstate shipped behavior, hurt accessibility, or make the site harder to maintain.
- Keep changes proportional. Prefer a focused copy, style, or asset edit over introducing a framework or build system.

## Git workflow

- Before any branch, commit, or push, run `git fetch origin` and verify the current branch and remote state.
- Start each change from a clean `main` that is even with `origin/main`, then create a `feat/…`, `fix/…`, `docs/…`, or `chore/…` branch.
- Preserve unrelated user work and untracked files.
- After committing, fetch and verify state again, then push immediately.
- Open a ready-for-review PR, never a draft, unless the user explicitly asks otherwise.
- Watch every required check to completion. Fix failures on the same branch, merge only when green, and delete the merged branch.
- After a PR merges, return to a fresh `main`; never reuse the merged branch.

## Site boundary

- The deployed surface is `public/` (static pages) plus `functions/` (Pages Functions backing the feature board API at `/api/board*`) and `wrangler.toml` (Pages config and bindings). Nothing else outside those may be required at runtime or copied into the deployment.
- The marketing pages are plain static HTML/CSS with local assets and no build step. The one approved client-side application is the feature board on `/roadmap/`, and its only approved remote dependency is Cloudflare Turnstile (`challenges.cloudflare.com`). Do not add a framework, package manager, remote font dependency, analytics, or further remote scripts without explicit approval.
- Board data lives in Cloudflare D1 (binding `DB`, database `cantinarr-board`). The schema is created by `functions/api/board/_util.js` on first use — schema changes go there, not in migration files.
- The board is anonymous by design: no accounts, votes deduplicated by a first-party cookie plus salted IP-hash rate limits, submissions gated by honeypot + Turnstile and held as `pending` until approved at `/roadmap/admin.html`. Board user content is always rendered with `textContent`, never `innerHTML`.
- `TURNSTILE_SECRET`, `ADMIN_TOKEN`, and `VOTE_SALT` are Pages secrets (`wrangler pages secret put`). Never commit or print them; the only committed Turnstile value is the public site key in `wrangler.toml`.
- Keep runtime paths rooted at `/`, and keep every production asset inside `public/`.
- Never expose repo instructions, workflows, credentials, environment values, or local paths through `public/`.
- Screenshots, icons, and the OG image are site-owned rendered copies. Do not hotlink source assets from another repository.

## Product and copy truth

- Marketing copy describes shipped Cantinarr behavior. Verify changing claims against `windoze95/cantinarr`; do not publish planned or inferred functionality as current.
- Requester-facing copy uses plain product language, not arr implementation jargon.
- Counts and enumerations drift quickly. Use them only when the number itself materially strengthens the claim, and verify every occurrence when they change.
- Preserve intentional brand decisions recorded in the local project memory. If a requested line conflicts with them, surface the tradeoff rather than quietly reintroducing rejected language.
- Keep the HTML description, Open Graph/Twitter descriptions, JSON-LD, visible hero copy, and social image mutually consistent without forcing them to be identical.

## Verification

- Run `python3 scripts/verify_site.py` for every change.
- Serve `public/` locally and inspect relevant pages at phone and desktop widths when layout, copy length, or assets change.
- For board changes, run `npx wrangler pages dev` (local D1, no secrets needed) and smoke `/api/board` list, submit, vote toggle, and — with `ADMIN_TOKEN` in `.dev.vars` — the admin flow.
- For visual changes, verify keyboard focus, readable contrast, image alternatives, no horizontal overflow, and reduced-motion behavior.
- For metadata or social-card changes, validate the title, canonical URL, descriptions, JSON-LD, OG/Twitter tags, and referenced image dimensions.
- After a merged deploy, verify `https://cantinarr.com`, `/404.html`, security/cache headers, fonts, images, primary links, and the exact changed copy.
- Mention any check that could not be run.

## Deployment

- `.github/workflows/deploy.yml` deploys `public/` plus `functions/` (per `wrangler.toml`) to the existing Cloudflare Pages project after merges to `main`.
- `wrangler.toml` is the source of truth for the D1 binding and the public Turnstile site key; deploys fail if its `database_id` does not exist in the Cloudflare account.
- Deployment requires the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Manual fallback: `npx wrangler pages deploy public --project-name=cantinarr --branch=main`.
- Never print, persist, or commit deployment credentials.

## Documentation

- `public/` owns the public pitch and links.
- `docs/testing.md` owns the site smoke, accessibility, security, and release checklist.
- `AGENTS.md` is the canonical operating manual. `CLAUDE.md` must remain a thin import of this file.
- Keep operational docs and tests aligned in the same PR when site behavior or deployment changes.
