# Public site static content

Status: draft
Translation: current

[中文](public-site-static-content.zh.md)

A reader or crawler opening a landing page, blog post, or documentation URL
must receive its title, description, canonical URL, main text, and ordinary
navigation links in the initial HTML. JavaScript is an enhancement, not a
prerequisite for reading or following these links. Both locales follow this rule. Mobile navigation must expose its links through
a native disclosure that remains usable before hydration and without JavaScript.

The site builds every published URL to static HTML. A failed prerender must fail
the build; unknown URLs retain the existing HTTP 404 and noindex behavior.
No request-time application server is required for public content.

On a direct page visit, client initialization must finish loading the matched
route and its article content before React takes ownership of the document.
If initialization or a required module fails, retain the static document and
its metadata. Do not render a framework error screen or repeatedly reload it.
Optional landing animations and product demos must contain their own rendering
failures so the surrounding static copy remains readable.

Search, theme controls, animation, and other JavaScript interactions may be
unavailable when initialization fails. This does not promise recovery from all
runtime exceptions after successful hydration or availability during an HTML/CDN
outage. Client-side navigation resilience is separate from direct static visits.

## Implementation evidence

- `site-docs/vite.config.ts`: enumerated static prerendering.
- `site-docs/src/client.tsx`: preparation before document hydration.
- `site-docs/components/optional-enhancement.tsx`: optional feature isolation.
