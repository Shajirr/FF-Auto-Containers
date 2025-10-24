const DEBUG = true; // Toggle for debug logging

function logDebug(...args) {
  if (DEBUG) console.log(...args);
}

document.addEventListener('DOMContentLoaded', async () => {
	logDebug('Options page loaded');
	
	const containerRules = document.getElementById('containerRules');
	const showNotifications = document.getElementById('showNotifications');
	const saveButton = document.getElementById('saveButton');
	const saveMessage = document.getElementById('save-message');
	
	// Elements for temp container style
	const colorGrid = document.getElementById('colorGrid');
	const iconGrid = document.getElementById('iconGrid');
	const randomColorCheckbox = document.getElementById('randomColor');
	const randomIconCheckbox = document.getElementById('randomIcon');

	// Check if DOM elements exist
	if (!containerRules || !showNotifications || !saveButton || !saveMessage) {
	console.error('One or more DOM elements not found');
	saveMessage.textContent = 'Error: Options page elements not found';
	saveMessage.classList.add('error', 'visible');
	return;
	}

	// Load container counts
	const updateContainerCounts = async () => {
	const identities = await browser.contextualIdentities.query({});
	const tempCount = identities.filter(identity => /^tmp_\d+$/.test(identity.name)).length;
	const totalCount = identities.length;
	const permCount = totalCount - tempCount;
	document.getElementById('totalContainers').textContent = totalCount;
	document.getElementById('permanentContainers').textContent = permCount;
	document.getElementById('temporaryContainers').textContent = tempCount;
	};
	await updateContainerCounts();

	// Load existing settings
	const { rules = '', notifications = true } = await browser.storage.local.get(['rules', 'notifications']);
	
	
	// Load default temp container style
	const { tempContainerStyle = { color: 'blue', icon: 'circle', randomColor: false, randomIcon: false } } = await browser.storage.local.get('tempContainerStyle');
	
	let selectedColor = tempContainerStyle.color;
	let selectedIcon = tempContainerStyle.icon;
	randomColorCheckbox.checked = tempContainerStyle.randomColor || false;
	randomIconCheckbox.checked = tempContainerStyle.randomIcon || false;

	// Firefox contextual identity colors and icons
	const COLORS = ['blue', 'turquoise', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'toolbar'];
	const ICONS = ['fingerprint', 'briefcase', 'dollar', 'cart', 'vacation', 'gift', 'food', 'fruit', 'pet', 'tree', 'chill', 'circle', 'fence'];

	// Helper: get CSS color value
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

	// Populate color swatches
	COLORS.forEach(color => {
	  const swatch = document.createElement('button');
	  swatch.type = 'button';
	  swatch.className = 'color-swatch';
	  swatch.dataset.color = color;
	  swatch.style.backgroundColor = getColorValue(color);
	  swatch.title = color;
	  
	  if (color === selectedColor && !randomColorCheckbox.checked) {
	    swatch.classList.add('selected');
	  }
	  
	  swatch.addEventListener('click', () => {
	    if (randomColorCheckbox.checked) return;
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
	  btn.style.backgroundImage = `url('resource://usercontext-content/${icon}.svg')`;
	  btn.style.backgroundSize = '80%';
	  btn.style.backgroundRepeat = 'no-repeat';
	  btn.style.backgroundPosition = 'center';
	  
	  if (icon === selectedIcon && !randomIconCheckbox.checked) {
	    btn.classList.add('selected');
	  }
	  
	  btn.addEventListener('click', () => {
	    if (randomIconCheckbox.checked) return;
	    iconGrid.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
	    btn.classList.add('selected');
	    selectedIcon = icon;
	  });
	  
	  iconGrid.appendChild(btn);
	});

	// When a random checkbox is toggled, clear any selected swatch/button
	randomColorCheckbox.addEventListener('change', () => {
	  if (randomColorCheckbox.checked) {
	    colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
	  } else {
	    // re-select the stored color if any
	    const swatch = colorGrid.querySelector(`[data-color="${selectedColor}"]`);
	    if (swatch) swatch.classList.add('selected');
	  }
	});

	randomIconCheckbox.addEventListener('change', () => {
	  if (randomIconCheckbox.checked) {
	    iconGrid.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
	  } else {
	    const btn = iconGrid.querySelector(`[data-icon="${selectedIcon}"]`);
	    if (btn) btn.classList.add('selected');
	  }
	});

	
	logDebug('Loaded rules from storage');
    logDebug('Loaded notifications setting:', notifications);
	
	containerRules.value = rules;
	showNotifications.checked = notifications;
	
	// Listen for storage changes to update the UI
	browser.storage.onChanged.addListener(async (changes, namespace) => {
	  if (namespace === 'local' && changes.rules) {
		logDebug('Rules changed externally, updating display');
		containerRules.value = changes.rules.newValue || '';
		await updateContainerCounts();
	  }
	});
  
	// Save settings
	saveButton.addEventListener('click', async () => {
	  try {
		const rulesText = containerRules.value.trim();
		const lines = rulesText.split('\n').filter(line => line.trim() !== '');
		// Validate rules format
		let invalidLine = null;
		let invalidLineNumber = 0;
		let errorType = '';

		const isValid = lines.every((line, index) => {
		  const trimmedLine = line.trim();

		  // Check basic format: must have exactly one comma with no space before it and space after it
		  if (!trimmedLine.includes(',') || trimmedLine.split(',').length !== 2) {
			invalidLine = trimmedLine;
			invalidLineNumber = index + 1;
			errorType = 'format';
			return false;
		  }

		  // Check for correct comma format: no space before comma, space after comma
		  if (!/^[^,\s]+,\s+[^,\s]+$/.test(trimmedLine)) {
			invalidLine = trimmedLine;
			invalidLineNumber = index + 1;
			errorType = 'comma';
			return false;
		  }

		  const [pattern, name] = trimmedLine.split(',').map(part => part.trim());

		  // Check for empty pattern or name
		  if (!pattern || !name) {
			invalidLine = trimmedLine;
			invalidLineNumber = index + 1;
			errorType = pattern ? 'name' : 'pattern';
			return false;
		  }

		  // Validate pattern - allow domains with wildcards, hyphens, underscores, and paths
		  const isDomainPattern = /^(\*\.)?([a-zA-Z0-9_-]+\.)*([a-zA-Z0-9_*-]+)(\.[a-zA-Z0-9_-]+)*(\.\*)?(\/.*)?$/.test(pattern) || pattern.includes('/');

		  if (!isDomainPattern) {
			invalidLine = trimmedLine;
			invalidLineNumber = index + 1;
			errorType = 'pattern';
			return false;
		  }

		  // Validate container name (letters, numbers, spaces, hyphens, underscores)
		  if (!/^[a-zA-Z0-9\s_-]+$/.test(name)) {
			invalidLine = trimmedLine;
			invalidLineNumber = index + 1;
			errorType = 'name';
			return false;
		  }

		  return true;
		});

		if (!isValid && lines.length > 0) {
		  let errorMessage = '';
		  switch (errorType) {
			case 'comma':
			  errorMessage = `Invalid comma format on line ${invalidLineNumber}: "${invalidLine}". Format must be: Pattern, Name (no space before comma, space after comma)`;
			  break;
			case 'format':
			  errorMessage = `Invalid rule format on line ${invalidLineNumber}: "${invalidLine}". Each rule must be in the format: Pattern, Name (e.g., youtube.com, YT)`;
			  break;
			case 'pattern':
			  errorMessage = `Invalid pattern on line ${invalidLineNumber}: "${invalidLine}". Pattern must be a valid domain (e.g., google.com, *.google.*, google.*, *.google.com) or URL path (e.g., google.com/search)`;
			  break;
			case 'name':
			  errorMessage = `Invalid container name on line ${invalidLineNumber}: "${invalidLine}". Container name must contain only letters, numbers, spaces, hyphens, or underscores`;
			  break;
			default:
			  errorMessage = `Invalid rule on line ${invalidLineNumber}: "${invalidLine}"`;
		  }

		  saveMessage.textContent = errorMessage;
		  saveMessage.classList.add('error', 'visible');
		  setTimeout(() => {
			saveMessage.classList.remove('visible', 'error');
		  }, 3000);

		  if (showNotifications.checked) {
			await browser.notifications.create({
			  type: 'basic',
			  title: 'Invalid Rules Format',
			  message: errorMessage
			});
		  }
		  return;
		}

		// Save rules and notification setting
		await browser.storage.local.set({
		  rules: rulesText,
		  notifications: showNotifications.checked,
		  tempContainerStyle: {
		    color: randomColorCheckbox.checked ? null : selectedColor,
		    icon: randomIconCheckbox.checked ? null : selectedIcon,
		    randomColor: randomColorCheckbox.checked,
		    randomIcon: randomIconCheckbox.checked
		  }
		});

		// Show success message
		saveMessage.textContent = 'Settings saved!';
		saveMessage.classList.add('visible');
		setTimeout(() => {
		  saveMessage.classList.remove('visible');
		}, 3000);

		// Sort rules for optimal lookup performance
		try {
		  const response = await browser.runtime.sendMessage({ action: 'sortRules' });
		  if (!response || !response.success) {
			console.warn('Rule sorting failed:', response?.error);
		  }
		} catch (sortError) {
		  console.warn('Rule sorting error:', sortError);
		  // Don't show error to user as the rules were saved successfully
		}

		// Show notification if enabled
		if (showNotifications.checked) {
		  await browser.notifications.create({
			type: 'basic',
			title: 'Settings Saved',
			message: 'Container rules and notification settings have been saved.'
		  });
		}
	  } catch (error) {
		console.error('Save error:', error);
		saveMessage.textContent = `Error saving: ${error.message}`;
		saveMessage.classList.add('error', 'visible');
		setTimeout(() => {
		  saveMessage.classList.remove('visible', 'error');
		}, 5000);
	  }
	});
	
});

