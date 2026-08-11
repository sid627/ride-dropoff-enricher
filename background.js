'use strict';

const DEBUG = false;
const LOG = '[BBC/Background]';
const MAX_WORKERS = 2;
const MESSAGE = Object.freeze({
  SEARCH_RIDE_DISCOVERED: 'SEARCH_RIDE_DISCOVERED',
  SEARCH_CACHE_LOOKUP: 'SEARCH_CACHE_LOOKUP',
  SEARCH_DOM_SNAPSHOT: 'SEARCH_DOM_SNAPSHOT',
  DETAIL_READY: 'DETAIL_READY',
  DETAIL_RESULT: 'DETAIL_RESULT',
  DETAIL_FAILED: 'DETAIL_FAILED',
  WORKER_JOB: 'WORKER_JOB',
  SEARCH_RESULT: 'SEARCH_RESULT',
  ENRICHER_TOGGLE: 'ENRICHER_TOGGLE'
});

const CACHE_PREFIX = 'bbcDestination:';
const FAILURE_PREFIX = 'bbcDestinationFailure:';
const WORKER_TABS_SESSION_KEY = 'bbcWorkerTabIds';
const LEGACY_WORKER_TAB_SESSION_KEY = 'bbcWorkerTabId';
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const EXTRACTION_TIMEOUT_MS = 30_000;
const WORKER_IDLE_CLOSE_MS = 5_000;
const TAB_EDIT_RETRY_DELAYS_MS = [500, 1_000];
const TAB_EDIT_BUSY_PATTERN = /tabs cannot be edited right now/i;

const jobQueue = [];
const queuedRideIds = new Set();
const searchSnapshots = new Map();
const workers = Array.from({ length: MAX_WORKERS }, (_, index) => ({
  index,
  tabId: null,
  currentJob: null,
  completion: null,
  idleCloseId: null
}));

let dispatchRunning = false;
let restoreWorkersPromise = null;

function debug(...args) {
  if (DEBUG) console.info(LOG, ...args);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cacheKey(rideId) {
  return `${CACHE_PREFIX}${rideId}`;
}

function failureKey(rideId) {
  return `${FAILURE_PREFIX}${rideId}`;
}

function isValidCacheEntry(entry) {
  return Boolean(
    entry?.fullAddress &&
    entry?.displayAddress &&
    Number.isFinite(entry?.fetchedAt) &&
    Date.now() - entry.fetchedAt < CACHE_MAX_AGE_MS
  );
}

async function readCache(rideId) {
  const key = cacheKey(rideId);
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (isValidCacheEntry(entry)) return entry;
  if (entry) await chrome.storage.local.remove(key);
  return null;
}

async function writeCache(job, result) {
  const entry = {
    fullAddress: result.fullAddress,
    displayAddress: result.displayAddress,
    fetchedAt: Date.now(),
    rideDate: job.rideDate || ''
  };
  await chrome.storage.local.set({ [cacheKey(job.rideId)]: entry });
  await chrome.storage.local.remove(failureKey(job.rideId));
  debug(`cached ${job.rideId}`);
  return entry;
}

async function recordFailure(rideId, error) {
  await chrome.storage.local.set({
    [failureKey(rideId)]: { failedAt: Date.now(), error: String(error || '') }
  });
}

async function readFailureCooldown(rideId) {
  const key = failureKey(rideId);
  const stored = await chrome.storage.local.get(key);
  const failure = stored[key];
  if (!Number.isFinite(failure?.failedAt)) return null;
  const remainingMs = FAILURE_COOLDOWN_MS - (Date.now() - failure.failedAt);
  if (remainingMs <= 0) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return { ...failure, remainingMs };
}

async function clearFailureCooldowns() {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(FAILURE_PREFIX));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

async function cleanupExpiredStorage() {
  const stored = await chrome.storage.local.get(null);
  const expiredKeys = [];
  const now = Date.now();

  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(CACHE_PREFIX)) {
      if (!isValidCacheEntry(value)) expiredKeys.push(key);
      continue;
    }
    if (key.startsWith(FAILURE_PREFIX)) {
      if (!Number.isFinite(value?.failedAt) || now - value.failedAt >= FAILURE_COOLDOWN_MS) {
        expiredKeys.push(key);
      }
    }
  }

  if (expiredKeys.length > 0) await chrome.storage.local.remove(expiredKeys);
}

async function isEnabled() {
  const { enabled } = await chrome.storage.local.get('enabled');
  return enabled !== false;
}

async function sendToSearchTab(job, payload) {
  try {
    await chrome.tabs.sendMessage(job.searchTabId, {
      type: MESSAGE.SEARCH_RESULT,
      rideId: job.rideId,
      ...payload
    });
  } catch (error) {
    debug(`search tab unavailable for ${job.rideId}`, error.message);
  }
}

async function reportSuccess(job, result) {
  const entry = await writeCache(job, result);
  await sendToSearchTab(job, { ok: true, entry });
}

async function reportFailure(job, error) {
  const message = error?.message || String(error || 'The arrival address was not found.');
  await recordFailure(job.rideId, message);
  await sendToSearchTab(job, { ok: false, error: message });
  console.warn(LOG, `failed ${job.rideId}:`, message);
}

async function rememberWorkerTabs() {
  await chrome.storage.session.set({
    [WORKER_TABS_SESSION_KEY]: workers.map((worker) => worker.tabId)
  });
}

function restoreWorkersOnce() {
  if (restoreWorkersPromise) return restoreWorkersPromise;
  restoreWorkersPromise = (async () => {
    const stored = await chrome.storage.session.get([
      WORKER_TABS_SESSION_KEY,
      LEGACY_WORKER_TAB_SESSION_KEY
    ]);
    const storedIds = Array.isArray(stored[WORKER_TABS_SESSION_KEY])
      ? stored[WORKER_TABS_SESSION_KEY]
      : [stored[LEGACY_WORKER_TAB_SESSION_KEY]];
    const claimed = new Set();

    for (let index = 0; index < workers.length; index += 1) {
      const tabId = storedIds[index];
      if (!Number.isInteger(tabId) || claimed.has(tabId)) continue;
      try {
        await chrome.tabs.get(tabId);
        workers[index].tabId = tabId;
        claimed.add(tabId);
      } catch {
        // A tab ID can become invalid after browser restart or manual closure.
      }
    }
    await chrome.storage.session.remove(LEGACY_WORKER_TAB_SESSION_KEY);
    await rememberWorkerTabs();
  })();
  return restoreWorkersPromise;
}

function cancelWorkerClose(worker) {
  if (worker.idleCloseId !== null) clearTimeout(worker.idleCloseId);
  worker.idleCloseId = null;
}

async function getOrCreateWorkerTab(worker, job) {
  cancelWorkerClose(worker);
  await restoreWorkersOnce();
  if (worker.tabId !== null) {
    try {
      await chrome.tabs.get(worker.tabId);
      return worker.tabId;
    } catch {
      worker.tabId = null;
      await rememberWorkerTabs();
    }
  }

  const tab = await chrome.tabs.create({
    url: 'about:blank',
    active: false,
    windowId: job.windowId
  });
  if (tab.id === undefined) throw new Error(`Chrome did not create worker ${worker.index + 1}.`);
  worker.tabId = tab.id;
  await rememberWorkerTabs();
  debug(`created worker ${worker.index + 1} tab ${worker.tabId}`);
  return worker.tabId;
}

function scheduleWorkerClose(worker) {
  cancelWorkerClose(worker);
  worker.idleCloseId = setTimeout(async () => {
    worker.idleCloseId = null;
    if (worker.currentJob || jobQueue.length > 0 || worker.tabId === null) return;
    const tabId = worker.tabId;
    worker.tabId = null;
    await rememberWorkerTabs();
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // The user may already have closed the inactive worker tab.
    }
  }, WORKER_IDLE_CLOSE_MS);
}

async function navigateWorkerWithRetry(tabId, job) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await chrome.tabs.update(tabId, { url: job.rideUrl, active: false });
      return;
    } catch (error) {
      const message = error?.message || String(error);
      const retryDelay = TAB_EDIT_RETRY_DELAYS_MS[attempt];
      if (!TAB_EDIT_BUSY_PATTERN.test(message) || retryDelay === undefined) throw error;
      await sleep(retryDelay);
    }
  }
}

function tabUrlMatchesJob(tabUrl, job) {
  try {
    const actual = new URL(tabUrl);
    const expected = new URL(job.rideUrl);
    if (actual.origin !== expected.origin) return false;
    const actualRideId =
      actual.searchParams.get('id') ||
      actual.searchParams.get('rideId') ||
      actual.pathname.match(/\/trip\/([^/?#]+)/i)?.[1];
    return decodeURIComponent(actualRideId || '') === job.rideId;
  } catch {
    return false;
  }
}

function createPageLoadWaiter(tabId, job) {
  let listener;
  let timeoutId;
  let settled = false;
  const cleanup = () => {
    if (listener) chrome.tabs.onUpdated.removeListener(listener);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  };
  const promise = new Promise((resolve, reject) => {
    listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      if (!tabUrlMatchesJob(tab.url || '', job)) return;
      settled = true;
      cleanup();
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
    timeoutId = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new Error(`Worker page did not finish loading within ${PAGE_LOAD_TIMEOUT_MS / 1000} seconds.`));
    }, PAGE_LOAD_TIMEOUT_MS);
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
    }
  };
}

async function injectDetailScript(tabId, job) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['detail.js'] });
  } catch (error) {
    throw new Error(`detail.js injection failed for ${job.rideId}: ${error.message || String(error)}`);
  }
}

function settleWorker(worker, result) {
  if (!worker.completion || worker.completion.settled) return false;
  worker.completion.settled = true;
  worker.completion.resolve(result);
  return true;
}

async function processWorkerJob(worker, job) {
  if (worker.currentJob?.rideId !== job.rideId) {
    throw new Error(`Worker ${worker.index + 1} correlation invariant failed for ${job.rideId}.`);
  }
  const resultPromise = new Promise((resolve) => {
    worker.completion = { resolve, settled: false };
  });
  let extractionTimeoutId = null;
  let loadWaiter = null;

  try {
    const tabId = await getOrCreateWorkerTab(worker, job);
    loadWaiter = createPageLoadWaiter(tabId, job);
    try {
      await navigateWorkerWithRetry(tabId, job);
    } catch (error) {
      loadWaiter.cancel();
      loadWaiter.promise.catch(() => {});
      throw error;
    }
    await loadWaiter.promise;
    await injectDetailScript(tabId, job);
    extractionTimeoutId = setTimeout(() => {
      settleWorker(worker, {
        ok: false,
        error: `Ride detail extraction timed out after ${EXTRACTION_TIMEOUT_MS / 1000} seconds.`
      });
    }, EXTRACTION_TIMEOUT_MS);
    return await resultPromise;
  } finally {
    loadWaiter?.cancel();
    if (extractionTimeoutId !== null) clearTimeout(extractionTimeoutId);
    worker.completion = null;
  }
}

function jobIsStillRelevant(job) {
  const snapshot = searchSnapshots.get(job.searchTabId);
  return !snapshot || snapshot.rideIds.has(job.rideId);
}

async function runAssignedJob(worker, job) {
  debug(`worker ${worker.index + 1} processing ${job.rideId}`);
  try {
    const result = await processWorkerJob(worker, job);
    if (result.ok) await reportSuccess(job, result);
    else await reportFailure(job, result.error);
  } catch (error) {
    await reportFailure(job, error);
  } finally {
    queuedRideIds.delete(job.rideId);
    worker.currentJob = null;
    scheduleDispatch();
    if (jobQueue.length === 0) scheduleWorkerClose(worker);
  }
}

function takeNextRelevantJob() {
  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    if (jobIsStillRelevant(job)) return job;
    queuedRideIds.delete(job.rideId);
    debug(`dropped stale queued ride ${job.rideId}`);
  }
  return null;
}

function scheduleDispatch() {
  if (dispatchRunning) return;
  dispatchRunning = true;
  try {
    for (const worker of workers) {
      if (worker.currentJob) continue;
      const job = takeNextRelevantJob();
      if (!job) break;
      worker.currentJob = job;
      void runAssignedJob(worker, job);
    }
  } finally {
    dispatchRunning = false;
  }
}

function insertJobByPriority(job) {
  if (job.priority !== 'visible') {
    jobQueue.push(job);
    return;
  }
  const firstLoadedIndex = jobQueue.findIndex((queuedJob) => queuedJob.priority !== 'visible');
  if (firstLoadedIndex === -1) jobQueue.push(job);
  else jobQueue.splice(firstLoadedIndex, 0, job);
}

function enqueueRide(job) {
  if (queuedRideIds.has(job.rideId)) return { ok: true, status: 'queued' };
  queuedRideIds.add(job.rideId);
  insertJobByPriority(job);
  scheduleDispatch();
  return { ok: true, status: 'queued' };
}

async function admitRide(message, sender) {
  const rideId = String(message.rideId || '').trim();
  const rideUrl = String(message.rideUrl || '').trim();
  const searchTabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (!rideId || !rideUrl || searchTabId === undefined || windowId === undefined) {
    return { ok: false, error: 'Missing ride identity, URL, or search tab.' };
  }
  if (queuedRideIds.has(rideId)) return { ok: true, status: 'queued' };
  const cached = await readCache(rideId);
  if (cached) return { ok: true, status: 'success', entry: cached, cached: true };
  const failure = await readFailureCooldown(rideId);
  if (failure) {
    return {
      ok: true,
      status: 'failed',
      error: failure.error || 'Ride extraction is cooling down after a recent failure.',
      cooldownRemainingMs: failure.remainingMs
    };
  }
  return enqueueRide({
    rideId,
    rideUrl,
    rideDate: String(message.rideDate || ''),
    destinationCity: String(message.destinationCity || ''),
    priority: message.priority === 'visible' ? 'visible' : 'loaded',
    searchTabId,
    windowId
  });
}

function updateSearchSnapshot(message, sender) {
  const searchTabId = sender.tab?.id;
  if (searchTabId === undefined) return;
  const rideIds = new Set((Array.isArray(message.rideIds) ? message.rideIds : []).map(String));
  searchSnapshots.set(searchTabId, { rideIds, searchKey: String(message.searchKey || '') });

  for (let index = jobQueue.length - 1; index >= 0; index -= 1) {
    const job = jobQueue[index];
    if (job.searchTabId !== searchTabId || rideIds.has(job.rideId)) continue;
    jobQueue.splice(index, 1);
    queuedRideIds.delete(job.rideId);
    debug(`removed stale queued ride ${job.rideId}`);
  }
}

function workerForSender(sender, rideId) {
  const worker = workers.find((candidate) => candidate.tabId === sender.tab?.id);
  if (!worker || !worker.currentJob || worker.currentJob.rideId !== rideId) return null;
  return worker;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE.SEARCH_RIDE_DISCOVERED) {
    admitRide(message, sender).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }
  if (message?.type === MESSAGE.SEARCH_CACHE_LOOKUP) {
    readCache(String(message.rideId || '')).then((entry) => sendResponse({ ok: true, entry }));
    return true;
  }
  if (message?.type === MESSAGE.SEARCH_DOM_SNAPSHOT) {
    updateSearchSnapshot(message, sender);
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === MESSAGE.DETAIL_READY) {
    const rideId = String(message.rideId || '');
    const worker = workerForSender(sender, rideId);
    if (!worker) {
      console.warn(LOG, 'ignoring stale detail ready', rideId, 'tab:', sender.tab?.id);
      sendResponse({ ok: false, error: 'Stale or mismatched worker page.' });
      return;
    }
    sendResponse({
      ok: true,
      type: MESSAGE.WORKER_JOB,
      job: {
        rideId: worker.currentJob.rideId,
        rideUrl: worker.currentJob.rideUrl,
        destinationCity: worker.currentJob.destinationCity,
        rideDate: worker.currentJob.rideDate
      }
    });
    return;
  }
  if (message?.type === MESSAGE.DETAIL_RESULT || message?.type === MESSAGE.DETAIL_FAILED) {
    const rideId = String(message.rideId || '');
    const worker = workerForSender(sender, rideId);
    if (!worker) {
      console.warn(LOG, 'ignoring stale detail result', rideId, 'tab:', sender.tab?.id);
      sendResponse({ ok: false, error: 'Stale or mismatched detail result ignored.' });
      return;
    }
    settleWorker(worker, {
      ok: message.type === MESSAGE.DETAIL_RESULT,
      fullAddress: String(message.fullAddress || '').trim(),
      displayAddress: String(message.displayAddress || '').trim(),
      error: String(message.error || '').trim()
    });
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === MESSAGE.ENRICHER_TOGGLE) {
    if (!message.enabled) {
      jobQueue.length = 0;
      for (const rideId of [...queuedRideIds]) {
        if (!workers.some((worker) => worker.currentJob?.rideId === rideId)) queuedRideIds.delete(rideId);
      }
    } else {
      clearFailureCooldowns().catch((error) => console.warn(LOG, 'could not clear cooldowns:', error));
    }
    sendResponse({ ok: true });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const worker = workers.find((candidate) => candidate.tabId === tabId);
  if (!worker) return;
  worker.tabId = null;
  void rememberWorkerTabs();
  settleWorker(worker, { ok: false, error: 'The worker tab was closed before extraction finished.' });
  searchSnapshots.delete(tabId);
});

cleanupExpiredStorage().catch((error) => {
  console.warn(LOG, 'could not clean expired local storage:', error);
});
