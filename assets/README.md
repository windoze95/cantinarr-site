# Brand assets

The site uses Julian Poidevin’s round 4 Play Sun v4 artwork. The lockup preserves the supplied title-case lettering, with the i-dot colored `#FBE15A` to match the small sun. The canonical application sources and export script live in `windoze95/cantinarr` under `branding/` and `scripts/generate_branding.py`.

`og-play-sun.svg` is the outlined source for the 1200 × 630 social card. Render it with resvg and use the PNG content hash in its filename. Navigation, footer, favicon, touch icon, and the simulated notification use local assets. Versioned icon URLs bypass cached copies of the previous logo.
