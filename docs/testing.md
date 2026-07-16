# Marketing Site Test Checklist

- [ ] `REL-012` · P1 · UI — Validate the homepage, 404 page, and header policy at phone and desktop sizes; verify navigation, screenshots, self-host snippet, demo, store badges, privacy, and canonical links.
- [ ] `REL-013` · P1 · LIVE — Deploy `public/` through the Cloudflare workflow or manual Wrangler path; verify the `cantinarr` project, cache policy, assets, fonts, and live smoke without a build step.
- [ ] `REL-014` · P1 · SEC/UI — Run the static verifier, accessibility and keyboard checks, contrast and overflow review, and verify no secret, environment value, repo instruction, or local path enters `public/`.
