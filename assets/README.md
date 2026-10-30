# Brand assets

The site uses Julian Poidevin’s round 4 Play Sun v4 artwork. The lockup preserves the supplied title-case lettering, with the i-dot colored `#FBE15A` to match the small sun. The canonical application sources and export script live in `windoze95/cantinarr` under `branding/` and `scripts/generate_branding.py`.

`og-play-sun.svg` is the outlined source for the 1200 × 630 social card. Render it with resvg and use the PNG content hash in its filename. Navigation, footer, favicon, touch icon, and the simulated notification use local assets. Versioned icon URLs bypass cached copies of the previous logo.

Navigation and footers use `public/static/lockup-transparent-v1.svg`, the kit's `deliverables/play-sun/svg/lockup-horizontal-dark.svg` from `julian-poidevin/cantinarr-logo` at `010eebb`. It has no charcoal tile, so the page background shows through the symbol. The core repository keeps an exact copy at `branding/play-sun-web-lockup-dark.svg`; run `scripts/generate_branding.py --web-only --site /path/to/cantinarr-site` there to refresh website assets. The light variant is available for light page backgrounds. Keep the old lockup for cached pages, and use a new filename for future changes because static assets are cached immutably. Touch icons, the notification preview, and social-card artwork retain their existing treatment.

The social card keeps “Discover · Request · Manage · Repair” as its primary message, with “How you doing, you old pirate?” in smaller cream lettering below. The quote replaces the duplicate site URL. Keep older hashed PNGs available for cached link previews.

The 48px `public/static/favicon-transparent-v1.png` uses the optimized small-size Play Sun geometry from the core repository's `branding/play-sun-small.svg`, exported without its charcoal tile. Its versioned URL avoids the immutable cache for the previous favicon; touch and launcher icons keep their existing artwork.
