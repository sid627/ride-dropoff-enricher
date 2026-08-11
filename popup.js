'use strict';

const toggle = document.getElementById('toggle');
const status = document.getElementById('status');

function showStatus(enabled) {
  status.textContent = enabled ? 'On — loaded cards will be enriched' : 'Off';
}

async function notifySearchTabs(enabled) {
  const tabs = await chrome.tabs.query({ url: 'https://www.blablacar.in/search*' });
  await Promise.allSettled(
    tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'ENRICHER_TOGGLE', enabled }))
  );
  await chrome.runtime.sendMessage({ type: 'ENRICHER_TOGGLE', enabled });
}

chrome.storage.local.get('enabled').then(({ enabled }) => {
  const effectiveEnabled = enabled !== false;
  toggle.checked = effectiveEnabled;
  showStatus(effectiveEnabled);
});

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  toggle.disabled = true;
  try {
    await chrome.storage.local.set({ enabled });
    await notifySearchTabs(enabled);
    showStatus(enabled);
  } finally {
    toggle.disabled = false;
  }
});
