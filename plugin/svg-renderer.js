const STATUS_STYLES = {
  blocked: {
    label: 'NEEDS YOU',
    bg: '#1F1309',
    border: '#F59E0B',
    badgeBg: '#F59E0B',
    badgeText: '#111827',
    dot: '#FBBF24',
  },
  working: {
    label: 'WORKING',
    bg: '#0B162C',
    border: '#3B82F6',
    badgeBg: '#1D4ED8',
    badgeText: '#EFF6FF',
    dot: '#60A5FA',
  },
  // Done is "look when convenient": quieter than working/blocked so those stand out.
  done: {
    label: 'DONE',
    bg: '#0A1714',
    border: '#047857',
    borderWidth: 3,
    badgeBg: '#065F46',
    badgeText: '#D1FAE5',
    dot: '#34D399',
  },
  // Done and already pressed (focused) once: styled like idle, keeps a check mark.
  seen: {
    label: 'DONE ✓',
    bg: '#0F172A',
    border: '#334155',
    borderWidth: 3,
    badgeBg: '#1E293B',
    badgeText: '#94A3B8',
    dot: '#4B5563',
  },
  error: {
    label: 'ERROR',
    bg: '#230C0E',
    border: '#EF4444',
    badgeBg: '#DC2626',
    badgeText: '#FEF2F2',
    dot: '#F87171',
  },
  idle: {
    label: 'IDLE',
    bg: '#0F172A',
    border: '#475569',
    borderWidth: 3,
    badgeBg: '#334155',
    badgeText: '#E2E8F0',
    dot: '#94A3B8',
  },
};

function escapeXml(str) {
  return String(str)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(str, maxLen) {
  const s = String(str || '').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

const FONT = 'Segoe UI, Arial, sans-serif';
// Usable text width inside the 144px key (border + side padding).
const TEXT_MAX_WIDTH = 114;

// Rough glyph widths in em for bold Segoe UI; good enough to pick a font size.
function charWidthEm(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x1100 && (code <= 0x11ff || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef))) {
    return 1.0;
  }
  if (/[ilj.,:;'|!·]/.test(ch)) return 0.3;
  if (/[\s\-_/()]/.test(ch)) return 0.38;
  if (/[mwMW]/.test(ch)) return 0.88;
  if (/[A-Z]/.test(ch)) return 0.66;
  return 0.56;
}

// Calibrated against Segoe UI bold rendering ("flow-tester" @20px ≈ 103px).
const WIDTH_CALIBRATION = 0.92;

function textWidthEm(str) {
  let total = 0;
  for (const ch of str) total += charWidthEm(ch);
  return total * WIDTH_CALIBRATION;
}

function fits(text, size, maxWidth = TEXT_MAX_WIDTH) {
  return textWidthEm(text) * size <= maxWidth;
}

// Drop characters from the middle so the distinguishing tail (e.g. "-002") survives.
function truncateMiddle(str, maxWidthEm) {
  const chars = Array.from(str);
  if (textWidthEm(str) <= maxWidthEm) return str;
  let head = Math.ceil(chars.length / 2);
  let tail = chars.length - head;
  while (head + tail > 2) {
    if (head >= tail) head -= 1;
    else tail -= 1;
    const candidate = `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
    if (textWidthEm(candidate) <= maxWidthEm) return candidate;
  }
  return `${chars[0] || ''}…`;
}

// Largest font size in [minSize, maxSize] that fits; below that, middle-truncate at minSize.
function fitText(value, maxSize, minSize, maxWidth = TEXT_MAX_WIDTH) {
  const text = String(value || '').trim();
  const widthEm = textWidthEm(text);
  for (let size = maxSize; size >= minSize; size -= 1) {
    if (widthEm * size <= maxWidth) return { text, size };
  }
  return { text: truncateMiddle(text, maxWidth / minSize), size: minSize };
}

function splitTerminalId(id) {
  const parts = String(id || '').split('/');
  const term = parts.pop() || '';
  return { machine: parts.join('/'), term };
}

function shortAgentName(name) {
  return String(name || '')
    .replace(/\.exe$/i, '')
    .replace(/^claude-code$/i, 'claude');
}

function toDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function formatTabPane(session) {
  if (session.tabName && session.paneIndex) {
    const tabLabel = /^\d+$/.test(session.tabName)
      ? `Tab ${session.tabName}`
      : truncate(session.tabName, 7);
    return `${tabLabel} / P${session.paneIndex}`;
  }
  return session.where || session.id;
}

export function renderSessionIcon(session) {
  const styleKey = session.status === 'done' && session.seen ? 'seen' : session.status;
  const style = STATUS_STYLES[styleKey] || STATUS_STYLES.idle;
  const { machine, term } = splitTerminalId(session.id);

  // Line 1 (largest): space name — the thing that tells keys apart.
  const title = fitText(session.spaceName || session.where || session.id, 20, 13);

  // Line 2: what is running and its unique terminal id, e.g. "claude · t18".
  const agent = session.name && session.name !== session.id ? shortAgentName(session.name) : '';
  const identity = fitText([agent, term].filter(Boolean).join(' · '), 15, 11);

  // Line 3 (quiet): where it lives, e.g. "Tab 1 / P2 · mac-webdev".
  // The machine name is dropped (not mid-truncated) when it doesn't fit.
  const tabPane = formatTabPane(session);
  const withMachine = machine ? `${tabPane} · ${machine}` : tabPane;
  // Hangul/CJK smears below ~13px on the device screen, so it gets a larger floor.
  const hasCjk = /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿]/.test(tabPane);
  const [locMax, locMin] = hasCjk ? [14, 12] : [12, 11];
  const location = fits(withMachine, locMax) ? { text: withMachine, size: locMax } : fitText(tabPane, locMax, locMin);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="20" fill="${style.bg}"/>
  <rect x="4" y="4" width="136" height="136" rx="17" fill="none" stroke="${style.border}" stroke-width="${style.borderWidth ?? 5}"/>
  <rect x="14" y="12" width="116" height="24" rx="7" fill="${style.badgeBg}"/>
  <circle cx="26" cy="24" r="4.5" fill="${style.dot}"/>
  <text x="78" y="29" font-family="${FONT}" font-size="12.5" font-weight="800" fill="${style.badgeText}" text-anchor="middle">${style.label}</text>
  <text x="72" y="70" font-family="${FONT}" font-size="${title.size}" font-weight="700" fill="#F8FAFC" text-anchor="middle">${escapeXml(title.text)}</text>
  <text x="72" y="98" font-family="${FONT}" font-size="${identity.size}" font-weight="600" fill="#CBD5E1" text-anchor="middle">${escapeXml(identity.text)}</text>
  <text x="72" y="123" font-family="${FONT}" font-size="${location.size}" font-weight="600" fill="#93B4E0" text-anchor="middle">${escapeXml(location.text)}</text>
</svg>`;

  return toDataUrl(svg);
}

export function renderRecentSpaceIcon(item) {
  const spaceTitle = escapeXml(truncate(item.spaceName || item.name || 'Space', 13));
  const folderName = item.folder ? item.folder.split(/[\\/]/).filter(Boolean).pop() : '';
  const hasPanePos = Boolean(item.tabName && item.paneIndex);
  const middleText = escapeXml(
    truncate(
      hasPanePos ? formatTabPane(item) : item.agentName || folderName || 'Reopen',
      14
    )
  );
  const footerText = escapeXml(
    truncate(
      hasPanePos
        ? [item.agentName, folderName].filter(Boolean).join(' · ') || 'Press to Reopen'
        : folderName && item.agentName
          ? `${folderName} · Reopen`
          : 'Press to Reopen',
      19
    )
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="20" fill="#131124"/>
  <rect x="4" y="4" width="136" height="136" rx="17" fill="none" stroke="#6366F1" stroke-width="3.5" stroke-dasharray="8 5"/>
  <rect x="14" y="12" width="116" height="24" rx="7" fill="#4338CA"/>
  <circle cx="26" cy="24" r="4.5" fill="#A5B4FC"/>
  <text x="78" y="29" font-family="Segoe UI, Arial, sans-serif" font-size="12.5" font-weight="800" fill="#EEF2FF" text-anchor="middle">${item.kind === 'pane' ? 'CLOSED PANE' : 'RECENT'}</text>
  <text x="72" y="70" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" fill="#F8FAFC" text-anchor="middle">${spaceTitle}</text>
  <text x="72" y="97" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700" fill="#A5B4FC" text-anchor="middle">${middleText}</text>
  <text x="72" y="124" font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="#818CF8" text-anchor="middle">${footerText}</text>
</svg>`;

  return toDataUrl(svg);
}

export function renderEmptyIcon(slotNumber) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="20" fill="#0B1120"/>
  <rect x="4" y="4" width="136" height="136" rx="17" fill="none" stroke="#1E293B" stroke-width="3"/>
  <text x="72" y="64" font-family="Segoe UI, Arial, sans-serif" font-size="16" font-weight="700" fill="#475569" text-anchor="middle">SLOT ${slotNumber}</text>
  <text x="72" y="92" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="#334155" text-anchor="middle">New Tab</text>
</svg>`;

  return toDataUrl(svg);
}

export function renderOfflineIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="20" fill="#18181B"/>
  <rect x="4" y="4" width="136" height="136" rx="17" fill="none" stroke="#52525B" stroke-width="3"/>
  <text x="72" y="66" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" fill="#A1A1AA" text-anchor="middle">HERDR</text>
  <text x="72" y="92" font-family="Segoe UI, Arial, sans-serif" font-size="14" fill="#71717A" text-anchor="middle">Core Offline</text>
</svg>`;

  return toDataUrl(svg);
}
