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
  done: {
    label: 'DONE',
    bg: '#081C15',
    border: '#10B981',
    badgeBg: '#059669',
    badgeText: '#ECFDF5',
    dot: '#34D399',
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
  const style = STATUS_STYLES[session.status] || STATUS_STYLES.idle;
  const spaceTitle = escapeXml(truncate(session.spaceName || session.where || session.id, 13));
  const tabPaneText = escapeXml(truncate(formatTabPane(session), 13));
  const agentLabel = session.name && session.name !== session.id ? `${session.name} · ${session.id}` : session.id;
  const footer = escapeXml(truncate(agentLabel, 19));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="20" fill="${style.bg}"/>
  <rect x="4" y="4" width="136" height="136" rx="17" fill="none" stroke="${style.border}" stroke-width="5"/>
  <rect x="14" y="12" width="116" height="24" rx="7" fill="${style.badgeBg}"/>
  <circle cx="26" cy="24" r="4.5" fill="${style.dot}"/>
  <text x="78" y="29" font-family="Segoe UI, Arial, sans-serif" font-size="12.5" font-weight="800" fill="${style.badgeText}" text-anchor="middle">${style.label}</text>
  <text x="72" y="66" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" fill="#F8FAFC" text-anchor="middle">${spaceTitle}</text>
  <text x="72" y="97" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="800" fill="#93C5FD" text-anchor="middle">${tabPaneText}</text>
  <text x="72" y="125" font-family="Segoe UI, Arial, sans-serif" font-size="11.5" fill="#94A3B8" text-anchor="middle">${footer}</text>
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
