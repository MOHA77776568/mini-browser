/* The renderer owns browser chrome only. Websites run in isolated native views. */
'use strict';

const api = window.browser;
const $ = (id) => document.getElementById(id);
const elements = {
  tabs: $('tabs'), address: $('address-input'), addressForm: $('address-form'),
  back: $('back'), forward: $('forward'), reload: $('reload'), bookmark: $('bookmark'),
  home: $('home-page'), error: $('error-page'), stage: $('web-stage'),
  status: $('status-text'), statusDot: $('status-dot'), progress: $('page-progress'),
  bookmarks: $('bookmarks-list'), bookmarksHint: $('bookmarks-hint'),
  homeSearch: $('home-search-input'), homeSearchForm: $('home-search-form'),
};

let state = { tabs: [], activeTabId: null, bookmarks: [], downloads: [] };
let addressIsEditing = false;
let lastActiveTabId = null;
let lastAddress = '';
let lastTabsKey = '';
let lastBookmarksKey = '';
let boundsFrame = null;
let toastTimer = null;
let lastBoundsKey = '';

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0];
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

async function action(method, ...args) {
  if (!api || typeof api[method] !== 'function') return;
  try {
    return await api[method](...args);
  } catch (error) {
    console.error(`Browser action failed: ${method}`, error);
    showToast('تعذّر إتمام العملية. حاول مرة أخرى.');
  }
}

function renderTabs() {
  const key = JSON.stringify([state.activeTabId, state.tabs.map(({ id, title, url, loading }) => ({ id, title, url, loading }))]);
  if (key === lastTabsKey) return;
  lastTabsKey = key;
  const focusedTabId = document.activeElement?.closest('[data-tab-id]')?.dataset.tabId;
  const fragment = document.createDocumentFragment();
  for (const tab of state.tabs) {
    const item = document.createElement('div');
    item.className = `tab${tab.id === state.activeTabId ? ' active' : ''}${tab.loading ? ' loading' : ''}`;
    item.dataset.tabId = String(tab.id);
    item.dataset.testid = 'tab';
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', String(tab.id === state.activeTabId));
    item.setAttribute('aria-controls', 'web-stage');
    item.tabIndex = tab.id === state.activeTabId ? 0 : -1;
    item.title = tab.title || tab.url || 'علامة تبويب جديدة';
    item.append(icon(tab.loading ? 'reload' : (tab.url ? 'globe' : 'orbit'), 'tab-icon'));
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = tab.title || tab.url || 'علامة تبويب جديدة';
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.dataset.closeTab = String(tab.id);
    close.title = 'إغلاق علامة التبويب (Ctrl+W)';
    close.setAttribute('aria-label', `إغلاق ${label.textContent}`);
    close.append(icon('close'));
    item.append(label, close);
    fragment.append(item);
  }
  elements.tabs.replaceChildren(fragment);
  if (focusedTabId) {
    Array.from(elements.tabs.children).find((node) => node.dataset.tabId === focusedTabId)?.focus({ preventScroll: true });
  }
  if (state.activeTabId !== lastActiveTabId) {
    Array.from(elements.tabs.children).find((node) => node.dataset.tabId === String(state.activeTabId))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function renderBookmarks() {
  const bookmarks = state.bookmarks || [];
  const key = JSON.stringify(bookmarks);
  if (key === lastBookmarksKey) return;
  lastBookmarksKey = key;
  const fragment = document.createDocumentFragment();
  bookmarks.forEach((bookmark) => {
    const button = document.createElement('button');
    button.className = 'bookmark-link';
    button.dataset.url = bookmark.url;
    button.title = `${bookmark.title || bookmark.url}\n${bookmark.url}`;
    button.append(icon('globe'));
    const title = document.createElement('span');
    title.textContent = bookmark.title || bookmark.url;
    button.append(title);
    fragment.append(button);
  });
  elements.bookmarks.replaceChildren(fragment);
  elements.bookmarksHint.hidden = bookmarks.length > 0;
}

function renderDownloads() {
  const downloads = state.downloads || [];
  const active = downloads.filter((download) => ['progressing', 'paused', 'interrupted'].includes(download.state));
  const count = $('download-count');
  count.hidden = active.length === 0;
  count.textContent = String(active.length);
  const recent = active[active.length - 1] || downloads[downloads.length - 1];
  const summary = $('download-status');
  summary.hidden = !recent;
  if (!recent) return;
  const isComplete = recent.state === 'completed';
  const isCancelled = recent.state === 'cancelled';
  const status = isComplete ? 'اكتمل' : isCancelled ? 'أُلغي' : 'جارٍ تنزيل';
  $('download-status-text').textContent = `${status}: ${recent.filename || 'ملف'}`;
  $('downloads').title = active.length ? `جارٍ تنزيل ${active.length} ملف — فتح مجلد التنزيلات` : 'فتح مجلد التنزيلات';
  const progress = $('download-progress');
  progress.hidden = isComplete || isCancelled;
  if (recent.total > 0) progress.value = Math.min(100, (recent.received / recent.total) * 100);
  else progress.removeAttribute('value');
}

function render(nextState) {
  if (!nextState || !Array.isArray(nextState.tabs)) return;
  state = nextState;
  const tab = activeTab();
  const changedTab = lastActiveTabId !== state.activeTabId;
  renderTabs();
  renderBookmarks();
  renderDownloads();
  const url = tab?.url || '';
  if (changedTab || (!addressIsEditing && url !== lastAddress)) {
    elements.address.value = url;
    lastAddress = url;
  }
  lastActiveTabId = state.activeTabId;
  elements.back.disabled = !tab?.canGoBack;
  elements.forward.disabled = !tab?.canGoForward;
  elements.reload.disabled = !url;
  elements.reload.title = tab?.loading ? 'إيقاف التحميل' : 'إعادة تحميل (Ctrl+R)';
  elements.reload.setAttribute('aria-label', tab?.loading ? 'إيقاف التحميل' : 'إعادة تحميل');
  elements.reload.replaceChildren(icon(tab?.loading ? 'close' : 'reload'));
  elements.bookmark.disabled = !url || Boolean(tab?.error);
  elements.bookmark.setAttribute('aria-pressed', String(Boolean(state.isBookmarked)));
  const bookmarkLabel = state.isBookmarked ? 'إزالة من المفضّلة' : 'إضافة إلى المفضّلة';
  elements.bookmark.setAttribute('aria-label', bookmarkLabel);
  elements.bookmark.title = `${bookmarkLabel} (Ctrl+D)`;
  const security = $('address-security');
  const secure = url.startsWith('https://');
  security.replaceChildren(icon(!url ? 'search' : secure ? 'lock' : 'globe'));
  security.title = !url ? 'علامة تبويب جديدة' : secure ? 'اتصال HTTPS' : 'عنوان الصفحة';
  elements.home.hidden = Boolean(url || tab?.error);
  elements.error.hidden = !tab?.error;
  $('error-detail').textContent = tab?.error || '';
  $('retry').replaceChildren(icon(url ? 'reload' : 'search'), document.createTextNode(url ? 'إعادة المحاولة' : 'تعديل العنوان'));
  elements.progress.hidden = !tab?.loading;
  elements.status.textContent = tab?.error ? 'تعذّر تحميل الصفحة' : tab?.loading ? 'جارٍ تحميل الصفحة…' : url ? 'اكتمل تحميل الصفحة' : 'جاهز للاكتشاف';
  elements.statusDot.className = `status-dot${tab?.loading ? ' loading' : ''}${tab?.error ? ' error' : ''}`;
  document.title = 'مِدار';
  scheduleBounds();
}

function focusAddress() {
  elements.address.focus();
  elements.address.select();
}

async function submitAddress(input) {
  const value = input.trim();
  if (!value) return;
  addressIsEditing = false;
  elements.address.blur();
  elements.homeSearch.blur();
  await action('navigate', value);
}

async function reportBounds(force = false) {
  const rect = elements.stage.getBoundingClientRect();
  const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
  const key = JSON.stringify(bounds);
  if (!force && key === lastBoundsKey) return;
  lastBoundsKey = key;
  await action('setBounds', bounds);
}

function scheduleBounds() {
  if (boundsFrame !== null) return;
  boundsFrame = requestAnimationFrame(() => { boundsFrame = null; void reportBounds(); });
}

elements.addressForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitAddress(elements.address.value);
});
elements.homeSearchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitAddress(elements.homeSearch.value);
});
elements.address.addEventListener('focus', () => { addressIsEditing = true; });
elements.address.addEventListener('blur', () => { addressIsEditing = false; });
elements.address.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    elements.address.value = activeTab()?.url || '';
    elements.address.blur();
  }
});
elements.homeSearch.addEventListener('input', () => {
  const value = elements.homeSearch.value;
  elements.homeSearch.dir = /^[a-z0-9:/]/i.test(value) ? 'ltr' : 'rtl';
});
$('new-tab').addEventListener('click', async () => { await action('newTab'); focusAddress(); });
$('back').addEventListener('click', () => { void action('goBack'); });
$('forward').addEventListener('click', () => { void action('goForward'); });
$('reload').addEventListener('click', () => { void action(activeTab()?.loading ? 'stop' : 'reload'); });
$('home').addEventListener('click', () => { elements.homeSearch.value = ''; void action('navigate', ''); });
$('bookmark').addEventListener('click', () => { void action('toggleBookmark'); });
$('downloads').addEventListener('click', () => { void action('openDownloads'); });
$('retry').addEventListener('click', () => {
  if (activeTab()?.url) void action('reload');
  else focusAddress();
});

elements.tabs.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-tab]');
  if (close) { void action('closeTab', close.dataset.closeTab); return; }
  const tab = event.target.closest('[data-tab-id]');
  if (tab) void action('activateTab', tab.dataset.tabId);
});
elements.tabs.addEventListener('auxclick', (event) => {
  if (event.button !== 1) return;
  const tab = event.target.closest('[data-tab-id]');
  if (tab) { event.preventDefault(); void action('closeTab', tab.dataset.tabId); }
});
elements.tabs.addEventListener('keydown', (event) => {
  if (event.target.closest('[data-close-tab]')) return;
  const tab = event.target.closest('[data-tab-id]');
  if (!tab) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void action('activateTab', tab.dataset.tabId);
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const index = state.tabs.findIndex((item) => String(item.id) === tab.dataset.tabId);
    const direction = event.key === 'ArrowLeft' ? 1 : -1;
    const next = state.tabs[(index + direction + state.tabs.length) % state.tabs.length];
    if (next) void action('activateTab', next.id).then(() => {
      Array.from(elements.tabs.children).find((node) => node.dataset.tabId === String(next.id))?.focus();
    });
  }
});
document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-url]');
  if (link?.dataset.url) void action('navigate', link.dataset.url);
});

function updateClock() {
  const date = new Date();
  $('home-date').textContent = new Intl.DateTimeFormat('ar', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  $('home-clock').textContent = new Intl.DateTimeFormat('ar-u-nu-latn', { hour: '2-digit', minute: '2-digit' }).format(date);
  $('home-clock').dateTime = date.toISOString();
}

async function initialize() {
  updateClock();
  setInterval(updateClock, 30000);
  new ResizeObserver(scheduleBounds).observe(elements.stage);
  window.addEventListener('resize', scheduleBounds);
  if (!api) {
    elements.status.textContent = 'افتح التطبيق باستخدام Electron لبدء التصفح';
    return;
  }
  api.onState(render);
  api.onFocusAddress(focusAddress);
  const initialState = await action('getState');
  if (initialState) render(initialState);
  await reportBounds(true);
}

void initialize();
