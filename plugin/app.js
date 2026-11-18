import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
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
const RECENT_SPACES_FILE = path.join(
  process.env.LOCALAPPDATA || os.tmpdir(),
  'herdr',
  'ulanzi-recent-spaces.json'
);
const RECENT_PANES_FILE = path.join(
  process.env.LOCALAPPDATA || os.tmpdir(),
  'herdr',
  'ulanzi-recent-panes.json'
);
const DISMISSED_RECENT_FILE = path.join(
  process.env.LOCALAPPDATA || os.tmpdir(),
  'herdr',
  'ulanzi-dismissed-recent.json'
);

const STATUS_PRIORITY = {
  blocked: 0,
  working: 1,
  done: 2,
  error: 3,
  idle: 4,
};
// Done sessions already pressed once sort after errors, just before idle.
const SEEN_DONE_PRIORITY = 3.5;

/**
 * Terminal ids whose current "done" has been looked at (key pressed).
 * Cleared as soon as the terminal leaves "done", so the next finish shows fresh.
 * @type {Set<string>}
 */
const seenDoneTerminals = new Set();

const $UD = new UlanziApi();

/** @type {Map<string, { context: string, key: string, active: boolean, lastIcon: string, terminal: object | null, recentSpace: object | null }>} */
const slots = new Map();

/** @type {Map<string, { spaceName: string, tabName: string, paneIndex: number, paneTotal: number, app: string | null, name: string | null }>} */
const layoutByTerminal = new Map();

/** @type {Map<string, { id: string, name: string, folder: string, machine: string | null }>} */
let lastOpenSpaces = new Map();

/** @type {Map<string, { id: string, spaceId: string, spaceName: string, tabName: string, paneIndex: number, agentName: string, folder: string, machine: string | null }>} */
let lastOpenPanes = new Map();

/** @type {Array<{ kind?: string, name: string, folder: string, machine: string | null }>} */
let rememberedClosedSpaces = loadJsonArray(RECENT_SPACES_FILE);

/** @type {Array<{ kind: string, id: string, spaceId: string, spaceName: string, tabName: string, paneIndex: number, agentName: string, folder: string, machine: string | null }>} */
let rememberedClosedPanes = loadJsonArray(RECENT_PANES_FILE);

/** @type {Set<string>} */
let dismissedRecentKeys = new Set(loadJsonArray(DISMISSED_RECENT_FILE, 50));

/** @type {Array<{ name: string, folder: string, machine: string | null }>} */
let apiRecentSpaces = [];

/** @type {Array<{ name: string, folder: string, machine: string | null }>} */
let finishedTerminalSpaces = [];

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
    cwd: rawCwd,
    spaceName: layout?.spaceName || '',
    tabName: layout?.tabName || '',
    paneIndex: layout?.paneIndex || null,
    paneTotal: layout?.paneTotal || null,
  };
}

function loadJsonArray(filePath, limit = 6) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, limit) : [];
  } catch {
    return [];
  }
}

function saveJsonArray(filePath, items) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf8');
  } catch {
    // Ignore persistence failures
  }
}

function spaceKey(space) {
  const folder = String(space.folder || space.name || '').toLowerCase();
  return `${space.machine || 'local'}::${folder}`;
}

function paneItemKey(item) {
  if (item.kind === 'pane') {
    const folder = String(item.folder || item.spaceName || '').toLowerCase();
    const agent = String(item.agentName || '').toLowerCase();
    const pos = item.tabName && item.paneIndex ? `${item.tabName}:${item.paneIndex}` : '';
    return `pane::${item.machine || 'local'}::${folder}::${agent}::${pos}`;
  }
  return `space::${spaceKey(item)}`;
}

function parseTerminalNum(id) {
  const m = String(id || '').match(/\d+/);
  return m ? Number(m[0]) : 0;
}

function normalizeFinishedSpace(t) {
  const folder = t.cwd || t.foreground?.cwd || '';
  const whereSpace = t.where ? String(t.where).split(' / ')[0].trim() : '';
  const name =
    whereSpace && whereSpace !== '~'
      ? whereSpace
      : folder
        ? path.basename(folder)
        : t.address || t.id || '';
  if (!name && !folder) return null;
  const agentName = getAgentDisplayName(t, null, t.address || t.id || '');
  return {
    kind: 'pane',
    id: t.address || t.id || '',
    name,
    spaceName: name,
    agentName: agentName !== (t.address || t.id) ? agentName : '',
    folder,
    machine: t.machine || null,
  };
}

function rebuildRecentSpaces(liveTerminals = []) {
  const openSpaceKeys = new Set();
  for (const space of lastOpenSpaces.values()) {
    openSpaceKeys.add(spaceKey(space));
  }
  for (const term of liveTerminals) {
    if (term.cwd) {
      openSpaceKeys.add(spaceKey({ folder: term.cwd, machine: null }));
    }
  }

  const seenItems = new Set();
  const combined = [];

  for (const pane of rememberedClosedPanes) {
    if (!pane || typeof pane !== 'object') continue;
    const key = paneItemKey({ ...pane, kind: 'pane' });
    if (seenItems.has(key)) continue;
    seenItems.add(key);
    combined.push({ ...pane, kind: 'pane' });
    if (combined.length >= MAX_RECENT_SPACES) {
      recentSpaces = combined;
      return;
    }
  }

  for (const item of [...rememberedClosedSpaces, ...apiRecentSpaces]) {
    if (!item || typeof item !== 'object') continue;
    const candidate = {
      kind: 'space',
      name: item.name || (item.folder ? path.basename(item.folder) : ''),
      folder: item.folder || '',
      machine: item.machine || null,
    };
    if (!candidate.name && !candidate.folder) continue;
    if (openSpaceKeys.has(spaceKey(candidate))) continue;
    const key = paneItemKey(candidate);
    if (seenItems.has(key)) continue;
    seenItems.add(key);
    combined.push(candidate);
    if (combined.length >= MAX_RECENT_SPACES) {
      recentSpaces = combined;
      return;
    }
  }

  for (const item of finishedTerminalSpaces) {
    if (!item || typeof item !== 'object') continue;
    const key = paneItemKey(item);
    if (dismissedRecentKeys.has(key) || seenItems.has(key)) continue;
    seenItems.add(key);
    combined.push(item);
    if (combined.length >= MAX_RECENT_SPACES) break;
  }

  recentSpaces = combined;
}

function updateRecentSpaces(data) {
  const currentOpen = new Map();
  const currentPanes = new Map();
  let spacesChanged = false;
  let panesChanged = false;

  for (const space of data.spaces || []) {
    const entry = {
      id: space.id || '',
      name: space.name || '',
      folder: space.folder || '',
      machine: space.machine || null,
    };
    if (entry.id) currentOpen.set(entry.id, entry);

    for (const tab of space.tabs || []) {
      const tabName = tab.name || '';
      const termList = Array.isArray(tab.terminals) ? tab.terminals : [];
      termList.forEach((term, idx) => {
        if (!term.terminal) return;
        currentPanes.set(term.terminal, {
          kind: 'pane',
          id: term.terminal,
          spaceId: entry.id,
          spaceName: entry.name || (entry.folder ? path.basename(entry.folder) : ''),
          tabName,
          paneIndex: idx + 1,
          agentName: term.name || term.app || '',
          folder: entry.folder,
          machine: entry.machine,
        });
      });
    }
  }

  let dismissedChanged = false;
  for (const [id, prev] of lastOpenSpaces.entries()) {
    if (!currentOpen.has(id) && (prev.folder || prev.name)) {
      const key = spaceKey(prev);
      rememberedClosedSpaces = [
        { name: prev.name, folder: prev.folder, machine: prev.machine },
        ...rememberedClosedSpaces.filter((s) => spaceKey(s) !== key),
      ].slice(0, 6);
      spacesChanged = true;
    }
  }

  for (const [id, prev] of lastOpenPanes.entries()) {
    if (!currentPanes.has(id) && currentOpen.has(prev.spaceId)) {
      const key = paneItemKey(prev);
      const finishedKey = paneItemKey({ ...prev, tabName: '', paneIndex: null });
      if (dismissedRecentKeys.delete(key)) dismissedChanged = true;
      if (dismissedRecentKeys.delete(finishedKey)) dismissedChanged = true;
      rememberedClosedPanes = [
        prev,
        ...rememberedClosedPanes.filter((p) => paneItemKey(p) !== key),
      ].slice(0, 6);
      panesChanged = true;
    }
  }

  lastOpenSpaces = currentOpen;
  lastOpenPanes = currentPanes;
  if (spacesChanged) saveJsonArray(RECENT_SPACES_FILE, rememberedClosedSpaces);
  if (panesChanged) saveJsonArray(RECENT_PANES_FILE, rememberedClosedPanes);
  if (dismissedChanged) saveJsonArray(DISMISSED_RECENT_FILE, Array.from(dismissedRecentKeys));

  apiRecentSpaces = Array.isArray(data.recent) ? data.recent : [];
  rebuildRecentSpaces();
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
  const { stdout } = await execFileAsync('hc', ['ls', '--all', '--json'], {
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

  const normalized = list
    .filter((t) => String(t.state || '').toLowerCase() !== 'finished')
    .map(normalizeTerminal)
    .filter((t) => Boolean(t.id));

  const doneIds = new Set(normalized.filter((t) => t.status === 'done').map((t) => t.id));
  for (const id of seenDoneTerminals) {
    if (!doneIds.has(id)) seenDoneTerminals.delete(id);
  }

  const priorityOf = (t) =>
    t.seen ? SEEN_DONE_PRIORITY : STATUS_PRIORITY[t.status] ?? 99;

  const live = normalized
    .map((t) => (t.status === 'done' && seenDoneTerminals.has(t.id) ? { ...t, seen: true } : t))
    .sort((a, b) => {
      const pa = priorityOf(a);
      const pb = priorityOf(b);
      if (pa !== pb) return pa - pb;
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });

  finishedTerminalSpaces = list
    .filter((t) => String(t.state || '').toLowerCase() === 'finished')
    .sort((a, b) => parseTerminalNum(b.address || b.id) - parseTerminalNum(a.address || a.id))
    .map(normalizeFinishedSpace)
    .filter(Boolean);

  return live;
}

// Ulanzi keys are "col_row" (e.g. "3_1"); order row-first so priority reads left→right, top→bottom.
function parseKeyPosition(key) {
  const match = /^(\d+)_(\d+)$/.exec(String(key));
  return match ? { col: Number(match[1]), row: Number(match[2]) } : null;
}

function getOrderedSlots() {
  return Array.from(slots.values()).sort((a, b) => {
    const pa = parseKeyPosition(a.key);
    const pb = parseKeyPosition(b.key);
    if (pa && pb) return pa.row - pb.row || pa.col - pb.col;
    return String(a.key).localeCompare(String(b.key), undefined, { numeric: true });
  });
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
    rebuildRecentSpaces(terminals);
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

function consumeRecentItem(item) {
  const targetPaneKey = paneItemKey(item);
  const targetFinishedKey = paneItemKey({ ...item, kind: 'pane', tabName: '', paneIndex: null });
  const targetSpaceKey = spaceKey(item);

  const nextPanes = rememberedClosedPanes.filter((p) => paneItemKey(p) !== targetPaneKey);
  if (nextPanes.length !== rememberedClosedPanes.length) {
    rememberedClosedPanes = nextPanes;
    saveJsonArray(RECENT_PANES_FILE, rememberedClosedPanes);
  }

  const nextSpaces = rememberedClosedSpaces.filter((s) => spaceKey(s) !== targetSpaceKey);
  if (nextSpaces.length !== rememberedClosedSpaces.length) {
    rememberedClosedSpaces = nextSpaces;
    saveJsonArray(RECENT_SPACES_FILE, rememberedClosedSpaces);
  }

  dismissedRecentKeys.add(targetPaneKey);
  dismissedRecentKeys.add(targetFinishedKey);
  saveJsonArray(DISMISSED_RECENT_FILE, Array.from(dismissedRecentKeys).slice(-50));
}

async function reopenSpace(item) {
  try {
    const openSpace =
      (item.spaceId && lastOpenSpaces.get(item.spaceId)) ||
      Array.from(lastOpenSpaces.values()).find(
        (s) => item.folder && s.folder && s.folder.toLowerCase() === item.folder.toLowerCase()
      );

    if (item.kind === 'pane' && openSpace?.id) {
      const args = ['do', 'tab.new', '--space', openSpace.id];
      if (item.folder) args.push('--folder', item.folder);
      await execFileAsync('herdr-app', args, {
        timeout: 4000,
        windowsHide: true,
      });
    } else {
      const args = ['do', 'space.new'];
      const spaceName = item.spaceName || item.name;
      if (spaceName) args.push('--name', spaceName);
      if (item.folder) args.push('--folder', item.folder);
      if (item.machine) args.push('--machine', item.machine);

      await execFileAsync('herdr-app', args, {
        timeout: 4000,
        windowsHide: true,
      });
    }

    consumeRecentItem(item);
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
    if (slot.terminal.status === 'done') {
      seenDoneTerminals.add(slot.terminal.id);
    }
    focusTerminal(slot.terminal).then(refreshAllSlots);
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
