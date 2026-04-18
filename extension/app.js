/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
function buildDeferredItem(tab, uniqueId) {
  return {
    id:        uniqueId,
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  };
}

async function saveTabsForLater(tabs) {
  if (!tabs || tabs.length === 0) return;

  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const base = Date.now();
  tabs.forEach((tab, index) => {
    deferred.push(buildDeferredItem(tab, `${base}-${index}`));
  });
  await chrome.storage.local.set({ deferred });
}

async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push(buildDeferredItem(tab, Date.now().toString()));
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

async function archiveAllSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const completedAt = new Date().toISOString();
  let changed = false;

  deferred.forEach(tab => {
    if (!tab.dismissed && !tab.completed) {
      tab.completed = true;
      tab.completedAt = completedAt;
      changed = true;
    }
  });

  if (changed) {
    await chrome.storage.local.set({ deferred });
  }
}

async function openSavedGroupTabs(section, key, mode = 'background') {
  const { active, archived } = await getSavedTabs();
  const items = section === 'archive' ? archived : active;
  const groups = groupSavedItems(items, section);
  const group = groups.find(entry => entry.key === key);
  if (!group || group.items.length === 0) return 0;

  const urls = group.items.map(item => item.url).filter(Boolean);
  if (urls.length === 0) return 0;

  if (mode === 'new-window') {
    await chrome.windows.create({ url: urls });
    return urls.length;
  }

  const currentWindow = await chrome.windows.getCurrent();
  let shouldActivate = mode === 'current-window';
  for (const url of urls) {
    await chrome.tabs.create({
      windowId: currentWindow.id,
      url,
      active: shouldActivate,
    });
    shouldActivate = false;
  }

  return urls.length;
}

function closeOpenGroupMenus(exceptMenu = null) {
  document.querySelectorAll('.saved-group-action-menu.is-open').forEach(menu => {
    if (menu !== exceptMenu) {
      menu.classList.remove('is-open');
    }
  });
}

function toggleOpenGroupMenu(menuEl) {
  if (!menuEl) return;
  const willOpen = !menuEl.classList.contains('is-open');
  closeOpenGroupMenus(willOpen ? menuEl : null);
  menuEl.classList.toggle('is-open', willOpen);
}

function getOpenGroupModeToastKey(mode) {
  return mode === 'new-window'
    ? 'openedGroupTabsNewWindowToast'
    : mode === 'current-window'
      ? 'openedGroupTabsCurrentWindowToast'
      : 'openedGroupTabsBackgroundToast';
}

async function closeTabsByIds(tabIds) {
  const ids = (tabIds || []).filter(id => Number.isInteger(id));
  if (ids.length === 0) return;
  await chrome.tabs.remove(ids);
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

const STRINGS = {
  en: {
    pageTitle: 'Tab Out',
    greetingMorning: 'Good morning',
    greetingAfternoon: 'Good afternoon',
    greetingEvening: 'Good evening',
    openTabs: 'Open tabs',
    savedForLater: 'Saved for later',
    archive: 'Archive',
    archiveSearchPlaceholder: 'Search archived tabs...',
    emptyTitle: 'Inbox zero, but for tabs.',
    emptySubtitle: "You're free.",
    deferredEmpty: 'Nothing saved. Living in the moment.',
    closeExtras: 'Close extras',
    collapseAll: 'Collapse all',
    expandAll: 'Expand all',
    closeThisTab: 'Close this tab',
    saveForLater: 'Save for later',
    dismiss: 'Dismiss',
    homepages: 'Homepages',
    collapseTabs: 'Collapse tabs',
    expandTabs: 'Expand tabs',
    collapseGroup: 'Collapse group',
    expandGroup: 'Expand group',
    collapseAllGroups: 'Collapse all',
    expandAllGroups: 'Expand all',
    moveAllToSaved: 'Move all to saved',
    archiveAllSaved: 'Archive all',
    openGroupTabs: 'Open group tabs',
    openGroupTabsMenu: 'Choose how to open this group',
    openGroupTabsBackground: 'Open in background',
    openGroupTabsCurrentWindow: 'Open in current window',
    openGroupTabsNewWindow: 'Open in new window',
    rememberedOpenGroupMode: 'Use last open mode',
    deferredSearchPlaceholder: 'Search saved tabs...',
    clearSearch: 'Clear search',
    openedGroupTabsBackgroundToast: 'Opened this group in background tabs',
    openedGroupTabsCurrentWindowToast: 'Opened this group in the current window',
    openedGroupTabsNewWindowToast: 'Opened this group in a new window',
    movedAllToSavedToast: 'Moved all open tabs to Saved for later',
    archivedAllSavedToast: 'Archived all saved items',
    noResults: 'No results',
    languageSwitcher: 'Language switcher',
    otherItems: 'Other',
    localFilesLabel: 'Local Files',
    closedExtraTabOutTabs: 'Closed extra Tab Out tabs',
    tabClosed: 'Tab closed',
    failedSave: 'Failed to save tab',
    savedForLaterToast: 'Saved for later',
    closedDuplicatesToast: 'Closed duplicates, kept one copy each',
    allTabsClosed: 'All tabs closed. Fresh start.',
    justNow: 'just now',
    yesterday: 'yesterday',
  },
  'zh-CN': {
    pageTitle: 'Tab Out',
    greetingMorning: '早上好',
    greetingAfternoon: '下午好',
    greetingEvening: '晚上好',
    openTabs: '当前标签',
    savedForLater: '稍后处理',
    archive: '归档',
    archiveSearchPlaceholder: '搜索已归档标签...',
    emptyTitle: '标签页也清零了。',
    emptySubtitle: '现在轻松了。',
    deferredEmpty: '还没有保存内容，继续保持清爽。',
    closeExtras: '关闭多余标签',
    collapseAll: '全部折叠',
    expandAll: '全部展开',
    closeThisTab: '关闭这个标签',
    saveForLater: '保存到稍后处理',
    dismiss: '移除',
    homepages: '首页',
    collapseTabs: '折叠标签',
    expandTabs: '展开标签',
    collapseGroup: '折叠分组',
    expandGroup: '展开分组',
    collapseAllGroups: '全部收起',
    expandAllGroups: '全部展开',
    moveAllToSaved: '全部移到稍后处理',
    archiveAllSaved: '全部归档',
    openGroupTabs: '打开整组标签',
    openGroupTabsMenu: '选择整组打开方式',
    openGroupTabsBackground: '后台静默打开',
    openGroupTabsCurrentWindow: '当前窗口打开',
    openGroupTabsNewWindow: '新窗口打开',
    rememberedOpenGroupMode: '使用上一次打开方式',
    deferredSearchPlaceholder: '搜索稍后处理标签...',
    clearSearch: '清空搜索',
    openedGroupTabsBackgroundToast: '已在后台静默打开这个分组',
    openedGroupTabsCurrentWindowToast: '已在当前窗口打开这个分组',
    openedGroupTabsNewWindowToast: '已在新窗口打开这个分组',
    movedAllToSavedToast: '已将当前全部标签移到稍后处理',
    archivedAllSavedToast: '已将稍后处理全部归档',
    noResults: '没有结果',
    languageSwitcher: '语言切换',
    otherItems: '其他',
    localFilesLabel: '本地文件',
    closedExtraTabOutTabs: '已关闭多余的 Tab Out 标签页',
    tabClosed: '标签已关闭',
    failedSave: '保存失败',
    savedForLaterToast: '已保存到稍后处理',
    closedDuplicatesToast: '已关闭重复标签，并保留一个',
    allTabsClosed: '已关闭全部标签页，重新开始吧。',
    justNow: '刚刚',
    yesterday: '昨天',
  },
};

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">${t('emptyTitle')}</div>
      <div class="empty-subtitle">${t('emptySubtitle')}</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = formatDomainCount(0);
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1) return t('justNow');
  if (currentLanguage === 'zh-CN') {
    if (diffMins < 60) return `${diffMins} 分钟前`;
    if (diffHours < 24) return `${diffHours} 小时前`;
    if (diffDays === 1) return t('yesterday');
    return `${diffDays} 天前`;
  }

  if (diffMins < 60)  return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hr${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays === 1) return t('yesterday');
  return `${diffDays} days ago`;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMatches(text, query) {
  const safeText = escapeHtml(text);
  const q = (query || '').trim();
  if (q.length < 2) return safeText;

  const pattern = new RegExp(`(${escapeRegExp(q)})`, 'ig');
  return safeText.replace(pattern, '<mark class="search-highlight">$1</mark>');
}

function updateSearchClearButton(inputId) {
  const input = document.getElementById(inputId);
  const clearBtn = document.querySelector(`[data-target-input="${inputId}"]`);
  if (!input || !clearBtn) return;
  clearBtn.style.display = input.value ? 'inline-flex' : 'none';
}

function getSearchQuery(inputId) {
  const input = document.getElementById(inputId);
  return input ? input.value : '';
}

function scrollFirstHighlightIntoView(container, query) {
  const q = (query || '').trim();
  if (!container || q.length < 2) return;

  requestAnimationFrame(() => {
    const first = container.querySelector('.search-highlight');
    if (first) {
      first.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  });
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return t('greetingMorning');
  if (hour < 17) return t('greetingAfternoon');
  return t('greetingEvening');
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString(currentLanguage === 'zh-CN' ? 'zh-CN' : 'en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

function t(key) {
  return (STRINGS[currentLanguage] && STRINGS[currentLanguage][key]) || STRINGS.en[key] || key;
}

function formatCount(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTabCount(count) {
  return currentLanguage === 'zh-CN'
    ? `${count} 个标签页`
    : formatCount(count, 'tab', 'tabs');
}

function formatTabsOpen(count) {
  return currentLanguage === 'zh-CN'
    ? `${count} 个标签页`
    : `${formatTabCount(count)} open`;
}

function formatDomainCount(count) {
  return currentLanguage === 'zh-CN'
    ? `${count} 个分组`
    : formatCount(count, 'domain', 'domains');
}

function formatItemCount(count) {
  return currentLanguage === 'zh-CN'
    ? `${count} 项`
    : formatCount(count, 'item', 'items');
}

function formatDuplicateCount(count) {
  return currentLanguage === 'zh-CN'
    ? `${count} 个重复项`
    : formatCount(count, 'duplicate', 'duplicates');
}

function formatMoreCount(count) {
  return currentLanguage === 'zh-CN' ? `+${count} 更多` : `+${count} more`;
}

function formatCloseAllTabs(count) {
  return currentLanguage === 'zh-CN'
    ? `关闭全部 ${formatTabCount(count)}`
    : `Close all ${formatTabCount(count)}`;
}

function formatCloseDuplicates(count) {
  return currentLanguage === 'zh-CN'
    ? `关闭 ${formatDuplicateCount(count)}`
    : `Close ${formatDuplicateCount(count)}`;
}

function formatClosedTabsFromGroup(count, groupLabel) {
  return currentLanguage === 'zh-CN'
    ? `已从 ${groupLabel} 关闭 ${formatTabCount(count)}`
    : `Closed ${formatTabCount(count)} from ${groupLabel}`;
}

function setTabOutDupeBannerText(count) {
  const textEl = document.getElementById('tabOutDupeText');
  if (!textEl) return;

  if (currentLanguage === 'zh-CN') {
    textEl.innerHTML = `你打开了 <strong id="tabOutDupeCount">${count}</strong> 个 Tab Out 标签页。只保留当前这个吗？`;
  } else {
    textEl.innerHTML = `You have <strong id="tabOutDupeCount">${count}</strong> Tab Out tabs open. Keep just this one?`;
  }
}

function loadLanguagePreference() {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') return stored;
  } catch {}

  return navigator.language && navigator.language.toLowerCase().startsWith('zh')
    ? 'zh-CN'
    : 'en';
}

function saveLanguagePreference() {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, currentLanguage);
  } catch {
    // Ignore storage failures so the dashboard still works.
  }
}

function updateLanguageControls() {
  document.querySelectorAll('.lang-btn[data-lang]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === currentLanguage);
  });
}

function applyStaticTranslations() {
  document.title = t('pageTitle');
  document.documentElement.lang = currentLanguage === 'zh-CN' ? 'zh-CN' : 'en';

  const deferredSectionTitle = document.getElementById('deferredSectionTitle');
  if (deferredSectionTitle) deferredSectionTitle.textContent = t('savedForLater');

  const deferredEmpty = document.getElementById('deferredEmpty');
  if (deferredEmpty) deferredEmpty.textContent = t('deferredEmpty');

  const archiveToggleLabel = document.getElementById('archiveToggleLabel');
  if (archiveToggleLabel) archiveToggleLabel.textContent = t('archive');

  const archiveSearch = document.getElementById('archiveSearch');
  if (archiveSearch) archiveSearch.placeholder = t('archiveSearchPlaceholder');

  const deferredSearch = document.getElementById('deferredSearch');
  if (deferredSearch) deferredSearch.placeholder = t('deferredSearchPlaceholder');

  document.querySelectorAll('.search-clear-btn').forEach(btn => {
    btn.setAttribute('aria-label', t('clearSearch'));
    btn.setAttribute('title', t('clearSearch'));
  });

  updateSearchClearButton('deferredSearch');
  updateSearchClearButton('archiveSearch');

  const languageSwitch = document.querySelector('.language-switch');
  if (languageSwitch) languageSwitch.setAttribute('aria-label', t('languageSwitcher'));

  const statTabsLabel = document.getElementById('statTabsLabel');
  if (statTabsLabel) statTabsLabel.textContent = t('openTabs');

  const collapseAllBtn = document.getElementById('collapseAllBtn');
  if (collapseAllBtn) collapseAllBtn.textContent = t('collapseAll');

  const expandAllBtn = document.getElementById('expandAllBtn');
  if (expandAllBtn) expandAllBtn.textContent = t('expandAll');

  const tabOutDupeCloseBtn = document.getElementById('tabOutDupeCloseBtn');
  if (tabOutDupeCloseBtn) tabOutDupeCloseBtn.textContent = t('closeExtras');

  const currentDupeCount = document.getElementById('tabOutDupeCount');
  setTabOutDupeBannerText(currentDupeCount ? currentDupeCount.textContent : 0);

  updateLanguageControls();
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  bookmark:`<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>`,
  folderClosed: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.85" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 7.5A2.25 2.25 0 0 1 6 5.25h3.044c.43 0 .845.154 1.17.434l1.373 1.182c.325.28.739.434 1.17.434H18A2.25 2.25 0 0 1 20.25 9.75v6A2.25 2.25 0 0 1 18 18H6a2.25 2.25 0 0 1-2.25-2.25V7.5Z" /></svg>`,
  folderOpen: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.85" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 9.75A2.25 2.25 0 0 1 4.5 7.5h4.028c.403 0 .792-.146 1.096-.41l1.6-1.39a1.686 1.686 0 0 1 1.096-.41H19.5a2.25 2.25 0 0 1 2.2 2.72l-1.134 5.107A2.25 2.25 0 0 1 18.37 15H5.63a2.25 2.25 0 0 1-2.197-1.883L2.25 9.75Z" /></svg>`,
  openBackground: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.9" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 7.5A2.25 2.25 0 0 1 6.75 5.25h7.5A2.25 2.25 0 0 1 16.5 7.5v7.5a2.25 2.25 0 0 1-2.25 2.25h-7.5A2.25 2.25 0 0 1 4.5 15V7.5Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M9 9h10.5m-3-3 3 3-3 3" /></svg>`,
  openCurrent: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.9" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h12A2.25 2.25 0 0 1 20.25 6.75v10.5A2.25 2.25 0 0 1 18 19.5H6a2.25 2.25 0 0 1-2.25-2.25V6.75Z" /><path stroke-linecap="round" stroke-linejoin="round" d="m10.5 9 3 3-3 3" /></svg>`,
  openNewWindow: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.9" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 6h6.75A2.25 2.25 0 0 1 15.75 8.25V15A2.25 2.25 0 0 1 13.5 17.25H6.75A2.25 2.25 0 0 1 4.5 15V8.25A2.25 2.25 0 0 1 6.75 6Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6h3.75A2.25 2.25 0 0 1 19.5 8.25V12" /><path stroke-linecap="round" stroke-linejoin="round" d="m14.25 9.75 5.25-5.25M16.5 4.5h3v3" /></svg>`,
  expandAllIcon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m7 14 5-5 5 5" /><path stroke-linecap="round" stroke-linejoin="round" d="m7 20 5-5 5 5" /></svg>`,
  collapseAllIcon: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m7 10 5 5 5-5" /><path stroke-linecap="round" stroke-linejoin="round" d="m7 4 5 5 5-5" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
  chevron: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];
const COLLAPSED_DOMAINS_STORAGE_KEY = 'tabout-collapsed-domains';
const COLLAPSED_SAVED_GROUPS_STORAGE_KEY = 'tabout-collapsed-saved-groups';
const LANGUAGE_STORAGE_KEY = 'tabout-language';
const OPEN_GROUP_MODE_STORAGE_KEY = 'tabout-open-group-mode';
const collapsedDomainIds = loadCollapsedDomainIds();
const collapsedSavedGroupIds = loadCollapsedSavedGroupIds();
let currentLanguage = loadLanguagePreference();
let lastOpenGroupMode = loadOpenGroupModePreference();

function loadCollapsedDomainIds() {
  try {
    const raw = localStorage.getItem(COLLAPSED_DOMAINS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function loadCollapsedSavedGroupIds() {
  try {
    const raw = localStorage.getItem(COLLAPSED_SAVED_GROUPS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function normalizeOpenGroupMode(mode) {
  return ['background', 'current-window', 'new-window'].includes(mode)
    ? mode
    : 'background';
}

function loadOpenGroupModePreference() {
  try {
    return normalizeOpenGroupMode(localStorage.getItem(OPEN_GROUP_MODE_STORAGE_KEY));
  } catch {
    return 'background';
  }
}

function saveCollapsedDomainIds() {
  try {
    localStorage.setItem(
      COLLAPSED_DOMAINS_STORAGE_KEY,
      JSON.stringify(Array.from(collapsedDomainIds))
    );
  } catch {
    // Ignore storage failures so the dashboard still works.
  }
}

function saveCollapsedSavedGroupIds() {
  try {
    localStorage.setItem(
      COLLAPSED_SAVED_GROUPS_STORAGE_KEY,
      JSON.stringify(Array.from(collapsedSavedGroupIds))
    );
  } catch {
    // Ignore storage failures so the dashboard still works.
  }
}

function saveOpenGroupModePreference(mode) {
  lastOpenGroupMode = normalizeOpenGroupMode(mode);
  try {
    localStorage.setItem(OPEN_GROUP_MODE_STORAGE_KEY, lastOpenGroupMode);
  } catch {
    // Ignore storage failures so the dashboard still works.
  }
}

function toggleCollapsedDomain(domainId) {
  if (collapsedDomainIds.has(domainId)) {
    collapsedDomainIds.delete(domainId);
    saveCollapsedDomainIds();
    return false;
  }

  collapsedDomainIds.add(domainId);
  saveCollapsedDomainIds();
  return true;
}

function applyCardCollapseState(card, collapsed) {
  if (!card) return;
  card.classList.toggle('is-collapsed', collapsed);

  const toggleBtn = card.querySelector('[data-action="toggle-card-collapse"]');
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggleBtn.setAttribute('aria-label', collapsed ? t('expandTabs') : t('collapseTabs'));
    toggleBtn.setAttribute('title', collapsed ? t('expandTabs') : t('collapseTabs'));
  }
}

function setAllCardsCollapsed(collapsed) {
  const cards = document.querySelectorAll('#openTabsMissions .mission-card[data-domain-id]');
  cards.forEach(card => {
    const domainId = card.dataset.domainId;
    if (!domainId) return;

    if (collapsed) {
      collapsedDomainIds.add(domainId);
    } else {
      collapsedDomainIds.delete(domainId);
    }

    applyCardCollapseState(card, collapsed);
  });

  saveCollapsedDomainIds();
}

function setLanguage(language) {
  if (language !== 'zh-CN' && language !== 'en') return;
  if (language === currentLanguage) return;

  currentLanguage = language;
  saveLanguagePreference();
  renderDashboard();
}

function setAllSavedGroupsCollapsed(section, collapsed) {
  const groups = document.querySelectorAll(`.saved-group[data-group-section="${section}"]`);
  groups.forEach(groupEl => {
    const key = groupEl.dataset.groupKey;
    if (!key) return;

    const storageId = getSavedGroupStorageId(section, key);
    if (collapsed) {
      collapsedSavedGroupIds.add(storageId);
    } else {
      collapsedSavedGroupIds.delete(storageId);
    }

    applySavedGroupCollapseState(groupEl, collapsed);
  });

  saveCollapsedSavedGroupIds();
}

function getSavedGroupStorageId(section, key) {
  return `${section}:${key}`;
}

function toggleSavedGroupCollapsed(section, key) {
  const storageId = getSavedGroupStorageId(section, key);
  if (collapsedSavedGroupIds.has(storageId)) {
    collapsedSavedGroupIds.delete(storageId);
    saveCollapsedSavedGroupIds();
    return false;
  }

  collapsedSavedGroupIds.add(storageId);
  saveCollapsedSavedGroupIds();
  return true;
}

function isSavedGroupCollapsed(section, key) {
  return collapsedSavedGroupIds.has(getSavedGroupStorageId(section, key));
}

function applySavedGroupCollapseState(groupEl, collapsed) {
  if (!groupEl) return;
  groupEl.classList.toggle('is-collapsed', collapsed);

  const toggleBtn = groupEl.querySelector('[data-action="toggle-saved-group"]');
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggleBtn.setAttribute('aria-label', collapsed ? t('expandGroup') : t('collapseGroup'));
    toggleBtn.setAttribute('title', collapsed ? t('expandGroup') : t('collapseGroup'));
  }

  const body = groupEl.querySelector('.saved-group-body');
  if (!body) return;

  const finishExpand = () => {
    if (!groupEl.classList.contains('is-collapsed')) {
      body.style.maxHeight = 'none';
    }
  };

  if (collapsed) {
    const currentHeight = body.scrollHeight;
    body.style.maxHeight = `${currentHeight}px`;
    body.style.opacity = '1';
    body.style.transform = 'translateY(0) scaleY(1)';
    requestAnimationFrame(() => {
      body.style.maxHeight = '0px';
      body.style.opacity = '0';
      body.style.transform = 'translateY(-8px) scaleY(0.96)';
    });
  } else {
    body.style.maxHeight = '0px';
    body.style.opacity = '0';
    body.style.transform = 'translateY(-10px) scaleY(0.94)';
    requestAnimationFrame(() => {
      body.style.maxHeight = `${body.scrollHeight}px`;
      body.style.opacity = '1';
      body.style.transform = 'translateY(0) scaleY(1)';
    });
    body.addEventListener('transitionend', finishExpand, { once: true });
  }
}

function getSavedItemGroup(item, section = 'active') {
  const savedGroupRules = [
    ...(typeof LOCAL_SAVED_GROUP_RULES !== 'undefined' ? LOCAL_SAVED_GROUP_RULES : []),
    ...(section === 'active' && typeof LOCAL_DEFERRED_GROUP_RULES !== 'undefined' ? LOCAL_DEFERRED_GROUP_RULES : []),
    ...(section === 'archive' && typeof LOCAL_ARCHIVE_GROUP_RULES !== 'undefined' ? LOCAL_ARCHIVE_GROUP_RULES : []),
  ];

  function matchSavedCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return savedGroupRules.find(rule => {
        if (rule.sections && Array.isArray(rule.sections) && !rule.sections.includes(section)) {
          return false;
        }

        const hostnameMatch = rule.hostname
          ? parsed.hostname === rule.hostname
          : rule.hostnameEndsWith
            ? parsed.hostname.endsWith(rule.hostnameEndsWith)
            : true;

        if (!hostnameMatch) return false;
        if (rule.test) return rule.test(parsed.pathname, url);
        if (rule.pathPrefix) return parsed.pathname.startsWith(rule.pathPrefix);
        if (rule.pathExact) {
          return Array.isArray(rule.pathExact)
            ? rule.pathExact.includes(parsed.pathname)
            : parsed.pathname === rule.pathExact;
        }
        return true;
      }) || null;
    } catch {
      return null;
    }
  }

  const customRule = item.url ? matchSavedCustomGroup(item.url) : null;
  if (customRule) {
    return {
      key: `custom:${customRule.groupKey || customRule.groupLabel || 'custom'}`,
      label: customRule.groupLabel || customRule.groupKey || t('otherItems'),
    };
  }

  let key = 'other';

  try {
    if (item.url && item.url.startsWith('file://')) {
      key = 'local-files';
    } else {
      const parsed = new URL(item.url);
      key = parsed.hostname ? parsed.hostname.replace(/^www\./, '') : 'other';
    }
  } catch {
    key = 'other';
  }

  let label;
  if (key === 'other') {
    label = t('otherItems');
  } else if (key === 'local-files') {
    label = t('localFilesLabel');
  } else {
    label = friendlyDomain(key);
  }

  return { key, label };
}

function groupSavedItems(items, section = 'active') {
  const map = {};

  for (const item of items) {
    const group = getSavedItemGroup(item, section);
    if (!map[group.key]) {
      map[group.key] = {
        key: group.key,
        label: group.label,
        items: [],
      };
    }
    map[group.key].items.push(item);
  }

  const locale = currentLanguage === 'zh-CN' ? 'zh-CN' : 'en-US';
  return Object.values(map).sort((a, b) => {
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    return a.label.localeCompare(b.label, locale);
  });
}

function renderSavedGroup(group, section) {
  const isCollapsed = isSavedGroupCollapsed(section, group.key);
  const safeKey = group.key.replace(/"/g, '&quot;');
  const safeLabel = (group.label || '').replace(/"/g, '&quot;');
  const query = getSearchQuery(section === 'active' ? 'deferredSearch' : 'archiveSearch');
  const labelHtml = highlightMatches(group.label || '', query);
  const itemsHtml = section === 'active'
    ? group.items.map(item => renderDeferredItem(item)).join('')
    : group.items.map(item => renderArchiveItem(item)).join('');
  const groupActions = [];

  if (section === 'active' && group.items.length > 0) {
    groupActions.push(`
      <div class="saved-group-action-menu">
        <button
          class="saved-group-action"
          data-action="open-saved-group-tabs-default"
          data-group-section="${section}"
          data-group-key="${safeKey}"
          aria-label="${t('rememberedOpenGroupMode')}"
          title="${t('rememberedOpenGroupMode')}"
        >
          ${ICONS.focus}
        </button>
        <div class="saved-group-menu-popover">
          <button
            class="saved-group-menu-item"
            data-action="open-saved-group-tabs"
            data-group-section="${section}"
            data-group-key="${safeKey}"
            data-open-mode="background"
          >
            <span class="saved-group-menu-item-icon">${ICONS.openBackground}</span>
            <span>${t('openGroupTabsBackground')}</span>
          </button>
          <button
            class="saved-group-menu-item"
            data-action="open-saved-group-tabs"
            data-group-section="${section}"
            data-group-key="${safeKey}"
            data-open-mode="current-window"
          >
            <span class="saved-group-menu-item-icon">${ICONS.openCurrent}</span>
            <span>${t('openGroupTabsCurrentWindow')}</span>
          </button>
          <button
            class="saved-group-menu-item"
            data-action="open-saved-group-tabs"
            data-group-section="${section}"
            data-group-key="${safeKey}"
            data-open-mode="new-window"
          >
            <span class="saved-group-menu-item-icon">${ICONS.openNewWindow}</span>
            <span>${t('openGroupTabsNewWindow')}</span>
          </button>
        </div>
      </div>`);
  }

  return `
    <div
      class="saved-group saved-group-${section}${isCollapsed ? ' is-collapsed' : ''}"
      data-saved-group-id="${getSavedGroupStorageId(section, group.key)}"
      data-group-section="${section}"
      data-group-key="${safeKey}"
    >
      <div class="saved-group-header">
        <button
          class="saved-group-toggle"
          data-action="toggle-saved-group"
          data-group-section="${section}"
          data-group-key="${safeKey}"
          aria-label="${isCollapsed ? t('expandGroup') : t('collapseGroup')}"
          aria-expanded="${isCollapsed ? 'false' : 'true'}"
          title="${isCollapsed ? t('expandGroup') : t('collapseGroup')}"
        >
          <svg class="saved-group-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.1" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" /></svg>
          <span class="saved-group-folder-stack">
            <span class="saved-group-folder saved-group-folder-closed">${ICONS.folderClosed}</span>
            <span class="saved-group-folder saved-group-folder-open">${ICONS.folderOpen}</span>
          </span>
          <span class="saved-group-label" title="${safeLabel}">${labelHtml}</span>
          <span class="saved-group-count">${group.items.length}</span>
        </button>
        <div class="saved-group-actions">${groupActions.join('')}</div>
      </div>
      <div class="saved-group-body">${itemsHtml}</div>
    </div>`;
}

function renderSavedGroupControls(section, groupCount, itemCount = 0) {
  const actions = [];

  if (section === 'active' && itemCount > 0) {
    actions.push(`
      <button class="mini-icon-btn" data-action="archive-all-saved" title="${t('archiveAllSaved')}" aria-label="${t('archiveAllSaved')}">
        ${ICONS.archive}
      </button>`);
  }

  if (groupCount > 1) {
    actions.push(`
      <button class="mini-icon-btn" data-action="collapse-all-saved-groups" data-group-section="${section}" title="${t('collapseAllGroups')}" aria-label="${t('collapseAllGroups')}">
        ${ICONS.collapseAllIcon}
      </button>`);
    actions.push(`
      <button class="mini-icon-btn" data-action="expand-all-saved-groups" data-group-section="${section}" title="${t('expandAllGroups')}" aria-label="${t('expandAllGroups')}">
        ${ICONS.expandAllIcon}
      </button>`);
  }

  return actions.join('');
}

function renderSavedGroupList(container, items, section) {
  if (!container) return;
  const groups = groupSavedItems(items, section);
  return renderSavedGroups(container, groups, section);
}

function renderSavedGroups(container, groups, section) {
  if (!container) return 0;
  container.innerHTML = groups.map(group => renderSavedGroup(group, section)).join('');
  container.querySelectorAll('.saved-group').forEach(groupEl => {
    const body = groupEl.querySelector('.saved-group-body');
    if (!body) return;
    if (groupEl.classList.contains('is-collapsed')) {
      body.style.maxHeight = '0px';
      body.style.opacity = '0';
      body.style.transform = 'translateY(-8px) scaleY(0.96)';
    } else {
      body.style.maxHeight = 'none';
      body.style.opacity = '1';
      body.style.transform = 'translateY(0) scaleY(1)';
    }
  });
  return groups.length;
}

function filterSavedItemsByQuery(items, query) {
  const q = (query || '').trim().toLowerCase();
  if (q.length < 2) return items;

  return items.filter(item =>
    (item.title || '').toLowerCase().includes(q) ||
    (item.url || '').toLowerCase().includes(q)
  );
}

function getFilteredSavedGroups(items, section, query) {
  const q = (query || '').trim().toLowerCase();
  const groups = groupSavedItems(items, section);
  if (q.length < 2) return groups;

  return groups
    .map(group => {
      const labelMatches = (group.label || '').toLowerCase().includes(q);
      if (labelMatches) return group;

      const filteredItems = group.items.filter(item =>
        (item.title || '').toLowerCase().includes(q) ||
        (item.url || '').toLowerCase().includes(q)
      );

      return filteredItems.length > 0
        ? { ...group, items: filteredItems }
        : null;
    })
    .filter(Boolean);
}


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    setTabOutDupeBannerText(tabOutTabs.length);
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${t('saveForLater')}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="${t('closeThisTab')}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">${formatMoreCount(hiddenTabs.length)}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');
  const isCollapsed = collapsedDomainIds.has(stableId);

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${formatTabsOpen(tabCount)}
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge dupe-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${formatDuplicateCount(totalExtras)}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${t('saveForLater')}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="${t('closeThisTab')}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      ${formatCloseAllTabs(tabCount)}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        ${formatCloseDuplicates(totalExtras)}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}${isCollapsed ? ' is-collapsed' : ''}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <div class="mission-title-row">
            <button
              class="mission-collapse-toggle"
              data-action="toggle-card-collapse"
              data-domain-id="${stableId}"
              aria-label="${isCollapsed ? t('expandTabs') : t('collapseTabs')}"
              aria-expanded="${isCollapsed ? 'false' : 'true'}"
              title="${isCollapsed ? t('expandTabs') : t('collapseTabs')}"
            >
              ${ICONS.chevron}
            </button>
            <span class="mission-name">${isLanding ? t('homepages') : (group.label || friendlyDomain(group.domain))}</span>
          </div>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">${t('openTabs')}</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const deferredSearch = document.getElementById('deferredSearch');
  const controlsEl     = document.getElementById('deferredGroupControls');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');
  const archiveControlsEl = document.getElementById('archiveGroupControls');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = formatItemCount(active.length);
      if (deferredSearch) deferredSearch.style.display = 'block';

      const deferredQuery = deferredSearch ? deferredSearch.value : '';
      const filteredGroups = getFilteredSavedGroups(active, 'active', deferredQuery);
      const filteredCount = filteredGroups.reduce((sum, group) => sum + group.items.length, 0);
      if (filteredGroups.length > 0) {
        const groupCount = renderSavedGroups(list, filteredGroups, 'active');
        if (controlsEl) controlsEl.innerHTML = renderSavedGroupControls('active', groupCount, filteredCount);
        list.style.display = 'block';
        empty.style.display = 'none';
      } else {
        if (controlsEl) controlsEl.innerHTML = '';
        list.style.display = 'block';
        list.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:8px 0">${t('noResults')}</div>`;
        empty.style.display = 'none';
      }
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      if (deferredSearch) {
        deferredSearch.style.display = 'none';
        deferredSearch.value = '';
      }
      if (controlsEl) controlsEl.innerHTML = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      const archiveGroupCount = renderSavedGroupList(archiveList, archived, 'archive');
      if (archiveControlsEl) archiveControlsEl.innerHTML = renderSavedGroupControls('archive', archiveGroupCount, archived.length);
      archiveEl.style.display = 'block';
    } else {
      if (archiveControlsEl) archiveControlsEl.innerHTML = '';
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);
  const query = getSearchQuery('deferredSearch');
  const safeTitleAttr = escapeHtml(item.title || '');
  const safeUrl = escapeHtml(item.url || '');
  const titleHtml = highlightMatches(item.title || item.url, query);
  const domainHtml = highlightMatches(domain, query);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${safeUrl}" target="_blank" rel="noopener" class="deferred-title" title="${safeTitleAttr}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${titleHtml}
        </a>
        <div class="deferred-meta">
          <span>${domainHtml}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="${t('dismiss')}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  const query = getSearchQuery('archiveSearch');
  const safeTitleAttr = escapeHtml(item.title || '');
  const safeUrl = escapeHtml(item.url || '');
  const titleHtml = highlightMatches(item.title || item.url, query);
  return `
    <div class="archive-item">
      <a href="${safeUrl}" target="_blank" rel="noopener" class="archive-item-title" title="${safeTitleAttr}">
        ${titleHtml}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  applyStaticTranslations();

  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = t('openTabs');
    openTabsSectionCount.innerHTML = `
      <span>${formatDomainCount(domainGroups.length)}</span>
      <span class="section-inline-actions">
        <button class="action-btn save-tabs" data-action="defer-all-open-tabs" style="font-size:11px;padding:3px 10px;">
          ${ICONS.bookmark} ${t('moveAllToSaved')}
        </button>
        <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">
          ${ICONS.close} ${formatCloseAllTabs(realTabs.length)}
        </button>
      </span>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) {
    closeOpenGroupMenus();
    return;
  }

  const action = actionEl.dataset.action;
  if (action !== 'open-saved-group-tabs') {
    closeOpenGroupMenus();
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast(t('closedExtraTabOutTabs'));
    return;
  }

  if (action === 'set-language') {
    e.stopPropagation();
    setLanguage(actionEl.dataset.lang);
    return;
  }

  if (action === 'collapse-all-cards') {
    setAllCardsCollapsed(true);
    return;
  }

  if (action === 'expand-all-cards') {
    setAllCardsCollapsed(false);
    return;
  }

  if (action === 'defer-all-open-tabs') {
    const realTabs = getRealTabs();
    if (realTabs.length === 0) return;

    try {
      await saveTabsForLater(realTabs.map(tab => ({ url: tab.url, title: tab.title })));
    } catch (err) {
      console.error('[tab-out] Failed to save all tabs:', err);
      showToast(t('failedSave'));
      return;
    }

    await closeTabsByIds(realTabs.map(tab => tab.id));
    await fetchOpenTabs();
    await renderDashboard();
    playCloseSound();
    showToast(t('movedAllToSavedToast'));
    return;
  }

  if (action === 'collapse-all-saved-groups') {
    e.stopPropagation();
    const section = actionEl.dataset.groupSection;
    if (!section) return;
    setAllSavedGroupsCollapsed(section, true);
    return;
  }

  if (action === 'expand-all-saved-groups') {
    e.stopPropagation();
    const section = actionEl.dataset.groupSection;
    if (!section) return;
    setAllSavedGroupsCollapsed(section, false);
    return;
  }

  if (action === 'archive-all-saved') {
    e.stopPropagation();
    await archiveAllSavedTabs();
    await renderDeferredColumn();
    showToast(t('archivedAllSavedToast'));
    return;
  }

  if (action === 'clear-search') {
    e.stopPropagation();
    const inputId = actionEl.dataset.targetInput;
    const input = inputId ? document.getElementById(inputId) : null;
    if (!input) return;

    input.value = '';
    updateSearchClearButton(inputId);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return;
  }

  if (action === 'open-saved-group-tabs') {
    e.stopPropagation();
    const section = actionEl.dataset.groupSection;
    const key = actionEl.dataset.groupKey;
    const mode = actionEl.dataset.openMode || 'background';
    if (!section || !key) return;

    const openedCount = await openSavedGroupTabs(section, key, mode);
    saveOpenGroupModePreference(mode);
    closeOpenGroupMenus();
    if (openedCount > 0) {
      await fetchOpenTabs();
      showToast(t(getOpenGroupModeToastKey(mode)));
    }
    return;
  }

  if (action === 'open-saved-group-tabs-default') {
    e.stopPropagation();
    const section = actionEl.dataset.groupSection;
    const key = actionEl.dataset.groupKey;
    if (!section || !key) return;

    const openedCount = await openSavedGroupTabs(section, key, lastOpenGroupMode);
    closeOpenGroupMenus();
    if (openedCount > 0) {
      await fetchOpenTabs();
      showToast(t(getOpenGroupModeToastKey(lastOpenGroupMode)));
    }
    return;
  }

  if (action === 'toggle-saved-group') {
    e.stopPropagation();
    const section = actionEl.dataset.groupSection;
    const key = actionEl.dataset.groupKey;
    if (!section || !key) return;

    const isCollapsed = toggleSavedGroupCollapsed(section, key);
    const groupEl = actionEl.closest('.saved-group');
    applySavedGroupCollapseState(groupEl, isCollapsed);
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Collapse or expand a domain card ----
  if (action === 'toggle-card-collapse') {
    e.stopPropagation();
    const domainId = actionEl.dataset.domainId;
    if (!domainId || !card) return;

    const isCollapsed = toggleCollapsedDomain(domainId);
    applyCardCollapseState(card, isCollapsed);
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast(t('tabClosed'));
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast(t('failedSave'));
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast(t('savedForLaterToast'));
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? t('homepages') : (group.label || friendlyDomain(group.domain));
    showToast(formatClosedTabsFromGroup(urls.length, groupLabel));

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.dupe-badge').forEach(badge => {
        badge.style.transition = 'opacity 0.2s';
        badge.style.opacity    = '0';
        setTimeout(() => badge.remove(), 200);
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast(t('closedDuplicatesToast'));
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast(t('allTabsClosed'));
    return;
  }
});

document.addEventListener('contextmenu', (e) => {
  const actionButton = e.target.closest('.saved-group-action[data-action="open-saved-group-tabs-default"]');
  if (!actionButton) return;

  e.preventDefault();
  e.stopPropagation();
  toggleOpenGroupMenu(actionButton.closest('.saved-group-action-menu'));
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id === 'deferredSearch') {
    updateSearchClearButton('deferredSearch');
    const list = document.getElementById('deferredList');
    const controlsEl = document.getElementById('deferredGroupControls');
    if (!list) return;

    try {
      const { active } = await getSavedTabs();
      const filteredGroups = getFilteredSavedGroups(active, 'active', e.target.value);
      const filteredCount = filteredGroups.reduce((sum, group) => sum + group.items.length, 0);

      if (filteredGroups.length > 0) {
        const groupCount = renderSavedGroups(list, filteredGroups, 'active');
        if (controlsEl) controlsEl.innerHTML = renderSavedGroupControls('active', groupCount, filteredCount);
      } else {
        if (controlsEl) controlsEl.innerHTML = '';
        list.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:8px 0">${t('noResults')}</div>`;
      }
    } catch (err) {
      console.warn('[tab-out] Deferred search failed:', err);
    }
    return;
  }

  if (e.target.id !== 'archiveSearch') return;

  updateSearchClearButton('archiveSearch');
  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  const archiveControlsEl = document.getElementById('archiveGroupControls');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      const archiveGroupCount = renderSavedGroupList(archiveList, archived, 'archive');
      if (archiveControlsEl) archiveControlsEl.innerHTML = renderSavedGroupControls('archive', archiveGroupCount);
      return;
    }

    const filteredGroups = getFilteredSavedGroups(archived, 'archive', q);
    const filteredCount = filteredGroups.reduce((sum, group) => sum + group.items.length, 0);

    if (filteredGroups.length > 0) {
      const groupCount = renderSavedGroups(archiveList, filteredGroups, 'archive');
      if (archiveControlsEl) archiveControlsEl.innerHTML = renderSavedGroupControls('archive', groupCount, filteredCount);
    } else {
      if (archiveControlsEl) archiveControlsEl.innerHTML = '';
      archiveList.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:8px 0">${t('noResults')}</div>`;
    }
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id !== 'deferredSearch' && e.target.id !== 'archiveSearch') return;

  const input = e.target;
  const list = input.id === 'deferredSearch'
    ? document.getElementById('deferredList')
    : document.getElementById('archiveList');

  scrollFirstHighlightIntoView(list, input.value);
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
