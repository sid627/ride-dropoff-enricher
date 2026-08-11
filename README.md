# ride-dropoff-enricher
 This extension enhances BlaBlaCar search results by displaying a more precise ride drop-off location available on the corresponding ride-detail page.

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
