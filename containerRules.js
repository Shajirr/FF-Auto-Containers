export { getDomain, getContainerForDomain, checkOverrideRules };

let DEBUG = false;
const debugPrefix = '[AC]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

function getDomain(url) {
  if (!url || url === 'about:blank' || url === 'about:newtab' || url === 'about:home') {
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

// Function to check rules for permanent container
async function getContainerForDomain(url) {
  try {
    const { rules = '', containerStyles = {} } = await browser.storage.local.get(['rules', 'containerStyles']);
    const ruleLines = rules.split('\n').filter((line) => line.trim() !== '');
    logDebug(`Loaded ${ruleLines.length} rules`);

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

// Function to check override rules that allow staying in current container
async function checkOverrideRules(url, containerName) {
  if (!containerName || containerName === 'firefox-default') return false;

  try {
    const { overrideRules = '' } = await browser.storage.local.get('overrideRules');
    const ruleLines = overrideRules.split('\n').filter((line) => line.trim() !== '');

    if (ruleLines.length === 0) return false;

    const domain = getDomain(url);
    if (!domain) return false;

    for (const line of ruleLines) {
      const firstComma = line.indexOf(',');
      if (firstComma === -1) continue;

      const rulePattern = line.substring(0, firstComma).trim();
      // Supports checking against multiple comma-separated allowed containers per domain rule
      const allowedContainers = line
        .substring(firstComma + 1)
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c !== '');

      if (allowedContainers.includes(containerName) && matchesRule(url, domain, rulePattern)) {
        logDebug(`Override rule matched: ${rulePattern} allows staying in ${containerName}`);
        return true;
      }
    }
  } catch (error) {
    console.error(`Error in checkOverrideRules for URL: ${url}`, error);
  }
  return false;
}
