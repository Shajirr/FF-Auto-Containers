import { deduplicateRules, mergeOverrideRules } from './sorting.js';

// --- Constants & State ---

let DEBUG = false;
const debugPrefix = '[AC]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

const DEFAULTS = Object.freeze({
  showNotifications: true,
  saveVisitedFavicons: false,
  debugMode: false,
});

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

// Single cached DOM registry
let dom = {};

let selectedColor = 'blue';
let selectedIcon = 'circle';

// --- DOM Registry Constructor ---

function createDOM() {
  return {
    autoSaveError: document.getElementById('auto-save-error'),
    containerRules: document.getElementById('containerRules'),
    overrideRules: document.getElementById('overrideRules'),
    saveButton: document.getElementById('saveButton'),
    saveMessage: document.getElementById('save-message'),
    totalContainers: document.getElementById('totalContainers'),
    permanentContainers: document.getElementById('permanentContainers'),
    temporaryContainers: document.getElementById('temporaryContainers'),

    // Domain hop tracking elements
    toggleTrackerBtn: document.getElementById('toggleTrackerBtn'),
    hopLogModal: document.getElementById('hopLogModal'),
    hopLogResult: document.getElementById('hopLogResult'),
    closeModalBtn: document.getElementById('closeModalBtn'),

    // Elements for temp container style
    colorGrid: document.getElementById('colorGrid'),
    iconGrid: document.getElementById('iconGrid'),
    randomColorCheckbox: document.getElementById('randomColor'),
    randomIconCheckbox: document.getElementById('randomIcon'),

    // Elements for favicon import
    folderUpload: document.getElementById('folderUpload'),
    folderMessage: document.getElementById('folder-message'),
  };
}

// --- UI Helpers & Error Handling ---

// Display auto-save / load event error message
function displayError(message) {
  if (!dom.autoSaveError) return;

  if (message) {
    dom.autoSaveError.textContent = message;
    dom.autoSaveError.classList.add('visible');
  } else {
    dom.autoSaveError.classList.remove('visible');
  }
}

// Show error for the manual Save button & textareas
async function displayManualSaveError(errorMessage) {
  dom.saveMessage.textContent = errorMessage;
  dom.saveMessage.classList.add('error', 'visible');

  if (await areNotificationsEnabled()) {
    await browser.notifications.create({
      type: 'basic',
      title: 'Invalid Rules Format',
      message: errorMessage,
    });
  }
}

// Helper function to check notifications setting
async function areNotificationsEnabled() {
  const { showNotifications } = await browser.storage.local.get({ showNotifications: DEFAULTS.showNotifications });
  return showNotifications;
}

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

// Helper to read file natively as Base64 Data URI
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}

// --- Main Section ---

// Load settings into data-setting elements
async function loadOptions() {
  try {
    const settings = await browser.storage.local.get(DEFAULTS);
    DEBUG = settings.debugMode; // Initialize the global debug variable

    document.querySelectorAll('[data-setting]').forEach((el) => {
      const key = el.getAttribute('data-setting');
      if (key in settings) {
        if (el.type === 'checkbox') {
          el.checked = settings[key];
        } else {
          el.value = settings[key];
        }
      }
    });

    displayError(null);
  } catch (error) {
    displayError('Failed to load settings from storage.');
    console.error('Failed to load settings from storage:', error);
  }
}

// Auto-save settings to storage on user interaction
document.addEventListener('input', (e) => {
  const el = e.target;

  // Ignore clicks on things that aren't settings
  if (!el.hasAttribute('data-setting')) return;

  // Clear any existing error when the user interacts
  displayError(null);

  const key = el.getAttribute('data-setting');
  let value;

  // Parse numbers safely and handle checkboxes
  if (el.type === 'checkbox') {
    value = el.checked;
  } else if (el.type === 'number') {
    value = parseInt(el.value, 10);
  } else {
    value = el.value;
  }

  try {
    browser.storage.local.set({ [key]: value });
    if (key === 'debugMode') {
      DEBUG = Boolean(value);
    }
    logDebug(`Auto-saved setting "${key}":`, value);
  } catch (error) {
    displayError(`Error auto-saving ${key}: ${error.message}`);
    console.error(`Failed to auto-save ${key}:`, error);
  }
});

// Update container counts in the UI
async function updateContainerCounts() {
  try {
    const identities = await browser.contextualIdentities.query({});
    const tempCount = identities.filter((identity) => /^tmp_\d+$/.test(identity.name)).length;
    const totalCount = identities.length;
    const permCount = totalCount - tempCount;

    dom.totalContainers.textContent = String(totalCount);
    dom.permanentContainers.textContent = String(permCount);
    dom.temporaryContainers.textContent = String(tempCount);
  } catch (e) {
    console.error('Failed to update container count elements', e);
  }
}

async function initStylingControls() {
  // Load default temp container style
  const { tempContainerStyle = { color: 'blue', icon: 'circle', randomColor: false, randomIcon: false } } =
    await browser.storage.local.get('tempContainerStyle');

  selectedColor = tempContainerStyle.color || 'blue';
  selectedIcon = tempContainerStyle.icon || 'circle';
  dom.randomColorCheckbox.checked = Boolean(tempContainerStyle.randomColor);
  dom.randomIconCheckbox.checked = Boolean(tempContainerStyle.randomIcon);

  // Populate colour swatches
  COLORS.forEach((color) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.dataset.color = color;
    swatch.style.backgroundColor = getColorValue(color);
    swatch.title = color;

    if (color === selectedColor && !dom.randomColorCheckbox.checked) {
      swatch.classList.add('selected');
    }

    swatch.addEventListener('click', () => {
      if (dom.randomColorCheckbox.checked) {
        dom.randomColorCheckbox.checked = false;
      }
      dom.colorGrid.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      swatch.classList.add('selected');
      selectedColor = color;
    });

    dom.colorGrid.appendChild(swatch);
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

    if (icon === selectedIcon && !dom.randomIconCheckbox.checked) {
      btn.classList.add('selected');
    }

    btn.addEventListener('click', () => {
      if (dom.randomIconCheckbox.checked) {
        dom.randomIconCheckbox.checked = false;
      }
      dom.iconGrid.querySelectorAll('.icon-option').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedIcon = icon;
    });

    dom.iconGrid.appendChild(btn);
  });

  // When a random checkbox is toggled, clear any selected swatch/button
  dom.randomColorCheckbox.addEventListener('change', () => {
    if (dom.randomColorCheckbox.checked) {
      dom.colorGrid.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
    } else {
      // re-select the stored colour if any
      const swatch = dom.colorGrid.querySelector(`[data-color="${selectedColor}"]`);
      if (swatch) swatch.classList.add('selected');
    }
  });

  dom.randomIconCheckbox.addEventListener('change', () => {
    if (dom.randomIconCheckbox.checked) {
      dom.iconGrid.querySelectorAll('.icon-option').forEach((b) => b.classList.remove('selected'));
    } else {
      const btn = dom.iconGrid.querySelector(`[data-icon="${selectedIcon}"]`);
      if (btn) btn.classList.add('selected');
    }
  });
}

// Domain hop tracking
async function initHopTracker() {
  let { trackingActive = false } = await browser.storage.local.get('isRecordingHops');

  function updateTrackerButtonUI() {
    if (trackingActive) {
      dom.toggleTrackerBtn.textContent = '⏹ Stop Tracker';
      dom.toggleTrackerBtn.style.backgroundColor = '#ff613d'; // Firefox red
      dom.toggleTrackerBtn.style.color = 'white';
    } else {
      dom.toggleTrackerBtn.textContent = '▶ Start Tracker';
      dom.toggleTrackerBtn.style.backgroundColor = '';
      dom.toggleTrackerBtn.style.color = '';
    }
  }

  updateTrackerButtonUI();

  dom.toggleTrackerBtn.addEventListener('click', async () => {
    trackingActive = !trackingActive;
    updateTrackerButtonUI();

    if (trackingActive) {
      // Start tracking: clear old hops and enable flag
      await browser.storage.local.set({ isRecordingHops: true, domainHops: [] });
    } else {
      // Stop tracking: disable flag, fetch results, and show modal
      await browser.storage.local.set({ isRecordingHops: false });
      const { domainHops = [] } = await browser.storage.local.get('domainHops');

      dom.hopLogResult.value =
        domainHops.length > 0 ? domainHops.join('\n') : 'No domain hops detected during this tracking session.';

      dom.hopLogModal.showModal();
    }
  });

  dom.closeModalBtn.addEventListener('click', () => dom.hopLogModal.close());
}

function initFaviconImporter() {
  let folderStatusTimer = null;

  // Helper to show favicons folder import status messages
  function showFolderStatus(msg, isError, duration = 8000) {
    if (folderStatusTimer) clearTimeout(folderStatusTimer);

    dom.folderMessage.textContent = msg;
    if (isError) {
      dom.folderMessage.classList.add('error');
    } else {
      dom.folderMessage.classList.remove('error');
    }
    dom.folderMessage.classList.add('visible');

    if (duration > 0) {
      folderStatusTimer = setTimeout(() => {
        dom.folderMessage.classList.remove('visible', 'error');
        folderStatusTimer = null;
      }, duration);
    }
  }

  // Handle folder selection for favicon import
  dom.folderUpload.addEventListener('change', async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    try {
      showFolderStatus('Processing...', false, 0);

      // Fetch all local storage keys to check if icons already exist
      const allData = await browser.storage.local.get(null);
      const newIcons = {};

      let totalProcessed = 0;
      let added = 0;
      let existed = 0;
      let skippedSize = 0;
      let skippedInvalid = 0;
      let hasUpdates = false;

      const validExtensions = ['png', 'jpg', 'jpeg', 'ico', 'gif', 'svg'];
      const MAX_FILE_SIZE = 100 * 1024; // 100 KB limit per favicon

      for (const file of files) {
        // webkitRelativePath format is "SelectedFolderName/filename.png"
        const pathParts = file.webkitRelativePath.split('/');

        // Ignore files inside subfolders
        if (pathParts.length > 2) {
          skippedInvalid++;
          continue;
        }

        const filename = file.name;

        // Match extension
        const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
        if (!extMatch) {
          skippedInvalid++;
          continue;
        }

        const ext = extMatch[1].toLowerCase();
        if (!validExtensions.includes(ext)) {
          skippedInvalid++;
          continue;
        }

        // Strip the extension to get the domain
        const domain = filename.replace(/\.[^/.]+$/, '');
        if (!domain) {
          skippedInvalid++;
          continue;
        }

        // Enforce file size limit
        if (file.size > MAX_FILE_SIZE) {
          logDebug(
            `[Folder Import] Skipped ${filename}: File size (${(file.size / 1024).toFixed(1)} KB) exceeds ${MAX_FILE_SIZE / 1024}KB limit.`,
          );
          skippedSize++;
          continue;
        }

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

      let report = `Processed ${totalProcessed} files: ${added} new added, ${existed} existing updated.`;
      if (skippedSize > 0 || skippedInvalid > 0) {
        report += ` Skipped: ${skippedSize} exceeding size limit, ${skippedInvalid} with invalid type/location.`;
      }

      logDebug(`[Folder Import] ${report}`);
      showFolderStatus(report, false, 8000);

      if (await areNotificationsEnabled()) {
        await browser.notifications.create({
          type: 'basic',
          title: 'Favicon Import Complete',
          message: report,
        });
      }
    } catch (err) {
      console.error('Folder processing error:', err);
      showFolderStatus(`Error: ${err.message}`, true, 6000);
    } finally {
      dom.folderUpload.value = ''; // Reset input to allow re-selection
    }
  });
}

// --- Rules ---

// Validate rules format
function validateRulesText(text, ruleListName, allowMultipleContainers = ruleListName !== 'Container Rules') {
  const lines = text.split('\n').filter((line) => line.trim() !== '');

  let invalidLine = null;
  let invalidLineNumber = 0;
  let errorType = '';
  let conflictingPattern = '';
  let conflictingContainer = '';

  const seenPatterns = new Map();

  const isValid = lines.every((line, index) => {
    const trimmedLine = line.trim();

    // Check comma format: must have at least one comma, no space before comma, has space after comma
    if (!trimmedLine.includes(',') || !/^[^,\s]+,\s+.+$/.test(trimmedLine)) {
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

    // For regular container rules: check for conflicting containers assigned to the same pattern
    if (!allowMultipleContainers) {
      const patternKey = pattern.toLowerCase();
      if (seenPatterns.has(patternKey)) {
        const existing = seenPatterns.get(patternKey);
        if (existing.container !== name) {
          invalidLine = trimmedLine;
          invalidLineNumber = index + 1;
          errorType = 'duplicate-pattern';
          conflictingPattern = pattern;
          conflictingContainer = existing.container;
          return false;
        }
      } else {
        seenPatterns.set(patternKey, { container: name, line: index + 1 });
      }
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
      case 'duplicate-pattern':
        errorMessage = `[${ruleListName}] Conflicting rule on line ${invalidLineNumber}: "${invalidLine}". Pattern "${conflictingPattern}" is already assigned to "${conflictingContainer}". Each pattern can only be associated with a single container`;
        break;
      default:
        errorMessage = `[${ruleListName}] Invalid rule on line ${invalidLineNumber}: "${invalidLine}"`;
    }
    return errorMessage;
  }

  return null; // Indicates successful validation
}

async function initRules() {
  // Load existing rules and override rules from storage
  const { rules = '', overrideRules = '' } = await browser.storage.local.get(['rules', 'overrideRules']);

  logDebug('Loaded rules from storage');

  dom.containerRules.value = rules;
  dom.overrideRules.value = overrideRules;

  // Manually save rules and styling settings
  dom.saveButton.addEventListener('click', async () => {
    try {
      const rulesText = dom.containerRules.value.trim();
      const overrideRulesText = dom.overrideRules.value.trim();

      // Validate Standard Rules
      const rulesError = validateRulesText(rulesText, 'Container Rules');
      if (rulesError) {
        await displayManualSaveError(rulesError);
        return;
      }

      // Validate Override Rules
      const overrideError = validateRulesText(overrideRulesText, 'Override Rules');
      if (overrideError) {
        await displayManualSaveError(overrideError);
        return;
      }

      // Deduplicate standard rules and merge same-base override rules
      const cleanRulesText = deduplicateRules(rulesText);
      const cleanOverrideRulesText = mergeOverrideRules(overrideRulesText);

      dom.containerRules.value = cleanRulesText;
      dom.overrideRules.value = cleanOverrideRulesText;

      // Save rules and notification setting
      await browser.storage.local.set({
        rules: cleanRulesText,
        overrideRules: cleanOverrideRulesText,
        tempContainerStyle: {
          color: selectedColor || 'blue',
          icon: selectedIcon || 'circle',
          randomColor: dom.randomColorCheckbox.checked,
          randomIcon: dom.randomIconCheckbox.checked,
        },
      });

      // Show success message
      dom.saveMessage.textContent = 'Settings saved!';
      dom.saveMessage.classList.remove('error');
      dom.saveMessage.classList.add('visible');
      setTimeout(() => {
        dom.saveMessage.classList.remove('visible');
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

      if (await areNotificationsEnabled()) {
        await browser.notifications.create({
          type: 'basic',
          title: 'Settings Saved',
          message: 'Auto Containers settings have been saved.',
        });
      }
    } catch (error) {
      console.error('Save error:', error);
      await displayManualSaveError(`Error saving: ${error.message}`);
    }
  });
}

// --- Storage Change Listener ---

browser.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace === 'local') {
    if (changes.debugMode !== undefined) {
      DEBUG = changes.debugMode.newValue ?? false;
    }
    if (changes.rules) {
      logDebug('Rules changed externally, updating display');
      dom.containerRules.value = changes.rules.newValue || '';
      await updateContainerCounts();
    }
    if (changes.overrideRules) {
      logDebug('Override rules changed externally, updating display');
      dom.overrideRules.value = changes.overrideRules.newValue || '';
    }
  }
});

// --- Main Initialization ---

async function initOptions() {
  // Cache DOM elements
  dom = createDOM();

  // Verify DOM elements exist
  const missing = Object.entries(dom)
    .filter(([_, el]) => !el)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error('Missing DOM elements:', missing);
    displayError('Error: One or more Options page elements not found');
    return;
  }

  await loadOptions();
  await updateContainerCounts();
  await initStylingControls();
  await initHopTracker();
  initFaviconImporter();
  await initRules();
}

// Initialize the options page when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', initOptions);
