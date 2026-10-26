'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, session, shell, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { normalizeInput, isAllowedUrl } = require('./navigation');
const { createProfileStore } = require('./profile');

if (process.env.MINI_BROWSER_USER_DATA) {
  const userDataPath = path.resolve(process.env.MINI_BROWSER_USER_DATA);
  fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
}

const chromePath = path.join(__dirname, 'renderer', 'index.html');
const chromeUrl = pathToFileURL(chromePath).href;
const tabs = new Map();
const downloads = new Map();
const downloadItems = new Map();
const privatePermissions = new Map();
const closedTabs = [];
const supportedPermissions = new Set(['media', 'geolocation', 'notifications', 'fullscreen', 'pointerLock', 'clipboard-read', 'clipboard-sanitized-write', 'speaker-selection']);
let mainWindow = null;
let browserSession;
let privateSession = null;
let profile;
let activeTabId = null;
let attachedView = null;
let contentBounds = { x: 0, y: 148, width: 0, height: 0 };
let htmlFullscreen = false;
let panelOpen = false;
let quitting = false;
let restoring = false;
let titleSaveTimer = null;
const pendingTitleTabs = new Set();
const ownsProfileLock = app.requestSingleInstanceLock();
if (!ownsProfileLock) app.quit();
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }
});

function activeTab() { return tabs.get(activeTabId); }
function tabContents(tab = activeTab()) {
  const contents = tab?.view?.webContents;
  return contents && !contents.isDestroyed() ? contents : null;
}
function orderedTabs() {
  return [...tabs.values()].sort((left, right) => Number(right.pinned) - Number(left.pinned));
}
function historyAvailable(tab, direction) {
  const contents = tabContents(tab);
  return Boolean(contents && (direction === 'back' ? contents.navigationHistory.canGoBack() : contents.navigationHistory.canGoForward()));
}
function emptyFindResult() { return { matches: 0, activeMatchOrdinal: 0, finalUpdate: true }; }
function originOf(url) {
  return isAllowedUrl(url) ? new URL(url).origin : null;
}
function currentPermissions() {
  if (activeTab()?.private) {
    return [...privatePermissions.entries()].map(([key, decision]) => {
      const [origin, permission] = JSON.parse(key);
      return { origin, permission, decision };
    });
  }
  return Object.entries(profile.data.permissions || {}).flatMap(([origin, decisions]) =>
    Object.entries(decisions).map(([permission, decision]) => ({ origin, permission, decision })));
}
function nativeDownloadStatus(id) {
  const item = downloadItems.get(id);
  if (!item) return { canResume: false };
  try { return { canResume: item.canResume() }; } catch { return { canResume: false }; }
}
function state() {
  const current = activeTab();
  return {
    tabs: orderedTabs().map((tab) => ({
      id: tab.id, title: tab.title, url: tab.url, loading: tab.loading,
      private: tab.private, pinned: tab.pinned, muted: Boolean(tabContents(tab)?.isAudioMuted() || tab.muted),
      popup: Boolean(tab.popup),
      zoomFactor: tabContents(tab)?.getZoomFactor() || tab.zoomFactor,
      canGoBack: historyAvailable(tab, 'back'), canGoForward: historyAvailable(tab, 'forward'),
      ...(tab.error ? { error: tab.error } : {}),
    })),
    activeTabId,
    bookmarks: profile.data.bookmarks.map((bookmark) => ({ ...bookmark })),
    isBookmarked: Boolean(current?.url && profile.data.bookmarks.some((bookmark) => bookmark.url === current.url)),
    downloads: [...downloads.values()].map((download) => ({ ...download, ...nativeDownloadStatus(download.id) })),
    settings: { ...profile.data.settings },
    history: profile.data.history.map((visit) => ({ ...visit })),
    permissions: currentPermissions(),
    findResult: { ...(current?.findResult || emptyFindResult()) },
    canReopenTab: closedTabs.length > 0,
    profilePath: app.getPath('userData'),
  };
}
function publish() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser:state', state());
  }
}
function saveProfile() {
  try { profile.save(); } catch (error) { console.warn('Could not save browser profile:', error.message); }
}
function recordVisit(tab) {
  if (tab.private || !isAllowedUrl(tab.url)) return;
  try { profile.recordVisit({ url: tab.url, title: tab.title }); }
  catch (error) { console.warn('Could not save browsing history:', error.message); }
}
function flushTitleChanges() {
  if (titleSaveTimer) clearTimeout(titleSaveTimer);
  titleSaveTimer = null;
  if (!pendingTitleTabs.size || !profile) return;
  for (const id of pendingTitleTabs) {
    const tab = tabs.get(id);
    if (!tab || tab.private || !tab.recordedUrl || tab.recordedUrl !== tab.url) continue;
    const visit = profile.data.history.find((entry) => entry.url === tab.url);
    if (visit) visit.title = tab.title;
  }
  pendingTitleTabs.clear();
  if (profile.data.settings.restoreSession) persistSession(); else saveProfile();
}
function queueTitleChange(tab) {
  if (tab.private) return;
  pendingTitleTabs.add(tab.id);
  if (!titleSaveTimer) { titleSaveTimer = setTimeout(flushTitleChanges, 250); titleSaveTimer.unref(); }
}
function forgetPendingTitles() {
  if (titleSaveTimer) clearTimeout(titleSaveTimer);
  titleSaveTimer = null;
  pendingTitleTabs.clear();
}
function persistSession() {
  if (!profile || restoring) return;
  if (!profile.data.settings.restoreSession) {
    if (profile.data.session.tabs.length) profile.resetSession();
    return;
  }
  const normal = orderedTabs().filter((tab) => !tab.private && (!tab.popup || isAllowedUrl(tab.url)));
  profile.data.session = {
    tabs: normal.map((tab) => ({ url: tab.url, title: tab.title, pinned: tab.pinned, zoomFactor: tabContents(tab)?.getZoomFactor() || tab.zoomFactor })),
    activeIndex: Math.max(0, normal.findIndex((tab) => tab.id === activeTabId)),
  };
  saveProfile();
}
function layoutActiveView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tab = activeTab();
  const nextView = !panelOpen && (tab?.url || tab?.popup) && !tab.error && contentBounds.width > 0 && contentBounds.height > 0 ? tab.view : null;
  if (attachedView && attachedView !== nextView) {
    mainWindow.contentView.removeChildView(attachedView);
    attachedView = null;
  }
  if (!nextView || nextView.webContents.isDestroyed()) return;
  if (attachedView !== nextView) {
    mainWindow.contentView.addChildView(nextView);
    attachedView = nextView;
  }
  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  nextView.setBounds(htmlFullscreen ? { x: 0, y: 0, width: windowWidth, height: windowHeight } : {
    x: Math.min(contentBounds.x, windowWidth), y: Math.min(contentBounds.y, windowHeight),
    width: Math.min(contentBounds.width, Math.max(0, windowWidth - contentBounds.x)),
    height: Math.min(contentBounds.height, Math.max(0, windowHeight - contentBounds.y)),
  });
}
function setTabError(tab, message) {
  tab.error = message;
  tab.loading = false;
  layoutActiveView();
  publish();
}
function displayTitle(url) {
  try { return new URL(url).hostname; } catch { return 'علامة تبويب جديدة'; }
}
function permissionKeys(permission, details = {}) {
  if (permission !== 'media') return [permission];
  const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
  const valid = [...new Set(types.filter((type) => type === 'audio' || type === 'video'))];
  return valid.length ? valid.map((type) => `media:${type}`) : ['media'];
}
function permissionLabel(permission) {
  return ({ 'media:audio': 'الميكروفون', 'media:video': 'الكاميرا', media: 'الكاميرا والميكروفون',
    geolocation: 'الموقع الجغرافي', notifications: 'الإشعارات', fullscreen: 'ملء الشاشة',
    pointerLock: 'التحكّم بمؤشر الفأرة', 'clipboard-read': 'قراءة الحافظة',
    'clipboard-sanitized-write': 'النسخ إلى الحافظة', 'speaker-selection': 'اختيار مخرج الصوت' })[permission] || 'إذن الموقع';
}
function permissionDecision(isPrivate, origin, permission) {
  return isPrivate ? privatePermissions.get(JSON.stringify([origin, permission])) || 'ask' : profile.getPermission(origin, permission);
}
function rememberPermission(isPrivate, origin, permission, decision) {
  if (isPrivate) privatePermissions.set(JSON.stringify([origin, permission]), decision);
  else profile.setPermission(origin, permission, decision);
}
function configurePermissions(targetSession, isPrivate) {
  targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const tab = [...tabs.values()].find((candidate) => tabContents(candidate) === contents);
    const origin = originOf(requestingOrigin);
    return Boolean(tab && tab.private === isPrivate && origin && supportedPermissions.has(permission) &&
      permissionKeys(permission, details).every((key) => permissionDecision(isPrivate, origin, key) === 'allow'));
  });
  targetSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const tab = [...tabs.values()].find((candidate) => tabContents(candidate) === contents);
    const origin = originOf(details.requestingUrl) || originOf(details.securityOrigin) || originOf(contents.getURL());
    if (!tab || tab.private !== isPrivate || !origin || !supportedPermissions.has(permission) || !mainWindow || mainWindow.isDestroyed()) {
      callback(false); return;
    }
    const keys = permissionKeys(permission, details);
    const decisions = keys.map((key) => permissionDecision(isPrivate, origin, key));
    if (decisions.some((decision) => decision === 'block')) { callback(false); return; }
    if (decisions.every((decision) => decision === 'allow')) { callback(true); return; }
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question', buttons: ['حظر', 'سماح'], defaultId: 0, cancelId: 0, noLink: true,
        title: 'إذن الموقع', message: `${new URL(origin).hostname} يطلب الوصول إلى ${keys.map(permissionLabel).join('، ')}.`,
        detail: 'امنح الإذن فقط للموقع الذي تثق به.',
        checkboxLabel: isPrivate ? 'تذكّر القرار خلال جلسة التصفح الخاص' : 'تذكّر القرار لهذا الموقع', checkboxChecked: true,
      });
      const allow = result.response === 1 && !contents.isDestroyed() && tabs.has(tab.id);
      if (result.checkboxChecked && tabs.has(tab.id)) {
        for (const key of keys) rememberPermission(isPrivate, origin, key, allow ? 'allow' : 'block');
        publish();
      }
      callback(allow);
    } catch { callback(false); }
  });
}
function configureDownloads(targetSession, isPrivate) {
  targetSession.on('will-download', (_event, item) => {
    const id = randomUUID();
    const cleaned = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_');
    const filename = cleaned && !/^\.+$/u.test(cleaned) ? cleaned : 'download';
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), filename) });
    const download = { id, filename, state: 'progressing', received: 0, total: item.getTotalBytes(), isPrivate };
    downloads.set(id, download);
    downloadItems.set(id, item);
    while (downloads.size > 100) {
      const removable = [...downloads.values()].find((entry) => !downloadItems.has(entry.id));
      if (!removable) break;
      downloads.delete(removable.id);
    }
    publish();
    let lastPublished = 0;
    item.on('updated', (_updateEvent, downloadState) => {
      download.state = item.isPaused() ? 'paused' : downloadState;
      download.received = item.getReceivedBytes();
      download.total = item.getTotalBytes();
      if (Date.now() - lastPublished > 150) { lastPublished = Date.now(); publish(); }
    });
    item.once('done', (_doneEvent, downloadState) => {
      download.state = downloadState;
      download.received = item.getReceivedBytes();
      download.total = item.getTotalBytes();
      download.path = item.getSavePath();
      if (downloadState === 'completed' || downloadState === 'cancelled' || !item.canResume()) downloadItems.delete(id);
      publish();
    });
  });
}
function configureSession() {
  browserSession = session.fromPartition('persist:mini-browser');
  configurePermissions(browserSession, false);
  configureDownloads(browserSession, false);
}
function getPrivateSession() {
  if (!privateSession) {
    privateSession = session.fromPartition(`private-${randomUUID()}`);
    configurePermissions(privateSession, true);
    configureDownloads(privateSession, true);
  }
  return privateSession;
}
function discardPrivateSession() {
  if ([...tabs.values()].some((tab) => tab.private)) return;
  const previous = privateSession;
  privateSession = null;
  privatePermissions.clear();
  for (const [id, download] of downloads) {
    if (download.isPrivate) { downloads.delete(id); downloadItems.delete(id); }
  }
  if (previous) Promise.all([previous.clearStorageData(), previous.clearCache()]).catch((error) => console.warn('Could not clear private session:', error.message));
}
function showPanel(name) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.focus();
  mainWindow.webContents.send('browser:show-panel', name);
}
function setZoom(factor, tab = activeTab()) {
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0.25 || factor > 5) throw new Error('Zoom must be between 25% and 500%.');
  if (tab) {
    tab.zoomFactor = Math.round(factor * 100) / 100;
    tabContents(tab)?.setZoomFactor(tab.zoomFactor);
    persistSession(); publish();
  }
  return state();
}
function changeZoom(delta) {
  const current = tabContents()?.getZoomFactor() || activeTab()?.zoomFactor || 1;
  return setZoom(Math.min(5, Math.max(0.25, current + delta)));
}
function requirePage() {
  const contents = tabContents();
  if (!contents || (!activeTab()?.url && !activeTab()?.popup) || activeTab().error) throw new Error('افتح صفحة أولًا.');
  return contents;
}
function safePageName(contents, extension) {
  const title = contents.getTitle().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim().slice(0, 100) || 'page';
  return `${title}${extension}`;
}
async function printPage() {
  const contents = requirePage();
  await new Promise((resolve, reject) => contents.print({ printBackground: true }, (success, reason) => success ? resolve() : reject(new Error(reason || 'لم تكتمل الطباعة.'))));
  return state();
}
async function savePDF() {
  const contents = requirePage();
  const result = await dialog.showSaveDialog(mainWindow, { title: 'حفظ الصفحة بصيغة PDF', defaultPath: path.join(app.getPath('downloads'), safePageName(contents, '.pdf')), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!result.canceled && result.filePath) {
    const bytes = await contents.printToPDF({ printBackground: true });
    await fs.promises.writeFile(result.filePath, bytes);
  }
  return state();
}
async function savePage() {
  const contents = requirePage();
  const result = await dialog.showSaveDialog(mainWindow, { title: 'حفظ صفحة الويب', defaultPath: path.join(app.getPath('downloads'), safePageName(contents, '.html')), filters: [{ name: 'HTML', extensions: ['html', 'htm'] }] });
  if (!result.canceled && result.filePath) await contents.savePage(result.filePath, 'HTMLComplete');
  return state();
}
function installPageContextMenu(tab) {
  const contents = tabContents(tab);
  contents.on('context-menu', (_event, params) => {
    const items = [];
    if (isAllowedUrl(params.linkURL)) {
      items.push({ label: 'فتح الرابط في تبويب جديد', click: () => createTab(params.linkURL, { background: true, isPrivate: tab.private }) },
        { label: 'فتح الرابط في تبويب خاص', click: () => createTab(params.linkURL, { isPrivate: true }) },
        { label: 'نسخ الرابط', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
    }
    if (params.mediaType === 'image') {
      items.push({ label: 'نسخ الصورة', click: () => contents.copyImageAt(params.x, params.y) });
      if (isAllowedUrl(params.srcURL)) items.push({ label: 'حفظ الصورة', click: () => contents.downloadURL(params.srcURL) });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
        items.push({ type: 'separator' });
      }
      items.push({ label: 'تراجع', role: 'undo' }, { label: 'إعادة', role: 'redo' }, { type: 'separator' },
        { label: 'قص', role: 'cut' }, { label: 'نسخ', role: 'copy' }, { label: 'لصق', role: 'paste' }, { label: 'تحديد الكل', role: 'selectAll' }, { type: 'separator' });
    } else if (params.selectionText) {
      items.push({ label: 'نسخ النص', click: () => clipboard.writeText(params.selectionText) },
        { label: 'البحث عن النص', click: () => createTab(params.selectionText, { isPrivate: tab.private }) }, { type: 'separator' });
    }
    items.push({ label: 'رجوع', enabled: historyAvailable(tab, 'back'), click: () => goHistory('back', tab) },
      { label: 'تقدّم', enabled: historyAvailable(tab, 'forward'), click: () => goHistory('forward', tab) },
      { label: 'إعادة تحميل', click: () => reload(false, tab) },
      { label: 'بحث داخل الصفحة', click: () => showPanel('find') },
      { label: 'طباعة', click: () => printPage().catch(showActionError) },
      { label: 'حفظ PDF', click: () => savePDF().catch(showActionError) });
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
}
function showActionError(error) {
  if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, { type: 'error', title: 'تعذّر إتمام العملية', message: error.message }).catch(() => {});
}
function attachBrowserView(tab, nativeOptions = {}) {
  if (tab.view) return tab.view;
  const targetSession = tab.private ? getPrivateSession() : browserSession;
  const preferences = {
    ...(nativeOptions.webPreferences && typeof nativeOptions.webPreferences === 'object' ? nativeOptions.webPreferences : {}),
    session: targetSession,
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false,
    allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: true, plugins: true,
  };
  // Never let window.open features or inherited options introduce privileged preload code.
  delete preferences.preload;
  delete preferences.partition;
  const inheritedContents = nativeOptions.webContents && typeof nativeOptions.webContents.getLastWebPreferences === 'function' &&
    typeof nativeOptions.webContents.getURL === 'function' ? nativeOptions.webContents : null;
  if (inheritedContents) {
    const inherited = inheritedContents.getLastWebPreferences();
    if (inheritedContents.session !== targetSession || inherited.nodeIntegration || inherited.nodeIntegrationInWorker ||
      inherited.nodeIntegrationInSubFrames || inherited.webviewTag || inherited.preload || !inherited.contextIsolation || !inherited.sandbox || !inherited.webSecurity || inherited.allowRunningInsecureContent) {
      throw new Error('Unsafe popup WebContents.');
    }
  }
  const view = new WebContentsView({ ...(inheritedContents ? { webContents: inheritedContents } : {}), webPreferences: preferences });
  tab.view = view;
  const contents = view.webContents;
  contents.setZoomMode('isolated');
  contents.setAudioMuted(tab.muted);
  contents.setWindowOpenHandler((details) => {
    const blank = details.url === 'about:blank' || details.url === '';
    if ((!isAllowedUrl(details.url) && !blank) || tabs.size >= 50) return { action: 'deny' };
    return {
      action: 'allow', outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: { session: targetSession, nodeIntegration: false, nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false } },
      createWindow: (options) => createPopupTab(tab, details, options),
    };
  });
  const guardNavigation = (event, url) => {
    const initialPopupBlank = tab.popup && tab.nativeBlankAllowed && url === 'about:blank';
    if (!isAllowedUrl(url) && !initialPopupBlank) { event.preventDefault(); setTabError(tab, 'هذا الرابط يستخدم بروتوكولًا غير مدعوم. يدعم المتصفح HTTP وHTTPS.'); }
    else { tab.error = ''; layoutActiveView(); }
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => { if (isMainFrame) guardNavigation(event, url); });
  contents.on('did-start-loading', () => { tab.loading = true; publish(); });
  contents.on('did-stop-loading', () => { tab.loading = false; persistSession(); publish(); });
  const navigated = (_event, url, ...details) => {
    if (details.length && details[0] === false) return;
    if (!isAllowedUrl(url)) return;
    tab.nativeBlankAllowed = false;
    tab.url = url; tab.error = ''; tab.findResult = emptyFindResult(); tab.findText = '';
    layoutActiveView(); persistSession(); publish();
  };
  contents.on('did-navigate', (_event, url) => navigated(_event, url));
  contents.on('did-navigate-in-page', navigated);
  contents.on('page-title-updated', (_event, title) => {
    tab.title = !tab.url && !tab.popup ? 'علامة تبويب جديدة' : title.trim().slice(0, 250) || displayTitle(tab.url);
    queueTitleChange(tab); publish();
  });
  contents.on('did-finish-load', () => {
    if (tab.restoreZoom) { contents.setZoomFactor(tab.zoomFactor); tab.restoreZoom = false; }
    if (!tab.private && isAllowedUrl(tab.url) && !tab.error) {
      recordVisit(tab); tab.recordedUrl = tab.url;
    }
    persistSession(); publish();
  });
  contents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (isAllowedUrl(validatedURL)) tab.url = validatedURL;
    setTabError(tab, `تعذّر تحميل الصفحة (${description || code}). تحقّق من العنوان أو الاتصال ثم أعد المحاولة.`);
  });
  contents.on('render-process-gone', (_event, details) => setTabError(tab, `توقّف هذا التبويب (${details.reason}). أعد التحميل للمحاولة.`));
  contents.on('enter-html-full-screen', () => { if (activeTabId === tab.id) { htmlFullscreen = true; layoutActiveView(); } });
  contents.on('leave-html-full-screen', () => { htmlFullscreen = false; layoutActiveView(); });
  contents.on('found-in-page', (_event, result) => {
    tab.findResult = { matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal, finalUpdate: result.finalUpdate };
    if (activeTabId === tab.id && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser:find-result', tab.findResult);
    publish();
  });
  contents.on('zoom-changed', (_event, direction) => {
    const factor = contents.getZoomFactor() + (direction === 'in' ? 0.1 : -0.1);
    setZoom(Math.min(5, Math.max(0.25, factor)), tab);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  const closeNativeTab = () => {
    if (!quitting && mainWindow && !mainWindow.isDestroyed() && tabs.has(tab.id)) closeTab(tab.id);
  };
  contents.on('close', closeNativeTab);
  contents.on('destroyed', closeNativeTab);
  installPageContextMenu(tab);
  return view;
}
function navigateTab(tab, input, loadOptions = {}) {
  if (!tab) return state();
  let url;
  try { url = normalizeInput(input, profile.data.settings.searchEngine); } catch (error) { setTabError(tab, error.message); return state(); }
  tab.popup = false; tab.nativeBlankAllowed = false;
  tab.error = ''; tab.url = url; tab.title = url ? displayTitle(url) : 'علامة تبويب جديدة'; tab.loading = Boolean(url); tab.recordedUrl = '';
  tab.findResult = emptyFindResult(); tab.findText = '';
  if (!url) {
    const contents = tabContents(tab);
    if (contents) {
      contents.stop();
      // Trusted internal navigation discards the previous document, scripts and media.
      // The address-bar normalizer still never accepts about:, file: or script URLs.
      contents.loadURL('about:blank').catch((error) => {
        if (!contents.isDestroyed() && error.code !== 'ERR_ABORTED') console.warn('Could not unload previous page:', error.message);
      });
    }
    layoutActiveView(); persistSession(); publish(); return state();
  }
  const view = attachBrowserView(tab);
  layoutActiveView(); persistSession(); publish();
  view.webContents.loadURL(url, loadOptions).catch((error) => {
    if (!tabs.has(tab.id) || view.webContents.isDestroyed() || error.code === 'ERR_ABORTED') return;
    if (!tab.error) setTabError(tab, `تعذّر تحميل الصفحة (${error.code || error.message}). أعد المحاولة.`);
  });
  return state();
}
function createTab(input = '', { background = false, isPrivate = false, pinned = false, zoomFactor = 1, loadOptions = {} } = {}) {
  if (tabs.size >= 50) { dialog.showMessageBox(mainWindow, { type: 'info', message: 'أغلق تبويبًا قبل فتح تبويب آخر.', detail: 'يمكن فتح 50 تبويبًا في الوقت نفسه.' }); return state(); }
  const tab = { id: randomUUID(), title: 'علامة تبويب جديدة', url: '', loading: false, error: '', view: null,
    private: Boolean(isPrivate), pinned: Boolean(pinned), muted: false, zoomFactor, restoreZoom: zoomFactor !== 1, findText: '', findResult: emptyFindResult() };
  tabs.set(tab.id, tab);
  if (!background || !activeTabId) { activeTabId = tab.id; htmlFullscreen = false; }
  return navigateTab(tab, input, loadOptions);
}
function createPopupTab(opener, details, nativeOptions) {
  const blank = details.url === 'about:blank' || details.url === '';
  const tab = { id: randomUUID(), title: blank ? 'نافذة موقع' : displayTitle(details.url), url: blank ? '' : details.url,
    loading: !blank, error: '', view: null, private: opener.private, pinned: false, muted: false,
    zoomFactor: 1, restoreZoom: false, findText: '', findResult: emptyFindResult(), popup: true, nativeBlankAllowed: blank };
  tabs.set(tab.id, tab);
  if (details.disposition !== 'background-tab') { activeTabId = tab.id; htmlFullscreen = false; }
  try {
    const view = attachBrowserView(tab, nativeOptions);
    layoutActiveView(); persistSession(); publish();
    // Electron performs the native navigation and connects WindowProxy/opener itself.
    return view.webContents;
  } catch (error) {
    tabs.delete(tab.id); activeTabId = opener.id; layoutActiveView(); publish(); throw error;
  }
}
function activateTab(id) {
  if (typeof id !== 'string' || !tabs.has(id)) return state();
  activeTabId = id; htmlFullscreen = false; layoutActiveView(); persistSession(); publish(); return state();
}
function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return state();
  const ids = orderedTabs().map((entry) => entry.id);
  const index = ids.indexOf(id);
  if (!tab.private && isAllowedUrl(tab.url)) {
    closedTabs.push({ url: tab.url, title: tab.title, pinned: tab.pinned, zoomFactor: tabContents(tab)?.getZoomFactor() || tab.zoomFactor });
    if (closedTabs.length > 25) closedTabs.shift();
  }
  tabs.delete(id);
  if (activeTabId === id) activeTabId = ids[index + 1] || ids[index - 1] || null;
  htmlFullscreen = false; layoutActiveView();
  tabContents(tab)?.close({ waitForBeforeUnload: false });
  discardPrivateSession();
  if (!tabs.size) return createTab();
  if (!panelOpen) tabContents()?.focus();
  persistSession(); publish(); return state();
}
function reopenClosedTab() {
  const tab = closedTabs.pop();
  return tab ? createTab(tab.url, { pinned: tab.pinned, zoomFactor: tab.zoomFactor }) : state();
}
function duplicateTab(id) {
  const tab = tabs.get(id);
  return tab ? createTab(tab.url, { isPrivate: tab.private, zoomFactor: tabContents(tab)?.getZoomFactor() || tab.zoomFactor }) : state();
}
function pinTab(id) { const tab = tabs.get(id); if (tab) { tab.pinned = !tab.pinned; persistSession(); publish(); } return state(); }
function muteTab(id) { const tab = tabs.get(id); if (tab) { tab.muted = !tab.muted; tabContents(tab)?.setAudioMuted(tab.muted); publish(); } return state(); }
function toggleBookmark() {
  const tab = activeTab();
  if (!tab || !isAllowedUrl(tab.url)) return state();
  const previous = profile.data.bookmarks;
  profile.data.bookmarks = profile.data.bookmarks.some((bookmark) => bookmark.url === tab.url)
    ? profile.data.bookmarks.filter((bookmark) => bookmark.url !== tab.url)
    : [...profile.data.bookmarks, { title: tab.title, url: tab.url }].slice(-2000);
  try { profile.save(); } catch (error) { profile.data.bookmarks = previous; throw error; }
  publish(); return state();
}
function removeBookmark(url) {
  if (!isAllowedUrl(url)) throw new Error('Invalid bookmark.');
  const previous = profile.data.bookmarks;
  profile.data.bookmarks = profile.data.bookmarks.filter((bookmark) => bookmark.url !== url);
  try { profile.save(); } catch (error) { profile.data.bookmarks = previous; throw error; }
  publish(); return state();
}
function goHistory(direction, tab = activeTab()) {
  if (historyAvailable(tab, direction)) {
    tab.error = '';
    if (direction === 'back') tabContents(tab).navigationHistory.goBack(); else tabContents(tab).navigationHistory.goForward();
    layoutActiveView();
  }
  return state();
}
function reload(ignoreCache = false, tab = activeTab()) {
  if (!tab?.url && !tab?.popup) return state();
  if (!tabContents(tab) || tab.error) return navigateTab(tab, tab.url);
  if (ignoreCache) tabContents(tab).reloadIgnoringCache(); else tabContents(tab).reload();
  return state();
}
function updateBounds(bounds) {
  if (!bounds || typeof bounds !== 'object' || !['x', 'y', 'width', 'height'].every((key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 100000)) throw new Error('Invalid browser content bounds.');
  const [width, height] = mainWindow.getContentSize();
  const x = Math.min(Math.round(bounds.x), width); const y = Math.min(Math.round(bounds.y), height);
  contentBounds = { x, y, width: Math.min(Math.round(bounds.width), width - x), height: Math.min(Math.round(bounds.height), height - y) };
  layoutActiveView();
}
function findInPage(text, forward = true) {
  if (typeof text !== 'string' || text.length > 1000 || typeof forward !== 'boolean') throw new Error('Invalid page search.');
  if (!text.trim()) return stopFind();
  const tab = activeTab(); const contents = tabContents(tab);
  if (!contents) return state();
  contents.findInPage(text, { forward, findNext: tab.findText === text });
  tab.findText = text;
  return state();
}
function stopFind() {
  const tab = activeTab();
  if (tab) { tabContents(tab)?.stopFindInPage('clearSelection'); tab.findText = ''; tab.findResult = emptyFindResult(); publish(); }
  return state();
}
async function downloadAction(id, action) {
  if (typeof id !== 'string' || !['pause', 'resume', 'cancel', 'open', 'reveal'].includes(action)) throw new Error('Invalid download action.');
  const download = downloads.get(id); const item = downloadItems.get(id);
  if (!download) throw new Error('هذا التنزيل غير متاح.');
  if (action === 'open' || action === 'reveal') {
    if (download.state !== 'completed' || !download.path) throw new Error('انتظر اكتمال التنزيل.');
    const info = await fs.promises.stat(download.path);
    if (!info.isFile()) throw new Error('ملف التنزيل غير متاح.');
    if (action === 'open') { const error = await shell.openPath(download.path); if (error) throw new Error(error); }
    else shell.showItemInFolder(download.path);
  } else {
    if (!item) throw new Error('لا يمكن التحكم بهذا التنزيل بعد انتهائه.');
    if (action === 'pause') { item.pause(); download.state = 'paused'; }
    if (action === 'resume') {
      if (!item.isPaused() && !item.canResume()) throw new Error('لا يمكن استئناف هذا التنزيل.');
      item.resume(); download.state = 'progressing';
    }
    if (action === 'cancel') item.cancel();
  }
  publish(); return state();
}
function updateSettings(patch) {
  profile.updateSettings(patch);
  if (!profile.data.settings.restoreSession) profile.resetSession();
  publish(); return state();
}
async function clearBrowsingData(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || !['history', 'cookies', 'cache', 'permissions'].some((key) => options[key] === true) || Object.entries(options).some(([key, value]) => !['history', 'cookies', 'cache', 'permissions'].includes(key) || typeof value !== 'boolean')) throw new Error('اختر بيانات التصفح التي تريد مسحها.');
  const sessions = [browserSession, ...(privateSession ? [privateSession] : [])];
  if (options.cookies) await Promise.all(sessions.map((entry) => entry.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem'] })));
  if (options.cache) await Promise.all(sessions.map((entry) => entry.clearCache()));
  if (options.history) { forgetPendingTitles(); profile.clearHistory(); closedTabs.length = 0; }
  if (options.permissions) { profile.clearPermissions(); privatePermissions.clear(); }
  publish(); return state();
}
function resetSitePermission(origin, permission) {
  const normalized = originOf(origin);
  if (!normalized || (permission !== undefined && (typeof permission !== 'string' || permission.length > 100))) throw new Error('Invalid site permission.');
  if (activeTab()?.private) {
    for (const key of privatePermissions.keys()) { const [storedOrigin, storedPermission] = JSON.parse(key); if (storedOrigin === normalized && (!permission || permission === storedPermission)) privatePermissions.delete(key); }
  } else if (permission) profile.setPermission(normalized, permission, 'ask');
  else { delete profile.data.permissions[normalized]; profile.save(); }
  publish(); return state();
}
function registerIpc() {
  const handlers = {
    'get-state': () => state(), navigate: (input) => navigateTab(activeTab(), input),
    'new-tab': (input = '') => createTab(input), 'new-private-tab': (input = '') => createTab(input, { isPrivate: true }),
    'activate-tab': activateTab, 'close-tab': closeTab, 'reopen-closed-tab': reopenClosedTab,
    'duplicate-tab': duplicateTab, 'pin-tab': pinTab, 'mute-tab': muteTab,
    back: () => goHistory('back'), forward: () => goHistory('forward'), reload: () => reload(),
    stop: () => { tabContents()?.stop(); return state(); }, 'set-bounds': updateBounds,
    'toggle-bookmark': toggleBookmark, 'remove-bookmark': removeBookmark,
    'remove-history': (id) => { profile.removeHistory(id); publish(); return state(); },
    'clear-history': () => { forgetPendingTitles(); profile.clearHistory(); closedTabs.length = 0; publish(); return state(); },
    'find-in-page': findInPage, 'stop-find': stopFind, 'set-zoom': setZoom,
    'print-page': printPage, 'save-pdf': savePDF, 'save-page': savePage,
    'update-settings': updateSettings, 'clear-browsing-data': clearBrowsingData,
    'reset-site-permission': resetSitePermission, 'download-action': downloadAction,
    'set-panel-open': (open) => { if (typeof open !== 'boolean') throw new Error('Invalid panel state.'); panelOpen = open; layoutActiveView(); return state(); },
    'go-home': () => navigateTab(activeTab(), profile.data.settings.homeUrl),
    'open-downloads': async () => { const error = await shell.openPath(app.getPath('downloads')); if (error) throw new Error(error); },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`browser:${name}`, (event, ...args) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== chromeUrl) throw new Error('Browser controls are available only to the application window.');
      return handler(...args);
    });
  }
}
function focusAddress() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.focus(); mainWindow.webContents.send('browser:focus-address'); }
}
function cycleTab(delta) {
  const ids = orderedTabs().map((tab) => tab.id); const index = ids.indexOf(activeTabId);
  if (ids.length) activateTab(ids[(index + delta + ids.length) % ids.length]);
}
function installMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'ملف', submenu: [
      { label: 'تبويب جديد', accelerator: 'CmdOrCtrl+T', click: () => { createTab(); focusAddress(); } },
      { label: 'تبويب خاص جديد', accelerator: 'CmdOrCtrl+Shift+N', click: () => { createTab('', { isPrivate: true }); focusAddress(); } },
      { label: 'إغلاق التبويب', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabId) },
      { label: 'استعادة التبويب المغلق', accelerator: 'CmdOrCtrl+Shift+T', click: reopenClosedTab }, { type: 'separator' },
      { label: 'حفظ صفحة الويب', accelerator: 'CmdOrCtrl+S', click: () => savePage().catch(showActionError) },
      { label: 'حفظ PDF', click: () => savePDF().catch(showActionError) },
      { label: 'طباعة', accelerator: 'CmdOrCtrl+P', click: () => printPage().catch(showActionError) }, { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'عرض', submenu: [
      { label: 'شريط العنوان', accelerator: 'CmdOrCtrl+L', click: focusAddress },
      { label: 'بحث داخل الصفحة', accelerator: 'CmdOrCtrl+F', click: () => showPanel('find') },
      { label: 'إعادة تحميل', accelerator: 'CmdOrCtrl+R', click: () => reload() },
      { label: 'إعادة تحميل دون الذاكرة المؤقتة', accelerator: 'CmdOrCtrl+Shift+R', click: () => reload(true) },
      { label: 'رجوع', accelerator: 'Alt+Left', click: () => goHistory('back') },
      { label: 'تقدّم', accelerator: 'Alt+Right', click: () => goHistory('forward') },
      { label: 'تكبير الصفحة', accelerator: 'CmdOrCtrl+Plus', click: () => changeZoom(0.1) },
      { label: 'تصغير الصفحة', accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-0.1) },
      { label: 'الحجم الأصلي', accelerator: 'CmdOrCtrl+0', click: () => setZoom(1) }, { type: 'separator' },
      { role: 'togglefullscreen' },
      { label: 'أدوات المطوّر', accelerator: 'CmdOrCtrl+Shift+I', click: () => tabContents()?.toggleDevTools() },
    ] },
    { label: 'المكتبة', submenu: [
      { label: 'المفضّلة', accelerator: 'CmdOrCtrl+Shift+O', click: () => showPanel('bookmarks') },
      { label: 'إضافة الصفحة إلى المفضّلة', accelerator: 'CmdOrCtrl+D', click: toggleBookmark },
      { label: 'السجل', accelerator: 'CmdOrCtrl+H', click: () => showPanel('history') },
      { label: 'التنزيلات', accelerator: 'CmdOrCtrl+J', click: () => showPanel('downloads') },
      { label: 'الإعدادات', accelerator: 'CmdOrCtrl+,', click: () => showPanel('settings') },
    ] },
    { label: 'التبويبات', submenu: [
      { label: 'التبويب التالي', accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
      { label: 'التبويب السابق', accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) },
      ...Array.from({ length: 9 }, (_entry, index) => ({ label: `التبويب ${index + 1}`, accelerator: `Alt+${index + 1}`, click: () => { const list = orderedTabs(); const tab = index === 8 ? list.at(-1) : list[index]; if (tab) activateTab(tab.id); } })),
    ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function restoreTabs() {
  const saved = profile.data.settings.restoreSession ? profile.data.session : null;
  restoring = true;
  try {
    if (saved?.tabs?.length) {
      for (const tab of saved.tabs.slice(0, 50)) createTab(tab.url, { background: true, pinned: tab.pinned, zoomFactor: tab.zoomFactor || 1 });
      const list = orderedTabs();
      activeTabId = list[Math.min(saved.activeIndex || 0, list.length - 1)]?.id || list[0]?.id;
      layoutActiveView();
    } else createTab();
  } finally { restoring = false; }
  persistSession();
}
function createWindow() {
  panelOpen = false;
  mainWindow = new BrowserWindow({
    width: 1320, height: 900, minWidth: 760, minHeight: 540,
    title: 'مِدار', backgroundColor: '#f8fafc', autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== chromeUrl) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.on('resize', layoutActiveView);
  mainWindow.on('leave-full-screen', () => { htmlFullscreen = false; layoutActiveView(); });
  mainWindow.on('close', () => { flushTitleChanges(); persistSession(); });
  mainWindow.on('closed', () => {
    for (const tab of tabs.values()) tabContents(tab)?.close({ waitForBeforeUnload: false });
    tabs.clear(); attachedView = null; activeTabId = null; mainWindow = null;
    discardPrivateSession();
  });
  restoreTabs();
  mainWindow.loadFile(chromePath);
}
if (ownsProfileLock) app.whenReady().then(() => {
  profile = createProfileStore(app.getPath('userData'));
  configureSession(); registerIpc(); installMenu(); createWindow();
  app.on('activate', () => { if (!mainWindow && !quitting) createWindow(); });
}).catch((error) => { console.error('Could not start Mini Browser:', error); app.quit(); });
app.on('before-quit', () => { flushTitleChanges(); persistSession(); quitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
