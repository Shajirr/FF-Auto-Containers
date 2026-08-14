let DEBUG = true;
const debugPrefix = '[AC] [Favicons]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

// In-memory set to track which domains are cached without querying storage
let cachedDomains = null;
// Promise to ensure only one initialization of cachedDomains occurs at a time
let initDomainsPromise = null;

// Lazily initializes the in-memory cachedDomains set from storage keys
async function initCachedDomains() {
  if (cachedDomains) return;

  if (!initDomainsPromise) {
    initDomainsPromise = (async () => {
      const allData = await browser.storage.local.get(null);
      cachedDomains = new Set();

      for (const key of Object.keys(allData)) {
        if (key.startsWith('favicon_')) {
          cachedDomains.add(key.replace('favicon_', ''));
        }
      }
      logDebug(`In-memory domain index initialized with ${cachedDomains.size} items.`);
    })().finally(() => {
      initDomainsPromise = null;
    });
  }
  await initDomainsPromise;
}

// Helper to extract clean domain/hostname from a URL or domain string
export function extractDomain(urlString) {
  if (!urlString) return null;
  try {
    const u = urlString.startsWith('http') ? new URL(urlString) : new URL(`https://${urlString}`);
    return u.hostname;
  } catch (e) {
    return null;
  }
}

// Helper to convert Blob to Base64 Data URI
const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Purges the bottom 2/3 of least-used favicons from storage when quota is reached
async function purgeLeastUsedIcons() {
  try {
    const allData = await browser.storage.local.get(null);
    const entries = [];

    // Gather only favicon keys
    for (const [key, value] of Object.entries(allData)) {
      if (key.startsWith('favicon_')) {
        entries.push({ key, count: value.count || 0 });
      }
    }

    if (entries.length === 0) return;

    // Sort ascending by usage count (lowest counts first)
    entries.sort((a, b) => a.count - b.count);

    // Calculate 2/3 of items to delete
    const deleteCount = Math.floor(entries.length * (2 / 3));
    const entriesToDelete = entries.slice(0, deleteCount).map(e => e.key);

    await browser.storage.local.remove(entriesToDelete);

    // Update the in-memory cachedDomains set
    if (cachedDomains) {
      for (const key of entriesToDelete) {
        cachedDomains.delete(key.replace('favicon_', ''));
      }
    }

    logDebug(`Purged ${deleteCount} least-used favicons. Retained ${entries.length - deleteCount}.`);
  } catch (error) {
    console.error('[Favicons] Failed to execute cache purge:', error);
  }
}

// Lock to prevent concurrent topSites queries during Promise.all sweeps
let topSitesFetchPromise = null;

// Helper to fetch Top Sites, respect the cooldown, and populate the cache
async function fetchTopSitesFavicons() {
  const { lastTopSitesFetch = 0 } = await browser.storage.local.get('lastTopSitesFetch');
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  if (now - lastTopSitesFetch <= TWO_HOURS) {
    logDebug(
      'Top Sites fetch cooldown active. Skipping fetch. Cooldown remaining:',
      ((TWO_HOURS - (now - lastTopSitesFetch)) / 1000 / 60).toFixed(1),
      'minutes',
    );
    return {};
  }

  logDebug('Fetching topSites to populate missing cache...');
  const newIcons = {};

  try {
    const topSites = await browser.topSites.get({ includeFavicon: true });
    logDebug(`Fetched ${topSites.length} topSites entries.`);

    topSites.forEach((site) => {
      if (!site.url || !site.favicon) return;
      const siteDomain = extractDomain(site.url);

      // Add to payload if valid and not already cached
      if (siteDomain && (!cachedDomains || !cachedDomains.has(siteDomain))) {
        newIcons[`favicon_${siteDomain}`] = { data: site.favicon, count: 1 };
        if (cachedDomains) cachedDomains.add(siteDomain);
      }
    });

    // Save the new timestamp, and the cache if it was updated
    await browser.storage.local.set({
      lastTopSitesFetch: now,
      ...newIcons,
    });

    logDebug('Top Sites fetch completed and cache updated.');
  } catch (err) {
    console.error('[Favicons] Failed to fetch topSites:', err);
  }

  return newIcons;
}

/**
 * Retrieves a Base64 Data URI favicon for a given URL or domain.
 * Checks local cache first. If missing, attempts a Top Sites retrieval.
 * @param {string} urlOrDomain - Full URL or domain string.
 * @returns {Promise<string|null>} Base64 Data URI or null if unavailable locally.
 */
export async function fetchFavicon(urlOrDomain) {
  const domain = extractDomain(urlOrDomain);
  if (!domain) return null;

  // Ensure the in-memory set is ready
  if (!cachedDomains) {
    await initCachedDomains();
  }

  const storageKey = `favicon_${domain}`;
  logDebug(`Fetching favicon for domain: ${domain}`);

  try {
    // Check local cache via in-memory set
    if (cachedDomains.has(domain)) {
      // If the domain is in the in-memory set, fetch the actual data from storage
      const result = await browser.storage.local.get(storageKey);
      const cachedItem = result[storageKey];

      if (cachedItem) {
        logDebug(`Favicon found in local cache for domain: ${domain}`);
        const data = typeof cachedItem === 'string' ? cachedItem : cachedItem.data;

        // Update count asynchronously directly to the isolated key
        if (typeof cachedItem === 'object') {
          browser.storage.local.set({
            [storageKey]: { ...cachedItem, count: (cachedItem.count || 0) + 1 }
          }).catch(() => {});
        }
        return data || null;
      }
    } else {
      logDebug(`Favicon not found in local cache for domain: ${domain}`);
    }

    // Missing from cache -> check Top Sites
    // Use a lock to ensure multiple concurrent missing domains don't spam the API
    if (!topSitesFetchPromise) {
      topSitesFetchPromise = fetchTopSitesFavicons().finally(() => {
        topSitesFetchPromise = null;
      });
    }

    const newTopSitesIcons = await topSitesFetchPromise;

    if (newTopSitesIcons[storageKey]) {
      logDebug(`Favicon found in Top Sites cache for domain: ${domain}`);
      return newTopSitesIcons[storageKey].data;
    }
  } catch (e) {
    console.error('[Favicons] Failed to fetch favicon:', e);
  }

  return null;
}

/**
 * Caches favicon on active tab update if setting is enabled.
 * Fetches from the first-party site directly.
 * @param {string} tabUrl - The URL of the active tab.
 * @param {string} favIconUrl - The favicon URL provided by the tab.
 */
export async function recordFaviconFromTab(tabUrl, favIconUrl) {
    // Only process valid URLS / standard web pages
    if (!tabUrl || !favIconUrl || !tabUrl.startsWith('http')) return;

  const domain = extractDomain(tabUrl);
  // Do not record internal or extension favicons, or if the domain is invalid
  if (
    !domain ||
    favIconUrl.startsWith('chrome:') ||
    favIconUrl.startsWith('about:') ||
    favIconUrl.startsWith('resource:') ||
    favIconUrl.startsWith('moz-extension:')
  ) {
    logDebug(`Skipping favicon recording for domain: ${domain}, favicon URL: ${favIconUrl.substring(0, 80)}...`);
    return;
  }

  // Ensure the in-memory set is ready
  if (!cachedDomains) {
    await initCachedDomains();
  }

  // Instant in-memory check without touching browser.storage
  if (cachedDomains.has(domain)) {
    // Already cached
    logDebug(`Favicon already cached for domain: ${domain}`);
    return;
  }

  logDebug(`Recording favicon for tab URL: ${tabUrl}, favicon URL: ${favIconUrl.substring(0, 80)}...`);

  try {
    let base64Data;

    // If the site provided the icon as a Base64 string directly, just use it
    if (favIconUrl.startsWith('data:')) {
      base64Data = favIconUrl;
    } else {
      // Otherwise, fetch the image file and convert it to Base64
      const response = await fetch(favIconUrl);
      if (!response.ok) {
        logDebug(`Failed to fetch favicon from URL: ${favIconUrl.substring(0, 80)}..., status: ${response.status}`);
        return;
      }

      const blob = await response.blob();
      base64Data = await blobToBase64(blob);
    }

    const storageKey = `favicon_${domain}`;

    try {
      await browser.storage.local.set({ [storageKey]: { data: base64Data, count: 1 } });
      cachedDomains.add(domain);
      logDebug(`Recorded favicon locally for domain: ${domain}`);
    } catch (quotaError) {
      // Catch Firefox storage quota errors specifically
      logDebug('Storage quota exceeded. Purging 2/3 of the least-used favicons...');
      await purgeLeastUsedIcons();
      await browser.storage.local.set({ [storageKey]: { data: base64Data, count: 1 } });
      cachedDomains.add(domain);
    }
  } catch (err) {
    // Suppress network errors for normal browsing
  }
}

initCachedDomains();

// Listen for new flattened favicon keys added by Options page operations
browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    let indexUpdated = false;

    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith('favicon_')) {
        const domain = key.replace('favicon_', '');

        if (change.newValue) {
          // Addition / Update
          if (cachedDomains && !cachedDomains.has(domain)) {
            cachedDomains.add(domain);
            indexUpdated = true;
          }
        } else {
          // Deletion
          if (cachedDomains && cachedDomains.has(domain)) {
            cachedDomains.delete(domain);
            indexUpdated = true;
          }
        }
      }
    }

    if (indexUpdated) {
      logDebug(`In-memory domain index updated from storage change. New size: ${cachedDomains.size}`);
    }
  }
});
