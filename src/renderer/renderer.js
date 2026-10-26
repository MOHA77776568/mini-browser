/* Browser chrome is trusted UI. Every website lives in an isolated native view. */
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
const defaults = { searchEngine: 'google', restoreSession: true, homeUrl: '', theme: 'system' };
const engineNames = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing' };
const panels = {
  history: ['سجل التصفح', 'عُد إلى صفحات زرتها، وابحث عن زيارة سابقة.'],
  bookmarks: ['المفضّلة', 'وجهاتك التي اخترت الاحتفاظ بها، في مكان واحد.'],
  downloads: ['التنزيلات', 'تابع ملفاتك، وافتحها أو اعرض مكان حفظها.'],
  settings: ['الإعدادات والخصوصية', 'اضبط متصفحك، وتحكّم في البيانات المحفوظة على جهازك.'],
};
let state = { tabs: [], activeTabId: null, bookmarks: [], downloads: [], history: [], permissions: [], settings: defaults };
let addressIsEditing = false;
let lastActiveTabId = null;
let lastAddress = '';
let lastTabsKey = '';
let lastBookmarksKey = '';
let boundsFrame = null;
let toastTimer = null;
let findTimer = null;
let lastBoundsKey = '';
let overlayMode = null;
let overlayToken = 0;
let currentPanel = null;
let contextTabId = null;
let panelKey = '';
let permissionKey = '';
const downloadRows = new Map();

function node(tag, className = '', text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function button(text, className = 'text-button') {
  const result = node('button', className, text);
  result.type = 'button';
  return result;
}
function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0];
}
function showToast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  elements.status.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}
async function action(method, ...args) {
  if (!api || typeof api[method] !== 'function') return;
  try { return await api[method](...args); }
  catch (error) {
    console.error(`Browser action failed: ${method}`, error);
    showToast('تعذّر إتمام العملية. تحقّق من المدخلات وحاول مرة أخرى.');
    return undefined;
  }
}

function renderTabs() {
  const key = JSON.stringify([state.activeTabId, state.tabs.map(({ id, title, url, loading, private: isPrivate, pinned, muted, popup }) => ({ id, title, url, loading, isPrivate, pinned, muted, popup }))]);
  if (key === lastTabsKey) return;
  lastTabsKey = key;
  const focusedId = document.activeElement?.closest('[data-tab-id]')?.dataset.tabId;
  const fragment = document.createDocumentFragment();
  for (const tab of state.tabs) {
    const item = node('div', `tab${tab.id === state.activeTabId ? ' active' : ''}${tab.loading ? ' loading' : ''}${tab.private ? ' private' : ''}${tab.pinned ? ' pinned' : ''}`);
    item.dataset.tabId = String(tab.id);
    item.dataset.testid = 'tab';
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', String(tab.id === state.activeTabId));
    item.setAttribute('aria-controls', 'web-stage');
    item.tabIndex = tab.id === state.activeTabId ? 0 : -1;
    const labelText = tab.title || tab.url || 'علامة تبويب جديدة';
    item.title = `${labelText}${tab.private ? ' — تبويب خاص' : ''}${tab.pinned ? ' — مثبّت' : ''}${tab.muted ? ' — الصوت مكتوم' : ''}`;
    item.append(icon(tab.loading ? 'reload' : tab.private ? 'private' : tab.pinned ? 'pin' : tab.url || tab.popup ? 'globe' : 'orbit', 'tab-icon'));
    item.append(node('span', 'tab-label', labelText));
    if (tab.muted) item.append(icon('volume', 'tab-muted'));
    const close = button('', 'tab-close');
    close.dataset.closeTab = String(tab.id);
    close.title = 'إغلاق علامة التبويب (Ctrl+W)';
    close.setAttribute('aria-label', `إغلاق ${labelText}`);
    close.append(icon('close'));
    item.append(close);
    fragment.append(item);
  }
  elements.tabs.replaceChildren(fragment);
  if (focusedId) Array.from(elements.tabs.children).find((item) => item.dataset.tabId === focusedId)?.focus({ preventScroll: true });
  if (state.activeTabId !== lastActiveTabId) Array.from(elements.tabs.children).find((item) => item.dataset.tabId === String(state.activeTabId))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function renderBookmarks() {
  const bookmarks = state.bookmarks || [];
  const key = JSON.stringify(bookmarks);
  if (key === lastBookmarksKey) return;
  lastBookmarksKey = key;
  const fragment = document.createDocumentFragment();
  for (const bookmark of bookmarks) {
    const link = button('', 'bookmark-link');
    link.dataset.url = bookmark.url;
    link.title = `${bookmark.title || bookmark.url}\n${bookmark.url}`;
    link.append(icon('globe'), node('span', '', bookmark.title || bookmark.url));
    fragment.append(link);
  }
  elements.bookmarks.replaceChildren(fragment);
  elements.bookmarksHint.hidden = bookmarks.length > 0;
}
function formatBytes(value) {
  if (!(value > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}
function downloadLabel(item) {
  return { completed: 'اكتمل التنزيل', cancelled: 'أُلغي التنزيل', interrupted: 'توقف التنزيل', paused: 'متوقف مؤقتًا', progressing: 'جارٍ التنزيل' }[item.state] || 'جارٍ التنزيل';
}
function renderDownloads() {
  const downloads = state.downloads || [];
  const running = downloads.filter((item) => ['progressing', 'paused'].includes(item.state));
  $('download-count').hidden = running.length === 0;
  $('download-count').textContent = String(running.length);
  const recent = running[running.length - 1] || downloads[downloads.length - 1];
  $('download-status').hidden = !recent;
  if (recent) {
    $('download-status-text').textContent = `${downloadLabel(recent)}: ${recent.filename || 'ملف'}`;
    const meter = $('download-progress');
    meter.hidden = ['completed', 'cancelled'].includes(recent.state);
    if (recent.total > 0) meter.value = Math.min(100, recent.received / recent.total * 100);
    else meter.removeAttribute('value');
  }
  $('downloads').title = running.length ? `التنزيلات — ${running.length} قيد التنزيل` : 'التنزيلات (Ctrl+J)';
  if (currentPanel === 'downloads') renderDownloadPanel();
}
function emptyMessage(text) {
  const empty = node('div', 'empty-state');
  empty.append(icon('orbit'), node('p', '', text));
  return empty;
}
function renderHistoryPanel() {
  const search = $('history-search').value.trim().toLowerCase();
  const items = (state.history || []).filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(search));
  const key = JSON.stringify(['history', search, items]);
  if (panelKey === key) return;
  panelKey = key;
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = node('article', 'library-row');
    row.dataset.testid = 'history-entry';
    row.append(icon('history', 'row-icon'));
    const link = button('', 'row-link');
    link.dataset.url = item.url;
    link.append(node('strong', '', item.title || item.url), node('span', 'row-url', item.url));
    const date = Number.isFinite(Number(item.visitedAt)) ? new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(Number(item.visitedAt))) : '';
    const remove = button('', 'icon-button row-remove');
    remove.dataset.removeHistory = String(item.id);
    remove.title = 'إزالة الزيارة من السجل';
    remove.setAttribute('aria-label', `إزالة ${item.title || 'الزيارة'} من السجل`);
    remove.append(icon('close'));
    row.append(link, node('time', 'row-time', date), remove);
    fragment.append(row);
  }
  $('history-list').replaceChildren(items.length ? fragment : emptyMessage(search ? 'لا توجد زيارات تطابق بحثك.' : 'لم تُسجَّل زيارات بعد. زيارات التبويبات الخاصة لا تظهر هنا.'));
  $('history-clear').disabled = !(state.history || []).length;
}
function renderBookmarkPanel() {
  const search = $('bookmark-search').value.trim().toLowerCase();
  const items = (state.bookmarks || []).filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(search));
  const key = JSON.stringify(['bookmarks', search, items]);
  if (panelKey === key) return;
  panelKey = key;
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = node('article', 'library-row');
    row.append(icon('star', 'row-icon'));
    const link = button('', 'row-link');
    link.dataset.url = item.url;
    link.append(node('strong', '', item.title || item.url), node('span', 'row-url', item.url));
    const remove = button('', 'icon-button row-remove');
    remove.dataset.removeBookmark = item.url;
    remove.title = 'إزالة من المفضّلة';
    remove.setAttribute('aria-label', `إزالة ${item.title || 'الصفحة'} من المفضّلة`);
    remove.append(icon('trash'));
    row.append(link, remove);
    fragment.append(row);
  }
  $('bookmark-list').replaceChildren(items.length ? fragment : emptyMessage(search ? 'لا توجد مفضّلة تطابق بحثك.' : 'صفحاتك المفضّلة ستظهر هنا. اضغط النجمة بجانب شريط العنوان لحفظ صفحة.'));
}
function renderDownloadPanel() {
  const items = [...(state.downloads || [])].reverse();
  if (!items.length) {
    downloadRows.clear();
    $('download-list').replaceChildren(emptyMessage('لا توجد تنزيلات في هذه الجلسة.'));
    return;
  }
  if (!downloadRows.size) $('download-list').replaceChildren();
  const present = new Set(items.map((item) => String(item.id)));
  for (const [id, row] of downloadRows) if (!present.has(id)) { row.remove(); downloadRows.delete(id); }
  items.forEach((item, index) => {
    const id = String(item.id);
    let row = downloadRows.get(id);
    if (!row) {
      row = node('article', 'download-row');
      row.dataset.downloadId = id;
      row.append(icon('download', 'row-icon'));
      const copy = node('div', 'download-copy');
      copy.append(node('strong', 'download-name'), node('span', 'download-details'));
      const meter = node('progress', 'download-meter');
      meter.max = 100;
      meter.setAttribute('aria-label', 'تقدم التنزيل');
      copy.append(meter);
      row.append(copy, node('div', 'download-actions'));
      downloadRows.set(id, row);
    }
    row.querySelector('.download-name').textContent = `${item.filename || 'ملف'}${item.isPrivate ? ' · خاص' : ''}`;
    row.querySelector('.download-details').textContent = `${downloadLabel(item)} · ${formatBytes(item.received)}${item.total > 0 ? ` / ${formatBytes(item.total)}` : ''}`;
    const meter = row.querySelector('.download-meter');
    meter.hidden = ['completed', 'cancelled'].includes(item.state);
    if (item.total > 0) meter.value = Math.min(100, item.received / item.total * 100);
    else meter.removeAttribute('value');
    const commands = [];
    if (item.state === 'progressing') commands.push(['pause', 'إيقاف مؤقت', 'pause']);
    if (item.state === 'paused' || (item.state === 'interrupted' && item.canResume)) commands.push(['resume', 'استئناف', 'play']);
    if (['progressing', 'paused', 'interrupted'].includes(item.state)) commands.push(['cancel', 'إلغاء التنزيل', 'close']);
    if (item.state === 'completed') commands.push(['open', 'فتح الملف', 'external'], ['reveal', 'عرض في المجلد', 'folder']);
    const actions = row.querySelector('.download-actions');
    const key = JSON.stringify(commands);
    if (actions.dataset.key !== key) {
      actions.dataset.key = key;
      actions.replaceChildren(...commands.map(([command, label, symbol]) => {
        const control = button(label);
        control.dataset.downloadAction = command;
        control.dataset.downloadId = id;
        control.prepend(icon(symbol));
        return control;
      }));
    }
    const current = $('download-list').children[index];
    if (current !== row) $('download-list').insertBefore(row, current || null);
  });
}
function renderPermissions() {
  const entries = Array.isArray(state.permissions) ? state.permissions : [];
  const key = JSON.stringify(entries);
  if (permissionKey === key) return;
  permissionKey = key;
  const names = { media: 'الكاميرا والميكروفون', 'media:audio': 'الميكروفون', 'media:video': 'الكاميرا', geolocation: 'الموقع الجغرافي', notifications: 'الإشعارات', fullscreen: 'ملء الشاشة', pointerLock: 'تثبيت المؤشر', 'clipboard-read': 'قراءة الحافظة', 'clipboard-sanitized-write': 'النسخ إلى الحافظة', 'speaker-selection': 'اختيار السماعة' };
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = node('div', 'permission-row');
    const copy = node('div');
    copy.append(node('strong', 'permission-origin', entry.origin), node('span', 'subtle', `${names[entry.permission] || 'إذن إضافي'} · ${entry.decision === 'allow' ? 'مسموح' : 'محظور'}`));
    const reset = button('إعادة ضبط');
    reset.dataset.resetOrigin = entry.origin;
    reset.dataset.resetPermission = entry.permission;
    row.append(copy, reset);
    fragment.append(row);
  }
  $('permissions-list').replaceChildren(entries.length ? fragment : node('p', 'subtle', 'لا توجد قرارات أذونات محفوظة. ستُسأل عندما يطلب موقع إذنًا.'));
}
function renderSettings() {
  const settings = state.settings || defaults;
  const controls = { 'setting-search-engine': settings.searchEngine, 'setting-home-url': settings.homeUrl || '', 'setting-theme': settings.theme || 'system' };
  for (const [id, value] of Object.entries(controls)) if (document.activeElement !== $(id)) $(id).value = value;
  $('setting-restore-session').checked = Boolean(settings.restoreSession);
  $('profile-path').textContent = state.profilePath || '';
  $('home-use-current').disabled = !/^https?:\/\//.test(activeTab()?.url || '');
  renderPermissions();
}
function renderPanel() {
  if (currentPanel === 'history') renderHistoryPanel();
  else if (currentPanel === 'bookmarks') renderBookmarkPanel();
  else if (currentPanel === 'downloads') renderDownloadPanel();
  else if (currentPanel === 'settings') renderSettings();
}
function applyTheme() {
  const preference = state.settings?.theme || 'system';
  document.documentElement.dataset.theme = preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
}
function renderFind(result = state.findResult) {
  const matches = Number(result?.matches) || 0;
  const ordinal = Number(result?.activeMatchOrdinal) || 0;
  $('find-count').textContent = `${Math.max(0, ordinal)} من ${Math.max(0, matches)}`;
  $('find-next').disabled = !$('find-input').value.trim();
  $('find-prev').disabled = !$('find-input').value.trim();
}
function render(nextState) {
  if (!nextState || !Array.isArray(nextState.tabs)) return;
  state = { history: [], permissions: [], ...nextState, settings: { ...defaults, ...nextState.settings } };
  const tab = activeTab();
  const changedTab = lastActiveTabId !== state.activeTabId;
  renderTabs();
  renderBookmarks();
  renderDownloads();
  const url = tab?.url || '';
  const hasPage = Boolean(url || tab?.popup);
  if (changedTab || (!addressIsEditing && url !== lastAddress)) { elements.address.value = url; lastAddress = url; }
  lastActiveTabId = state.activeTabId;
  elements.back.disabled = !tab?.canGoBack;
  elements.forward.disabled = !tab?.canGoForward;
  elements.reload.disabled = !hasPage;
  elements.reload.title = tab?.loading ? 'إيقاف التحميل' : 'إعادة تحميل (Ctrl+R)';
  elements.reload.setAttribute('aria-label', tab?.loading ? 'إيقاف التحميل' : 'إعادة تحميل');
  elements.reload.replaceChildren(icon(tab?.loading ? 'close' : 'reload'));
  elements.bookmark.disabled = !url || Boolean(tab?.error);
  elements.bookmark.setAttribute('aria-pressed', String(Boolean(state.isBookmarked)));
  const bookmarkLabel = state.isBookmarked ? 'إزالة من المفضّلة' : 'إضافة إلى المفضّلة';
  elements.bookmark.setAttribute('aria-label', bookmarkLabel);
  elements.bookmark.title = `${bookmarkLabel} (Ctrl+D)`;
  const security = $('address-security');
  security.replaceChildren(icon(!hasPage ? 'search' : url.startsWith('https://') ? 'lock' : 'globe'));
  security.title = !hasPage ? 'علامة تبويب جديدة' : url.startsWith('https://') ? 'اتصال HTTPS' : 'عنوان الصفحة';
  elements.home.hidden = Boolean(hasPage || tab?.error);
  elements.error.hidden = !tab?.error;
  $('error-detail').textContent = tab?.error || '';
  $('retry').replaceChildren(icon(url ? 'reload' : 'search'), document.createTextNode(url ? 'إعادة المحاولة' : 'تعديل العنوان'));
  elements.progress.hidden = !tab?.loading;
  elements.status.textContent = tab?.error ? 'تعذّر تحميل الصفحة' : tab?.loading ? 'جارٍ تحميل الصفحة…' : tab?.private ? 'تصفّح خاص · لا يُحفظ السجل' : hasPage ? 'اكتمل تحميل الصفحة' : 'جاهز للاكتشاف';
  elements.statusDot.className = `status-dot${tab?.loading ? ' loading' : ''}${tab?.error ? ' error' : ''}`;
  $('private-indicator').hidden = !tab?.private;
  $('private-notice').hidden = !tab?.private;
  document.body.classList.toggle('private-tab-active', Boolean(tab?.private));
  $('search-engine-label').textContent = `بحث ${engineNames[state.settings.searchEngine] || 'Google'}`;
  $('menu-reopen').disabled = !state.canReopenTab;
  $('zoom-reset').textContent = `${Math.round((Number(tab?.zoomFactor) || 1) * 100)}%`;
  $('zoom-in').disabled = !hasPage || (Number(tab?.zoomFactor) || 1) >= 3;
  $('zoom-out').disabled = !hasPage || (Number(tab?.zoomFactor) || 1) <= .25;
  $('zoom-reset').disabled = !hasPage;
  document.querySelectorAll('[data-command="printPage"], [data-command="savePDF"], [data-command="savePage"]').forEach((control) => { control.disabled = !hasPage || Boolean(tab?.error); });
  document.title = 'مِدار';
  applyTheme();
  renderFind();
  renderPanel();
  scheduleBounds();
  if (changedTab && !$('find-bar').hidden && $('find-input').value.trim()) void action('findInPage', $('find-input').value, true);
}

function hideOverlayElements() {
  $('browser-menu').hidden = true;
  $('tab-menu').hidden = true;
  $('library-panel').hidden = true;
  $('menu-button').setAttribute('aria-expanded', 'false');
}
async function prepareOverlay() {
  try { await api.setPanelOpen(true); return true; }
  catch (error) { console.error('Could not open browser panel', error); showToast('تعذّر فتح أدوات المتصفح. حاول مرة أخرى.'); return false; }
}
async function closeOverlay() {
  overlayToken++;
  overlayMode = null;
  currentPanel = null;
  hideOverlayElements();
  await action('setPanelOpen', false);
}
async function showPanel(panel) {
  if (!panels[panel]) return;
  const token = ++overlayToken;
  if (!(await prepareOverlay()) || token !== overlayToken) return;
  hideOverlayElements();
  overlayMode = 'panel';
  currentPanel = panel;
  panelKey = '';
  $('library-panel').hidden = false;
  $('panel-title').textContent = panels[panel][0];
  $('panel-description').textContent = panels[panel][1];
  for (const name of Object.keys(panels)) $(`panel-${name}`).hidden = name !== panel;
  document.querySelectorAll('.library-nav [data-panel]').forEach((item) => item.classList.toggle('selected', item.dataset.panel === panel));
  renderPanel();
  const focus = panel === 'history' ? $('history-search') : panel === 'bookmarks' ? $('bookmark-search') : $('panel-close');
  focus.focus();
}
async function showMenu() {
  if (overlayMode === 'menu') { await closeOverlay(); return; }
  const token = ++overlayToken;
  if (!(await prepareOverlay()) || token !== overlayToken) return;
  hideOverlayElements();
  currentPanel = null;
  overlayMode = 'menu';
  $('browser-menu').hidden = false;
  $('menu-button').setAttribute('aria-expanded', 'true');
  $('browser-menu').querySelector('button:not(:disabled)')?.focus();
}
async function showTabMenu(tabId, x, y) {
  const token = ++overlayToken;
  if (!(await prepareOverlay()) || token !== overlayToken) return;
  hideOverlayElements();
  currentPanel = null;
  overlayMode = 'tab-menu';
  contextTabId = tabId;
  const tab = state.tabs.find((item) => String(item.id) === tabId);
  $('tab-pin').querySelector('span').textContent = tab?.pinned ? 'إلغاء تثبيت التبويب' : 'تثبيت التبويب';
  $('tab-mute').querySelector('span').textContent = tab?.muted ? 'تشغيل صوت التبويب' : 'كتم صوت التبويب';
  const menu = $('tab-menu');
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button')?.focus();
}
async function focusAddress() {
  if (overlayMode) await closeOverlay();
  elements.address.focus();
  elements.address.select();
}
async function showFind() {
  if (overlayMode) await closeOverlay();
  $('find-bar').hidden = false;
  scheduleBounds();
  $('find-input').focus();
  $('find-input').select();
  renderFind();
}
async function closeFind() {
  clearTimeout(findTimer);
  $('find-bar').hidden = true;
  $('find-input').value = '';
  await action('stopFind');
  scheduleBounds();
}
async function submitAddress(input) {
  const value = input.trim();
  if (!value) return;
  if (overlayMode) await closeOverlay();
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
async function runCommand(method) {
  if (method === 'find') { await showFind(); return; }
  await closeOverlay();
  await action(method);
  if (['newTab', 'newPrivateTab'].includes(method)) await focusAddress();
}
async function saveSetting(patch) {
  await action('updateSettings', patch);
}

// Navigation and tabs.
elements.addressForm.addEventListener('submit', (event) => { event.preventDefault(); void submitAddress(elements.address.value); });
elements.homeSearchForm.addEventListener('submit', (event) => { event.preventDefault(); void submitAddress(elements.homeSearch.value); });
elements.address.addEventListener('focus', () => { addressIsEditing = true; });
elements.address.addEventListener('blur', () => { addressIsEditing = false; });
elements.address.addEventListener('keydown', (event) => { if (event.key === 'Escape') { elements.address.value = activeTab()?.url || ''; elements.address.blur(); } });
elements.homeSearch.addEventListener('input', () => { elements.homeSearch.dir = /^[a-z0-9:/]/i.test(elements.homeSearch.value) ? 'ltr' : 'rtl'; });
$('new-tab').addEventListener('click', () => { void runCommand('newTab'); });
$('private-tab').addEventListener('click', () => { void runCommand('newPrivateTab'); });
$('back').addEventListener('click', () => { void action('goBack'); });
$('forward').addEventListener('click', () => { void action('goForward'); });
$('reload').addEventListener('click', () => { void action(activeTab()?.loading ? 'stop' : 'reload'); });
$('home').addEventListener('click', async () => { elements.homeSearch.value = ''; if (overlayMode) await closeOverlay(); await action('goHome'); });
$('bookmark').addEventListener('click', () => { void action('toggleBookmark'); });
$('downloads').addEventListener('click', () => { void showPanel('downloads'); });
$('bookmarks-manager').addEventListener('click', () => { void showPanel('bookmarks'); });
$('retry').addEventListener('click', () => { if (activeTab()?.url) void action('reload'); else void focusAddress(); });
elements.tabs.addEventListener('click', async (event) => {
  const close = event.target.closest('[data-close-tab]');
  if (overlayMode) await closeOverlay();
  if (close) { await action('closeTab', close.dataset.closeTab); return; }
  const tab = event.target.closest('[data-tab-id]');
  if (tab) await action('activateTab', tab.dataset.tabId);
});
elements.tabs.addEventListener('auxclick', (event) => { if (event.button === 1) { const tab = event.target.closest('[data-tab-id]'); if (tab) { event.preventDefault(); void action('closeTab', tab.dataset.tabId); } } });
elements.tabs.addEventListener('contextmenu', (event) => { const tab = event.target.closest('[data-tab-id]'); if (tab) { event.preventDefault(); void showTabMenu(tab.dataset.tabId, event.clientX, event.clientY); } });
elements.tabs.addEventListener('keydown', (event) => {
  if (event.target.closest('[data-close-tab]')) return;
  const tab = event.target.closest('[data-tab-id]');
  if (!tab) return;
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void action('activateTab', tab.dataset.tabId); }
  if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const index = state.tabs.findIndex((item) => String(item.id) === tab.dataset.tabId);
    const next = state.tabs[(index + (event.key === 'ArrowLeft' ? 1 : -1) + state.tabs.length) % state.tabs.length];
    if (next) void action('activateTab', next.id).then(() => Array.from(elements.tabs.children).find((item) => item.dataset.tabId === String(next.id))?.focus());
  }
});

// Menus and trusted library panels.
$('menu-button').addEventListener('click', () => { void showMenu(); });
$('panel-close').addEventListener('click', async () => { await closeOverlay(); $('menu-button').focus(); });
document.addEventListener('click', async (event) => {
  const panel = event.target.closest('[data-panel]');
  if (panel) { await showPanel(panel.dataset.panel); return; }
  const command = event.target.closest('[data-command]');
  if (command) { await runCommand(command.dataset.command); return; }
  const tabCommand = event.target.closest('[data-tab-command]');
  if (tabCommand) { const id = contextTabId; await closeOverlay(); await action(tabCommand.dataset.tabCommand, id); return; }
  const history = event.target.closest('[data-remove-history]');
  if (history) { await action('removeHistory', history.dataset.removeHistory); return; }
  const bookmark = event.target.closest('[data-remove-bookmark]');
  if (bookmark) { await action('removeBookmark', bookmark.dataset.removeBookmark); return; }
  const download = event.target.closest('[data-download-action]');
  if (download) { await action('downloadAction', download.dataset.downloadId, download.dataset.downloadAction); return; }
  const reset = event.target.closest('[data-reset-origin]');
  if (reset) { await action('resetSitePermission', reset.dataset.resetOrigin, reset.dataset.resetPermission); return; }
  const link = event.target.closest('[data-url]');
  if (link?.dataset.url) { if (overlayMode) await closeOverlay(); await action('navigate', link.dataset.url); return; }
  if (['menu', 'tab-menu'].includes(overlayMode) && !event.target.closest('#browser-menu, #tab-menu, #menu-button, #downloads, #bookmarks-manager')) await closeOverlay();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (overlayMode) { event.preventDefault(); void closeOverlay(); }
    else if (!$('find-bar').hidden) { event.preventDefault(); void closeFind(); }
  }
  if (['menu', 'tab-menu'].includes(overlayMode) && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    const container = overlayMode === 'menu' ? $('browser-menu') : $('tab-menu');
    const items = [...container.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    event.preventDefault();
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
});
$('history-search').addEventListener('input', renderHistoryPanel);
$('bookmark-search').addEventListener('input', renderBookmarkPanel);
$('history-clear').addEventListener('click', () => { void action('clearHistory'); });
$('open-downloads-folder').addEventListener('click', () => { void action('openDownloads'); });
$('zoom-in').addEventListener('click', () => { void action('setZoom', Math.min(3, (Number(activeTab()?.zoomFactor) || 1) + .1)); });
$('zoom-out').addEventListener('click', () => { void action('setZoom', Math.max(.25, (Number(activeTab()?.zoomFactor) || 1) - .1)); });
$('zoom-reset').addEventListener('click', () => { void action('setZoom', 1); });
$('find-input').addEventListener('input', () => { clearTimeout(findTimer); renderFind(); findTimer = setTimeout(() => { if ($('find-input').value) void action('findInPage', $('find-input').value, true); else void action('stopFind'); }, 120); });
$('find-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void action('findInPage', $('find-input').value, !event.shiftKey); } });
$('find-next').addEventListener('click', () => { void action('findInPage', $('find-input').value, true); });
$('find-prev').addEventListener('click', () => { void action('findInPage', $('find-input').value, false); });
$('find-close').addEventListener('click', () => { void closeFind(); });
$('setting-search-engine').addEventListener('change', (event) => { void saveSetting({ searchEngine: event.target.value }); });
$('setting-theme').addEventListener('change', (event) => { void saveSetting({ theme: event.target.value }); });
$('setting-restore-session').addEventListener('change', (event) => { void saveSetting({ restoreSession: event.target.checked }); });
$('setting-home-url').addEventListener('change', (event) => { void saveSetting({ homeUrl: event.target.value.trim() }); });
$('home-use-current').addEventListener('click', () => { const url = activeTab()?.url; if (url) { $('setting-home-url').value = url; void saveSetting({ homeUrl: url }); } });
$('home-use-default').addEventListener('click', () => { $('setting-home-url').value = ''; void saveSetting({ homeUrl: '' }); });
$('clear-browsing-data').addEventListener('click', async () => {
  const choices = { history: $('clear-history').checked, cookies: $('clear-cookies').checked, cache: $('clear-cache').checked, permissions: $('clear-permissions').checked };
  if (!Object.values(choices).some(Boolean)) { $('privacy-result').textContent = 'اختر نوع البيانات الذي تريد مسحه.'; return; }
  const result = await action('clearBrowsingData', choices);
  if (result !== undefined) { $('privacy-result').textContent = 'تم مسح البيانات المحددة.'; showToast('تم مسح البيانات المحددة.'); }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
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
  if (!api) { elements.status.textContent = 'افتح التطبيق باستخدام Electron لبدء التصفح'; return; }
  api.onState(render);
  api.onFocusAddress(() => { void focusAddress(); });
  api.onShowPanel?.((panel) => { if (panel === 'find') void showFind(); else void showPanel(panel); });
  api.onFindResult?.((result) => { state.findResult = result; renderFind(result); });
  const initialState = await action('getState');
  if (initialState) render(initialState);
  await reportBounds(true);
}
void initialize();
