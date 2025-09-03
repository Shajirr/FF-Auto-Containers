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
		  notifications: showNotifications.checked
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

