import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import UlanziApi from './ulanzi-api.js';
import {
  renderEmptyIcon,
  renderOfflineIcon,
  renderRecentSpaceIcon,
  renderSessionIcon,
} from './svg-renderer.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVATE_SCRIPT = path.join(__dirname, 'activate-herdr.ps1');

const PLUGIN_UUID = 'com.herdr.ulanzistudio.sessions';
const POLL_INTERVAL_MS = 1500;
const LAYOUT_POLL_INTERVAL_MS = 3000;
const MAX_RECENT_SPACES = 3;

const STATUS_PRIORITY = {
  blocked: 0,
  working: 1,
  done: 2,
  error: 3,
  idle: 4,
};

const $UD = new UlanziApi();

/** @type {Map<string, { context: string, key: string, active: boolean, lastIcon: string, terminal: object | null, recentSpace: object | null }>} */
const slots = new Map();

/** @type {Map<string, { spaceName: string, tabName: string, paneIndex: number, paneTotal: number, app: string | null, name: string | null }>} */
const layoutByTerminal = new Map();

/** @type {Map<string, { id: string, name: string, folder: string, machine: string | null }>} */
let lastOpenSpaces = new Map();

/** @type {Array<{ name: string, folder: string, machine: string | null }>} */
let rememberedClosedSpaces = [];

/** @type {Array<{ name: string, folder: string, machine: string | null }>} */
let recentSpaces = [];

let pollTimer = null;
let layoutTimer = null;
let isPolling = false;
let isPollingLayout = false;

function normalizeStatus(rawStatus) {
  const s = String(rawStatus || '').toLowerCase();
  if (s === 'blocked' || s === 'needs_you' || s === 'waiting' || s === 'permission') {
    return 'blocked';
  }
  if (s === 'working' || s === 'running' || s === 'busy') {
    return 'working';
  }
  if (s === 'done' || s === 'completed' || s === 'finished') {
    return 'done';
  }
  if (s === 'error' || s === 'failed') {
    return 'error';
  }
  return 'idle';
}

function getAgentDisplayName(t, layout, id) {
  if (layout?.name && layout.name !== id) return layout.name;
  if (t.name && t.name !== id) return t.name;
  if (t.title && t.title !== id) return t.title;
  if (layout?.app) return layout.app;
  if (typeof t.agent === 'string' && t.agent.trim()) {
    return path.basename(t.agent.trim()).replace(/\.exe$/i, '');
  }
  if (t.agent?.name) return t.agent.name;
  if (t.agent?.kind) return t.agent.kind;
  if (t.program) return path.basename(t.program).replace(/\.exe$/i, '');
  return id;
}

function normalizeTerminal(t) {
  const id = t.address || t.id || t.terminal_id || '';
  const layout = layoutByTerminal.get(id) || null;
  const name = getAgentDisplayName(t, layout, id);
  const status = normalizeStatus(t.status || t.agent?.status);
  const rawCwd = t.foreground?.cwd || t.cwd || '';
  const where = t.where || t.labels?.where || (rawCwd ? path.basename(rawCwd) : '');

  return {
    id,
    name,
    status,
    where,
    spaceName: layout?.spaceName || '',
    tabName: layout?.tabName || '',
    paneIndex: layout?.paneIndex || null,
    paneTotal: layout?.paneTotal || null,
  };
}

function spaceKey(space) {
  return `${space.machine || 'local'}::${space.folder || space.name || ''}`;
}

function updateRecentSpaces(data) {
  const currentOpen = new Map();
  const openKeys = new Set();

  for (const space of data.spaces || []) {
    const entry = {
      id: space.id || '',
      name: space.name || '',
      folder: space.folder || '',
      machine: space.machine || null,
    };
    if (entry.id) currentOpen.set(entry.id, entry);
    openKeys.add(spaceKey(entry));
  }

  for (const [id, prev] of lastOpenSpaces.entries()) {
    if (!currentOpen.has(id) && (prev.folder || prev.name)) {
      const key = spaceKey(prev);
      rememberedClosedSpaces = [
        { name: prev.name, folder: prev.folder, machine: prev.machine },
        ...rememberedClosedSpaces.filter((s) => spaceKey(s) !== key),
      ].slice(0, 6);
    }
  }
  lastOpenSpaces = currentOpen;

  const combined = [];
  const seen = new Set(openKeys);

  for (const item of [...rememberedClosedSpaces, ...(Array.isArray(data.recent) ? data.recent : [])]) {
    if (!item || typeof item !== 'object') continue;
    const candidate = {
      name: item.name || (item.folder ? path.basename(item.folder) : ''),
      folder: item.folder || '',
      machine: item.machine || null,
    };
    if (!candidate.name && !candidate.folder) continue;
    const key = spaceKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(candidate);
    if (combined.length >= MAX_RECENT_SPACES) break;
  }

  recentSpaces = combined;
}

async function refreshLayout() {
  if (isPollingLayout || slots.size === 0) return;
  isPollingLayout = true;

  try {
    const { stdout } = await execFileAsync('herdr-app', ['ls'], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    const data = JSON.parse(stdout || '{}');
    const nextMap = new Map();

    for (const space of data.spaces || []) {
      const spaceName = space.name || '';
      for (const tab of space.tabs || []) {
        const tabName = tab.name || '';
        const termList = Array.isArray(tab.terminals) ? tab.terminals : [];
        const paneTotal = termList.length;

        termList.forEach((term, idx) => {
          if (!term.terminal) return;
          nextMap.set(term.terminal, {
            spaceName,
            tabName,
            paneIndex: idx + 1,
            paneTotal,
            app: term.app || null,
            name: term.name || null,
          });
        });
      }
    }

    layoutByTerminal.clear();
    for (const [k, v] of nextMap.entries()) {
      layoutByTerminal.set(k, v);
    }

    updateRecentSpaces(data);
  } catch {
    // herdr-app window might be closed; keep existing or fallback to hc where
  } finally {
    isPollingLayout = false;
  }
}

async function fetchTerminals() {
  const { stdout } = await execFileAsync('hc', ['ls', '--json'], {
    timeout: 3000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  const parsed = JSON.parse(stdout || '[]');
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.terminals)
      ? parsed.terminals
      : [];

  return list
    .map(normalizeTerminal)
    .filter((t) => Boolean(t.id))
    .sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 99;
      const pb = STATUS_PRIORITY[b.status] ?? 99;
      if (pa !== pb) return pa - pb;
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });
}

function getOrderedSlots() {
  return Array.from(slots.values()).sort((a, b) =>
    String(a.key).localeCompare(String(b.key), undefined, { numeric: true })
  );
}

function updateSlotIcon(slot, iconDataUrl) {
  if (slot.lastIcon === iconDataUrl) return;
  slot.lastIcon = iconDataUrl;
  $UD.setBaseDataIcon(slot.context, iconDataUrl);
}

async function refreshAllSlots() {
  if (isPolling || slots.size === 0) return;
  isPolling = true;

  try {
    const terminals = await fetchTerminals();
    const ordered = getOrderedSlots();

    ordered.forEach((slot, index) => {
      const terminal = terminals[index] || null;
      if (terminal) {
        slot.terminal = terminal;
        slot.recentSpace = null;
        updateSlotIcon(slot, renderSessionIcon(terminal));
        return;
      }

      const recentIdx = index - terminals.length;
      const recentSpace = recentSpaces[recentIdx] || null;
      slot.terminal = null;
      slot.recentSpace = recentSpace;

      const icon = recentSpace
        ? renderRecentSpaceIcon(recentSpace)
        : renderEmptyIcon(index + 1);
      updateSlotIcon(slot, icon);
    });
  } catch {
    const offlineIcon = renderOfflineIcon();
    for (const slot of slots.values()) {
      slot.terminal = null;
      slot.recentSpace = null;
      updateSlotIcon(slot, offlineIcon);
    }
  } finally {
    isPolling = false;
  }
}

function ensurePolling() {
  if (!pollTimer) {
    pollTimer = setInterval(refreshAllSlots, POLL_INTERVAL_MS);
  }
  if (!layoutTimer) {
    refreshLayout().then(refreshAllSlots);
    layoutTimer = setInterval(refreshLayout, LAYOUT_POLL_INTERVAL_MS);
  }
}

function stopPollingIfEmpty() {
  if (slots.size === 0) {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (layoutTimer) {
      clearInterval(layoutTimer);
      layoutTimer = null;
    }
  }
}

async function activateHerdrWindow() {
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ACTIVATE_SCRIPT],
    {
      timeout: 3000,
      windowsHide: true,
    }
  );
}

async function focusTerminal(terminal) {
  try {
    await execFileAsync(
      'herdr-app',
      ['do', 'agent.focus', '--terminal', terminal.id],
      {
        timeout: 3000,
        windowsHide: true,
      }
    );
    await activateHerdrWindow();
  } catch (err) {
    $UD.toast(`Focus failed (${terminal.id}): ${err.message}`);
  }
}

async function reopenSpace(space) {
  try {
    const args = ['do', 'space.new'];
    if (space.name) args.push('--name', space.name);
    if (space.folder) args.push('--folder', space.folder);
    if (space.machine) args.push('--machine', space.machine);

    await execFileAsync('herdr-app', args, {
      timeout: 4000,
      windowsHide: true,
    });
    await activateHerdrWindow();
    await refreshLayout();
    await refreshAllSlots();
  } catch (err) {
    $UD.toast(`Reopen failed: ${err.message}`);
  }
}

async function openNewTab() {
  try {
    await execFileAsync('herdr-app', ['do', 'tab.new'], {
      timeout: 3000,
      windowsHide: true,
    });
    await activateHerdrWindow();
    await refreshLayout();
    await refreshAllSlots();
  } catch (err) {
    try {
      await activateHerdrWindow();
    } catch {
      $UD.toast(`New tab failed: ${err.message}`);
    }
  }
}

$UD.connect(PLUGIN_UUID);

$UD.on('connected', () => {
  refreshLayout().then(refreshAllSlots);
});

$UD.on('add', (jsn) => {
  const context = jsn.context;
  if (!slots.has(context)) {
    slots.set(context, {
      context,
      key: jsn.key ?? '',
      active: true,
      lastIcon: '',
      terminal: null,
      recentSpace: null,
    });
  }
  ensurePolling();
  refreshAllSlots();
});

$UD.on('setactive', (jsn) => {
  const slot = slots.get(jsn.context);
  if (slot) {
    slot.active = Boolean(jsn.active);
    if (slot.active) {
      slot.lastIcon = '';
      refreshLayout().then(refreshAllSlots);
    }
  }
});

$UD.on('run', (jsn) => {
  const slot = slots.get(jsn.context);
  if (!slot) {
    $UD.emit('add', jsn);
    return;
  }

  if (slot.terminal?.id) {
    focusTerminal(slot.terminal);
  } else if (slot.recentSpace) {
    reopenSpace(slot.recentSpace);
  } else {
    openNewTab();
  }
});

$UD.on('clear', (jsn) => {
  if (Array.isArray(jsn.param)) {
    for (const item of jsn.param) {
      slots.delete(item.context);
    }
  } else if (jsn.context) {
    slots.delete(jsn.context);
  }
  stopPollingIfEmpty();
});
