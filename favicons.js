let DEBUG = false;
const debugPrefix = '[AC][Favicons]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

// In-memory set to track which domains are cached without pulling the full storage object
let cachedDomains = null;
// Promise to ensure only one initialization of cachedDomains occurs at a time
let initDomainsPromise = null;

// Lazily initializes the in-memory cachedDomains set from storage
async function initCachedDomains() {
  if (cachedDomains) return;

  if (!initDomainsPromise) {
    initDomainsPromise = (async () => {
      const { faviconCache = {} } = await browser.storage.local.get('faviconCache');
      cachedDomains = new Set(Object.keys(faviconCache));
      logDebug(`[Favicon] In-memory domain index initialized with ${cachedDomains.size} items.`);
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

// Purges the bottom 2/3 of least-used favicons from storage when quota is reached.
async function purgeLeastUsedIcons() {
  try {
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

    // Update the in-memory cachedDomains set to reflect the new cache state
    if (cachedDomains) {
      cachedDomains = new Set(Object.keys(newCache));
    }

    logDebug(`Purged ${deleteCount} least-used favicons. Retained ${entriesToKeep.length}.`);
  } catch (error) {
    console.error('[Favicons] Failed to execute cache purge:', error);
  }
}

// Lock to prevent concurrent topSites queries during Promise.all sweeps
let topSitesFetchPromise = null;

// Helper to fetch Top Sites, respect the cooldown, and populate the cache
async function fetchTopSitesFavicons(currentCache) {
  const { lastTopSitesFetch = 0 } = await browser.storage.local.get('lastTopSitesFetch');
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  if (now - lastTopSitesFetch <= TWO_HOURS) {
    return currentCache; // Cooldown is active, return existing cache unmodified
  }

  logDebug('Fetching topSites to populate missing cache...');

  try {
    const topSites = await browser.topSites.get({ includeFavicon: true });
    let updated = false;

    topSites.forEach((site) => {
      if (!site.url || !site.favicon) return;
      const siteDomain = extractDomain(site.url);

      // Only add to cache if it doesn't already exist
      if (siteDomain && !currentCache[siteDomain]) {
        currentCache[siteDomain] = { data: site.favicon, count: 1 };
        if (cachedDomains) cachedDomains.add(siteDomain); // Update in-memory set
        updated = true;
      }
    });

    // Save the new timestamp, and the cache if it was updated
    await browser.storage.local.set({
      lastTopSitesFetch: now,
      ...(updated ? { faviconCache: currentCache } : {}),
    });
  } catch (err) {
    console.error('[Favicons] Failed to fetch topSites:', err);
  }

  return currentCache;
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

  logDebug(`Fetching favicon for domain: ${domain}`);

  try {
    // Check local cache
    if (cachedDomains.has(domain)) {
      // If the domain is in the in-memory set, fetch the actual data from storage
      const { faviconCache = {} } = await browser.storage.local.get('faviconCache');
      const cachedItem = faviconCache[domain];

      if (cachedItem) {
        logDebug(`Favicon found in local cache for domain: ${domain}`);
        const data = typeof cachedItem === 'string' ? cachedItem : cachedItem.data;

        // Update count asynchronously
        if (typeof cachedItem === 'object') {
          cachedItem.count = (cachedItem.count || 0) + 1;
          browser.storage.local.set({ faviconCache }).catch(() => {});
        }
        return data || null;
      }
    } else {
      logDebug(`Favicon not found in local cache for domain: ${domain}`);
    }

    // Missing from cache -> check Top Sites
    // Use a lock to ensure multiple concurrent missing domains don't spam the API
    if (!topSitesFetchPromise) {
      topSitesFetchPromise = (async () => {
        const { faviconCache = {} } = await browser.storage.local.get('faviconCache');
        return await fetchTopSitesFavicons(faviconCache);
      })().finally(() => {
        topSitesFetchPromise = null;
      });
    }

    const updatedCache = await topSitesFetchPromise;

    // Check if the Top Sites fetch found the missing domain
    if (updatedCache[domain]) {
      logDebug(`Favicon found in Top Sites cache for domain: ${domain}`);
      const cachedItem = updatedCache[domain];
      return typeof cachedItem === 'string' ? cachedItem : cachedItem.data;
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
  if (!tabUrl || !favIconUrl) return;

  // Only process standard web pages
  if (!tabUrl.startsWith('http')) {
    return;
  }

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

    const { faviconCache = {} } = await browser.storage.local.get('faviconCache');
    faviconCache[domain] = { data: base64Data, count: 1 };

    try {
      await browser.storage.local.set({ faviconCache });
      cachedDomains.add(domain);
      logDebug(`Recorded favicon locally for domain: ${domain}`);
    } catch (quotaError) {
      // Catch Firefox storage quota errors specifically
      logDebug('Storage quota exceeded. Purging 2/3 of the least-used favicons...');
      await purgeLeastUsedIcons();

      const { faviconCache: freshCache = {} } = await browser.storage.local.get('faviconCache');
      freshCache[domain] = { data: base64Data, count: 1 };
      await browser.storage.local.set({ faviconCache: freshCache });
      cachedDomains.add(domain);
    }
  } catch (err) {
    // Suppress network errors for normal browsing
  }
}

initCachedDomains();
