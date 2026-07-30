# Marketing Site Test Checklist

- [ ] `REL-012` · P1 · UI — Validate the homepage, 404 page, and header policy at phone and desktop sizes; verify navigation, screenshots, self-host snippet, demo, store badges, privacy, and canonical links.
- [ ] `REL-013` · P1 · LIVE — Deploy `public/` through the Cloudflare workflow or manual Wrangler path; verify the `cantinarr` project, cache policy, assets, fonts, and live smoke without a build step.
- [ ] `REL-014` · P1 · SEC/UI — Run the static verifier, accessibility and keyboard checks, contrast and overflow review, and verify no secret, environment value, repo instruction, or local path enters `public/`.
- [ ] `REL-015` · P1 · BOARD — Exercise `/roadmap/`: the list loads, an anonymous vote toggles and survives a reload, a submission passes Turnstile and lands in the pending queue, admin approve/decline/status/delete flows work at `/roadmap/admin.html`, rate limits return friendly errors, and a wrong admin token is rejected.
