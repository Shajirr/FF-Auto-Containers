export { createTempContainer, getTempContainers, startDeletionTimer, cancelDeletionTimer };

let DEBUG = false;
const debugPrefix = '[AC]';

function logDebug(...args) {
  if (DEBUG) console.log(debugPrefix, ...args);
}

const COLORS = ['blue', 'turquoise', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'toolbar'];
// prettier-ignore
const ICONS = ['fingerprint', 'briefcase', 'dollar', 'cart', 'vacation',
  'gift', 'food', 'fruit', 'pet', 'tree', 'chill', 'circle', 'fence'];

// Map to store deletion timers for temporary containers
const deletionTimers = new Map();

// Get random colour or icon
function getRandomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
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
