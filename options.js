let DEBUG = false;
const debugPrefix = '[AC]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

document.addEventListener('DOMContentLoaded', async () => {
  const result = await browser.storage.local.get({ DEBUG: false });
  DEBUG = result.DEBUG;

  logDebug('Options page loaded');

  const containerRules = document.getElementById('containerRules');
  const overrideRulesEl = document.getElementById('overrideRules');
  const showNotifications = document.getElementById('showNotifications');
  const debugLogging = document.getElementById('debugLogging');
  const saveVisitedFaviconsCheckbox = document.getElementById('saveVisitedFavicons');
  const unmatchedTemp = document.getElementById('unmatchedTemp');
  const unmatchedDefault = document.getElementById('unmatchedDefault');
  const saveButton = document.getElementById('saveButton');
  const saveMessage = document.getElementById('save-message');
  const totalContainersEl = document.getElementById('totalContainers');
  const permanentContainersEl = document.getElementById('permanentContainers');
  const temporaryContainersEl = document.getElementById('temporaryContainers');

  // Domain hop tracking elements
  const toggleTrackerBtn = document.getElementById('toggleTrackerBtn');
  const hopLogModal = document.getElementById('hopLogModal');
  const hopLogResult = document.getElementById('hopLogResult');
  const closeModalBtn = document.getElementById('closeModalBtn');

  // Elements for temp container style
  const colorGrid = document.getElementById('colorGrid');
  const iconGrid = document.getElementById('iconGrid');
  const randomColorCheckbox = document.getElementById('randomColor');
  const randomIconCheckbox = document.getElementById('randomIcon');

  // Elements for favicon import
  const folderUpload = document.getElementById('folderUpload');
  const folderMessage = document.getElementById('folder-message');

  // Check if DOM elements exist
  if (
    !containerRules ||
    !overrideRulesEl ||
    !showNotifications ||
    !debugLogging ||
    !saveVisitedFaviconsCheckbox ||
    !saveButton ||
    !saveMessage ||
    !folderUpload ||
    !folderMessage ||
    !totalContainersEl ||
    !permanentContainersEl ||
    !temporaryContainersEl
  ) {
    console.error('One or more DOM elements not found');
    saveMessage.textContent = 'Error: Options page elements not found';
    saveMessage.classList.add('error', 'visible');
    return;
  }

  // Load container counts
  const updateContainerCounts = async () => {
    const identities = await browser.contextualIdentities.query({});
    const tempCount = identities.filter((identity) => /^tmp_\d+$/.test(identity.name)).length;
    const totalCount = identities.length;
    const permCount = totalCount - tempCount;
    try {
      if (totalContainersEl) totalContainersEl.textContent = String(totalCount);
      if (permanentContainersEl) permanentContainersEl.textContent = String(permCount);
      if (temporaryContainersEl) temporaryContainersEl.textContent = String(tempCount);
    } catch (e) {
      console.error('Failed to update container count elements', e);
    }
  };
  await updateContainerCounts();

  // Load existing settings
  const {
    rules = '',
    overrideRules = '',
    notifications = true,
    isRecordingHops = false,
    saveVisitedFavicons = false,
    defaultToNoContainer = false,
  } = await browser.storage.local.get([
    'rules',
    'overrideRules',
    'notifications',
    'isRecordingHops',
    'saveVisitedFavicons',
    'defaultToNoContainer',
  ]);

  // Load default temp container style
  const { tempContainerStyle = { color: 'blue', icon: 'circle', randomColor: false, randomIcon: false } } =
    await browser.storage.local.get('tempContainerStyle');

  let selectedColor = tempContainerStyle.color;
  let selectedIcon = tempContainerStyle.icon;
  randomColorCheckbox.checked = tempContainerStyle.randomColor || false;
  randomIconCheckbox.checked = tempContainerStyle.randomIcon || false;

  // Firefox contextual identity colours and icons
  const COLORS = ['blue', 'turquoise', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'toolbar'];
  const ICONS = [
    'fingerprint',
    'briefcase',
    'dollar',
    'cart',
    'vacation',
    'gift',
    'food',
    'fruit',
    'pet',
    'tree',
    'chill',
    'circle',
    'fence',
  ];

  // Helper: get CSS colour value
  function getColorValue(color) {
    const colors = {
      blue: '#37adff',
      turquoise: '#00c79b',
      green: '#51cd00',
      yellow: '#ffcb00',
      orange: '#ff9f00',
      red: '#ff613d',
      pink: '#ff4bda',
      purple: '#af51f5',
    };
    return colors[color] || '#37adff';
  }

  // Populate colour swatches
  COLORS.forEach((color) => {
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
      colorGrid.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      swatch.classList.add('selected');
      selectedColor = color;
    });

    colorGrid.appendChild(swatch);
  });

  // Populate icon options
  ICONS.forEach((icon) => {
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
      iconGrid.querySelectorAll('.icon-option').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedIcon = icon;
    });

    iconGrid.appendChild(btn);
  });

  // When a random checkbox is toggled, clear any selected swatch/button
  randomColorCheckbox.addEventListener('change', () => {
    if (randomColorCheckbox.checked) {
      colorGrid.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
    } else {
      // re-select the stored colour if any
      const swatch = colorGrid.querySelector(`[data-color="${selectedColor}"]`);
      if (swatch) swatch.classList.add('selected');
    }
  });

  randomIconCheckbox.addEventListener('change', () => {
    if (randomIconCheckbox.checked) {
      iconGrid.querySelectorAll('.icon-option').forEach((b) => b.classList.remove('selected'));
    } else {
      const btn = iconGrid.querySelector(`[data-icon="${selectedIcon}"]`);
      if (btn) btn.classList.add('selected');
    }
  });

  logDebug('Loaded rules from storage');
  logDebug('Loaded notifications setting:', notifications);

  containerRules.value = rules;
  overrideRulesEl.value = overrideRules;
  showNotifications.checked = notifications;
  debugLogging.checked = DEBUG;
  saveVisitedFaviconsCheckbox.checked = saveVisitedFavicons;
  unmatchedTemp.checked = !defaultToNoContainer;
  unmatchedDefault.checked = defaultToNoContainer;

  // Listen for storage changes to update the UI
  browser.storage.onChanged.addListener(async (changes, namespace) => {
    if (namespace === 'local') {
      if (changes.DEBUG) {
        DEBUG = changes.DEBUG.newValue ?? false;
      }
      if (changes.rules) {
        logDebug('Rules changed externally, updating display');
        containerRules.value = changes.rules.newValue || '';
        await updateContainerCounts();
      }
      if (changes.overrideRules) {
        logDebug('Override rules changed externally, updating display');
        overrideRulesEl.value = changes.overrideRules.newValue || '';
      }
      if (changes.saveVisitedFavicons) {
        saveVisitedFaviconsCheckbox.checked = changes.saveVisitedFavicons.newValue ?? false;
      }
      if (changes.defaultToNoContainer) {
        const noContainer = changes.defaultToNoContainer.newValue ?? false;
        unmatchedTemp.checked = !noContainer;
        unmatchedDefault.checked = noContainer;
      }
    }
  });

  // Helper function to trigger notifications and DOM error states
  async function triggerError(errorMessage) {
    saveMessage.textContent = errorMessage;
    saveMessage.classList.add('error', 'visible');
    setTimeout(() => {
      saveMessage.classList.remove('visible', 'error');
    }, 5000);

    if (showNotifications.checked) {
      await browser.notifications.create({
        type: 'basic',
        title: 'Invalid Rules Format',
        message: errorMessage,
      });
    }
  }

  // Validate rules format
  function validateRulesText(text, ruleListName) {
    const lines = text.split('\n').filter((line) => line.trim() !== '');

    let invalidLine = null;
    let invalidLineNumber = 0;
    let errorType = '';

    const isValid = lines.every((line, index) => {
      const trimmedLine = line.trim();

      // Check basic format: must have at least one comma
      if (!trimmedLine.includes(',')) {
        invalidLine = trimmedLine;
        invalidLineNumber = index + 1;
        errorType = 'format';
        return false;
      }

      // Check for correct comma format: no space before comma, space after comma
      if (!/^[^,\s]+,\s+.+$/.test(trimmedLine)) {
        invalidLine = trimmedLine;
        invalidLineNumber = index + 1;
        errorType = 'format';
        return false;
      }

      const commaIndex = trimmedLine.indexOf(',');
      const pattern = trimmedLine.slice(0, commaIndex).trim();
      const name = trimmedLine.slice(commaIndex + 1).trim();

      // Check for empty pattern or name
      if (!pattern || !name) {
        invalidLine = trimmedLine;
        invalidLineNumber = index + 1;
        errorType = pattern ? 'name' : 'pattern';
        return false;
      }

      // Validate pattern - allow domains with wildcards, hyphens, underscores, and paths
      const isDomainPattern =
        /^(\*\.)?([a-zA-Z0-9_-]+\.)*([a-zA-Z0-9_*-]+)(\.[a-zA-Z0-9_-]+)*(\.\*)?(\/.*)?$/.test(pattern) ||
        pattern.includes('/');

      if (!isDomainPattern) {
        invalidLine = trimmedLine;
        invalidLineNumber = index + 1;
        errorType = 'pattern';
        return false;
      }

      // Validate container name (any printable characters and spaces)
      if (!/^[\x20-\x7E]+$/.test(name)) {
        invalidLine = trimmedLine;
        invalidLineNumber = index + 1;
        errorType = 'name';
        return false;
      }

      return true;
    });

    if (!isValid && lines.length > 0) {
      let errorMessage;
      switch (errorType) {
        case 'format':
          errorMessage = `[${ruleListName}] Invalid format on line ${invalidLineNumber}: "${invalidLine}". Each rule must be in the format: Pattern, Name (e.g., youtube.com, YT)`;
          break;
        case 'pattern':
          errorMessage = `[${ruleListName}] Invalid pattern on line ${invalidLineNumber}: "${invalidLine}". Pattern must be a valid domain (e.g., google.com, *.google.*, google.*, *.google.com) or URL path (e.g., google.com/search)`;
          break;
        case 'name':
          errorMessage = `[${ruleListName}] Invalid container name on line ${invalidLineNumber}: "${invalidLine}". Container name must not be empty and contain only printable characters`;
          break;
        default:
          errorMessage = `[${ruleListName}] Invalid rule on line ${invalidLineNumber}: "${invalidLine}"`;
      }
      return errorMessage;
    }

    return null; // Indicates successful validation
  }

  // Domain hop tracking
  let trackingActive = isRecordingHops;

  function updateTrackerButtonUI() {
    if (trackingActive) {
      toggleTrackerBtn.textContent = '⏹ Stop Tracker';
      toggleTrackerBtn.style.backgroundColor = '#ff613d'; // Firefox red
      toggleTrackerBtn.style.color = 'white';
    } else {
      toggleTrackerBtn.textContent = '▶ Start Tracker';
      toggleTrackerBtn.style.backgroundColor = '';
      toggleTrackerBtn.style.color = '';
    }
  }

  updateTrackerButtonUI();

  toggleTrackerBtn.addEventListener('click', async () => {
    trackingActive = !trackingActive;
    updateTrackerButtonUI();

    if (trackingActive) {
      // Start tracking: clear old hops and enable flag
      await browser.storage.local.set({ isRecordingHops: true, domainHops: [] });
    } else {
      // Stop tracking: disable flag, fetch results, and show modal
      await browser.storage.local.set({ isRecordingHops: false });
      const { domainHops = [] } = await browser.storage.local.get('domainHops');

      hopLogResult.value =
        domainHops.length > 0 ? domainHops.join('\n') : 'No domain hops detected during this tracking session.';

      hopLogModal.showModal();
    }
  });

  closeModalBtn.addEventListener('click', () => hopLogModal.close());

  // Helper to show Folder import status messages
  function showFolderStatus(msg, isError) {
    folderMessage.textContent = msg;
    if (isError) {
      folderMessage.classList.add('error');
    } else {
      folderMessage.classList.remove('error');
    }
    folderMessage.classList.add('visible');
    setTimeout(() => {
      folderMessage.classList.remove('visible', 'error');
    }, 5000);
  }

  // Helper to read file natively as Base64 Data URI
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(file);
    });
  }

  // Handle Folder selection
  folderUpload.addEventListener('change', async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    try {
      showFolderStatus('Processing...', false);

      // Fetch all local storage keys to check if icons already exist
      const allData = await browser.storage.local.get(null);
      const newIcons = {};

      let totalProcessed = 0;
      let added = 0;
      let existed = 0;
      let hasUpdates = false;

      const validExtensions = ['png', 'jpg', 'jpeg', 'ico', 'gif', 'svg'];

      for (const file of files) {
        // webkitRelativePath format is "SelectedFolderName/filename.png"
        const pathParts = file.webkitRelativePath.split('/');

        // Ignore files inside subfolders
        if (pathParts.length > 2) continue;

        const filename = file.name;

        // Match extension
        const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
        if (!extMatch) continue;

        const ext = extMatch[1].toLowerCase();
        if (!validExtensions.includes(ext)) continue;

        // Strip the extension to get the domain
        const domain = filename.replace(/\.[^/.]+$/, '');
        if (!domain) continue;

        totalProcessed++;
        const storageKey = `favicon_${domain}`;

        // Check against the flattened keys
        if (allData[storageKey]) {
          existed++;
        } else {
          added++;
        }

        // Convert the file directly to a Base64 Data URI
        const dataUri = await readFileAsDataURL(file);

        // Stage the flattened key for saving
        newIcons[storageKey] = { data: dataUri, count: 1 };
        hasUpdates = true;
      }

      if (hasUpdates) {
        // Write the flattened keys directly to the root of local storage
        await browser.storage.local.set(newIcons);
      }

      const report = `Processed ${totalProcessed} files: ${added} new added, ${existed} updated/existed.`;
      logDebug(`[Folder Import] ${report}`);
      showFolderStatus('Import complete!', false);

      if (showNotifications.checked) {
        await browser.notifications.create({
          type: 'basic',
          title: 'Favicon Import Complete',
          message: report,
        });
      }
    } catch (err) {
      console.error('Folder processing error:', err);
      showFolderStatus(`Error: ${err.message}`, true);
    } finally {
      folderUpload.value = ''; // Reset input to allow re-selection
    }
  });

  // Save settings
  saveButton.addEventListener('click', async () => {
    try {
      const rulesText = containerRules.value.trim();
      const overrideRulesText = overrideRulesEl.value.trim();

      // Validate Standard Rules
      const rulesError = validateRulesText(rulesText, 'Container Rules');
      if (rulesError) {
        await triggerError(rulesError);
        return;
      }

      // Validate Override Rules
      const overrideError = validateRulesText(overrideRulesText, 'Override Rules');
      if (overrideError) {
        await triggerError(overrideError);
        return;
      }

      // Save rules and notification setting
      await browser.storage.local.set({
        rules: rulesText,
        overrideRules: overrideRulesText,
        notifications: showNotifications.checked,
        DEBUG: debugLogging.checked,
        saveVisitedFavicons: saveVisitedFaviconsCheckbox.checked,
        defaultToNoContainer: unmatchedDefault.checked,
        tempContainerStyle: {
          color: randomColorCheckbox.checked ? null : selectedColor,
          icon: randomIconCheckbox.checked ? null : selectedIcon,
          randomColor: randomColorCheckbox.checked,
          randomIcon: randomIconCheckbox.checked,
        },
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
          message: 'Auto Containers settings have been saved.',
        });
      }
    } catch (error) {
      console.error('Save error:', error);
      await triggerError(`Error saving: ${error.message}`);
    }
  });
});
