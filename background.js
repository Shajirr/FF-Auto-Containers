import { sortRules } from './sorting.js';

let DEBUG = false;

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

// Map to store deletion timers for temporary containers
const deletionTimers = new Map();
// Set to track tabs being processed to avoid duplicate actions
const processingTabs = new Set();
// Set to track tabs waiting for URL updates
const pendingTabs = new Set();
// Map to store the last known URL for each tab
const tabUrls = new Map();
// Map to store the cookieStoreId for each tab (needed for cleanup after tab removal)
const tabCookieStoreIds = new Map();
// Set to track tabs created by the addon
const addonCreatedTabs = new Set();

// Domain isolation exclusion tracking
const excludedTabs = new Set(); // all excluded tabs (perm + temp)
const permanentExclusions = new Set(); // only tabs explicitly excluded via context menu / message (never expire)
const tabToExclusionTimer = new Map(); // tabId -> timerId (shared across inheritance chain)
const exclusionGroups = new Map(); // timerId -> Set<tabId> (all tabs sharing the same timer)

const EXCLUSION_TIMER = 30 * 60 * 1000; // in ms

const COLORS = ['blue', 'turquoise', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'toolbar'];
// prettier-ignore
const ICONS = ['fingerprint', 'briefcase', 'dollar', 'cart', 'vacation',
  'gift', 'food', 'fruit', 'pet', 'tree', 'chill', 'circle', 'fence'];

// Safeguard: Track processing operations to prevent infinite loops
const MAX_PROCESSING_PER_TAB = 3;
const tabProcessingCount = new Map();
function incrementProcessingCount(tabId) {
  const count = tabProcessingCount.get(tabId) || 0;
  tabProcessingCount.set(tabId, count + 1);
  if (count >= MAX_PROCESSING_PER_TAB) {
    console.warn(`Tab ${tabId} has been processed ${count} times, possible infinite loop detected`);
    return false;
  }
  return true;
}

function resetProcessingCount(tabId) {
  tabProcessingCount.delete(tabId);
}

function getDomain(url) {
  if (!url || url === 'about:blank' || url === 'about:newtab') {
    return '';
  }
  // Skip extension pages
  if (url.startsWith('moz-extension://')) {
    return '';
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    console.error('Invalid URL:', url, e);
    return '';
  }
}

// Function to get all temporary containers
async function getTempContainers() {
  const identities = await browser.contextualIdentities.query({});
  return identities.filter((identity) => /^tmp_\d+$/.test(identity.name));
}

// Function to get the next available container number
async function getNextContainerNumber() {
  const tempContainers = await getTempContainers();
  const numbers = tempContainers
    .map((container) => parseInt(container.name.split('_')[1], 10))
    .filter((num) => !isNaN(num))
    .sort((a, b) => a - b);
  let nextNum = 1;
  while (numbers.includes(nextNum)) {
    nextNum++;
  }
  return nextNum;
}

// Get random color or icon
function getRandomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// Function to update badge for excluded tabs
async function updateTabBadge(tabId) {
  try {
    const isExcluded = excludedTabs.has(tabId);
    if (!isExcluded) {
      await browser.browserAction.setBadgeText({ text: '', tabId: tabId });
      return;
    }

    const isPermanent = permanentExclusions.has(tabId);
    const badgeText = 'EX';
    const badgeColor = isPermanent ? '#ff6b35' : '#ffd700'; // orange = permanent, gold = temporary

    await browser.browserAction.setBadgeText({ text: badgeText, tabId: tabId });
    await browser.browserAction.setBadgeBackgroundColor({ color: badgeColor, tabId: tabId });
  } catch (error) {
    console.error('Error updating badge for tab', tabId, error);
  }
}

// Handler for temporary exclusion timer expiration (shared across inheritance chain)
function handleTempExpiration(timerId) {
  const group = exclusionGroups.get(timerId);
  if (!group) return;

  logDebug(`Temporary exclusion timer ${timerId} expired for group of ${group.size} tabs`);

  for (const tabId of [...group]) {
    // copy to safely modify while iterating
    excludedTabs.delete(tabId);
    tabToExclusionTimer.delete(tabId);
    updateTabBadge(tabId).catch((e) => console.error('Badge update on expire failed:', e));
  }
  exclusionGroups.delete(timerId);
}

// Helper function to clean up temporary exclusion timers
function clearTabExclusionTimer(tabId) {
  if (tabToExclusionTimer.has(tabId)) {
    const timerId = tabToExclusionTimer.get(tabId);
    const group = exclusionGroups.get(timerId);
    if (group) {
      group.delete(tabId);
      if (group.size === 0) {
        clearTimeout(timerId);
        exclusionGroups.delete(timerId);
        logDebug(`Cleared empty temp exclusion timer ${timerId}`);
      }
    }
    tabToExclusionTimer.delete(tabId);
  }
}

// Centralized inheritance logic (temporary, shared timer across chain)
async function inheritExclusion(newTabId, sourceTabId) {
  if (excludedTabs.has(newTabId)) {
    return; // already excluded (prevent duplicate processing)
  }

  const isSourcePermanent = permanentExclusions.has(sourceTabId);
  excludedTabs.add(newTabId);

  if (isSourcePermanent) {
    // Start a new timer for this inheritance chain
    const timerId = setTimeout(() => {
      handleTempExpiration(timerId);
    }, EXCLUSION_TIMER);

    exclusionGroups.set(timerId, new Set([newTabId]));
    tabToExclusionTimer.set(newTabId, timerId);

    logDebug(
      `Created new temp exclusion chain for tab ${newTabId} (inherited from permanent tab ${sourceTabId}), timerId=${timerId}`,
    );
  } else {
    // Inherit the same timer from the source temporary tab
    const sourceTimerId = tabToExclusionTimer.get(sourceTabId);
    if (sourceTimerId !== undefined && exclusionGroups.has(sourceTimerId)) {
      exclusionGroups.get(sourceTimerId).add(newTabId);
      tabToExclusionTimer.set(newTabId, sourceTimerId);
      logDebug(`Tab ${newTabId} joined existing temp exclusion group (timer ${sourceTimerId}) from tab ${sourceTabId}`);
    } else {
      // Fallback (should never happen) - treat as new temporary chain
      const timerId = setTimeout(() => {
        handleTempExpiration(timerId);
      }, EXCLUSION_TIMER);
      exclusionGroups.set(timerId, new Set([newTabId]));
      tabToExclusionTimer.set(newTabId, timerId);
      logDebug(`Warning: source tab ${sourceTabId} had no timer - created new temp chain for tab ${newTabId}`);
    }
  }

  await updateTabBadge(newTabId);
}

// Function to check rules for permanent container
async function getContainerForDomain(url) {
  try {
    const { rules = '', containerStyles = {} } = await browser.storage.local.get(['rules', 'containerStyles']);
    const ruleLines = rules.split('\n').filter((line) => line.trim() !== '');
    logDebug(`Loaded ${ruleLines.length} rules:`, ruleLines);

    if (ruleLines.length === 0) {
      logDebug('No rules available');
      return null;
    }

    const domain = getDomain(url);
    if (!domain) {
      logDebug(`Invalid domain for URL: ${url}`);
      return null;
    }

    logDebug(`Checking rules sequentially for URL: ${url}, domain: ${domain}`);

    let rulesChecked = 0;

    for (const line of ruleLines) {
      // Split only on the first comma so container names can contain commas
      const firstComma = line.indexOf(',');
      if (firstComma === -1) continue; // skip invalid rule
      const rulePattern = line.substring(0, firstComma).trim();
      const containerName = line.substring(firstComma + 1).trim();
      rulesChecked++;

      if (matchesRule(url, domain, rulePattern)) {
        logDebug(`Rule ${rulePattern} matched! Matches container: ${containerName}, rules checked: ${rulesChecked}`);

        // Handling special reserved container names
        if (containerName === '#Default') {
          return 'firefox-default';
        }
        if (containerName === '#Ignore') {
          return '#Ignore'; // Signal string to stop processing
        }

        const identities = await browser.contextualIdentities.query({ name: containerName });
        if (identities.length > 0) {
          logDebug(
            `Found existing container: ${containerName} (${identities[0].cookieStoreId}) for pattern: ${rulePattern}`,
          );
          return identities[0].cookieStoreId;
        }
        // Apply saved styles when creating container
        const styles = containerStyles[containerName] || { color: 'blue', icon: 'circle' };
        const identity = await browser.contextualIdentities.create({
          name: containerName,
          color: styles.color,
          icon: styles.icon,
        });
        logDebug(`Created container: ${containerName} (${identity.cookieStoreId}) for pattern: ${rulePattern}`);
        return identity.cookieStoreId;
      }
    }

    logDebug(`No rules matched for URL: ${url}, checked all ${ruleLines.length} rules`);
    return null;
  } catch (error) {
    console.error(`Error in getContainerForDomain for URL: ${url}`, error);
    return null;
  }
}

// Function to check if a URL matches a rule pattern
function matchesRule(url, domain, rulePattern) {
  try {
    const urlObj = new URL(url);
    // Handle different rule pattern types:
    // 1. URL path or query patterns (contains /)
    if (rulePattern.includes('/')) {
      // Split pattern into domain, path, and query parts
      const [patternDomain, ...pathAndQueryParts] = rulePattern.split('/');
      const patternPathFull = '/' + pathAndQueryParts.join('/');
      const queryIndex = patternPathFull.indexOf('?');
      const hasQuery = queryIndex !== -1;
      const cleanPatternPath = hasQuery ? patternPathFull.substring(0, queryIndex) : patternPathFull;
      const patternQuery = hasQuery ? patternPathFull.substring(queryIndex) : '';
      // Normalize domains (remove www.)
      const urlDomain = urlObj.hostname.replace(/^www\./, '');
      // Check domain with wildcard support
      if (!matchesDomainPattern(urlDomain, patternDomain)) {
        //logDebug(`Domain mismatch: urlDomain=${urlDomain}, patternDomain=${patternDomain}`);
        return false;
      }
      // Check if URL path matches pattern path
      if (cleanPatternPath.includes('*')) {
        // Convert pattern path to regex for wildcard support
        let regexPath = cleanPatternPath
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
          .replace(/\*/g, '.*'); // Convert * to .*
        regexPath = '^' + regexPath + '(/.*)?$'; // Match path and optional trailing segments
        logDebug(
          `Path regex test: urlPath=${urlObj.pathname}, regex=${regexPath}, result=${new RegExp(regexPath).test(urlObj.pathname)}`,
        );
        return new RegExp(regexPath).test(urlObj.pathname);
      } else {
        // Match exact path, path with query parameters, or path with trailing slash
        const pathResult =
          urlObj.pathname === cleanPatternPath ||
          urlObj.pathname === cleanPatternPath + '/' ||
          urlObj.pathname.startsWith(cleanPatternPath + '/') ||
          urlObj.pathname.startsWith(cleanPatternPath + '?');
        logDebug(`Path comparison: urlPath=${urlObj.pathname}, patternPath=${cleanPatternPath}, result=${pathResult}`);
        // Check query parameters if present in rule
        if (hasQuery && pathResult) {
          // Split pattern query into parameters
          const patternParams = new URLSearchParams(patternQuery);
          const urlParams = new URLSearchParams(urlObj.search);
          let queryResult = true;
          for (const [key, value] of patternParams) {
            if (!urlParams.has(key) || (value !== '' && urlParams.get(key) !== value)) {
              queryResult = false;
              break;
            }
          }
          logDebug(`Query comparison: urlQuery=${urlObj.search}, patternQuery=${patternQuery}, result=${queryResult}`);
          return queryResult;
        }
        return pathResult;
      }
    }
    // 2. Domain-only patterns (no /)
    else {
      const urlDomain = urlObj.hostname.replace(/^www\./, '');
      const result = matchesDomainPattern(urlDomain, rulePattern);
      //logDebug(`Domain-only pattern test: urlDomain=${urlDomain}, pattern=${rulePattern}, result=${result}`);
      return result;
    }
  } catch (e) {
    console.error('Error matching rule:', rulePattern, 'against URL:', url, e);
    return false;
  }
}

// Helper function to match domains with wildcard support
function matchesDomainPattern(domain, pattern) {
  if (pattern === '*' || pattern === '*.*') return true; // valid global patterns

  // Normalize both domain and pattern by removing www.
  const normalizedDomain = domain.replace(/^www\./, '');
  const normalizedPattern = pattern.replace(/^www\./, '');
  // No wildcards - exact match
  if (!normalizedPattern.includes('*')) {
    const result = normalizedDomain === normalizedPattern;
    if (result === true) {
      logDebug(`Testing domain pattern: domain=${domain}, pattern=${pattern}`);
      logDebug(`Exact match test: ${normalizedDomain} === ${normalizedPattern} = ${result}`);
    }
    return result;
  }
  // Handle wildcard patterns
  // For patterns like "google.*", match domains that contain "google."
  // For patterns like "*.google.com", match subdomains of "google.com"
  let regexPattern;
  if (normalizedPattern.startsWith('*.')) {
    // Subdomain pattern like "*.google.com" - matches subdomains
    const baseDomain = normalizedPattern.substring(2); // Remove "*."
    regexPattern = `^(${baseDomain.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}|.*\\.${baseDomain.replace(/[.+?^${}()|[\]\\]/g, '\\$&')})$`;
    //logDebug(`Subdomain regex: ${regexPattern}`);
  } else if (normalizedPattern.endsWith('.*')) {
    // Domain family pattern like "google.*" - matches google.<tld> but not subdomains
    const baseDomain = normalizedPattern.substring(0, normalizedPattern.length - 2); // Remove ".*"
    regexPattern = `^${baseDomain.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}\\.[a-zA-Z]{2,}$`;
    //logDebug(`Domain family regex: ${regexPattern}`);
  } else {
    // General wildcard pattern - convert * to .*
    regexPattern = normalizedPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
      .replace(/\\\*/g, '.*'); // Convert escaped * back to .*
    regexPattern = '^' + regexPattern + '$';
    logDebug(`General wildcard regex: ${regexPattern}`);
  }
  try {
    const regex = new RegExp(regexPattern, 'i'); // Case-insensitive
    const result = regex.test(normalizedDomain);
    //logDebug(`Domain pattern test: "${normalizedDomain}" against "${normalizedPattern}" (regex: ${regexPattern}) = ${result}`);
    return result;
  } catch (e) {
    console.error('Invalid wildcard pattern:', normalizedPattern, e);
    return false;
  }
}

// Function to create a new temporary container
async function createTempContainer() {
  const num = await getNextContainerNumber();
  const name = `tmp_${num}`;
  logDebug('Creating temp container:', name);

  // Load default style
  const { tempContainerStyle = { color: 'blue', icon: 'circle', randomColor: false, randomIcon: false } } =
    await browser.storage.local.get('tempContainerStyle');

  const color = tempContainerStyle.randomColor ? getRandomItem(COLORS) : tempContainerStyle.color || 'blue';
  const icon = tempContainerStyle.randomIcon ? getRandomItem(ICONS) : tempContainerStyle.icon || 'circle';

  const container = await browser.contextualIdentities.create({
    name: name,
    color: color,
    icon: icon,
  });

  logDebug(`Created temp container: ${name} with color=${color}, icon=${icon}`);
  startDeletionTimer(container.cookieStoreId);
  return container;
}

// Function to start a deletion timer for a container
function startDeletionTimer(cookieStoreId) {
  if (deletionTimers.has(cookieStoreId)) {
    clearTimeout(deletionTimers.get(cookieStoreId));
  }
  const timerId = setTimeout(
    async () => {
      const tabs = await browser.tabs.query({ cookieStoreId });
      if (tabs.length === 0) {
        await browser.contextualIdentities.remove(cookieStoreId);
        logDebug('Deleted container:', cookieStoreId);
      }
      deletionTimers.delete(cookieStoreId);
    },
    5 * 60 * 1000,
  ); // 5 minutes
  deletionTimers.set(cookieStoreId, timerId);
}

// Function to cancel a deletion timer
function cancelDeletionTimer(cookieStoreId) {
  if (deletionTimers.has(cookieStoreId)) {
    clearTimeout(deletionTimers.get(cookieStoreId));
    deletionTimers.delete(cookieStoreId);
  }
}

// Replace a tab with a new one in a temporary or permanent container
// targetCookieStoreId: optional pre-resolved container ID; skips getContainerForDomain if provided
async function replaceTab(tab, newUrl = null, targetCookieStoreId = null) {
  const originalTabId = tab.id;

  // Resolve the target URL first so it can be validated
  const targetUrl = newUrl || (tab.url && !['about:blank', 'about:newtab'].includes(tab.url) ? tab.url : null);

  // Comprehensive Privileged/Invalid URL check.
  // Check targetUrl here because that is what browser.tabs.create will eventually use.
  if (
    !targetUrl ||
    targetUrl.startsWith('about:') ||
    targetUrl.startsWith('chrome:') ||
    targetUrl.startsWith('resource:')
  ) {
    logDebug(`Skipping replaceTab for blank or privileged URL: ${targetUrl || 'No URL'}`);
    // Clean up the lock on early return
    processingTabs.delete(originalTabId);
    return tab;
  }

  const originalIndex = tab.index;
  const windowId = tab.windowId;

  // Logging setup (for debugging)
  const container = tab.cookieStoreId
    ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null)
    : null;
  const containerName = container ? container.name : tab.cookieStoreId === 'firefox-default' ? 'Default' : 'unknown';
  const isTempContainer = container && /^tmp_\d+$/.test(container.name);
  logDebug(
    `replaceTab: Tab ${originalTabId}, URL: ${targetUrl}, container: ${containerName} (${tab.cookieStoreId}), isTemp: ${isTempContainer}`,
  );

  // Resolve the CookieStoreId
  let cookieStoreId = targetCookieStoreId;

  if (!cookieStoreId) {
    const domain = getDomain(targetUrl);
    if (domain) {
      cookieStoreId = await getContainerForDomain(targetUrl);
    }
  }

  if (!cookieStoreId) {
    logDebug(`No rule found for ${targetUrl}. Creating temporary isolation container.`);
    const tempContainer = await createTempContainer();
    cookieStoreId = tempContainer.cookieStoreId;
  }

  try {
    const newTab = await browser.tabs.create({
      url: targetUrl,
      cookieStoreId: cookieStoreId,
      index: originalIndex,
      windowId: windowId,
      active: tab.active,
    });

    addonCreatedTabs.add(newTab.id);
    logDebug(`Created new tab at index: ${originalIndex}, new tab id: ${newTab.id}, container: ${cookieStoreId}`);

    // Remove original tab
    try {
      await browser.tabs.get(originalTabId);
      await browser.tabs.remove(originalTabId);
      logDebug(`Removed original tab: ${originalTabId}`);
    } catch (error) {
      console.warn(`Original tab ${originalTabId} no longer exists, skipping removal`);
    }

    if (targetUrl) {
      tabUrls.set(newTab.id, targetUrl);
    }
    return newTab;
  } catch (error) {
    console.error(`Error in replaceTab for tab ${originalTabId}:`, error);
    throw error;
  } finally {
    // Ensure the lock is always released
    processingTabs.delete(originalTabId);
  }
}

// Listen for storage changes
browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.DEBUG) {
    DEBUG = changes.DEBUG.newValue ?? false;
    logDebug('Auto Containers: Debug mode changed to:', DEBUG);
  }
});

// Track active tab to filter user-initiated actions
browser.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await browser.tabs.get(activeInfo.tabId).catch(() => null);
  if (tab) {
    const container = tab.cookieStoreId
      ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null)
      : null;
    const containerName = container ? container.name : 'default';
    logDebug(
      `Active tab updated: ${activeInfo.tabId}, URL: ${tab.url}, container: ${containerName} (${tab.cookieStoreId || 'firefox-default'})`,
    );

    // Update badge for the activated tab
    await updateTabBadge(activeInfo.tabId);
  } else {
    logDebug(`Active tab updated: ${activeInfo.tabId}, tab info unavailable`);
  }
});

// Handle new tab creation
browser.tabs.onCreated.addListener(async (tab) => {
  // Track cookieStoreId so it's available after the tab is removed
  if (tab.cookieStoreId) {
    tabCookieStoreIds.set(tab.id, tab.cookieStoreId);
  }

  // If the opener tab is excluded from domain isolation, inherit that exclusion.
  // This preserves container context across multi-domain flows (e.g. payment redirects)
  // where the next stage opens in a new tab and must stay in the same container.
  // Inheritance is temporary and shares timer with the source chain.
  if (tab.openerTabId && excludedTabs.has(tab.openerTabId)) {
    await inheritExclusion(tab.id, tab.openerTabId);
    logDebug(`Tab ${tab.id} inherited domain isolation exclusion from opener tab ${tab.openerTabId}`);
    // Don't return - handleNewTab will skip processing this tab due to the exclusion,
    // and Firefox naturally keeps the new tab in the opener's container
  }

  const container = tab.cookieStoreId
    ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null)
    : null;
  const containerName = container ? container.name : 'unknown';
  const isTempContainer = container && /^tmp_\d+$/.test(container.name);
  logDebug(
    `Tab created: ${tab.id}, URL: ${tab.url}, openerTabId: ${tab.openerTabId}, container: ${containerName} (${tab.cookieStoreId}), isTemp: ${isTempContainer}`,
  );

  if (processingTabs.has(tab.id)) {
    logDebug(`Tab ${tab.id} already being processed, skipping`);
    return;
  }

  // Skip addon-created tabs to prevent infinite loops
  if (addonCreatedTabs.has(tab.id)) {
    logDebug(`Tab ${tab.id} was created by addon, skipping processing`);
    return;
  }

  // Handle blank tabs - prevent domain contamination while preserving tab restoration
  if ((tab.url === 'about:blank' || tab.url === 'about:newtab') && !tab.openerTabId) {
    const isDefaultContainer = !tab.cookieStoreId || tab.cookieStoreId === 'firefox-default';

    // Special case: Don't interfere with tab restoration (reopen closed tab)
    // Restored tabs often start as blank but will get their URL shortly after
    // Detect this by checking if the tab has a title that doesn't match about:blank
    const hasNonBlankTitle = tab.title && tab.title !== 'New Tab' && tab.title !== '';

    if (hasNonBlankTitle) {
      logDebug(`Blank tab ${tab.id} appears to be a restored tab (title: "${tab.title}"), deferring to URL update`);
      pendingTabs.add(tab.id);
      return;
    }

    // Check if this blank tab inherited a container that could cause contamination
    // Move to new temp container if:
    // 1. It's in a permanent container (domain-specific container) - but not if it's being restored
    // 2. It's in a temp container that already has other tabs with domains
    if (!isDefaultContainer) {
      let shouldMoveToNewContainer = false;
      let reason = '';

      if (!isTempContainer) {
        // Blank tab in permanent container - move to prevent contamination
        shouldMoveToNewContainer = true;
        reason = `inherited permanent container ${tab.cookieStoreId}`;
      } else {
        // Blank tab in temp container - check if container has other tabs with domains
        const containerTabs = await browser.tabs.query({ cookieStoreId: tab.cookieStoreId });
        const tabsWithDomains = containerTabs.filter(
          (t) => t.id !== tab.id && t.url && t.url !== 'about:blank' && t.url !== 'about:newtab' && getDomain(t.url),
        );

        if (tabsWithDomains.length > 0) {
          shouldMoveToNewContainer = true;
          reason = `temp container ${tab.cookieStoreId} already has ${tabsWithDomains.length} tabs with domains`;
        }
      }

      if (shouldMoveToNewContainer) {
        logDebug(`Blank tab ${tab.id} needs new container: ${reason}`);
        if (!incrementProcessingCount(tab.id)) {
          console.error(`Skipping processing of tab ${tab.id} due to infinite loop protection`);
          return;
        }
        processingTabs.add(tab.id);
        try {
          const tempContainer = await createTempContainer();
          const newTab = await browser.tabs.create({
            url: tab.url,
            cookieStoreId: tempContainer.cookieStoreId,
            index: tab.index,
            windowId: tab.windowId,
            active: tab.active,
          });
          addonCreatedTabs.add(newTab.id);
          logDebug(`Created new blank tab ${newTab.id} in fresh temp container: ${tempContainer.cookieStoreId}`);
          await browser.tabs.remove(tab.id);
          logDebug(`Removed original blank tab: ${tab.id}`);
          resetProcessingCount(tab.id);
        } catch (error) {
          console.error(`Error replacing blank tab ${tab.id}:`, error);
        } finally {
          processingTabs.delete(tab.id);
        }
        return;
      }
    }

    // Blank tab is safe - in default container or in empty/fresh temp container
    logDebug(
      `Blank tab ${tab.id} is safe in ${isDefaultContainer ? 'default' : 'clean temp'} container, leaving as-is`,
    );
    return;
  }

  // For all other tabs, defer handling until URL is available
  pendingTabs.add(tab.id);
});

// Handle tab updates
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Keep cookieStoreId in sync in case tab was replaced into a new container
  if (tab.cookieStoreId) {
    tabCookieStoreIds.set(tabId, tab.cookieStoreId);
  }
  const filteredChangeInfo = { ...changeInfo };
  delete filteredChangeInfo.favIconUrl;
  logDebug(
    `onUpdated triggered - tabId: ${tabId}, index: ${tab.index}, url: ${tab.url}, changeInfo:`,
    filteredChangeInfo,
  );

  // Update badge when page loading completes or URL changes
  if ((changeInfo.status === 'complete' || changeInfo.url) && excludedTabs.has(tabId)) {
    await updateTabBadge(tabId);
  }

  // Fallback container replacement when onBeforeNavigate did not trigger
  // (covers cases where navigation happens after temp exclusion timer expires)
  if (
    changeInfo.url &&
    !processingTabs.has(tabId) &&
    !addonCreatedTabs.has(tabId) &&
    !excludedTabs.has(tabId) &&
    !pendingTabs.has(tabId)
  ) {
    logDebug(`onUpdated URL change fallback for tab ${tabId} - checking container`);
    await handleContainerChangeOnNavigation(tabId, changeInfo.url);
  }

  if (processingTabs.has(tabId)) {
    logDebug(`Tab ${tabId} already being processed, skipping`);
    return;
  }
  // Store initial URL when loading starts
  if (
    changeInfo.status === 'loading' &&
    tab.url !== 'about:blank' &&
    tab.url !== 'about:newtab' &&
    !tabUrls.get(tabId)
  ) {
    tabUrls.set(tabId, tab.url);
    logDebug(`Stored initial URL for tab ${tabId}: ${tab.url}`);
  }
  // Handle pending tabs with new URLs
  if (pendingTabs.has(tabId) && changeInfo.url && tab.url !== 'about:blank' && tab.url !== 'about:newtab') {
    logDebug(`URL now available for tab: ${tabId}`);
    pendingTabs.delete(tabId);
    await handleNewTab(tab);
    return;
  }
  // Handle blank tabs that remain blank after loading
  if (
    pendingTabs.has(tabId) &&
    changeInfo.status === 'complete' &&
    (tab.url === 'about:blank' || tab.url === 'about:newtab') &&
    !addonCreatedTabs.has(tabId)
  ) {
    logDebug(`Pending blank tab ${tabId} completed loading, leaving as-is`);
    pendingTabs.delete(tabId);
    return;
  }
  // Clean up addonCreatedTabs when navigation is complete
  if (changeInfo.status === 'complete' && addonCreatedTabs.has(tabId)) {
    logDebug(`Removing tab ${tabId} from addonCreatedTabs after navigation complete`);
    addonCreatedTabs.delete(tabId);
  }
});

// Handle navigation events for domain changes
browser.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return; // Only handle main frame navigations

    const tabId = details.tabId;

    // Check if tab is excluded from domain isolation
    if (excludedTabs.has(tabId)) {
      logDebug(`Tab ${tabId} is excluded from domain isolation, skipping navigation handling`);
      const newUrl = details.url;
      tabUrls.set(tabId, newUrl); // Still update stored URL for tracking

      // Update badge to ensure it shows after navigation
      await updateTabBadge(tabId);
      return;
    }

    // Call shared container logic
    await handleContainerChangeOnNavigation(tabId, details.url);
  },
  { url: [{ schemes: ['http', 'https'] }] },
);

// Handle tab removal to clean up
browser.tabs.onRemoved.addListener(async (tabId) => {
  tabUrls.delete(tabId);
  pendingTabs.delete(tabId);
  addonCreatedTabs.delete(tabId);
  tabProcessingCount.delete(tabId);

  // // Clean up exclusion tracking for both permanent and temporary exclusions
  const wasPermanent = permanentExclusions.has(tabId);
  excludedTabs.delete(tabId);
  permanentExclusions.delete(tabId);
  clearTabExclusionTimer(tabId);

  // Use the tracked cookieStoreId - browser.tabs.get() on a removed tab always returns null
  const cookieStoreId = tabCookieStoreIds.get(tabId);
  tabCookieStoreIds.delete(tabId);

  if (cookieStoreId) {
    const container = await browser.contextualIdentities.get(cookieStoreId).catch(() => null);
    if (container && /^tmp_\d+$/.test(container.name)) {
      const tabs = await browser.tabs.query({ cookieStoreId });
      if (tabs.length === 0) {
        startDeletionTimer(cookieStoreId);
      }
    }
  }

  logDebug(`Tab ${tabId} removed${wasPermanent ? ' (was permanent exclusion)' : ''}`);
});

// Centralized function that decides whether to replace the tab when domain changes
// Called from onBeforeNavigate (preferred) and as fallback from onUpdated
async function handleContainerChangeOnNavigation(tabId, newUrl) {
  // Skip empty URLs
  if (!newUrl) return;

  // Skip all internal Firefox pages (about:, chrome:, resource:)
  // These cannot be moved between containers anyway.
  if (newUrl.startsWith('about:') || newUrl.startsWith('chrome:') || newUrl.startsWith('resource:')) {
    logDebug(`Ignoring privileged URL: ${newUrl}`);
    return;
  }

  logDebug(`handleContainerChangeOnNavigation - tabId: ${tabId}, newUrl: ${newUrl}`);

  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;

  // Check for inherited exclusion status before locking.
  // For cases where onBeforeNavigate beats onCreated to the tab.
  // Only inherit if the tab is new to extension (!tabUrls.has) to prevent re-inheriting status after it was removed.
  if (!tabUrls.has(tabId) && tab.openerTabId && excludedTabs.has(tab.openerTabId)) {
    await inheritExclusion(tab.id, tab.openerTabId);
    logDebug(`Tab ${tab.id} inherited domain isolation exclusion from opener tab ${tab.openerTabId}`);
    // Set the URL so the next navigation knows this tab is established
    tabUrls.set(tabId, newUrl);
    return; // this tab is excluded, do not change its container
  }

  // Standard processing locks
  if (addonCreatedTabs.has(tabId) || pendingTabs.has(tabId) || processingTabs.has(tabId)) {
    logDebug(`Skipping tab ${tabId} as it's addon-created, pending, or already processing`);
    return;
  }

  // Lock this tab immediately to prevent concurrent onUpdated fallbacks
  processingTabs.add(tabId);

  try {
    const newDomain = getDomain(newUrl);
    if (!newDomain) return;

    // Synchronously get currentUrl from the map before the next 'await' (getContainerForDomain) to prevent race conditions.
    // This stops concurrent onUpdated events from overwriting tabUrls before its read.
    let currentUrl = tabUrls.get(tabId);

    // If no stored URL exists, it's an untracked (blank/new) tab.
    // Prevent Firefox's preemptive tab.url update from tricking the comparison.
    if (!currentUrl) {
      currentUrl = tab.url === newUrl ? '' : tab.url;
    }

    const currentDomain = getDomain(currentUrl);
    logDebug(`Domain comparison - Current: ${currentDomain} (from ${currentUrl}), New: ${newDomain} (from ${newUrl})`);

    const currentContainer = tab.cookieStoreId
      ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null)
      : null;
    const isTempContainer = currentContainer && /^tmp_\d+$/.test(currentContainer.name);

    // Check if the tab is in the default container or needs a different container
    const targetContainerId = await getContainerForDomain(newUrl);

    // Handle special reserved container names
    if (targetContainerId === '#Ignore') {
      logDebug(`Rule #Ignore matched for ${newUrl}, skipping container assignment.`);
      tabUrls.set(tabId, newUrl); // Still track URL but don't move tab
      return;
    }

    // Check opener for same-domain navigation.
    // Skip if a permanent container rule exists and the opener isn't in it — the rule takes precedence.
    if (tab.openerTabId) {
      const openerTab = await browser.tabs.get(tab.openerTabId).catch(() => null);
      if (openerTab) {
        const openerDomain = getDomain(openerTab.url);
        const openerContainerId = openerTab.cookieStoreId;
        const openerConflictsWithRule = targetContainerId && openerContainerId !== targetContainerId;
        if (
          newDomain === openerDomain &&
          openerContainerId &&
          openerContainerId !== 'firefox-default' &&
          !openerConflictsWithRule
        ) {
          if (tab.cookieStoreId !== openerContainerId) {
            logDebug(
              `Replacing tab ${tabId} with opener's container for same domain ${newDomain}: ${openerContainerId}`,
            );
            await replaceTab(tab, newUrl, openerContainerId);
            return; // Return early: don't update tabUrls for a dead tab
          } else {
            logDebug(`Tab ${tabId} already in correct opener container for domain ${newDomain}: ${tab.cookieStoreId}`);
            if (isTempContainer) {
              cancelDeletionTimer(tab.cookieStoreId); // Cancel existing timer
              startDeletionTimer(tab.cookieStoreId); // Start new timer
            }
          }
          tabUrls.set(tabId, newUrl); // Update stored URL
          return;
        }
      }
    }

    // Determine if the tab needs to be replaced
    let shouldReplace = false;
    let reason = '';

    const isCurrentlyDefault = tab.cookieStoreId === 'firefox-default';
    const isTargetDefault = !targetContainerId || targetContainerId === 'firefox-default';

    // If the tab is already in the container specified by the rules (or default),
    // don't replace it, even if currentDomain is unknown (session restore).
    if (targetContainerId && tab.cookieStoreId === targetContainerId) {
      logDebug(`Tab ${tabId} already satisfies rule for ${newDomain} (${targetContainerId}). Skipping.`);
      tabUrls.set(tabId, newUrl);
      return;
    }

    if (isCurrentlyDefault) {
      // Tab is currently in the Default Container
      if (targetContainerId && !isTargetDefault) {
        // Case 1: Tab is in default container but needs a specific container
        shouldReplace = true;
        reason = `moving from default container to specific container: ${targetContainerId}`;
      } else if (!targetContainerId && newDomain !== currentDomain) {
        // Case 2: No rule found, but domain changed -> isolate in new temporary container
        if (currentDomain !== null) {
          shouldReplace = true;
          reason = `moving from default container to temp container for domain change`;
        }
      }
      // If isTargetDefault is true, do nothing (stay in default)
    } else {
      // Tab is currently in a Container (Temporary or Permanent)
      // Case 3: Domain changed and containers should be different
      if (newDomain !== currentDomain) {
        // Handle session restore (currentDomain is null)
        if (currentDomain === null) {
          // If previous domain is unknown, only replace if a rule explicitly
          // conflicts with the current container.
          if (targetContainerId && tab.cookieStoreId !== targetContainerId) {
            shouldReplace = true;
            reason = `session restore mismatch: tab is in ${tab.cookieStoreId} but rule requires ${targetContainerId}`;
          } else {
            logDebug(`Session restore for ${newDomain}: keeping current container ${tab.cookieStoreId}`);
          }
        } else {
          // Normal domain change navigation
          // Resolve current domain's container for comparison
          const currentTargetContainerId = await getContainerForDomain(currentUrl);
          // Only replace if the target containers are actually different
          if (targetContainerId !== currentTargetContainerId) {
            shouldReplace = true;
            reason = `domain change requiring different container: ${currentTargetContainerId} -> ${targetContainerId}`;
          } else if (!targetContainerId && !currentTargetContainerId) {
            // Both domains are "unassigned", but they are different -> new temp container
            shouldReplace = true;
            reason = `domain change requiring new temp container isolation`;
          }
        }
      } else if (targetContainerId && tab.cookieStoreId !== targetContainerId) {
        // Case 4: Same domain navigation, but tab is in the wrong container per rules
        // (e.g. user manually moved tab or rule was updated)
        shouldReplace = true;
        reason = `same domain but wrong container: ${tab.cookieStoreId} -> ${targetContainerId}`;
      }
    }

    if (shouldReplace) {
      logDebug(`Replacing tab ${tabId} for domain ${newDomain} (was ${currentDomain}): ${reason}`);
      await replaceTab(tab, newUrl, targetContainerId);
      return; // Return early so dead tab isn't put back into tabUrls
    } else {
      logDebug(
        `Tab ${tabId} staying in current container for navigation from ${currentDomain} to ${newDomain}: ${tab.cookieStoreId}`,
      );
      if (isTempContainer) {
        cancelDeletionTimer(tab.cookieStoreId); // Cancel existing timer
        startDeletionTimer(tab.cookieStoreId); // Start new timer
      }
    }
    tabUrls.set(tabId, newUrl); // Only hit this if the tab wasn't replaced
  } finally {
    processingTabs.delete(tabId); // Always release the lock no matter what happens
  }
}

// Handle new tabs with available URL
async function handleNewTab(tab) {
  // Skip if tab is excluded from domain isolation
  if (excludedTabs.has(tab.id)) {
    logDebug(`Tab ${tab.id} is excluded from domain isolation, skipping handleNewTab processing`);
    return;
  }

  if (!tab.url || tab.url.startsWith('about:')) {
    // Skip pages like about:blank, about:newtab, about:addons, etc.
    logDebug(`Skipping internal or blank page: ${tab.url || 'No URL'}, id: ${tab.id}`);
    return;
  }

  // Skip extension pages
  if (tab.url.startsWith('moz-extension://')) {
    logDebug(`Tab ${tab.id} is extension page, skipping container processing: ${tab.url}`);
    return;
  }

  if (processingTabs.has(tab.id)) {
    logDebug(`Tab ${tab.id} already being processed, skipping`);
    return;
  }

  processingTabs.add(tab.id);
  try {
    const newDomain = getDomain(tab.url);
    const currentContainer = tab.cookieStoreId
      ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null)
      : null;
    const isTempContainer = currentContainer && /^tmp_\d+$/.test(currentContainer.name);
    // Fetch opener tab once here so it's available for both the same-domain check below
    // and the final fallback condition, avoiding a redundant browser.tabs.get() call
    const openerTab = tab.openerTabId ? await browser.tabs.get(tab.openerTabId).catch(() => null) : null;
    // Check for permanent container first
    if (newDomain) {
      const targetContainerId = await getContainerForDomain(tab.url);

      // Handle special reserved container names
      if (targetContainerId === '#Ignore') {
        logDebug(`New tab ${tab.id} matched #Ignore rule. Doing nothing.`);
        return;
      }

      if (targetContainerId && tab.cookieStoreId !== targetContainerId) {
        logDebug(`Replacing tab ${tab.id} with permanent container: ${targetContainerId}`);
        await replaceTab(tab, tab.url);
        return;
      } else if (targetContainerId) {
        logDebug(`Tab ${tab.id} already in correct permanent container: ${targetContainerId}`);
        return;
      }
    }
    // Check if there's an opener tab and if domains match
    if (openerTab) {
      const openerDomain = getDomain(openerTab.url);
      const openerContainerId = openerTab.cookieStoreId;
      const openerContainer = openerContainerId
        ? await browser.contextualIdentities.get(openerContainerId).catch(() => null)
        : null;
      logDebug(`Opener domain: ${openerDomain}, New domain: ${newDomain}, Opener container: ${openerContainerId}`);
      // Reuse opener's container if domains match and opener is not in default container
      if (openerDomain === newDomain && openerContainerId && openerContainerId !== 'firefox-default') {
        if (tab.cookieStoreId !== openerContainerId) {
          logDebug(`Replacing tab ${tab.id} with opener's container: ${openerContainerId}`);
          await replaceTab(tab, tab.url);
        } else {
          logDebug(`Tab ${tab.id} already in correct opener container: ${openerContainerId}`);
        }
        // If opener's container is temporary, restart its deletion timer
        if (openerContainer && /^tmp_\d+$/.test(openerContainer.name)) {
          startDeletionTimer(openerContainerId);
        }
        return;
      }
    }
    // If no permanent container or opener match, assign a new temporary container
    if (!isTempContainer || (openerTab && getDomain(tab.url) !== getDomain(openerTab.url))) {
      logDebug(`Replacing tab ${tab.id} with temporary container`);
      await replaceTab(tab, tab.url);
    } else {
      logDebug(`Tab ${tab.id} already in a suitable temporary container: ${tab.cookieStoreId}`);
      if (isTempContainer) {
        startDeletionTimer(tab.cookieStoreId);
      }
    }
  } finally {
    processingTabs.delete(tab.id);
  }
}

// Listen for messages from options/popup to sort rules when they're saved
browser.runtime.onMessage.addListener(async (message) => {
  try {
    logDebug('Received message:', message);

    if (message.action === 'excludeTab') {
      const tabId = message.tabId;
      if (!excludedTabs.has(tabId) || !permanentExclusions.has(tabId)) {
        // Make sure it becomes / stays permanent
        excludedTabs.add(tabId);
        permanentExclusions.add(tabId);

        // If it was previously temporary, remove it from any temp group
        clearTabExclusionTimer(tabId);

        await updateTabBadge(tabId);
        logDebug(`Tab ${tabId} added to permanent domain isolation exclusions`);
      }
      return {
        success: true,
        isExcluded: true,
      };
    } else if (message.action === 'removeExclusion') {
      const tabId = message.tabId;
      if (excludedTabs.has(tabId)) {
        excludedTabs.delete(tabId);
        permanentExclusions.delete(tabId);

        // Clean up temporary timer association if any
        clearTabExclusionTimer(tabId);

        await updateTabBadge(tabId);
        logDebug(`Tab ${tabId} removed from domain isolation exclusions`);
      }
      return {
        success: true,
        isExcluded: false,
      };
    } else if (message.action === 'sortRules') {
      logDebug('Processing sortRules message');
      const { rules = '' } = await browser.storage.local.get('rules');
      const sortedRules = sortRules(rules);
      // Only save if sorting actually changed something and didn't fail
      if (sortedRules !== rules && sortedRules !== null && sortedRules !== undefined) {
        logDebug('Rules changed, saving sorted version');
        await browser.storage.local.set({ rules: sortedRules });
        logDebug('Sorted rules saved');
      } else {
        logDebug('Rules unchanged after sorting');
      }
      return { success: true };
    }
  } catch (error) {
    console.error('Error handling message:', error);
    return { success: false, error: error.message };
  }
});

// Startup
(async () => {
  logDebug('Auto Containers background script loaded');

  const result = await browser.storage.local.get({ DEBUG: false });
  DEBUG = result.DEBUG;
  logDebug('Auto Containers: Debug mode set to:', DEBUG);

  // Create main context menu with submenu
  browser.contextMenus.create({
    id: 'auto-containers-main',
    title: 'Auto Containers',
    contexts: ['page', 'link', 'selection'],
  });

  browser.contextMenus.create({
    id: 'exclude-from-isolation',
    parentId: 'auto-containers-main',
    title: 'Exclude tab from domain isolation',
    contexts: ['page', 'link', 'selection'],
  });

  browser.contextMenus.create({
    id: 'remove-from-exclusions',
    parentId: 'auto-containers-main',
    title: 'Remove tab from exclusions',
    contexts: ['page', 'link', 'selection'],
  });

  const tempContainers = await getTempContainers();
  logDebug(`Found ${tempContainers.length} temporary containers`);

  //delete empty temporary containers
  for (const container of tempContainers) {
    const tabs = await browser.tabs.query({ cookieStoreId: container.cookieStoreId });
    if (tabs.length === 0) {
      await browser.contextualIdentities.remove(container.cookieStoreId);
      logDebug(`Deleted empty container on startup: ${container.cookieStoreId}`);
    } else {
      // start deletion timer for non-empty temp container
      startDeletionTimer(container.cookieStoreId);
    }
  }
})();

// Context menu click handler
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'exclude-from-isolation') {
    if (!excludedTabs.has(tab.id) || !permanentExclusions.has(tab.id)) {
      excludedTabs.add(tab.id);
      permanentExclusions.add(tab.id);

      // If it was previously temporary, remove it from any temp group
      clearTabExclusionTimer(tab.id);

      await updateTabBadge(tab.id);
      logDebug(`Tab ${tab.id} added to permanent domain isolation exclusions`);
    }
  } else if (info.menuItemId === 'remove-from-exclusions') {
    if (excludedTabs.has(tab.id)) {
      excludedTabs.delete(tab.id);
      permanentExclusions.delete(tab.id);
      clearTabExclusionTimer(tab.id);

      await updateTabBadge(tab.id);
      logDebug(`Tab ${tab.id} removed from domain isolation exclusions`);
    }
  }
});
