const DEBUG = true; // Toggle for debug logging

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

// Firefox contextual identity colors and icons
const COLORS = ['blue', 'turquoise', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'toolbar'];
const ICONS = ['fingerprint', 'briefcase', 'dollar', 'cart', 'vacation', 'gift', 'food', 'fruit', 'pet', 'tree', 'chill', 'circle', 'fence'];

async function refreshUrlBar(currentTab) {
  try {
    const allTabs = await browser.tabs.query({ currentWindow: true });
    if (allTabs.length > 1) {
      const otherTab = allTabs.find(tab => tab.id !== currentTab.id);
      if (otherTab) {
        await browser.tabs.update(otherTab.id, { active: true });
        await new Promise(resolve => setTimeout(resolve, 50));
        await browser.tabs.update(currentTab.id, { active: true });
      }
    }
  } catch (error) {
    console.error('Error refreshing URL bar:', error);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Get current tab info
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const currentTab = tabs[0];
  
  const convertSection = document.getElementById('convertTempContainerSection');
  const convertCheckbox = document.getElementById('convertTempContainer');
  if (!currentTab || !currentTab.url || currentTab.url.startsWith('about:') || currentTab.url.startsWith('moz-extension:')) {
    document.getElementById('currentUrl').textContent = 'Cannot add rules for this page';
    document.querySelector('.pattern-input').style.display = 'none';
    document.querySelector('.quick-suggestions').style.display = 'none';
	    document.querySelector('.container-style').style.display = 'none';
    document.querySelector('.container-input').style.display = 'none';
    document.querySelector('.buttons').style.display = 'none';
    convertSection.style.display = 'none';
    return;
  }
  
  // Extract domain and path info
  const url = new URL(currentTab.url);
  const domain = url.hostname.replace(/^www\./, '');
  const path = url.pathname;
  const hasUsefulPath = path && path !== '/' && path.split('/').length <= 3; // Only suggest paths that aren't too deep
  
  // Check if this is a subdomain (more than 2 parts after removing www)
  const domainParts = domain.split('.');
  const hasSubdomain = domainParts.length > 2;
  
  // Update UI with current tab info
  document.getElementById('currentUrl').textContent = currentTab.url;
  document.getElementById('currentDomain').textContent = `Domain: ${domain}`;
  
  // Get container info
  let containerInfo = 'Default Container';
  let currentContainerColor = 'blue';
  let currentContainerIcon = 'circle';
  let isTempContainer = false;
  if (currentTab.cookieStoreId && currentTab.cookieStoreId !== 'firefox-default') {
    try {
      const container = await browser.contextualIdentities.get(currentTab.cookieStoreId);
      isTempContainer = /^tmp_\d+$/.test(container.name);
      containerInfo = `Container: ${container.name}${isTempContainer ? ' (temporary)' : ''}`;
      currentContainerColor = container.color;
      currentContainerIcon = container.icon;
      if (isTempContainer) {
        convertSection.style.display = 'block';
        convertCheckbox.title = `Rename "${container.name}" to the new container name`;
      } else {
        convertSection.style.display = 'none';
      }
    } catch (e) {
      containerInfo = 'Unknown Container';
	  convertSection.style.display = 'none';
    }								  
  } else {
    convertSection.style.display = 'none';
  }
  document.getElementById('currentContainer').textContent = containerInfo;
  
  // Get pattern input and suggestion buttons
  const patternInput = document.getElementById('patternName');
  const domainSugg = document.getElementById('domainSugg');
  const pathSugg = document.getElementById('pathSugg');
  const wildcardSugg = document.getElementById('wildcardSugg');
  
  // Set up intelligent suggestions
  let suggestions = [];
  
  // Always suggest exact domain
  suggestions.push({ 
    element: domainSugg, 
    pattern: domain, 
    text: domain 
  });
  
  // Suggest path only if it's useful (not too specific)
  if (hasUsefulPath) {
    suggestions.push({ 
      element: pathSugg, 
      pattern: `${domain}${path}`, 
      text: `${domain}${path}` 
    });
  } else {
    pathSugg.style.display = 'none';
  }
  
  // Suggest wildcard pattern intelligently
  if (hasSubdomain) {
    // For subdomains like mail.google.com, suggest *.google.com
    const baseDomain = domainParts.slice(-2).join('.');
    suggestions.push({ 
      element: wildcardSugg, 
      pattern: `*.${baseDomain}`, 
      text: `*.${baseDomain}` 
    });
  } else {
    // For main domains like google.com, suggest google.*
    const baseName = domainParts[0];
    suggestions.push({ 
      element: wildcardSugg, 
      pattern: `${baseName}.*`, 
      text: `${baseName}.*` 
    });
  }
  
  // Set button texts and click handlers
  suggestions.forEach(({ element, pattern, text }) => {
    element.textContent = text;
    element.addEventListener('click', () => {
      patternInput.value = pattern;
      patternInput.focus();
    });
  });
  
  // Set default pattern to domain
  patternInput.value = domain;
  
  // Set up color/icon selection
  const colorGrid = document.getElementById('colorGrid');
  const iconGrid = document.getElementById('iconGrid');
  let selectedColor = currentContainerColor;
  let selectedIcon = currentContainerIcon;
  
  // Populate color swatches
  COLORS.forEach(color => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.dataset.color = color;
    swatch.style.backgroundColor = getColorValue(color);
    swatch.title = color;
    
    if (color === selectedColor) {
      swatch.classList.add('selected');
    }
    
    swatch.addEventListener('click', () => {
      colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
      selectedColor = color;
    });
    
    colorGrid.appendChild(swatch);
  });
  
  // Populate icon options
  ICONS.forEach(icon => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-option';
    btn.dataset.icon = icon;
    btn.title = icon;
	btn.textContent = ''; // Don't set text
	
	btn.style.cursor = 'pointer';
	btn.style.backgroundImage = `url('resource://usercontext-content/${icon}.svg')`;
	btn.style.backgroundSize = '80%';
	btn.style.backgroundRepeat = 'no-repeat';
	btn.style.backgroundPosition = 'center';
    
    if (icon === selectedIcon) {
      btn.classList.add('selected');
    }
    
    btn.addEventListener('click', () => {
      iconGrid.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedIcon = icon;
    });
    
    iconGrid.appendChild(btn);
  });
  
  // Load existing containers
  const existingContainers = document.getElementById('existingContainers');
  const containerNameInput = document.getElementById('containerName');
  let currentTabContainer = null;
  try {
    const identities = await browser.contextualIdentities.query({});
    const permanentContainers = identities.filter(identity => !/^tmp_\d+$/.test(identity.name));
	const { containerStyles = {} } = await browser.storage.local.get('containerStyles');
    
    permanentContainers.forEach(container => {
      const option = document.createElement('option');
      option.value = container.name;
      option.textContent = container.name;
      option.dataset.color = containerStyles[container.name]?.color || container.color;
      option.dataset.icon = containerStyles[container.name]?.icon || container.icon;
      existingContainers.appendChild(option);
    });
    // Get current tab's container for related rules
    if (currentTab.cookieStoreId && currentTab.cookieStoreId !== 'firefox-default') {
      currentTabContainer = await browser.contextualIdentities.get(currentTab.cookieStoreId).catch(() => null);
    }
  } catch (e) {
    console.error('Failed to load containers:', e);
  }
  
  // Handle container selection
  existingContainers.addEventListener('change', (e) => {
    if (e.target.value) {
      containerNameInput.value = e.target.value;
      containerNameInput.disabled = true;
      convertCheckbox.checked = false;
	  convertCheckbox.disabled = true;
	  // Update color/icon when selecting an existing container
      const selectedOption = e.target.options[e.target.selectedIndex];
      selectedColor = selectedOption.dataset.color;
      selectedIcon = selectedOption.dataset.icon;
      
      colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      iconGrid.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      
      const colorSwatch = colorGrid.querySelector(`.color-swatch[data-color="${selectedColor}"]`);
      if (colorSwatch) colorSwatch.classList.add('selected');
      
      const iconOption = iconGrid.querySelector(`.icon-option[data-icon="${selectedIcon}"]`);
      if (iconOption) iconOption.classList.add('selected');
    } else {
      containerNameInput.value = '';
      containerNameInput.disabled = false;
      convertCheckbox.disabled = !isTempContainer;
      containerNameInput.focus();
      selectedColor = 'blue';
      selectedIcon = 'circle';
      
      colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      iconGrid.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      
      const colorSwatch = colorGrid.querySelector(`.color-swatch[data-color="${selectedColor}"]`);
      if (colorSwatch) colorSwatch.classList.add('selected');
      
      const iconOption = iconGrid.querySelector(`.icon-option[data-icon="${selectedIcon}"]`);
      if (iconOption) iconOption.classList.add('selected');
    }
  });
  
  // Load and display related rules
  await loadRelatedRules(currentTabContainer);
	
  // Handle save rule
  document.getElementById('saveRule').addEventListener('click', async () => {
	  const pattern = patternInput.value.trim();
	  const containerName = containerNameInput.value.trim();
      const convertTempContainer = convertCheckbox.checked;

   logDebug('Save rule clicked:', { pattern, containerName, convertTempContainer, selectedColor, selectedIcon });

	  if (!pattern) {
		showMessage('Please enter a pattern', 'error');
		return;
	  }

	  if (!containerName) {
		showMessage('Please enter a container name', 'error');
		return;
	  }

	  // Validate pattern - allow domains with wildcards, hyphens, underscores, and paths
	  const isDomainPattern = /^(\*\.)?([a-zA-Z0-9_-]+\.)*([a-zA-Z0-9_*-]+)(\.[a-zA-Z0-9_-]+)*(\.\*)?(\/.*)?$/.test(pattern) || // e.g., google.com, *.google.*, google.*, *.google.com, google.com/search
						  pattern.includes('/'); // e.g., google.com/search, google.com/?olud

	  if (!isDomainPattern) {
		showMessage('Pattern must be a valid domain (e.g., google.com, *.google.*, google.*, *.google.com) or URL path (e.g., google.com/search)', 'error');
		return;
	  }

	  // Validate container name
	  if (!/^[a-zA-Z0-9\s_-]+$/.test(containerName)) {
		showMessage('Container name can only contain letters, numbers, spaces, hyphens, or underscores', 'error');
		return;
	  }

	  try {
		// Load existing rules
		const { rules = '', containerStyles = {} } = await browser.storage.local.get(['rules', 'containerStyles']);
		logDebug('Current rules before adding:', rules);
		logDebug('Current containerStyles:', containerStyles);
		const existingRules = rules.split('\n').filter(line => line.trim() !== '');
		logDebug('Existing rules array:', existingRules);

		// Check if rule already exists
		const newRule = `${pattern}, ${containerName}`;
		logDebug('New rule to add:', newRule);
		const ruleExists = existingRules.some(rule => {
		  const [existingPattern] = rule.split(',').map(part => part.trim());
		  return existingPattern === pattern;
		});

		if (ruleExists) {
		  showMessage('A rule for this pattern already exists', 'error');
		  return;
		}

		// If 'convert temp container is selected, check for container name conflicts
		let targetContainerId = null;
		let shouldSaveStyles = false;
		if (convertTempContainer) {
		  // Check if container name matches an existing permanent container
		  const identities = await browser.contextualIdentities.query({});
		  const existingContainer = identities.find(c => c.name === containerName && !/^tmp_\d+$/.test(c.name));
		  
		  if (existingContainer) {
			showMessage('Cannot convert temp container: a permanent container with this name already exists', 'error');
			return;
		  }
		  
		  // Get the current temp container to rename
		  if (currentTab.cookieStoreId && currentTab.cookieStoreId !== 'firefox-default') {
			const currentContainer = await browser.contextualIdentities.get(currentTab.cookieStoreId).catch(() => null);
			if (currentContainer && /^tmp_\d+$/.test(currentContainer.name)) {
				targetContainerId = currentTab.cookieStoreId;
				shouldSaveStyles = true;
			} 
		  }
		} else if (!containerStyles[containerName]) {
			shouldSaveStyles = true;
		}						

		// Add new rule
		existingRules.push(newRule);
		const updatedRules = existingRules.join('\n');
		logDebug('Updated rules before saving:', updatedRules);

		const saveData = { rules: updatedRules };
		
		if (shouldSaveStyles) {
			saveData.containerStyles = {
				  ...containerStyles,
				  [containerName]: { color: selectedColor, icon: selectedIcon }
			};
		}
		// Save rules
		await browser.storage.local.set(saveData);
		logDebug('Rules / styles data saved to storage');

		// Verify the save worked
        if (DEBUG) {
			const { rules: savedRules, containerStyles: savedStyles } = await browser.storage.local.get(['rules', 'containerStyles']);
			logDebug('Rules after saving:', savedRules);
			logDebug('Container styles after saving:', savedStyles);
        }

        // Rename container if checkbox was checked
		if (convertTempContainer && targetContainerId) {
		  try {
			await browser.contextualIdentities.update(targetContainerId, {
            name: containerName,
            color: selectedColor,
            icon: selectedIcon
          });
          logDebug(`Renamed container ${targetContainerId} to ${containerName} with color ${selectedColor} and icon ${selectedIcon}`);
			
			// Trigger URL bar refresh by switching tabs
			await refreshUrlBar(currentTab);
			
			showMessage(`Rule added and container renamed to "${containerName}"!`, 'success');
		  } catch (renameError) {
			console.error('Error renaming container:', renameError);
			showMessage('Rule added but failed to rename container', 'error');
		  }
		} else {
		  showMessage('Rule added successfully!', 'success');
		}

		// Sort rules for optimal lookup performance
		try {
		  logDebug('Sending sortRules message');
		  const response = await browser.runtime.sendMessage({ action: 'sortRules' });
		  logDebug('sortRules response:', response);
		  if (!response || !response.success) {
			console.warn('Rule sorting failed:', response?.error);
		  }

		  // Verify rules after sorting
		  const { rules: finalRules } = await browser.storage.local.get('rules');
		  logDebug('Final rules after sorting:', finalRules);
		} catch (sortError) {
		  console.warn('Rule sorting error:', sortError);
		}

		// Clear form
		patternInput.value = domain; // Reset to default
		containerNameInput.value = '';
        convertCheckbox.checked = false;
		existingContainers.selectedIndex = 0;
		containerNameInput.disabled = false;
		convertCheckbox.disabled = !isTempContainer;

		selectedColor = 'blue';
		selectedIcon = 'circle';
		colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
		iconGrid.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));

		const colorSwatch = colorGrid.querySelector(`.color-swatch[data-color="${selectedColor}"]`);
		if (colorSwatch) colorSwatch.classList.add('selected');
      
		const iconOption = iconGrid.querySelector(`.icon-option[data-icon="${selectedIcon}"]`);
		if (iconOption) iconOption.classList.add('selected');
		// Close popup after delay
		setTimeout(() => {
		  window.close();
		}, 2500);
	  } catch (error) {
			console.error('Failed to save rule:', error);
			showMessage('Failed to save rule', 'error');
	  }
	});
  
  // Handle open options
  document.getElementById('openOptions').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
  
  // Handle save edits
  document.getElementById('saveEdits').addEventListener('click', async () => {
    await saveRuleEdits();
  });
  
  document.getElementById('applyToCurrentContainer').addEventListener('click', async () => {
	  if (!currentTab.cookieStoreId || currentTab.cookieStoreId === 'firefox-default') {
		showMessage('No container selected for this tab', 'error');
		return;
	  }

	  try {
		const currentContainer = await browser.contextualIdentities.get(currentTab.cookieStoreId);
		const containerName = currentContainer.name;

		// Update container style
		await browser.contextualIdentities.update(currentTab.cookieStoreId, {
		  name: containerName,
		  color: selectedColor,
		  icon: selectedIcon
		});

		// Save style to storage
		const { containerStyles = {} } = await browser.storage.local.get('containerStyles');
		containerStyles[containerName] = { color: selectedColor, icon: selectedIcon };
		await browser.storage.local.set({ containerStyles });

		logDebug(`Updated container ${containerName} with color ${selectedColor} and icon ${selectedIcon}`);

		// Refresh URL bar to reflect changes
		await refreshUrlBar(currentTab);

		showMessage(`Container style updated for "${containerName}"!`, 'success');
	  } catch (error) {
		console.error('Failed to update container style:', error);
		showMessage('Failed to update container style', 'error');
	  }
  });
  
  async function loadRelatedRules(currentContainer) {
    const relatedRulesSection = document.getElementById('relatedRulesSection');
    const relatedRulesList = document.getElementById('relatedRulesList');
    
    if (!currentContainer || /^tmp_\d+$/.test(currentContainer.name)) {
      relatedRulesSection.style.display = 'none';
      return;
    }
    
    try {
      const { rules = '' } = await browser.storage.local.get('rules');
      const ruleLines = rules.split('\n').filter(line => line.trim() !== '');
      
      // Find rules that use the same container
      const relatedRules = ruleLines.filter(line => {
        const [, containerName] = line.split(',').map(part => part.trim());
        return containerName === currentContainer.name;
      });
      
      if (relatedRules.length === 0) {
        relatedRulesList.innerHTML = '<div class="no-rules">No rules for this container</div>';
        return;
      }
      
      // Create editable rule items
      relatedRulesList.innerHTML = '';
      relatedRules.forEach((rule, index) => {
        const ruleItem = document.createElement('div');
        ruleItem.className = 'rule-item';
        
        // Create input element
        const input = document.createElement('input');
        input.type = 'text';
        input.value = rule.trim();
        input.setAttribute('data-original', rule.trim());
        input.setAttribute('data-index', index.toString());
        
        // Create delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'delete-btn';
        deleteBtn.setAttribute('data-rule', rule.trim());
        deleteBtn.setAttribute('title', 'Delete rule');
        deleteBtn.textContent = '×';
        
        // Append elements
        ruleItem.appendChild(input);
        ruleItem.appendChild(deleteBtn);
        relatedRulesList.appendChild(ruleItem);
      });
      
      // Add delete button handlers
      relatedRulesList.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-btn')) {
          const ruleToDelete = e.target.dataset.rule;
          await deleteRule(ruleToDelete);
          await loadRelatedRules(currentContainer); // Reload the list
        }
      });
      
    } catch (e) {
      console.error('Failed to load related rules:', e);
      relatedRulesList.innerHTML = '<div class="no-rules">Error loading rules</div>';
    }
  }
  
  async function deleteRule(ruleToDelete) {
    try {
      const { rules = '' } = await browser.storage.local.get('rules');
      const ruleLines = rules.split('\n').filter(line => line.trim() !== '');
      
      // Remove the rule
      const updatedRules = ruleLines.filter(line => line.trim() !== ruleToDelete).join('\n');
      
      // Save updated rules
      await browser.storage.local.set({ rules: updatedRules });
      
      showMessage('Rule deleted successfully!', 'success');
    } catch (error) {
      console.error('Failed to delete rule:', error);
      showMessage('Failed to delete rule', 'error');
    }
  }
  
  async function saveRuleEdits() {
    const ruleInputs = document.querySelectorAll('.rule-item input');
    const newRules = [];
    let hasError = false;
    
    // Clear previous errors
    ruleInputs.forEach(input => {
      input.classList.remove('error');
    });
    
    // Validate all rules
    ruleInputs.forEach((input, index) => {
      const ruleText = input.value.trim();
      
      if (!ruleText) {
        input.classList.add('error');
        hasError = true;
        return;
      }
      
      // Check basic format
      if (!ruleText.includes(',') || ruleText.split(',').length !== 2) {
        input.classList.add('error');
        hasError = true;
        return;
      }
      
      // Check comma format
      if (!/^[^,\s]+,\s+[^,\s]+$/.test(ruleText)) {
        input.classList.add('error');
        hasError = true;
        return;
      }
      
      const [pattern, containerName] = ruleText.split(',').map(part => part.trim());
      
      // Validate pattern
      const isDomainPattern = /^(\*\.)?([a-zA-Z0-9_-]+\.)*([a-zA-Z0-9_*-]+)(\.[a-zA-Z0-9_-]+)*(\.\*)?(\/.*)?$/.test(pattern) || pattern.includes('/');
      
      if (!isDomainPattern) {
        input.classList.add('error');
        hasError = true;
        return;
      }
      
      // Validate container name
      if (!/^[a-zA-Z0-9\s_-]+$/.test(containerName)) {
        input.classList.add('error');
        hasError = true;
        return;
      }
      
      newRules.push(ruleText);
    });
    
    if (hasError) {
      showMessage('Please fix the highlighted errors', 'error');
      return;
    }
    
    try {
      // Load all existing rules
      const { rules = '' } = await browser.storage.local.get('rules');
      const allRuleLines = rules.split('\n').filter(line => line.trim() !== '');
      
      // Get original rules that were being edited
      const originalRules = Array.from(ruleInputs).map(input => input.dataset.original);
      
      // Remove original rules and add new ones
      const otherRules = allRuleLines.filter(rule => !originalRules.includes(rule.trim()));
      const updatedAllRules = [...otherRules, ...newRules].join('\n');
      
      // Save updated rules
      await browser.storage.local.set({ rules: updatedAllRules });
	  
	  // Sort rules for optimal lookup performance
		try {
		  const response = await browser.runtime.sendMessage({ action: 'sortRules' });
		  if (!response || !response.success) {
			console.warn('Rule sorting failed:', response?.error);
		  }
		} catch (sortError) {
		  console.warn('Rule sorting error:', sortError);
		}
      
      showMessage('Rules updated successfully!', 'success');
      
      // Reload the related rules section
      const currentContainer = currentTab.cookieStoreId && currentTab.cookieStoreId !== 'firefox-default' 
        ? await browser.contextualIdentities.get(currentTab.cookieStoreId).catch(() => null) 
        : null;
      await loadRelatedRules(currentContainer);
      
    } catch (error) {
      console.error('Failed to save rule edits:', error);
      showMessage('Failed to save rules', 'error');
    }
  }
  
  function showMessage(text, type) {
    const messageEl = document.getElementById('statusMessage');
    messageEl.textContent = text;
    messageEl.className = `status-message ${type}`;
    messageEl.classList.remove('hidden');
    
    setTimeout(() => {
      messageEl.classList.add('hidden');
    }, 3000);
  }

  function getColorValue(color) {
    const colors = {
      blue: '#37adff',
      turquoise: '#00c79b',
      green: '#51cd00',
      yellow: '#ffcb00',
      orange: '#ff9f00',
      red: '#ff613d',
      pink: '#ff4bda',
      purple: '#af51f5'
    };
    return colors[color] || '#37adff';
  }
  
});