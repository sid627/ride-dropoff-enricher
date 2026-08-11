(() => {
  const DEBUG = false;
  if (DEBUG) console.log('[BBC/Detail]', 'STARTED', location.href);
  if (window.__BBC_DETAIL_RUNNING__) return;
  window.__BBC_DETAIL_RUNNING__ = true;

  'use strict';

  const LOG = '[BBC/Detail]';
  function debug(...args) {
    if (DEBUG) console.info(LOG, ...args);
  }
  const MESSAGE = Object.freeze({
    DETAIL_READY: 'DETAIL_READY',
    DETAIL_RESULT: 'DETAIL_RESULT',
    DETAIL_FAILED: 'DETAIL_FAILED'
  });
  const EXTRACTION_TIMEOUT_MS = 22_000;
  const POLL_INTERVAL_MS = 500;
  const TIME_PATTERN = /^\d{1,2}:\d{2}(?:\s*[ap]m)?$/i;
  const DURATION_PATTERN = /^(?:\d+\s*h(?:\s*\d+\s*m)?|\d+\s*(?:hr|hrs|hour|hours|minutes?|mins?))$/i;
  const BLOCKED_PAGE_PATTERN = /captcha|verify you are human|access denied|unusual traffic|sign in to continue|log in to continue|something went wrong|page not found/i;
  const IGNORED_LABEL_PATTERN = /^(?:arrival|destination|drop[- ]?off|departure|pickup|route|trip details?)$/i;
  const MAX_ANCESTOR_LEVELS = 6;
  const MAX_DIAGNOSTIC_TEXT = 1_200;

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  function cleanLine(value) {
    return cleanText(value).replace(/\n+/g, ' ');
  }

  function getRideIdFromLocation() {
    const url = new URL(location.href);
    const rideId =
      url.searchParams.get('id') ||
      url.searchParams.get('rideId') ||
      url.pathname.match(/\/trip\/([^/?#]+)/i)?.[1];
    return rideId ? decodeURIComponent(rideId) : '';
  }

  function expectedCityNames(destinationCity) {
    const full = cleanLine(destinationCity);
    if (!full) return [];
    const parts = full.split(/[,/|]+/).map(cleanLine).filter(Boolean);
    return [...new Set([full, ...parts].map((city) => city.toLocaleLowerCase()))];
  }

  function findExactTextParents(text) {
    const expected = cleanLine(text).toLocaleLowerCase();
    if (!expected || !document.body) return [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const matches = [];
    let node;
    while ((node = walker.nextNode())) {
      if (
        cleanLine(node.nodeValue).toLocaleLowerCase() === expected &&
        node.parentElement &&
        !node.parentElement.matches('script, style, noscript')
      ) {
        matches.push(node.parentElement);
      }
    }
    return [...new Set(matches)];
  }

  function normalizedInnerTextLines(element) {
    return String(element?.innerText || '')
      .split('\n')
      .map(cleanLine)
      .filter(Boolean);
  }

  function isMeaningfulAfterCity(text, cityNames) {
    const normalized = cleanLine(text);
    const lower = normalized.toLocaleLowerCase();
    if (normalized.length < 4 || normalized.length > 500) return false;
    if (TIME_PATTERN.test(normalized) || DURATION_PATTERN.test(normalized)) return false;
    if (/^\d+\s+stops?$/i.test(normalized)) return false;
    if (IGNORED_LABEL_PATTERN.test(normalized) || cityNames.includes(lower)) return false;
    return true;
  }

  function describeElement(element) {
    const tag = element.tagName.toLocaleLowerCase();
    const testId = element.getAttribute('data-testid');
    const role = element.getAttribute('role');
    return `<${tag}${testId ? ` data-testid="${testId}"` : ''}${role ? ` role="${role}"` : ''}>`;
  }

  /** Walk upward and use the first meaningful innerText line after the city. */
  function extractAddressNearCity(cityElement, cityNames) {
    let container = cityElement;
    const ancestors = [];
    for (let level = 0; container && level <= MAX_ANCESTOR_LEVELS; level += 1) {
      const lines = normalizedInnerTextLines(container);
      ancestors.push({ level, element: container, lines });
      const cityIndex = lines.findIndex((line) => cityNames.includes(line.toLocaleLowerCase()));
      if (cityIndex >= 0) {
        for (let index = cityIndex + 1; index < lines.length; index += 1) {
          const candidate = lines[index];
          if (!isMeaningfulAfterCity(candidate, cityNames)) continue;
          return {
            address: candidate,
            container,
            sequence: lines,
            distance: index - cityIndex,
            level,
            ancestors
          };
        }
      }
      container = container.parentElement;
    }
    return { address: null, container: cityElement.parentElement, ancestors };
  }

  function likelyRouteContainer(cityElement) {
    let container = cityElement;
    for (let level = 0; container && level <= MAX_ANCESTOR_LEVELS; level += 1) {
      const text = cleanText(container.innerText || container.textContent);
      if ((text.match(/\b\d{1,2}:\d{2}\b/g) || []).length >= 2) return container;
      container = container.parentElement;
    }
    return cityElement.closest('main, [role="main"], aside') || cityElement.parentElement;
  }

  function extractArrivalNearExpectedCity(destinationCity) {
    const cityNames = expectedCityNames(destinationCity);
    const cityElements = [...new Set(cityNames.flatMap(findExactTextParents))];
    const candidates = cityElements.map((cityElement, occurrenceIndex) => ({
      ...extractAddressNearCity(cityElement, cityNames),
      cityElement,
      occurrenceIndex
    }));
    // The arrival is the final route stop, so prefer the last occurrence that
    // has a structurally adjacent value.
    const best = [...candidates].reverse().find((candidate) => candidate.address) || null;
    return {
      address: best?.address || null,
      cityElements,
      candidates,
      best,
      routeContainer: best ? likelyRouteContainer(best.cityElement) : document.body
    };
  }

  function removeUnitPrefix(parts) {
    if (parts.length < 2) return parts;
    const unitPattern = /^(?:flat|unit|room|shop|plot|block|wing|floor|flr|house|h\.?no\.?)\s*[-:#\w/]*$/i;
    const compactBlockPattern = /^(?:block|wing)[-\s]?[a-z0-9]+$/i;
    return unitPattern.test(parts[0]) || compactBlockPattern.test(parts[0]) ? parts.slice(1) : parts;
  }

  /**
   * Keeps a recognizable landmark plus a useful locality while removing broad,
   * redundant geography. It deliberately falls back to more text when uncertain.
   */
  function simplifyAddress(fullAddress, destinationCity) {
    const city = cleanLine(destinationCity).toLocaleLowerCase();
    let parts = cleanLine(fullAddress)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/^\d{6}$/.test(part))
      .filter((part) => !/^(?:maharashtra|india)$/i.test(part))
      .filter((part) => !city || part.toLocaleLowerCase() !== city);

    parts = removeUnitPrefix(parts);
    if (parts.length === 0) return cleanLine(fullAddress);
    if (parts.length <= 2) return parts.join(', ');

    const landmarkPattern = /\b(?:apartment|apartments|building|complex|heights|residency|residences|society|tower|towers|park|mall|hotel|hospital|school|college|plaza|vihar|enclave)\b/i;
    const landmarkIndex = parts.findIndex((part) => landmarkPattern.test(part) || /^[A-Z][A-Z\s.'-]{4,}$/.test(part));
    if (landmarkIndex >= 0) {
      const locality = parts.at(-1);
      const landmark = parts[landmarkIndex];
      return locality && locality !== landmark ? `${landmark}, ${locality}` : landmark;
    }

    // With no confident landmark, preserve the first useful component and locality.
    return parts.length >= 3 ? `${parts[0]}, ${parts.at(-1)}` : parts.join(', ');
  }

  function detectBlockedPage() {
    const titleAndHeading = cleanText(`${document.title}\n${document.querySelector('main h1, h1')?.textContent || ''}`);
    return BLOCKED_PAGE_PATTERN.test(titleAndHeading) ? titleAndHeading : null;
  }

  function cappedVisibleText(element) {
    const text = normalizedInnerTextLines(element).join(' | ');
    return text.slice(0, MAX_DIAGNOSTIC_TEXT);
  }

  function logExtractionSnapshot(extraction) {
    debug(`city text nodes found: ${extraction.cityElements.length}`);
    extraction.candidates.forEach((candidate, candidateIndex) => {
      candidate.ancestors.forEach((ancestor) => {
        debug(
          `city candidate ${candidateIndex + 1} ancestor ${ancestor.level}: ${describeElement(ancestor.element)}`
        );
        debug('normalized lines:', ancestor.lines);
      });
    });
    if (extraction.best) {
      debug(`selected full address: ${extraction.best.address}`);
    }
  }

  async function sendFailure(rideId, error) {
    console.warn(LOG, error);
    await chrome.runtime.sendMessage({ type: MESSAGE.DETAIL_FAILED, rideId, error });
  }

  async function run() {
    const pageRideId = getRideIdFromLocation();
    if (!pageRideId) {
      console.warn(LOG, 'detail page has no ride ID');
      return;
    }

    let assignment;
    try {
      assignment = await chrome.runtime.sendMessage({
        type: MESSAGE.DETAIL_READY,
        rideId: pageRideId
      });
    } catch (error) {
      console.warn(LOG, 'worker handshake failed', error);
      return;
    }
    if (!assignment?.ok || !assignment.job?.rideId) return;

    const { rideId, destinationCity = '' } = assignment.job;
    debug(`ready ${rideId}`);
    debug(`expected destination city: ${destinationCity || '(not provided)'}`);
    const deadline = Date.now() + EXTRACTION_TIMEOUT_MS;
    let mutationVersion = 0;
    let lastDiagnosticSignature = '';
    let lastExtraction = null;
    const observer = new MutationObserver(() => { mutationVersion += 1; });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    try {
      let lastCheckedVersion = -1;
      while (Date.now() < deadline) {
        const blockedReason = detectBlockedPage();
        if (blockedReason) {
          await sendFailure(rideId, `Blocked or interstitial page detected: ${blockedReason}`);
          return;
        }

        if (mutationVersion !== lastCheckedVersion || document.readyState === 'complete') {
          lastCheckedVersion = mutationVersion;
          const extraction = extractArrivalNearExpectedCity(destinationCity);
          lastExtraction = extraction;
          const diagnosticSignature = `${extraction.cityElements.length}:${extraction.address || ''}`;
          if (diagnosticSignature !== lastDiagnosticSignature) {
            lastDiagnosticSignature = diagnosticSignature;
            logExtractionSnapshot(extraction);
          }
          const fullAddress = extraction.address;
          if (fullAddress) {
            const displayAddress = simplifyAddress(fullAddress, destinationCity);
            debug(`arrival DOM found ${rideId}`);
            debug(`full address: ${fullAddress}`);
            debug(`simplified: ${displayAddress}`);
            await chrome.runtime.sendMessage({
              type: MESSAGE.DETAIL_RESULT,
              rideId,
              fullAddress,
              displayAddress
            });
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (lastExtraction) {
        logExtractionSnapshot(lastExtraction);
        console.warn(
          LOG,
          `likely route container text: ${cappedVisibleText(lastExtraction.routeContainer) || '(empty)'}`
        );
      }
      await sendFailure(rideId, 'Rendered ride page did not expose an address adjacent to the final destination city.');
    } finally {
      observer.disconnect();
    }
  }

  run();
})();
