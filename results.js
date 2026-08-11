(() => {
  'use strict';

  const DEBUG = false;
  const LOG = '[BBC/Search]';
  const MESSAGE = Object.freeze({
    SEARCH_RIDE_DISCOVERED: 'SEARCH_RIDE_DISCOVERED',
    SEARCH_DOM_SNAPSHOT: 'SEARCH_DOM_SNAPSHOT',
    SEARCH_RESULT: 'SEARCH_RESULT',
    ENRICHER_TOGGLE: 'ENRICHER_TOGGLE'
  });
  const INJECTED_SELECTOR = '[data-bbc-enricher="destination"]';
  const SCAN_DEBOUNCE_MS = 500;
  const TIME_PATTERN = /^\d{1,2}:\d{2}(?:\s*[ap]m)?$/i;
  const rideStates = new Map();
  const discoveredRideIds = new Set();
  let enabled = true;
  let scanTimer = null;
  let initialBatchLogged = false;
  let lastDomRideSignature = '';

  function debug(...args) {
    if (DEBUG) console.info(LOG, ...args);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function canonicalRide(href) {
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin || !url.pathname.includes('/trip')) return null;
      url.hash = '';
      const rideId =
        url.searchParams.get('id') ||
        url.searchParams.get('rideId') ||
        url.pathname.match(/\/trip\/([^/?#]+)/i)?.[1];
      if (!rideId) return null;
      return { rideId: decodeURIComponent(rideId), rideUrl: url.href };
    } catch {
      return null;
    }
  }

  function getCardRoot(anchor) {
    return anchor.closest('article, li, [role="listitem"]') || anchor;
  }

  function isRendered(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      element.getClientRects().length > 0
    );
  }

  function isActualRideCard(anchor, cardRoot) {
    if (!isRendered(anchor) || !isRendered(cardRoot)) return false;
    const cardText = normalizeText(cardRoot.innerText || cardRoot.textContent);
    if (!cardText) return false;

    // A rendered search-result card contains route times. This excludes hidden
    // preload/navigation links without relying on generated CSS class names.
    const timeCount = (cardText.match(/\b\d{1,2}:\d{2}\b/g) || []).length;
    return timeCount >= 2;
  }

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  function getRideDate(rideUrl) {
    try {
      const url = new URL(rideUrl);
      return url.searchParams.get('date') || url.searchParams.get('departureDate') || '';
    } catch {
      return '';
    }
  }

  function discoverCards() {
    const cardsByRideId = new Map();
    for (const anchor of document.querySelectorAll('a[href*="/trip"]')) {
      const identity = canonicalRide(anchor.getAttribute('href') || '');
      if (!identity) continue;
      const cardRoot = getCardRoot(anchor);
      if (!isActualRideCard(anchor, cardRoot) || cardsByRideId.has(identity.rideId)) continue;
      cardsByRideId.set(identity.rideId, {
        ...identity,
        anchor,
        cardRoot,
        rideDate: getRideDate(identity.rideUrl)
      });
    }
    return [...cardsByRideId.values()];
  }

  function elementOwnText(element) {
    return normalizeText(
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(' ')
    );
  }

  function destinationFromSearchUrl() {
    const url = new URL(location.href);
    return normalizeText(
      url.searchParams.get('to') ||
      url.searchParams.get('destination') ||
      url.searchParams.get('arrival_place') ||
      url.searchParams.get('to_name') ||
      url.searchParams.get('tn') ||
      ''
    );
  }

  function destinationCityFromCard(entry) {
    const leaves = Array.from(entry.cardRoot.querySelectorAll('span, p, div'))
      .filter((element) => element.children.length === 0 && !element.closest(INJECTED_SELECTOR))
      .map((element) => normalizeText(element.textContent))
      .filter(Boolean);
    const finalTimeIndex = leaves.reduce(
      (latest, text, index) => (TIME_PATTERN.test(text) ? index : latest),
      -1
    );
    if (finalTimeIndex < 0) return '';
    return leaves.slice(finalTimeIndex + 1).find(
      (text) => text.length <= 80 && !TIME_PATTERN.test(text)
    ) || '';
  }

  function findDestinationNode(cardRoot, entry) {
    const searchDestination = destinationFromSearchUrl().toLocaleLowerCase();
    const leafCandidates = Array.from(cardRoot.querySelectorAll('span, p, div'))
      .filter((element) => !element.closest(INJECTED_SELECTOR))
      .filter((element) => element.children.length === 0 || elementOwnText(element))
      .map((element) => ({ element, text: normalizeText(elementOwnText(element) || element.textContent) }))
      .filter(({ text }) => text && text.length <= 80 && !/^\d{1,2}:\d{2}/.test(text));

    if (searchDestination) {
      const exact = leafCandidates.find(({ text }) => text.toLocaleLowerCase() === searchDestination);
      if (exact) return exact.element;
    }

    // Route information is normally ordered departure first, arrival last. Restricting
    // the fallback to the ride link and taking the final short leaf avoids card metadata.
    const insideLink = leafCandidates.filter(({ element }) => entry.anchor.contains(element));
    return insideLink.at(-1)?.element || leafCandidates.at(-1)?.element || null;
  }

  function renderDestination(entry, cacheEntry) {
    if (!cacheEntry?.displayAddress) return false;
    const target = findDestinationNode(entry.cardRoot, entry);
    if (!target) return false;

    let injected = entry.cardRoot.querySelector(
      `${INJECTED_SELECTOR}[data-ride-id="${CSS.escape(entry.rideId)}"]`
    );
    if (!injected) {
      injected = document.createElement('span');
      injected.dataset.bbcEnricher = 'destination';
      injected.dataset.rideId = entry.rideId;
      injected.style.cssText = [
        'display:inline-block',
        'max-width:min(260px, 38vw)',
        'margin-left:6px',
        'padding:1px 6px',
        'vertical-align:middle',
        'overflow:hidden',
        'color:#5b4a12',
        'background:#fff3bf',
        'border:1px solid #f2d675',
        'border-radius:999px',
        'font-size:12px',
        'font-weight:500',
        'line-height:16px',
        'white-space:nowrap',
        'text-overflow:ellipsis',
        'pointer-events:none'
      ].join(';');
    }
    injected.textContent = cacheEntry.displayAddress.replace(/\s*,\s*/g, ' · ');
    injected.title = cacheEntry.fullAddress;
    target.insertAdjacentElement('afterend', injected);
    debug(`rendered ${entry.rideId}`);
    return true;
  }

  async function queueEntry(entry, priority) {
    let state = rideStates.get(entry.rideId);
    if (!state) {
      state = { status: 'discovered', cacheEntry: null };
      rideStates.set(entry.rideId, state);
      debug(`discovered ride ${entry.rideId}`);
    }

    if (state.cacheEntry) {
      renderDestination(entry, state.cacheEntry);
      return;
    }
    if (state.status === 'queued' || state.status === 'fetching' || state.status === 'failed') return;

    state.status = 'queued';
    debug(`queueing ${entry.rideId}`);
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE.SEARCH_RIDE_DISCOVERED,
        rideId: entry.rideId,
        rideUrl: entry.rideUrl,
        rideDate: entry.rideDate,
        destinationCity: destinationCityFromCard(entry) || destinationFromSearchUrl(),
        priority
      });
      if (!response?.ok) throw new Error(response?.error || 'Background rejected the ride.');
      state.status = response.status || 'queued';
      if (response.status === 'failed' && response.cooldownRemainingMs) {
        debug(
          `cooldown active ${entry.rideId} (${Math.ceil(response.cooldownRemainingMs / 1000)}s remaining)`
        );
      }
      if (response.entry) {
        state.status = 'success';
        state.cacheEntry = response.entry;
        renderAllCardsForRide(entry.rideId);
      }
    } catch (error) {
      state.status = 'failed';
      console.warn(LOG, `queue failed ${entry.rideId}:`, error.message);
    }
  }

  function renderAllCardsForRide(rideId) {
    const state = rideStates.get(rideId);
    if (!state?.cacheEntry) return;
    for (const entry of discoverCards()) {
      if (entry.rideId === rideId) renderDestination(entry, state.cacheEntry);
    }
  }

  function scan() {
    if (!enabled) return;

    const currentCards = discoverCards();
    const currentDomIds = new Set(currentCards.map((entry) => entry.rideId));
    const newCards = currentCards.filter((entry) => !discoveredRideIds.has(entry.rideId));

    for (const entry of currentCards) {
      const state = rideStates.get(entry.rideId);
      if (state?.cacheEntry) renderDestination(entry, state.cacheEntry);
    }

    for (const entry of newCards) discoveredRideIds.add(entry.rideId);

    if (!initialBatchLogged) {
      initialBatchLogged = true;
      console.info(LOG, `initial batch: ${newCards.length} rides`);
    } else if (newCards.length > 0) {
      console.info(LOG, `${newCards.length} new rides added`);
    }

    const domSignature = [...currentDomIds].sort().join('|');
    if (domSignature !== lastDomRideSignature) {
      lastDomRideSignature = domSignature;
      console.info(LOG, `current DOM ride count: ${currentDomIds.size}`);
      chrome.runtime.sendMessage({
        type: MESSAGE.SEARCH_DOM_SNAPSHOT,
        rideIds: [...currentDomIds],
        searchKey: location.href
      }).catch((error) => console.warn(LOG, 'could not report current ride IDs:', error));
    }

    // Queue by identity-set difference, never by count subtraction. This runs
    // immediately after each settled DOM batch even while older rides process.
    const prioritizedNewCards = newCards
      .map((entry) => ({ entry, priority: isInViewport(entry.cardRoot) ? 'visible' : 'loaded' }))
      .sort((left, right) => (left.priority === right.priority ? 0 : left.priority === 'visible' ? -1 : 1));
    for (const { entry, priority } of prioritizedNewCards) queueEntry(entry, priority);
  }

  function scheduleScan() {
    if (!enabled) return;
    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE.SEARCH_RESULT) {
      const rideId = String(message.rideId || '');
      const state = rideStates.get(rideId) || { status: 'discovered', cacheEntry: null };
      rideStates.set(rideId, state);
      if (message.ok && message.entry) {
        state.status = 'success';
        state.cacheEntry = message.entry;
        renderAllCardsForRide(rideId);
      } else {
        state.status = 'failed';
        console.warn(LOG, `ride ${rideId} failed:`, message.error);
      }
      return;
    }

    if (message?.type === MESSAGE.ENRICHER_TOGGLE) {
      enabled = Boolean(message.enabled);
      if (enabled) {
        for (const state of rideStates.values()) {
          if (state.status === 'failed') state.status = 'discovered';
        }
        scheduleScan();
      } else {
        document.querySelectorAll(INJECTED_SELECTOR).forEach((element) => element.remove());
      }
    }
  });

  chrome.storage.local.get('enabled').then(({ enabled: storedEnabled }) => {
    enabled = storedEnabled !== false;
    if (storedEnabled === undefined) chrome.storage.local.set({ enabled: true });
    scheduleScan();
  });

  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
})();
