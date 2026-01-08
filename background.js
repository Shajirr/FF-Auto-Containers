import { sortRules } from './sorting.js';

const DEBUG = true; // Toggle for debug logging

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
// Variable to track the last active tab ID
let lastActiveTabId = null;
// Set to track tabs created by the addon
const addonCreatedTabs = new Set();
// Set to track tabs excluded from domain isolation
const excludedTabs = new Set();

const COLORS = ['blue', 'turquoise', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'toolbar'];
const ICONS = ['fingerprint', 'briefcase', 'dollar', 'cart', 'vacation', 'gift', 'food', 'fruit', 'pet', 'tree', 'chill', 'circle', 'fence'];

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
  return identities.filter(identity => /^tmp_\d+$/.test(identity.name));
}

// Function to get the next available container number
async function getNextContainerNumber() {
  const tempContainers = await getTempContainers();
  const numbers = tempContainers
    .map(container => parseInt(container.name.split('_')[1], 10))
    .filter(num => !isNaN(num))
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
async function updateTabBadge(tabId, isExcluded) {
  try {
    if (isExcluded) {
      await browser.browserAction.setBadgeText({ text: "EX", tabId: tabId });
      await browser.browserAction.setBadgeBackgroundColor({ color: "#ff6b35", tabId: tabId });
    } else {
      await browser.browserAction.setBadgeText({ text: "", tabId: tabId });
    }
  } catch (error) {
    console.error('Error updating badge for tab', tabId, error);
  }
}

// Function to check rules for permanent container
async function getContainerForDomain(url) {
  try {
    const { rules = '', containerStyles = {} } = await browser.storage.local.get(['rules', 'containerStyles']);
    const ruleLines = rules.split('\n').filter(line => line.trim() !== '');
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
      const [rulePattern, containerName] = line.split(',').map(part => part.trim());
      rulesChecked++;

      if (matchesRule(url, domain, rulePattern)) {
        logDebug(`Rule ${rulePattern} matched! Using container: ${containerName}, rules checked: ${rulesChecked}`);
        const identities = await browser.contextualIdentities.query({ name: containerName });
        if (identities.length > 0) {
          logDebug(`Found existing container: ${containerName} (${identities[0].cookieStoreId}) for pattern: ${rulePattern}`);
          return identities[0].cookieStoreId;
        }
        // Apply saved styles when creating container
        const styles = containerStyles[containerName] || { color: 'blue', icon: 'circle' }; 
        const identity = await browser.contextualIdentities.create({
          name: containerName,
          color: styles.color,
          icon: styles.icon
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
        logDebug(`Path regex test: urlPath=${urlObj.pathname}, regex=${regexPath}, result=${new RegExp(regexPath).test(urlObj.pathname)}`);
        return new RegExp(regexPath).test(urlObj.pathname);
      } else {
        // Match exact path, path with query parameters, or path with trailing slash
        const pathResult = urlObj.pathname === cleanPatternPath || 
                           urlObj.pathname === cleanPatternPath + '/' || 
                           urlObj.pathname.startsWith(cleanPatternPath + '/') || 
                           urlObj.pathname.startsWith(cleanPatternPath + '?');
        logDebug(`Path comparison: urlPath=${urlObj.pathname}, patternPath=${cleanPatternPath}, result=${pathResult}`);
        // Check query parameters if present in rule
        if (hasQuery && pathResult) {
          const normalizedPatternQuery = patternQuery.endsWith('=') ? patternQuery : patternQuery + '=';
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
          logDebug(`Query comparison: urlQuery=${urlObj.search}, patternQuery=${patternQuery}, normalizedPatternQuery=${normalizedPatternQuery}, result=${queryResult}`);
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
  logDebug(`Testing domain pattern: domain=${domain}, pattern=${pattern}`);
  
  if (pattern === '*' || pattern === '*.*') return true; // valid global patterns
  
  // Normalize both domain and pattern by removing www.
  const normalizedDomain = domain.replace(/^www\./, '');
  const normalizedPattern = pattern.replace(/^www\./, '');
  // No wildcards - exact match
  if (!normalizedPattern.includes('*')) {
    const result = normalizedDomain === normalizedPattern;
    logDebug(`Exact match test: ${normalizedDomain} === ${normalizedPattern} = ${result}`);
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
    logDebug(`Subdomain regex: ${regexPattern}`);
  } else if (normalizedPattern.endsWith('.*')) {
    // Domain family pattern like "google.*" - matches google.<tld> but not subdomains
    const baseDomain = normalizedPattern.substring(0, normalizedPattern.length - 2); // Remove ".*"
    regexPattern = `^${baseDomain.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}\\.[a-zA-Z]{2,}$`;
    logDebug(`Domain family regex: ${regexPattern}`);
  } else {
    // General wildcard pattern - convert * to .*
    regexPattern = normalizedPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
      .replace(/\\\*/g, '.*'); // Convert escaped * back to .*
    regexPattern = '^' + regexPattern + '$';
    logDebug(`General wildcard regex: ${regexPattern}`);
  }
  try {
    const regex = new RegExp(regexPattern, 'i'); // Case insensitive
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
  const { tempContainerStyle = { color: 'blue', icon: 'circle', randomColor: false, randomIcon: false } } = await browser.storage.local.get('tempContainerStyle');
  
  const color = tempContainerStyle.randomColor ? getRandomItem(COLORS) : (tempContainerStyle.color || 'blue');
  const icon = tempContainerStyle.randomIcon ? getRandomItem(ICONS) : (tempContainerStyle.icon || 'circle');
  
  const container = await browser.contextualIdentities.create({
    name: name,
    color: color,
    icon: icon
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
  const timerId = setTimeout(async () => {
    const tabs = await browser.tabs.query({ cookieStoreId });
    if (tabs.length === 0) {
      await browser.contextualIdentities.remove(cookieStoreId);
      logDebug('Deleted container:', cookieStoreId);
    }
    deletionTimers.delete(cookieStoreId);
  }, 5 * 60 * 1000); // 5 minutes
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
async function replaceTabWithTempContainer(tab, newUrl = null) {
  const originalTabId = tab.id;
  const originalIndex = tab.index;
  const originalUrl = newUrl || (tab.url && tab.url !== 'about:blank' && tab.url !== 'about:newtab' ? tab.url : null);
  const windowId = tab.windowId;
  const container = tab.cookieStoreId ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null) : null;
  const containerName = container ? container.name : 'unknown';
  const isTempContainer = container && /^tmp_\d+$/.test(container.name);
  logDebug(`replaceTabWithTempContainer: Tab ${tab.id}, URL: ${originalUrl}, container: ${containerName} (${tab.cookieStoreId}), isTemp: ${isTempContainer}`);
  // Don't create containers for blank URLs unless explicitly requested
  if (!originalUrl || originalUrl === 'about:blank' || originalUrl === 'about:newtab') {
    logDebug(`Skipping container creation for blank URL: ${originalUrl}`);
    processingTabs.delete(originalTabId);
    return tab;
  }
  let cookieStoreId = null;
  const domain = getDomain(originalUrl);
  if (domain) {
    cookieStoreId = await getContainerForDomain(originalUrl);
  }
  if (!cookieStoreId) {
    const tempContainer = await createTempContainer();
    cookieStoreId = tempContainer.cookieStoreId;
  }
  try {
    const newTab = await browser.tabs.create({
      url: originalUrl,
      cookieStoreId: cookieStoreId,
      index: originalIndex,
      windowId: windowId,
      active: tab.active
    });
    addonCreatedTabs.add(newTab.id);
    logDebug(`Created new tab at index: ${originalIndex}, new tab id: ${newTab.id}, container: ${cookieStoreId}`);
    try {
      await browser.tabs.get(originalTabId);
      await browser.tabs.remove(originalTabId);
      logDebug(`Removed original tab: ${originalTabId}`);
    } catch (error) {
      console.warn(`Original tab ${originalTabId} no longer exists, skipping removal`);
    }
    if (originalUrl) {
      tabUrls.set(newTab.id, originalUrl);
    }
    return newTab;
  } catch (error) {
    console.error(`Error in replaceTabWithTempContainer for tab ${originalTabId}:`, error);
    throw error;
  } finally {
    processingTabs.delete(originalTabId);
  }
}

// Track active tab to filter user-initiated actions
browser.tabs.onActivated.addListener(async (activeInfo) => {
  lastActiveTabId = activeInfo.tabId;
  const tab = await browser.tabs.get(activeInfo.tabId).catch(() => null);
  if (tab) {
    const container = tab.cookieStoreId ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null) : null;
    const containerName = container ? container.name : 'default';
    logDebug(`Active tab updated: ${activeInfo.tabId}, URL: ${tab.url}, container: ${containerName} (${tab.cookieStoreId || 'firefox-default'})`);
	
	// Update badge for the activated tab
	await updateTabBadge(activeInfo.tabId, excludedTabs.has(activeInfo.tabId));
  } else {
    logDebug(`Active tab updated: ${activeInfo.tabId}, tab info unavailable`);
  }
});

// Handle new tab creation
browser.tabs.onCreated.addListener(async (tab) => {
  const container = tab.cookieStoreId ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null) : null;
  const containerName = container ? container.name : 'unknown';
  const isTempContainer = container && /^tmp_\d+$/.test(container.name);
  logDebug(`Tab created: ${tab.id}, URL: ${tab.url}, openerTabId: ${tab.openerTabId}, container: ${containerName} (${tab.cookieStoreId}), isTemp: ${isTempContainer}`);
  
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
    const isTempContainer = container && /^tmp_\d+$/.test(container.name);
    
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
        const tabsWithDomains = containerTabs.filter(t => 
          t.id !== tab.id && 
          t.url && 
          t.url !== 'about:blank' && 
          t.url !== 'about:newtab' &&
          getDomain(t.url)
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
            active: tab.active
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
    logDebug(`Blank tab ${tab.id} is safe in ${isDefaultContainer ? 'default' : 'clean temp'} container, leaving as-is`);
    return;
  }
  
  // For all other tabs, defer handling until URL is available
  pendingTabs.add(tab.id);
});

// Handle tab updates
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const filteredChangeInfo = { ...changeInfo };
  delete filteredChangeInfo.favIconUrl;
  logDebug(`onUpdated triggered - tabId: ${tabId}, index: ${tab.index}, url: ${tab.url}, changeInfo:`, filteredChangeInfo);
  
  // Update badge when page loading completes or URL changes
  if ((changeInfo.status === 'complete' || changeInfo.url) && excludedTabs.has(tabId)) {
    await updateTabBadge(tabId, true);
  }
  
  if (processingTabs.has(tabId)) {
    logDebug(`Tab ${tabId} already being processed, skipping`);
    return;
  }
  // Store initial URL when loading starts
  if (changeInfo.status === 'loading' && tab.url !== 'about:blank' && tab.url !== 'about:newtab' && !tabUrls.get(tabId)) {
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
  if (pendingTabs.has(tabId) && changeInfo.status === 'complete' && 
      (tab.url === 'about:blank' || tab.url === 'about:newtab') && 
      !addonCreatedTabs.has(tabId)) {
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
browser.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // Only handle main frame navigations
  
  const tabId = details.tabId;
  
  // Check if tab is excluded from domain isolation
  if (excludedTabs.has(tabId)) {
    logDebug(`Tab ${tabId} is excluded from domain isolation, skipping navigation handling`);
    const newUrl = details.url;
    tabUrls.set(tabId, newUrl); // Still update stored URL for tracking
	
	// Update badge to ensure it shows after navigation
    await updateTabBadge(tabId, true);
    return;
  }
  
  logDebug(`onBeforeNavigate triggered - tabId: ${tabId}, url: ${details.url}`);
  
  if (addonCreatedTabs.has(tabId) || pendingTabs.has(tabId)) {
    logDebug(`Skipping tab ${tabId} as it's addon-created or pending`);
    return;
  }
  
  const newUrl = details.url;
  const newDomain = getDomain(newUrl);
  const tab = await browser.tabs.get(tabId);
  // Get the current domain from stored URL or tab URL
  const storedUrl = tabUrls.get(tabId);
  const currentUrl = storedUrl || tab.url;
  const currentDomain = getDomain(currentUrl);
  
  logDebug(`Domain comparison - Current: ${currentDomain} (from ${currentUrl}), New: ${newDomain} (from ${newUrl})`);
  const currentContainer = tab.cookieStoreId ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null) : null;
  const isTempContainer = currentContainer && /^tmp_\d+$/.test(currentContainer.name);
  // Check if the tab is in the default container or needs a different container
  if (newDomain) {
    const targetContainerId = await getContainerForDomain(newUrl);
    const currentTargetContainerId = currentDomain ? await getContainerForDomain(currentUrl) : null;
    // Check opener for same-domain navigation
    if (tab.openerTabId) {
      const openerTab = await browser.tabs.get(tab.openerTabId).catch(() => null);
      if (openerTab) {
        const openerDomain = getDomain(openerTab.url);
        const openerContainerId = openerTab.cookieStoreId;
        if (newDomain === openerDomain && openerContainerId && openerContainerId !== 'firefox-default') {
          if (tab.cookieStoreId !== openerContainerId) {
            logDebug(`Replacing tab ${tabId} with opener's container for same domain ${newDomain}: ${openerContainerId}`);
            processingTabs.add(tabId);
            try {
              await replaceTabWithTempContainer(tab, newUrl);
            } finally {
              processingTabs.delete(tabId);
            }
          } else {
            logDebug(`Tab ${tabId} already in correct opener container for domain ${newDomain}: ${tab.cookieStoreId}`);
            if (isTempContainer) {
              cancelDeletionTimer(tab.cookieStoreId); // Cancel existing timer
              startDeletionTimer(tab.cookieStoreId);   // Start new timer
            }
          }
          tabUrls.set(tabId, newUrl); // Update stored URL
          return;
        }
      }
    }
	
    // Determine if we need to replace the tab
    let shouldReplace = false;
    let reason = '';
    // Case 1: Tab is in default container but needs a specific container
    if (tab.cookieStoreId === 'firefox-default' && targetContainerId) {
      shouldReplace = true;
      reason = `moving from default container to ${targetContainerId}`;
    }
    // Case 2: Tab is in default container and domain changed (needs temp container)
    else if (tab.cookieStoreId === 'firefox-default' && newDomain !== currentDomain) {
      shouldReplace = true;
      reason = `moving from default container to temp container for domain change`;
    }
    // Case 3: Domain changed and containers should be different
    else if (newDomain !== currentDomain) {
      // Only replace if the target containers are actually different
      if (targetContainerId !== currentTargetContainerId) {
        shouldReplace = true;
        reason = `domain change requiring different container: ${currentTargetContainerId} -> ${targetContainerId}`;
      } else if (!targetContainerId && !currentTargetContainerId) {
        // Both domains need temp containers - create new one for new domain
        shouldReplace = true;
        reason = `domain change requiring new temp container`;
      }
    }
    // Case 4: Same domain but wrong container (shouldn't happen but safety check)
    else if (newDomain === currentDomain && targetContainerId && tab.cookieStoreId !== targetContainerId) {
      shouldReplace = true;
      reason = `same domain but wrong container: ${tab.cookieStoreId} -> ${targetContainerId}`;
    }
    if (shouldReplace) {
      logDebug(`Replacing tab ${tabId} for domain ${newDomain} (was ${currentDomain}): ${reason}`);
      processingTabs.add(tabId);
      try {
        await replaceTabWithTempContainer(tab, newUrl);
      } finally {
        processingTabs.delete(tabId);
      }
    } else {
      logDebug(`Tab ${tabId} staying in current container for navigation from ${currentDomain} to ${newDomain}: ${tab.cookieStoreId}`);
      if (isTempContainer) {
        cancelDeletionTimer(tab.cookieStoreId); // Cancel existing timer
        startDeletionTimer(tab.cookieStoreId);   // Start new timer
      }
    }
    tabUrls.set(tabId, newUrl); // Always update the stored URL
  }
}, { url: [{ schemes: ['http', 'https'] }] });

// Handle tab removal to clean up
browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  tabUrls.delete(tabId);
  pendingTabs.delete(tabId);
  addonCreatedTabs.delete(tabId);
  tabProcessingCount.delete(tabId);
  excludedTabs.delete(tabId); // Clean up exclusion tracking
  
  const tab = await browser.tabs.get(tabId).catch(() => null);
  
  if (tab && tab.cookieStoreId) {
    const container = await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null);
    if (container && /^tmp_\d+$/.test(container.name)) {
      const tabs = await browser.tabs.query({ cookieStoreId: tab.cookieStoreId });
      if (tabs.length === 0) {
        startDeletionTimer(tab.cookieStoreId);
      }
    }
  }
});

// Handle new tabs with available URL
async function handleNewTab(tab) {
	// Skip if tab is excluded from domain isolation
	if (excludedTabs.has(tab.id)) {
		logDebug(`Tab ${tab.id} is excluded from domain isolation, skipping handleNewTab processing`);
		return;
	}
	
	if (!tab.url || tab.url === 'about:blank' || tab.url === 'about:newtab') {
		logDebug(`Tab URL is invalid or not set, skipping: ${tab.id}`);
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
    const currentContainer = tab.cookieStoreId ? await browser.contextualIdentities.get(tab.cookieStoreId).catch(() => null) : null;
    const isTempContainer = currentContainer && /^tmp_\d+$/.test(currentContainer.name);
    // Check for permanent container first
    if (newDomain) {
      const targetContainerId = await getContainerForDomain(tab.url);
      if (targetContainerId && tab.cookieStoreId !== targetContainerId) {
        logDebug(`Replacing tab ${tab.id} with permanent container: ${targetContainerId}`);
        await replaceTabWithTempContainer(tab, tab.url);
        return;
      } else if (targetContainerId) {
        logDebug(`Tab ${tab.id} already in correct permanent container: ${targetContainerId}`);
        return;
      }
    }
    // Check if there's an opener tab and if domains match
    if (tab.openerTabId) {
      const openerTab = await browser.tabs.get(tab.openerTabId).catch(() => null);
      if (openerTab) {
        const openerDomain = getDomain(openerTab.url);
        const openerContainerId = openerTab.cookieStoreId;
        const openerContainer = openerContainerId ? await browser.contextualIdentities.get(openerContainerId).catch(() => null) : null;
        logDebug(`Opener domain: ${openerDomain}, New domain: ${newDomain}, Opener container: ${openerContainerId}`);
        // Reuse opener's container if domains match and opener is not in default container
        if (openerDomain === newDomain && openerContainerId && openerContainerId !== 'firefox-default') {
          if (tab.cookieStoreId !== openerContainerId) {
            logDebug(`Replacing tab ${tab.id} with opener's container: ${openerContainerId}`);
            await replaceTabWithTempContainer(tab, tab.url);
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
    }
    // If no permanent container or opener match, assign a new temporary container
    if (!isTempContainer || (tab.openerTabId && getDomain(tab.url) !== getDomain((await browser.tabs.get(tab.openerTabId).catch(() => ({ url: '' }))).url))) {
      const tempContainer = await createTempContainer();
      logDebug(`Replacing tab ${tab.id} with temporary container: ${tempContainer.cookieStoreId}`);
      await replaceTabWithTempContainer(tab, tab.url);
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
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  try {
    logDebug('Received message:', message);
	
	if (message.action === 'excludeTab') {
      const tabId = message.tabId;
      if (!excludedTabs.has(tabId)) {
        excludedTabs.add(tabId);
        await updateTabBadge(tabId, true);
        logDebug(`Tab ${tabId} added to domain isolation exclusions`);
      }
      return { 
        success: true, 
        isExcluded: true
      };
    } else if (message.action === 'removeExclusion') {
      const tabId = message.tabId;
      if (excludedTabs.has(tabId)) {
        excludedTabs.delete(tabId);
        await updateTabBadge(tabId, false);
        logDebug(`Tab ${tabId} removed from domain isolation exclusions`);
      }
      return { 
        success: true, 
        isExcluded: false 
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

// On startup, delete empty temporary containers and start timers for non-empty ones
(async () => {
  logDebug('Auto Containers background script loaded');
  
  // Create main context menu with submenu
  browser.contextMenus.create({
    id: "auto-containers-main",
    title: "Auto Containers",
    contexts: ["page", "link", "selection"]
  });
  
  browser.contextMenus.create({
    id: "exclude-from-isolation",
    parentId: "auto-containers-main",
    title: "Exclude tab from domain isolation",
    contexts: ["page", "link", "selection"]
  });
  
  browser.contextMenus.create({
    id: "remove-from-exclusions",
    parentId: "auto-containers-main", 
    title: "Remove tab from exclusions",
    contexts: ["page", "link", "selection"]
  });
  
  const tempContainers = await getTempContainers();

  for (const container of tempContainers) {
    const tabs = await browser.tabs.query({ cookieStoreId: container.cookieStoreId });
    if (tabs.length === 0) {
      await browser.contextualIdentities.remove(container.cookieStoreId);
      logDebug(`Deleted empty container on startup: ${container.cookieStoreId}`);
    } else {
      startDeletionTimer(container.cookieStoreId);
    }
  }
})();

// Context menu click handler
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "exclude-from-isolation") {
    if (!excludedTabs.has(tab.id)) {
      excludedTabs.add(tab.id);
      await updateTabBadge(tab.id, true);
      logDebug(`Tab ${tab.id} added to domain isolation exclusions`);
    }
  } else if (info.menuItemId === "remove-from-exclusions") {
    if (excludedTabs.has(tab.id)) {
      excludedTabs.delete(tab.id);
      await updateTabBadge(tab.id, false);
      logDebug(`Tab ${tab.id} removed from domain isolation exclusions`);
    }
  }
});