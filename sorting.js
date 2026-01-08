const DEBUG = true; // Toggle for debug logging

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

// Helper function to extract base domain for grouping
function extractBaseDomain(domain) {
  // List of common multi-part TLDs (extend as needed)
  const multiPartTlds = [
    'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
    'com.au', 'net.au', 'org.au',
    'co.jp', 'ne.jp',
    'com.br',
    // Add more as needed
  ];

  // Normalize input: lowercase, remove www., and trim
  let normalized = domain.toLowerCase().replace(/^www\./, '').trim();

  // Check for wildcard patterns before normalizing
  const hadLeadingWildcard = normalized.startsWith('*.');
  
  // Store original for debugging
  const originalPattern = normalized;
  
  normalized = normalized
    .replace(/^\*\./, '') // *.google.com -> google.com
    .replace(/\.\*$/, '') // google.com.* -> google.com
    .replace(/\*/g, '');  // Remove any remaining wildcards (e.g., google.*.com)

  // Special case: if pattern was "*.tld" (wildcard + TLD only), treat as global pattern
  // These should sort after specific domains but before true global patterns
  if (hadLeadingWildcard && normalized) {
    const parts = normalized.split('.');
	logDebug(`Checking *.pattern: original="${originalPattern}", normalized="${normalized}", parts=${parts.length}, isTldOnly check...`);
    
	// Check if it's just a TLD (single part) or a multi-part TLD
    const isTldOnly = parts.length === 1 || 
                     (parts.length === 2 && multiPartTlds.includes(normalized));
					 
	logDebug(`  -> isTldOnly=${isTldOnly}`);
    
    if (isTldOnly) {
      // Sort after specific domains but before global catchalls
	  logDebug(`  -> Returning global TLD key: zzzz_global_tld_${normalized}`);
      return `zzzz_global_tld_${normalized}`;
    }
  }

  // Split into parts
  const parts = normalized.split('.');

  // If empty or single part (e.g., "google" from google.*)
  if (!normalized || parts.length === 1) {
    return normalized || domain;
  }

  // Find the TLD by checking multi-part TLDs first, then single-part
  let tld = parts[parts.length - 1]; // Default to last part
  let tldLength = 1;

  // Check if the last two parts form a multi-part TLD
  if (parts.length >= 2) {
    const potentialMultiTld = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (multiPartTlds.includes(potentialMultiTld)) {
      tld = potentialMultiTld;
      tldLength = 2;
    }
  }

  // Main domain is the part immediately before the TLD
  if (parts.length <= tldLength) {
    return parts[0] || domain; // Fallback if too short
  }

  return parts[parts.length - tldLength - 1];
}

// Function to check if one url pattern completely covers another one
function patternCovers(pattern1, pattern2) {
	function patternToRegex(pattern) {
		let escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
		return escaped.replace(/\*/g, '.*');
	}
	
	const regex1 = new RegExp('^' + patternToRegex(pattern1) + '$');
	const testCases = generateTestCases(pattern2);
	
	for (const testCase of testCases) {
		if (!regex1.test(testCase)) {
			return false;
		}
	}
	
	return checkStructuralCoverage(pattern1, pattern2);
}

// Helper function for patternCovers()
function generateTestCases(pattern) {
	const testCases = [];
	const samples = ['', 'test', 'example', 'a', 'subdomain'];
	
	function replaceWildcards(pat, index = 0) {
		const starIndex = pat.indexOf('*', index);
		if (starIndex === -1) {
			testCases.push(pat);
			return;
		}
		
		for (const sample of samples) {
			const newPat = pat.substring(0, starIndex) + sample + pat.substring(starIndex + 1);
			replaceWildcards(newPat, starIndex + sample.length);
		}
	}
	
	replaceWildcards(pattern);
	return [...new Set(testCases)];
}

// Main logic function for patternCovers()
function checkStructuralCoverage(pattern1, pattern2) {
	if (pattern1.startsWith('*.') && !pattern2.includes('*')) {
		const domain2 = pattern2.split('/')[0].split('?')[0];
		const domainParts = domain2.split('.');
		
		if (domainParts.length <= 2 && pattern1.startsWith('*.')) {
			return false;
		}
	}
	
	const p1Parts = pattern1.split('');
	const p2Parts = pattern2.split('');
	
	let p1Pos = 0, p2Pos = 0;
	
	while (p1Pos < p1Parts.length && p2Pos < p2Parts.length) {
		if (p1Parts[p1Pos] === '*') {
			p1Pos++;
			while (p2Pos < p2Parts.length && 
				   p1Pos < p1Parts.length && 
				   p2Parts[p2Pos] !== p1Parts[p1Pos]) {
				p2Pos++;
			}
		} else if (p1Parts[p1Pos] === p2Parts[p2Pos]) {
			p1Pos++;
			p2Pos++;
		} else {
			return false;
		}
	}
	
	if (p1Pos < p1Parts.length) {
		const remaining = p1Parts.slice(p1Pos).join('');
		if (remaining !== '*' && remaining.replace(/\*/g, '') !== '') {
			return false;
		}
	}
	
	return true;
}

// Sort URL patterns within a group
function sortUrlPatternsInGroup(patterns) {
	// Create map of patterns to positions
	let patternMap = patterns.map((pattern, index) => ({ pattern, position: index }));
	let globalChanged = true;
	let iterations = 0;
	const maxIterations = patterns.length * 2; // Dynamic max based on list length

	while (globalChanged && iterations < maxIterations) {
		globalChanged = false;
		iterations++;

		logDebug(`Iteration ${iterations}:`);
		logDebug('Current order: ' + patternMap.map(p => p.pattern).join(', '));

		// Create map of all possible pairs
		const pairs = [];
		for (let i = 0; i < patternMap.length; i++) {
			for (let j = i + 1; j < patternMap.length; j++) {
				pairs.push({
					pattern1: patternMap[i].pattern,
					position1: patternMap[i].position,
					pattern2: patternMap[j].pattern,
					position2: patternMap[j].position
				});
			}
		}

		// Process each pair
		for (const pair of pairs) {
			// Skip if patterns are identical
			if (pair.pattern1 === pair.pattern2) {
				continue;
			}

			// If pattern1 covers pattern2 and position1 < position2
			if (pair.position1 < pair.position2 && patternCovers(pair.pattern1, pair.pattern2)) {
				globalChanged = true;

				// Move pattern1 to position after pattern2
				const newPos1 = pair.position2 + 1;

				// Increment positions >= newPos1
				for (let item of patternMap) {
					if (item.position >= newPos1) {
						item.position++;
					}
				}

				// Update pattern1's position
				patternMap.find(item => item.pattern === pair.pattern1).position = newPos1;

				logDebug(`Moving "${pair.pattern1}" (pos ${pair.position1}) after "${pair.pattern2}" (pos ${pair.position2}) to pos ${newPos1}`);
			}
		}

		// Sort patternMap by position to update order
		patternMap.sort((a, b) => a.position - b.position);

		if (!globalChanged) {
			logDebug('No more changes needed. Sorting complete!');
		} else {
			logDebug('End of iteration - order: ' + patternMap.map(p => p.pattern).join(', '));
		}
	}

	if (iterations >= maxIterations) {
		logDebug(`Reached maximum iterations (${maxIterations}). Stopping.`);
	}

	return patternMap.map(p => p.pattern);
}

// Function to sort rules by domain and specificity
function sortRules(rulesText) {
  try {
    const lines = rulesText.split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) return rulesText;
    logDebug(`Sorting ${lines.length} rules`);
    
	// Validate all rules first
    const validRules = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.includes(',') || trimmed.split(',').length !== 2) {
        console.warn(`Skipping invalid rule: ${trimmed}`);
        continue;
      }
      const [pattern, containerName] = trimmed.split(',').map(part => part.trim());
      if (!pattern || !containerName) {
        console.warn(`Skipping empty rule: ${trimmed}`);
        continue;
      }
      validRules.push(trimmed);
    }
    if (validRules.length === 0) return '';
	
    // Parse rules into objects with proper domain extraction
    const parsedRules = validRules.map((line, originalIndex) => {
      const [pattern, containerName] = line.split(',').map(part => part.trim());
      let domain = '';
      // Extract domain from pattern
      if (pattern.includes('/')) {
        domain = pattern.split('/')[0];
      } else {
        domain = pattern;
      }
      // Extract base domain for grouping (normalize wildcards)
      let sortDomain = extractBaseDomain(domain);
	  
	  // Force global wildcards to the absolute bottom
	  if (pattern === '*' || pattern === '*.*' || pattern === '*/*') {
		  sortDomain = 'zzzz_global_zzzz_catchall';
	  }

      return {
        original: line,
        pattern,
        containerName,
        domain,
        sortDomain,
        isPathPattern: pattern.includes('/'),
        isWildcard: pattern.includes('*'),
        hasQuery: pattern.includes('?'),
        pathDepth: pattern.includes('/') ? pattern.split('/').length - 1 : 0,
        wildcardType: pattern.includes('*') ? 
            (pattern.includes('*.') && pattern.endsWith('.*') ? 'generic' : 
             pattern.startsWith('*.') ? 'subdomain' : 
             pattern.endsWith('.*') ? 'domainFamily' : 'other') : 'none',
        originalIndex
      };
    });
    
    // Group by base domain
    const domainGroups = new Map();
    parsedRules.forEach(rule => {
      if (!domainGroups.has(rule.sortDomain)) {
        domainGroups.set(rule.sortDomain, []);
      }
      domainGroups.get(rule.sortDomain).push(rule);
    });
	
    // Sort each domain group by specificity, if more than 1 rule
    domainGroups.forEach((group, domain) => {
      logDebug(`Processing ${group.length} rules for domain: ${domain}`);
      
      if (group.length === 1) {
        return; // Skip sorting for single-rule groups
      }
      logDebug(`Sorting ${group.length} rules for domain: ${domain}`);
      
      // First, maintain original relative order within the group
      group.sort((a, b) => a.originalIndex - b.originalIndex);
      
      // Extract just the patterns for URL sorting
      const patterns = group.map(rule => rule.pattern);
      
      // Sort the patterns using the existing sortUrlPatternsInGroup function
      const sortedPatterns = sortUrlPatternsInGroup(patterns);
      
      // Reorder the group based on the sorted patterns
      const sortedGroup = [];
      sortedPatterns.forEach(pattern => {
        const rule = group.find(r => r.pattern === pattern);
        if (rule) {
          sortedGroup.push(rule);
        }
      });
      
      // Update the group in the map
      domainGroups.set(domain, sortedGroup);
    });
    
    // Combine all groups, sorted by base domain alphabetically
    const sortedDomains = Array.from(domainGroups.keys()).sort((a, b) => {
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    const sortedRules = [];
    sortedDomains.forEach(domain => {
      logDebug(`Adding ${domainGroups.get(domain).length} rules for domain: ${domain}`);
      sortedRules.push(...domainGroups.get(domain));
    });
    const result = sortedRules.map(rule => rule.original).join('\n');
    logDebug(`Sorting complete, ${sortedRules.length} rules processed`);
    logDebug('Sorted domains order:', sortedDomains);
    return result;
  } catch (error) {
    console.error('Error sorting rules:', error);
    return rulesText; // Return original rules if sorting fails
  }
}

export { sortRules, extractBaseDomain };