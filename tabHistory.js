export { synchronizedUpdateHistory, getTabHistory, clearTabHistory, setTabHistory };

let DEBUG = false;
const debugPrefix = '[AC]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

// Map to track tab history locking status per tab
const historyLocks = new Map();
// Map to cache tab history
const historyCache = new Map();
// Maximum number of history items to store per tab
const MAX_HISTORY_ITEMS = 20;

// Retrieves the custom history array from the tab's session data
async function getTabHistory(tabId) {
  if (historyCache.has(tabId)) {
    return historyCache.get(tabId);
  }

  // If not in cache, fetch from storage and populate cache
  try {
    const history = await browser.sessions.getTabValue(tabId, 'customTabHistory');
    const data = history || [];
    historyCache.set(tabId, data);
    return data;
  } catch (error) {
    return [];
  }
}

// Saves the custom history array to the tab's session data
async function setTabHistory(tabId, history) {
  // Update cache immediately (sync)
  historyCache.set(tabId, history);

  // Update storage (async)
  try {
    await browser.sessions.setTabValue(tabId, 'customTabHistory', history);
  } catch (error) {
    console.error(`[History] Failed to save history for tab ${tabId}:`, error);
  }
}

async function synchronizedUpdateHistory(tabId, url) {
  // Wait for any existing operation on this tab to finish
  if (historyLocks.has(tabId)) {
    await historyLocks.get(tabId);
  }

  // Create a new promise for this operation
  let resolveLock;
  const lockPromise = new Promise((resolve) => {
    resolveLock = resolve;
  });
  historyLocks.set(tabId, lockPromise);

  try {
    await updateTabHistory(tabId, url);
  } catch (e) {
    console.error('History update failed:', e);
  } finally {
    // Release the lock
    historyLocks.delete(tabId);
    resolveLock();
  }
}

// Appends a new URL to the tab's history, or updates the title of the current one
async function updateTabHistory(tabId, url) {
  // Skip invalid / internal / extension URLs
  if (!url || url.startsWith('about:') || url.startsWith('moz-extension://')) return;

  logDebug(`[History] Updating history for tab ${tabId} with URL: ${url}`);

  // Get tab data
  const history = await getTabHistory(tabId);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;

  const lastEntry = history.length > 0 ? history[history.length - 1] : null;

  // If the normalized URL is the same as the last entry, just update the title
  if (lastEntry && areEquivalent(lastEntry.url, url)) {
    // Update the last entry with the new URL and title
    history[history.length - 1] = {
      ...lastEntry,
      url: url, // Store the newer URL (which might have more params, but same content)
      title: tab.title || lastEntry.title,
      timestamp: Date.now(),
    };
    await setTabHistory(tabId, history);
    return;
  }

  // Otherwise, it's a genuine new page, add it to the history
  history.push({ url: url, title: tab.title, timestamp: Date.now() });

  // Keep history size manageable
  if (history.length > MAX_HISTORY_ITEMS) history.shift();

  await setTabHistory(tabId, history);
}

// Function to check if two URLs are equivalent (by origin, path, and params)
function areEquivalent(url1, url2) {
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);

    // Must have same origin and path
    if (u1.origin !== u2.origin || u1.pathname !== u2.pathname) return false;

    const p1 = new URLSearchParams(u1.search);
    const p2 = new URLSearchParams(u2.search);

    // Check if one set of params is a subset of the other
    const isSubset = (subsetParams, supersetParams) => {
      for (const [key, value] of subsetParams) {
        if (supersetParams.get(key) !== value) return false;
      }
      return true;
    };

    return isSubset(p1, p2) || isSubset(p2, p1);
  } catch (e) {
    return url1 === url2;
  }
}

function clearTabHistory(tabId) {
  historyCache.delete(tabId);
}
