'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { normalizeInput, isAllowedUrl } = require('./navigation');

if (process.env.MINI_BROWSER_USER_DATA) {
  const userDataPath = path.resolve(process.env.MINI_BROWSER_USER_DATA);
  fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
}

const chromePath = path.join(__dirname, 'renderer', 'index.html');
const chromeUrl = pathToFileURL(chromePath).href;
const tabs = new Map();
const downloads = new Map();
let mainWindow = null;
let browserSession;
let activeTabId = null;
let attachedView = null;
let bookmarks = [];
let contentBounds = { x: 0, y: 148, width: 0, height: 0 };
let htmlFullscreen = false;
let quitting = false;

function activeTab() {
  return tabs.get(activeTabId);
}

function historyAvailable(tab, direction) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) return false;
  return direction === 'back' ? contents.navigationHistory.canGoBack() : contents.navigationHistory.canGoForward();
}

function state() {
  const current = activeTab();
  return {
    tabs: [...tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      loading: tab.loading,
      canGoBack: historyAvailable(tab, 'back'),
      canGoForward: historyAvailable(tab, 'forward'),
      ...(tab.error ? { error: tab.error } : {}),
    })),
    activeTabId,
    bookmarks: bookmarks.map((bookmark) => ({ ...bookmark })),
    isBookmarked: Boolean(current?.url && bookmarks.some((bookmark) => bookmark.url === current.url)),
    downloads: [...downloads.values()].map((download) => ({ ...download })),
  };
}

function publish() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser:state', state());
  }
}

function layoutActiveView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tab = activeTab();
  const nextView = tab?.url && !tab.error && contentBounds.width > 0 && contentBounds.height > 0 ? tab.view : null;
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
  const bounds = htmlFullscreen ? { x: 0, y: 0, width: windowWidth, height: windowHeight } : {
    x: Math.min(contentBounds.x, windowWidth),
    y: Math.min(contentBounds.y, windowHeight),
    width: Math.min(contentBounds.width, Math.max(0, windowWidth - contentBounds.x)),
    height: Math.min(contentBounds.height, Math.max(0, windowHeight - contentBounds.y)),
  };
  nextView.setBounds(bounds);
}

function setTabError(tab, message) {
  tab.error = message;
  tab.loading = false;
  layoutActiveView();
  publish();
}

function displayTitle(url) {
  try { return new URL(url).hostname; } catch { return 'New tab'; }
}

function attachBrowserView(tab) {
  if (tab.view) return tab.view;
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: true,
    },
  });
  tab.view = view;
  const contents = view.webContents;
  contents.setWindowOpenHandler(({ url, disposition, referrer, postBody }) => {
    if (isAllowedUrl(url)) {
      const loadOptions = { httpReferrer: referrer };
      if (postBody) {
        loadOptions.postData = postBody.data;
        const boundary = postBody.boundary ? `; boundary=${postBody.boundary}` : '';
        loadOptions.extraHeaders = `Content-Type: ${postBody.contentType}${boundary}`;
      }
      createTab(url, { background: disposition === 'background-tab', loadOptions });
    } else setTabError(tab, 'This link uses an unsupported protocol. Only HTTP and HTTPS websites are supported.');
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      setTabError(tab, 'This link uses an unsupported protocol. Only HTTP and HTTPS websites are supported.');
    } else {
      tab.error = '';
      layoutActiveView();
    }
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame) guardNavigation(event, url);
  });
  contents.on('did-start-loading', () => {
    tab.loading = true;
    publish();
  });
  contents.on('did-stop-loading', () => {
    tab.loading = false;
    publish();
  });
  const navigated = (_event, url, ...details) => {
    // did-navigate-in-page includes an isMainFrame flag; subframes never change the address bar.
    if (details.length && details[0] === false) return;
    if (!isAllowedUrl(url)) return;
    tab.url = url;
    tab.error = '';
    layoutActiveView();
    publish();
  };
  contents.on('did-navigate', (_event, url) => navigated(_event, url));
  contents.on('did-navigate-in-page', navigated);
  contents.on('page-title-updated', (_event, title) => {
    tab.title = title.trim().slice(0, 250) || displayTitle(tab.url);
    publish();
  });
  contents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // A superseded navigation is not a failure.
    if (isAllowedUrl(validatedURL)) tab.url = validatedURL;
    setTabError(tab, `Could not load this page (${description || code}). Check the address or your connection, then try again.`);
  });
  contents.on('render-process-gone', (_event, details) => {
    setTabError(tab, `This tab stopped unexpectedly (${details.reason}). Reload to try again.`);
  });
  contents.on('enter-html-full-screen', () => {
    if (activeTabId === tab.id) {
      htmlFullscreen = true;
      layoutActiveView();
    }
  });
  contents.on('leave-html-full-screen', () => {
    htmlFullscreen = false;
    layoutActiveView();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  return view;
}

function navigateTab(tab, input, loadOptions = {}) {
  if (!tab) return state();
  let url;
  try {
    url = normalizeInput(input);
  } catch (error) {
    setTabError(tab, error.message);
    return state();
  }
  tab.error = '';
  tab.url = url;
  tab.title = url ? displayTitle(url) : 'New tab';
  tab.loading = Boolean(url);
  if (!url) {
    tab.view?.webContents.stop();
    layoutActiveView();
    publish();
    return state();
  }
  const view = attachBrowserView(tab);
  layoutActiveView();
  publish();
  view.webContents.loadURL(url, loadOptions).catch((error) => {
    if (!tabs.has(tab.id) || view.webContents.isDestroyed() || error.code === 'ERR_ABORTED') return;
    if (!tab.error) setTabError(tab, `Could not load this page (${error.code || error.message}). Try again.`);
  });
  return state();
}

function createTab(input = '', { background = false, loadOptions = {} } = {}) {
  if (tabs.size >= 50) {
    dialog.showMessageBox(mainWindow, { type: 'info', message: 'Close a tab before opening another.', detail: 'This browser supports up to 50 tabs at a time.' });
    return state();
  }
  const tab = { id: randomUUID(), title: 'New tab', url: '', loading: false, error: '', view: null };
  tabs.set(tab.id, tab);
  if (!background || !activeTabId) {
    activeTabId = tab.id;
    htmlFullscreen = false;
  }
  return navigateTab(tab, input, loadOptions);
}

function activateTab(id) {
  if (typeof id !== 'string' || !tabs.has(id)) return state();
  activeTabId = id;
  htmlFullscreen = false;
  layoutActiveView();
  publish();
  return state();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return state();
  const ids = [...tabs.keys()];
  const index = ids.indexOf(id);
  tabs.delete(id);
  if (activeTabId === id) activeTabId = ids[index + 1] || ids[index - 1] || null;
  htmlFullscreen = false;
  layoutActiveView();
  if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
  if (!tabs.size) return createTab();
  publish();
  return state();
}

function bookmarksFile() {
  return path.join(app.getPath('userData'), 'bookmarks.json');
}

function loadBookmarks() {
  try {
    const saved = JSON.parse(fs.readFileSync(bookmarksFile(), 'utf8'));
    if (Array.isArray(saved)) {
      bookmarks = saved.filter((item) => item && isAllowedUrl(item.url) && typeof item.title === 'string')
        .slice(0, 2000).map((item) => ({ url: item.url, title: item.title.slice(0, 250) }));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read saved bookmarks:', error.message);
  }
}

function toggleBookmark() {
  const tab = activeTab();
  if (!tab || !isAllowedUrl(tab.url)) return state();
  const previous = bookmarks;
  bookmarks = bookmarks.some((bookmark) => bookmark.url === tab.url)
    ? bookmarks.filter((bookmark) => bookmark.url !== tab.url)
    : [...bookmarks, { title: tab.title, url: tab.url }].slice(-2000);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const temporary = `${bookmarksFile()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(bookmarks, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, bookmarksFile());
  } catch (error) {
    bookmarks = previous;
    dialog.showErrorBox('Could not save bookmark', error.message);
  }
  publish();
  return state();
}

function goHistory(direction) {
  const tab = activeTab();
  if (historyAvailable(tab, direction)) {
    tab.error = '';
    if (direction === 'back') tab.view.webContents.navigationHistory.goBack();
    else tab.view.webContents.navigationHistory.goForward();
    layoutActiveView();
  }
  return state();
}

function reload(ignoreCache = false) {
  const tab = activeTab();
  if (!tab?.url) return state();
  if (!tab.view || tab.error) return navigateTab(tab, tab.url);
  if (ignoreCache) tab.view.webContents.reloadIgnoringCache();
  else tab.view.webContents.reload();
  return state();
}

function updateBounds(bounds) {
  if (!bounds || typeof bounds !== 'object' || !['x', 'y', 'width', 'height'].every((key) =>
    typeof bounds[key] === 'number' && Number.isFinite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 100000)) {
    throw new Error('Invalid browser content bounds.');
  }
  const [width, height] = mainWindow.getContentSize();
  const x = Math.min(Math.round(bounds.x), width);
  const y = Math.min(Math.round(bounds.y), height);
  contentBounds = {
    x, y,
    width: Math.min(Math.round(bounds.width), width - x),
    height: Math.min(Math.round(bounds.height), height - y),
  };
  layoutActiveView();
}

function registerIpc() {
  const handlers = {
    'get-state': () => state(),
    navigate: (input) => navigateTab(activeTab(), input),
    'new-tab': (input = '') => createTab(input),
    'activate-tab': activateTab,
    'close-tab': closeTab,
    back: () => goHistory('back'),
    forward: () => goHistory('forward'),
    reload: () => reload(),
    stop: () => {
      activeTab()?.view?.webContents.stop();
      return state();
    },
    'set-bounds': updateBounds,
    'toggle-bookmark': toggleBookmark,
    'open-downloads': async () => {
      const result = await shell.openPath(app.getPath('downloads'));
      if (result) throw new Error(result);
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`browser:${name}`, (event, ...args) => {
      if (!mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== chromeUrl) {
        throw new Error('Browser controls are available only to the application window.');
      }
      return handler(...args);
    });
  }
}

function configureSession() {
  browserSession = session.fromPartition('persist:mini-browser');
  // Electron otherwise grants permission checks by default. Returning false routes
  // each sensitive request through the native confirmation below.
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const allowedRequests = new Set(['media', 'geolocation', 'notifications', 'fullscreen', 'pointerLock', 'clipboard-read', 'clipboard-sanitized-write', 'speaker-selection']);
    const tab = [...tabs.values()].find((candidate) => candidate.view?.webContents === contents);
    const origin = details.requestingUrl || details.securityOrigin || contents.getURL();
    if (!tab || !isAllowedUrl(origin) || !allowedRequests.has(permission) || !mainWindow || mainWindow.isDestroyed()) {
      callback(false);
      return;
    }
    try {
      const hostname = new URL(origin).hostname;
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Block', 'Allow'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Website permission',
        message: `${hostname} wants permission for ${permission}.`,
        detail: details.mediaTypes?.length ? `Requested access: ${details.mediaTypes.join(', ')}. Allow only if you trust this website.` : 'Allow only if you trust this website.',
      });
      callback(result.response === 1 && !contents.isDestroyed());
    } catch {
      callback(false);
    }
  });
  browserSession.on('will-download', (_event, item) => {
    const id = randomUUID();
    const filename = path.basename(item.getFilename()).replace(/[\u0000-\u001f]/gu, '') || 'download';
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), filename) });
    const download = { id, filename, state: 'progressing', received: 0, total: item.getTotalBytes() };
    downloads.set(id, download);
    while (downloads.size > 100) downloads.delete(downloads.keys().next().value);
    publish();
    let lastPublished = 0;
    item.on('updated', (_updateEvent, downloadState) => {
      download.state = item.isPaused() ? 'paused' : downloadState;
      download.received = item.getReceivedBytes();
      download.total = item.getTotalBytes();
      if (Date.now() - lastPublished > 150) {
        lastPublished = Date.now();
        publish();
      }
    });
    item.once('done', (_doneEvent, downloadState) => {
      download.state = downloadState;
      download.received = item.getReceivedBytes();
      download.total = item.getTotalBytes();
      publish();
    });
  });
}

function focusAddress() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus();
    mainWindow.webContents.send('browser:focus-address');
  }
}

function installMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => { createTab(); focusAddress(); } },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabId) },
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: focusAddress },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => reload() },
      { label: 'Reload Without Cache', accelerator: 'CmdOrCtrl+Shift+R', click: () => reload(true) },
      { label: 'Back', accelerator: 'Alt+Left', click: () => goHistory('back') },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => goHistory('forward') },
      { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: toggleBookmark },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
    ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 720,
    minHeight: 540,
    title: 'Mini Browser',
    backgroundColor: '#f8fafc',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== chromeUrl) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.on('resize', layoutActiveView);
  mainWindow.on('leave-full-screen', () => {
    htmlFullscreen = false;
    layoutActiveView();
  });
  mainWindow.on('closed', () => {
    for (const tab of tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    }
    tabs.clear();
    attachedView = null;
    activeTabId = null;
    mainWindow = null;
  });
  createTab();
  mainWindow.loadFile(chromePath);
}

app.whenReady().then(() => {
  loadBookmarks();
  configureSession();
  registerIpc();
  installMenu();
  createWindow();
  app.on('activate', () => {
    if (!mainWindow && !quitting) createWindow();
  });
}).catch((error) => {
  console.error('Could not start Mini Browser:', error);
  app.quit();
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
