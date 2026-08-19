# ride-dropoff-enricher
 This extension enhances BlaBlaCar search results by displaying a more precise ride drop-off location available on the corresponding ride-detail page.

# Why I built it
BlaBlaCar search results may show only the destination city, even when rides have different drop-off points across that city. Users therefore have to open individual ride pages to check whether the actual destination is convenient for them.

This extension automates that process by retrieving the available drop-off location from each ride's detail page and displaying a simplified landmark or locality directly on the corresponding search card.

# Project Status
**Completed — Local Demo**

The extension is fully implemented and works as a local Chrome extension.

It is not currently published on the Chrome Web Store because publishing/distributing an extension that operates on BlaBlaCar requires permission from the platform, which I am still in the process of obtaining.

Therefore, there is currently no public/live demo. The project can be installed and tested locally from the source code.

The extension was deliberately designed to work only with information available through the user's normal browser session. It does not use private BlaBlaCar APIs or attempt to bypass CAPTCHA, authentication, or other access controls.

## Runtime design

### results.js:
discovers rendered search cards by ride ID, prioritizes visible cards, and renders exact destinations as compact inline pills.
### background.js:
feeds a global deduplicated queue into two reusable inactive workers and caches successful values for 30 days.
### detail.js:
waits for the rendered final route stop, detects block/interstitial pages, extracts its address, and simplifies it.
### popup.js: 
controls the enabled state.

MAX_WORKERS is defined near the top of background.js and defaults to 2.
