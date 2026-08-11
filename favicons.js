let DEBUG = false;
const debugPrefix = '[AC]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

// Helper to convert Blob to Base64
const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Track active/pending network fetches to prevent duplicate requests for the same domain
const pendingRequests = new Map();

// Purges the bottom 2/3 of least-used favicons from storage when quota is reached.
async function purgeLeastUsedIcons() {
  try {
    // Only fetch the favicon cache object, not all storage
    const { faviconCache = {} } = await browser.storage.local.get('faviconCache');
    const entries = Object.entries(faviconCache);

    if (entries.length === 0) return;

    // Sort ascending by usage count (lowest counts first)
    entries.sort((a, b) => (a[1].count || 0) - (b[1].count || 0));

    // Calculate 2/3 of items to delete
    const deleteCount = Math.floor(entries.length * (2 / 3));
    const entriesToKeep = entries.slice(deleteCount);

    // Reconstruct the cache object with remaining 1/3
    const newCache = Object.fromEntries(entriesToKeep);

    await browser.storage.local.set({ faviconCache: newCache });
    logDebug(`[Favicon] Purged ${deleteCount} least-used favicons. Retained ${entriesToKeep.length}.`);
  } catch (error) {
    console.error('[Favicon] Failed to execute cache purge:', error);
  }
}

/**
 * Fetches, caches, and returns a Base64 Data URI favicon for a given URL.
 * @param {string} urlString - Full URL to retrieve favicon for.
 * @returns {Promise<string|null>} Base64 Data URI or null if unavailable.
 */
export async function fetchFavicon(urlString) {
  if (!urlString) return null;

  let hostname;
  try {
    hostname = urlString.startsWith('http') ? new URL(urlString).hostname : urlString;
  } catch (e) {
    console.error(`[Favicon] Invalid URL provided: ${urlString}`);
    return null;
  }

  // If an active fetch/lookup for this hostname is already in progress, await it
  if (pendingRequests.has(hostname)) {
    return await pendingRequests.get(hostname);
  }

  // Define the execution task and register it immediately in pendingRequests
  const taskPromise = (async () => {
    // Fetch the favicon cache dictionary from storage
    const { faviconCache = {} } = await browser.storage.local.get('faviconCache');

    // Check local storage cache
    if (faviconCache[hostname]) {
      const cachedItem = faviconCache[hostname];
      cachedItem.count = (cachedItem.count || 0) + 1;

      // Update retrieval count
      browser.storage.local.set({ faviconCache }).catch((e) => {
        console.error('[Favicon] Failed to update usage count:', e);
      });

      return cachedItem.data;
    }

    // Check session cooldowns
    const globalCooldownKey = `favicon_cooldown_${hostname}`;
    const ddgKey = `favicon_ddg_fail_${hostname}`;
    const now = Date.now();

    const cooldownData = sessionStorage.getItem(globalCooldownKey);
    if (cooldownData && now < parseInt(cooldownData, 10)) {
      return null;
    }

    const ddgUrl = `https://icons.duckduckgo.com/ip3/${hostname}.ico`;
    const googleUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
    let iconBlob = null;

    // Try DuckDuckGo first
    if (!sessionStorage.getItem(ddgKey)) {
      try {
        const response = await fetch(ddgUrl);
        if (response.ok) {
          iconBlob = await response.blob();
        } else if (response.status === 404) {
          sessionStorage.setItem(ddgKey, 'true');
        }
      } catch (error) {
        logDebug(`[Favicon] DuckDuckGo fetch failed for ${hostname}`);
      }
    }

    // Try Google fallback
    if (!iconBlob) {
      try {
        const response = await fetch(googleUrl);
        if (response.ok) {
          iconBlob = await response.blob();
        }
      } catch (error) {
        logDebug(`[Favicon] Google fetch failed for ${hostname}`);
      }
    }

    // Process & cache result
    if (iconBlob) {
      try {
        const base64Icon = await blobToBase64(iconBlob);

        // Fetch latest cache state before writing
        const { faviconCache: latestCache = {} } = await browser.storage.local.get('faviconCache');
        latestCache[hostname] = {
          data: base64Icon,
          count: 1,
        };

        try {
          await browser.storage.local.set({ faviconCache: latestCache });
        } catch (quotaError) {
          // Catch Firefox storage quota errors specifically
          if (
            quotaError.name === 'QuotaExceededError' ||
            (quotaError.message &&
              (quotaError.message.includes('QuotaExceededError') || quotaError.message.includes('quota')))
          ) {
            logDebug('[Favicon] Storage quota exceeded. Purging 2/3 least-used favicons...');
            await purgeLeastUsedIcons();

            // Retry save after purge
            const { faviconCache: updatedCache = {} } = await browser.storage.local.get('faviconCache');
            updatedCache[hostname] = { data: base64Icon, count: 1 };
            await browser.storage.local.set({ faviconCache: updatedCache }).catch((e) => {
              console.error('[Favicon] Still out of storage after purge:', e);
            });
          }
        }

        return base64Icon;
      } catch (e) {
        console.error('[Favicon] Failed to process image blob:', e);
        return null;
      }
    } else {
      // Set 15-minute cooldown if both services failed
      sessionStorage.setItem(globalCooldownKey, (now + 15 * 60 * 1000).toString());
      return null;
    }
  })();

  // Register promise in in-flight map
  pendingRequests.set(hostname, taskPromise);

  try {
    return await taskPromise;
  } finally {
    // Always clean up after completion/rejection
    pendingRequests.delete(hostname);
  }
}
