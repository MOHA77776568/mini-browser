const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function waitUntil(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function readDownloadedFile(filePath, expected) {
  let lastError;
  return waitUntil(async () => {
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      if (contents === expected) return contents;
      lastError = new Error('The download did not contain the exact response bytes.');
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      lastError = error;
    }
    return false;
  }, `download bytes at ${filePath}`).catch(() => { throw lastError; });
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const chromeURL = pathToFileURL(path.join(root, 'src', 'renderer', 'index.html')).href;
  // Canonicalize Windows runner temporary paths before passing them to Chromium.
  const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mini-browser-test-')));
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const streams = new Set();
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://fixture.invalid').pathname;
    if (route === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="browser-test.txt"' });
      response.end('Mini Browser download works.');
      return;
    }
    if (route === '/slow-download') {
      const size = 8 * 1024 * 1024;
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Content-Disposition': 'attachment; filename="browser-slow.bin"' });
      let sent = 0;
      const timer = setInterval(() => {
        const chunk = Buffer.alloc(Math.min(32768, size - sent), 97);
        response.write(chunk);
        sent += chunk.length;
        if (sent === size) { clearInterval(timer); streams.delete(timer); response.end(); }
      }, 40);
      streams.add(timer);
      response.once('close', () => { clearInterval(timer); streams.delete(timer); });
      return;
    }
    if (route === '/cache.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>');
      return;
    }
    if (route === '/popup-reply') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Native popup reply</title><script>window.opener.postMessage({kind:"native-popup",cookie:document.cookie},location.origin);setTimeout(()=>window.close(),150)</script>');
      return;
    }
    if (route === '/popup-security') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Secure native popup</title><h1>Secure native popup</h1>');
      return;
    }
    const labels = { '/second': 'Second page', '/popup': 'Popup page', '/private': 'Private page', '/restored': 'Restored page' };
    const label = labels[route] || 'First page';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' });
    response.end(`<!doctype html><html><head><title>${label}</title></head><body><h1>${label}</h1><p>needle alpha needle beta needle</p><img src="/cache.svg" alt=""/><a id="next" href="/second">Next</a><a id="popup" target="_blank" href="/popup">Open tab</a><a id="download" href="/download">Download</a><a id="slow-download" href="/slow-download">Slow download</a><button onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1">Count</button><output id="count">0</output><button id="reply-popup" onclick="window.open('/popup-reply','reply-popup')">Popup reply</button><button id="blank-popup">Write popup</button><script>window.__popupMessages=[];addEventListener('message',event=>{if(event.origin===location.origin&&['native-popup','blank-popup'].includes(event.data?.kind))window.__popupMessages.push(event.data)});document.querySelector('#blank-popup').onclick=()=>{const child=window.open('about:blank','blank-popup');child.document.write('<!doctype html><title>Written popup</title><scr'+'ipt>window.opener.postMessage({kind:"blank-popup",cookie:document.cookie},'+JSON.stringify(location.origin)+');setTimeout(()=>window.close(),150)</scr'+'ipt>');child.document.close();};</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const args = [root, '--disable-gpu'];
  const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyValue) {
    const proxy = new URL(proxyValue);
    if (proxy.username || proxy.password) throw new Error('The Chromium test requires a proxy without inline credentials.');
    args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`);
  }
  let app;
  let page;
  let checks = 0;
  const passed = label => { checks++; console.log(`PASS ${label}`); };
  const launch = async () => {
    app = await electron.launch({ args, chromiumSandbox: process.env.MINI_BROWSER_CI_NO_SANDBOX !== '1', env: { ...process.env, MINI_BROWSER_USER_DATA: profile }, timeout: 30000 });
    // Restored WebContentsView pages can appear before the trusted browser chrome.
    page = await waitUntil(() => app.windows().find(candidate => !candidate.isClosed() && candidate.url() === chromeURL), 'trusted browser chrome');
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => Boolean(window.browser));
    await page.getByTestId('address-input').waitFor();
  };
  const state = () => page.evaluate(() => window.browser.getState());
  const active = async () => { const current = await state(); return current.tabs.find(tab => tab.id === current.activeTabId); };
  const nativeTitle = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  const waitURL = async (url, timeout = 10000) => {
    await page.waitForFunction(async expected => {
      const state = await window.browser.getState();
      const tab = state.tabs.find(tab => tab.id === state.activeTabId);
      return tab && tab.url === expected && !tab.loading && !tab.error;
    }, url, { timeout });
    const tab = await active();
    await waitUntil(() => app.evaluate(({ BrowserWindow }, { url, isPrivate }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const contents = window.contentView.children.find(view => view.webContents && view.webContents !== window.webContents)?.webContents;
      return contents && contents.getURL() === url && !contents.isLoading() && contents.session.isPersistent() !== isPrivate;
    }, { url, isPrivate: Boolean(tab.private) }), `actual active website load ${url}`, timeout);
  };
  const inSite = async script => {
    const tab = await active();
    return app.evaluate(async ({ BrowserWindow }, { url, isPrivate, script }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const contents = window.contentView.children.find(view => view.webContents && view.webContents !== window.webContents)?.webContents;
      if (!contents || contents.getURL() !== url || contents.session.isPersistent() === isPrivate) throw new Error(`The active website is not loaded: ${url}`);
      return contents.executeJavaScript(script, true);
    }, { url: tab.url, isPrivate: Boolean(tab.private), script });
  };
  const siteDetails = async () => {
    const tab = await active();
    return app.evaluate(({ BrowserWindow }, { url, isPrivate }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const contents = window.contentView.children.find(view => view.webContents && view.webContents !== window.webContents)?.webContents;
      if (!contents || contents.getURL() !== url || contents.session.isPersistent() === isPrivate) throw new Error(`No active website WebContents for ${url}`);
      const prefs = contents.getLastWebPreferences();
      return { id: contents.id, zoom: contents.getZoomFactor(), muted: contents.isAudioMuted(), persistent: contents.session.isPersistent(), preferences: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity } };
    }, { url: tab.url, isPrivate: Boolean(tab.private) });
  };
  const visibleWebsite = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some(view =>
    view.webContents && /^https?:/.test(view.webContents.getURL()) && (typeof view.getVisible !== 'function' || view.getVisible())));
  const openPanel = async name => {
    await page.getByTestId('menu-button').click();
    await page.getByTestId(`menu-${name}`).click();
    await page.getByTestId(`panel-${name}`).waitFor({ state: 'visible' });
  };
  const closePanel = async () => {
    await page.getByTestId('panel-close').click();
    await waitUntil(visibleWebsite, 'website view restored after panel close');
  };
  const prepareDownload = async (key, filePath) => {
    const tab = await active();
    await app.evaluate(({ app, session, webContents }, { key, filePath, fixtureURL, isPrivate }) => {
      const fixture = webContents.getAllWebContents().find(contents => contents.getURL() === fixtureURL && contents.session.isPersistent() !== isPrivate);
      if (!fixture) throw new Error(`The download fixture is not loaded: ${fixtureURL}`);
      const fixtureSession = fixture.session;
      const configuredSession = session.fromPartition('persist:mini-browser');
      const result = { requestedPath: filePath, state: 'waiting', fixtureWebContentsId: fixture.id, sessionStoragePath: fixtureSession.storagePath, sameAsConfiguredSession: fixtureSession === configuredSession };
      app.__miniBrowserSmokeDownloads ||= {};
      app.__miniBrowserSmokeDownloadItems ||= {};
      app.__miniBrowserSmokeDownloads[key] = result;
      // Use the actual session and app singleton: reconstructed sessions/globals differ on Windows.
      fixtureSession.once('will-download', (_event, item, sourceContents) => {
        item.setSavePath(filePath);
        app.__miniBrowserSmokeDownloadItems[key] = item;
        result.savePath = item.getSavePath();
        result.state = item.getState();
        result.sourceWebContentsId = sourceContents?.id;
        item.once('done', (_doneEvent, downloadState) => {
          result.savePath = item.getSavePath(); result.state = downloadState; result.receivedBytes = item.getReceivedBytes();
        });
      });
    }, { key, filePath, fixtureURL: tab.url, isPrivate: Boolean(tab.private) });
  };
  const downloadResult = key => app.evaluate(({ app }, key) => app.__miniBrowserSmokeDownloads?.[key], key);
  const popupReply = async (button, kind) => {
    const opener = await active();
    const openerContents = (await siteDetails()).id;
    const count = (await state()).tabs.length;
    await inSite(`document.querySelector(${JSON.stringify(button)}).click()`);
    const message = await waitUntil(() => app.evaluate(async ({ webContents }, { id, kind }) => {
      const contents = webContents.fromId(id);
      if (!contents || contents.isDestroyed()) throw new Error('The popup lost its opener.');
      return contents.executeJavaScript(`window.__popupMessages.find(message=>message.kind===${JSON.stringify(kind)})`);
    }, { id: openerContents, kind }), `native popup postMessage ${kind}`);
    await waitUntil(async () => { const current = await state(); return current.tabs.length === count && current.activeTabId === opener.id; }, 'native popup closes and restores its opener');
    return message;
  };
  try {
    await launch();
    assert.equal((await state()).tabs.length, 1);
    assert.equal(await nativeTitle(), 'مِدار');
    await page.screenshot({ path: path.join(artifacts, 'home.png') });
    passed('Arabic browser starts and renders its home page');

    await page.getByTestId('address-input').fill(`${origin}/`);
    await page.getByTestId('address-input').press('Enter');
    await waitURL(`${origin}/`);
    assert.equal(await inSite('document.querySelector("h1").textContent'), 'First page');
    await inSite('document.querySelector("button").click()');
    assert.equal(await inSite('document.querySelector("#count").textContent'), '1');
    passed('Address entry loads an interactive web page in a real WebContentsView');

    assert.deepEqual(await inSite('({ node: typeof require, bridge: typeof window.browser })'), { node: 'undefined', bridge: 'undefined' });
    assert.deepEqual((await siteDetails()).preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    passed('Websites cannot access Node.js or the browser control bridge');

    await inSite('document.title = "Sensitive website title"');
    await page.waitForFunction(async () => (await window.browser.getState()).tabs.some(tab => tab.title === 'Sensitive website title'));
    assert.equal(await nativeTitle(), 'مِدار');
    await page.evaluate(() => { document.title = 'Sensitive chrome title'; });
    assert.equal(await nativeTitle(), 'مِدار');
    passed('The operating-system window title never reveals page or tab titles');

    await inSite('document.querySelector("#next").click()');
    await waitURL(`${origin}/second`);
    await page.getByTestId('back').click(); await waitURL(`${origin}/`);
    await page.getByTestId('forward').click(); await waitURL(`${origin}/second`);
    passed('Links and history back/forward work');

    await page.getByTestId('bookmark').click();
    await page.waitForFunction(async url => (await window.browser.getState()).bookmarks.some(bookmark => bookmark.url === url), `${origin}/second`);
    await page.getByTestId('reload').click(); await waitURL(`${origin}/second`);
    passed('Bookmarks and reload work');

    await inSite('document.cookie = "mini_browser_smoke=remembered; Max-Age=3600; Path=/"');
    const normalId = (await active()).id;
    await inSite('document.querySelector("#popup").click()'); await waitURL(`${origin}/popup`);
    assert.equal((await state()).tabs.length, 2);
    await page.evaluate(async () => { const state = await window.browser.getState(); await window.browser.closeTab(state.activeTabId); });
    assert.equal((await state()).activeTabId, normalId);
    passed('Popup links open tabs; closing them restores the previous tab');
    await page.evaluate(() => window.browser.reopenClosedTab()); await waitURL(`${origin}/popup`);
    await page.evaluate(async () => { const state = await window.browser.getState(); await window.browser.closeTab(state.activeTabId); });
    passed('Recently closed normal tabs can be reopened');

    const reply = await popupReply('#reply-popup', 'native-popup');
    assert.ok(reply.cookie.includes('mini_browser_smoke=remembered'));
    const writtenReply = await popupReply('#blank-popup', 'blank-popup');
    assert.ok(writtenReply.cookie.includes('mini_browser_smoke=remembered'));
    assert.equal(await nativeTitle(), 'مِدار');
    passed('Native popups preserve opener messaging and script-written about:blank pages');

    const secureOpener = await active();
    const secureTabCount = (await state()).tabs.length;
    const hostileFeatures = 'nodeIntegration=yes,nodeIntegrationInWorker=yes,nodeIntegrationInSubFrames=yes,contextIsolation=no,sandbox=no,webSecurity=no,allowRunningInsecureContent=yes,webviewTag=yes,preload=/tmp/missing,partition=evil,webContents=yes';
    await inSite(`void window.open('/popup-security','secure-popup',${JSON.stringify(hostileFeatures)})`);
    await waitURL(`${origin}/popup-security`);
    assert.deepEqual((await siteDetails()).preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    assert.deepEqual(await inSite('({node:typeof require,bridge:typeof window.browser})'), { node: 'undefined', bridge: 'undefined' });
    assert.ok((await inSite('document.cookie')).includes('mini_browser_smoke=remembered'));
    const unsafePreferences = await app.evaluate(({ webContents }, url) => {
      const prefs = webContents.getAllWebContents().find(contents => contents.getURL() === url).getLastWebPreferences();
      return { worker: prefs.nodeIntegrationInWorker, subframes: prefs.nodeIntegrationInSubFrames, insecure: prefs.allowRunningInsecureContent, webview: prefs.webviewTag, preload: prefs.preload || '' };
    }, `${origin}/popup-security`);
    assert.ok(!unsafePreferences.worker && !unsafePreferences.subframes && !unsafePreferences.insecure && !unsafePreferences.webview && !unsafePreferences.preload);
    await inSite('window.close()');
    await waitUntil(async () => { const current = await state(); return current.tabs.length === secureTabCount && current.activeTabId === secureOpener.id; }, 'secure popup closes without closing the browser');
    passed('Popup features cannot enable Node, preload, insecure content or a foreign session');

    await page.evaluate(async () => { const state = await window.browser.getState(); await window.browser.duplicateTab(state.activeTabId); });
    await waitURL(`${origin}/second`);
    const workingId = (await active()).id;
    assert.notEqual(workingId, normalId);
    await page.evaluate(id => window.browser.closeTab(id), normalId);
    await page.evaluate(id => window.browser.pinTab(id), workingId);
    await page.evaluate(id => window.browser.muteTab(id), workingId);
    assert.equal((await active()).pinned, true);
    assert.equal((await siteDetails()).muted, true);
    await page.evaluate(id => window.browser.muteTab(id), workingId);
    passed('Tabs can be duplicated, pinned and muted through native website controls');

    await page.evaluate(url => window.browser.newTab(url), `${origin}/zoom-other`);
    await waitURL(`${origin}/zoom-other`);
    const otherZoomContents = (await siteDetails()).id;
    const otherZoomTab = (await active()).id;
    await page.evaluate(id => window.browser.activateTab(id), workingId);
    await page.evaluate(() => window.browser.setZoom(1.25));
    assert.ok(Math.abs((await siteDetails()).zoom - 1.25) < 0.001);
    assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).getZoomFactor(), otherZoomContents), 1);
    const chromeZoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
    assert.equal(chromeZoom, 1);
    await page.evaluate(() => window.browser.setZoom(1));
    await page.evaluate(id => window.browser.closeTab(id), otherZoomTab);
    passed('Website zoom changes without scaling browser chrome');

    await page.getByTestId('menu-button').click(); await page.getByTestId('menu-find').click();
    await page.getByTestId('find-input').waitFor({ state: 'visible' });
    await page.getByTestId('find-input').fill('needle');
    await page.waitForFunction(async () => (await window.browser.getState()).findResult.matches === 3);
    await page.screenshot({ path: path.join(artifacts, 'find.png') });
    await page.getByTestId('find-next').click();
    await page.getByTestId('find-close').click();
    await page.waitForFunction(async () => (await window.browser.getState()).findResult.matches === 0);
    passed('Find-in-page reports real website matches and clears its selection');

    await page.waitForFunction(async url => (await window.browser.getState()).history.some(visit => visit.url === url), `${origin}/second`);
    assert.equal(await visibleWebsite(), true);
    await openPanel('history');
    assert.equal(await visibleWebsite(), false);
    await page.getByTestId('history-search').fill('no-such-history-record-987654');
    assert.equal(await page.getByTestId('history-entry').count(), 0);
    await page.getByTestId('history-search').fill('Second');
    assert.ok(await page.getByTestId('history-entry').count() > 0);
    await page.screenshot({ path: path.join(artifacts, 'history.png') });
    await closePanel();
    passed('History search works in a usable panel above the native website view');

    await openPanel('settings');
    await page.getByTestId('setting-search-engine').selectOption('duckduckgo');
    await page.getByTestId('setting-theme').selectOption('dark');
    await page.waitForFunction(async () => { const state = await window.browser.getState(); return state.settings.searchEngine === 'duckduckgo' && state.settings.theme === 'dark'; });
    await page.getByTestId('setting-home-url').fill(`${origin}/`);
    await page.getByTestId('setting-home-url').press('Tab');
    await page.waitForFunction(async url => (await window.browser.getState()).settings.homeUrl === url, `${origin}/`);
    await page.screenshot({ path: path.join(artifacts, 'settings.png') });
    await closePanel();
    passed('Search, appearance and homepage settings can be changed from the interface');

    const pdfPath = path.join(profile, 'website.pdf');
    const htmlPath = path.join(profile, 'website.html');
    await app.evaluate(({ app, dialog }, filePath) => { app.__smokeSaveDialog = dialog.showSaveDialog; dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdfPath);
    try {
      await page.evaluate(() => window.browser.savePDF());
      const pdf = await fs.readFile(pdfPath); assert.equal(pdf.toString('ascii', 0, 5), '%PDF-'); assert.ok(pdf.length > 1000);
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, htmlPath);
      await page.evaluate(() => window.browser.savePage());
      assert.ok((await fs.readFile(htmlPath, 'utf8')).includes('Second page'));
    } finally { await app.evaluate(({ app, dialog }) => { dialog.showSaveDialog = app.__smokeSaveDialog; delete app.__smokeSaveDialog; }); }
    passed('The active website can be saved as a real PDF and HTML page');

    const downloadPath = path.join(profile, 'browser-test.txt');
    await prepareDownload('normal', downloadPath);
    await inSite('document.querySelector("#download").click()');
    const completed = await waitUntil(async () => { const result = await downloadResult('normal'); return result?.state === 'completed' && result; }, 'native download completion');
    assert.equal(await readDownloadedFile(completed.savePath, 'Mini Browser download works.'), 'Mini Browser download works.');
    assert.equal((await fs.realpath(completed.savePath)).toLowerCase(), (await fs.realpath(downloadPath)).toLowerCase());
    await page.waitForFunction(async () => (await window.browser.getState()).downloads.some(download => download.filename === 'browser-test.txt' && download.state === 'completed'));
    passed('Download saves the correct bytes and reports completion');

    const downloadId = (await state()).downloads.find(download => download.filename === 'browser-test.txt').id;
    await app.evaluate(({ app, shell }) => { app.__smokeOpenPath = shell.openPath; app.__smokeOpenedPaths = []; shell.openPath = async filePath => { app.__smokeOpenedPaths.push(filePath); return ''; }; });
    try {
      const rejected = await page.evaluate(async () => { try { await window.browser.downloadAction('unowned-download-id', 'open'); return false; } catch { return true; } });
      assert.equal(rejected, true);
      assert.deepEqual(await app.evaluate(({ app }) => app.__smokeOpenedPaths), []);
      await page.evaluate(id => window.browser.downloadAction(id, 'open'), downloadId);
      assert.deepEqual(await app.evaluate(({ app }) => app.__smokeOpenedPaths), [completed.savePath]);
    } finally { await app.evaluate(({ app, shell }) => { shell.openPath = app.__smokeOpenPath; delete app.__smokeOpenPath; }); }
    const slowPath = path.join(profile, 'browser-slow.bin');
    await prepareDownload('slow', slowPath);
    await inSite('document.querySelector("#slow-download").click()');
    const slow = await waitUntil(async () => (await state()).downloads.find(download => download.filename === 'browser-slow.bin'), 'slow download start');
    await page.evaluate(id => window.browser.downloadAction(id, 'pause'), slow.id);
    assert.equal(await app.evaluate(({ app }) => app.__miniBrowserSmokeDownloadItems.slow.isPaused()), true);
    await page.evaluate(id => window.browser.downloadAction(id, 'resume'), slow.id);
    assert.equal(await app.evaluate(({ app }) => app.__miniBrowserSmokeDownloadItems.slow.isPaused()), false);
    await page.evaluate(id => window.browser.downloadAction(id, 'cancel'), slow.id);
    await waitUntil(async () => (await downloadResult('slow'))?.state === 'cancelled', 'native download cancellation');
    await page.waitForFunction(async id => (await window.browser.getState()).downloads.some(download => download.id === id && download.state === 'cancelled'), slow.id);
    await openPanel('downloads');
    await page.screenshot({ path: path.join(artifacts, 'downloads.png') });
    await closePanel();
    passed('Downloads can be paused, resumed, cancelled and opened only through owned IDs');

    await app.evaluate(({ app, dialog }) => { app.__smokeMessageBox = dialog.showMessageBox; app.__smokePermissionPrompts = 0; dialog.showMessageBox = async () => { app.__smokePermissionPrompts++; return { response: 1, checkboxChecked: true }; }; });
    try {
      await inSite('new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve("located"), error => resolve(error.code), {timeout:1000}))');
      await page.waitForFunction(async origin => (await window.browser.getState()).permissions.some(entry => entry.origin === origin && entry.permission === 'geolocation' && entry.decision === 'allow'), origin);
      assert.ok(await app.evaluate(({ app }) => app.__smokePermissionPrompts) > 0);
    } finally { await app.evaluate(({ app, dialog }) => { dialog.showMessageBox = app.__smokeMessageBox; delete app.__smokeMessageBox; }); }
    passed('A real website permission request can be remembered for its origin');

    const historyBeforePrivate = (await state()).history;
    await page.getByTestId('private-tab').click();
    await page.evaluate(url => window.browser.navigate(url), `${origin}/private?generation=1`);
    await waitURL(`${origin}/private?generation=1`);
    assert.equal((await active()).private, true);
    assert.equal((await siteDetails()).persistent, false);
    await page.getByTestId('private-indicator').waitFor({ state: 'visible' });
    assert.equal(await inSite('document.cookie'), '');
    await inSite('document.cookie = "private_smoke=secret; Path=/"');
    const privateReply = await popupReply('#reply-popup', 'native-popup');
    assert.ok(privateReply.cookie.includes('private_smoke=secret'));
    assert.ok(!privateReply.cookie.includes('mini_browser_smoke=remembered'));
    assert.deepEqual((await state()).history, historyBeforePrivate);
    await page.screenshot({ path: path.join(artifacts, 'private.png') });
    assert.ok(!(await state()).history.some(visit => visit.url.includes('/private')));
    await page.evaluate(async () => { const state = await window.browser.getState(); await window.browser.closeTab(state.activeTabId); });
    await page.evaluate(() => window.browser.reopenClosedTab());
    assert.equal((await active()).private, false);
    assert.ok(!(await active()).url.includes('/private'));
    await page.evaluate(async () => { const state = await window.browser.getState(); await window.browser.closeTab(state.activeTabId); });
    await page.evaluate(url => window.browser.newPrivateTab(url), `${origin}/private?generation=2`);
    await waitURL(`${origin}/private?generation=2`);
    assert.equal(await inSite('document.cookie'), '');
    passed('Private tabs isolate cookies, omit history and are excluded from reopening');

    await page.evaluate(url => window.browser.newTab(url), `${origin}/restored`);
    await waitURL(`${origin}/restored`);
    assert.ok((await inSite('document.cookie')).includes('mini_browser_smoke=remembered'));
    assert.ok(!(await inSite('document.cookie')).includes('private_smoke'));
    const unsafe = await page.evaluate(async () => { try { const state = await window.browser.navigate('file:///etc/passwd'); return Boolean(state.tabs.find(tab => tab.id === state.activeTabId).error); } catch { return true; } });
    assert.equal(unsafe, true);
    passed('Address bar rejects local file URLs');
    await page.evaluate(url => window.browser.navigate(url), `${origin}/restored`); await waitURL(`${origin}/restored`);
    assert.equal(await nativeTitle(), 'مِدار');

    if (process.env.MINI_BROWSER_TEST_HTTPS_URL) {
      const url = process.env.MINI_BROWSER_TEST_HTTPS_URL;
      await page.evaluate(url => window.browser.newTab(url), url); await waitURL(url, 45000);
      const result = await inSite('({protocol:location.protocol,text:document.body.innerText.length})');
      assert.equal(result.protocol, 'https:'); assert.ok(result.text > 200);
      await page.screenshot({ path: path.join(artifacts, 'https.png') });
      await page.evaluate(async () => { const state = await window.browser.getState(); await window.browser.closeTab(state.activeTabId); });
      passed('External HTTPS browsing uses verified TLS through the configured proxy');
    }

    await app.close(); app = null; await launch();
    await waitURL(`${origin}/restored`);
    const restored = await state();
    assert.ok(restored.bookmarks.some(bookmark => bookmark.url === `${origin}/second`));
    passed('Bookmarks survive a full application restart');
    assert.ok((await inSite('document.cookie')).includes('mini_browser_smoke=remembered'));
    passed('Website cookies survive a full application restart');
    assert.ok(restored.tabs.some(tab => tab.url === `${origin}/second` && tab.pinned));
    assert.ok(restored.tabs.every(tab => !tab.private && !tab.url.includes('/private')));
    assert.ok(restored.history.some(visit => visit.url === `${origin}/second`));
    assert.ok(restored.history.every(visit => !visit.url.includes('/private')));
    assert.equal(restored.settings.searchEngine, 'duckduckgo'); assert.equal(restored.settings.theme, 'dark');
    assert.ok(restored.permissions.some(entry => entry.origin === origin && entry.permission === 'geolocation'));
    assert.equal(await nativeTitle(), 'مِدار');
    passed('Normal sessions, history, settings and permissions restore while private tabs do not');

    await page.evaluate(url => window.browser.removeBookmark(url), `${origin}/second`);
    assert.ok(!(await state()).bookmarks.some(bookmark => bookmark.url === `${origin}/second`));
    const visit = (await state()).history.find(visit => visit.url === `${origin}/second`);
    await page.evaluate(id => window.browser.removeHistory(id), visit.id);
    assert.ok(!(await state()).history.some(entry => entry.id === visit.id));
    await page.evaluate(origin => window.browser.resetSitePermission(origin, 'geolocation'), origin);
    assert.ok(!(await state()).permissions.some(entry => entry.origin === origin && entry.permission === 'geolocation'));
    passed('Individual bookmarks, history records and remembered permissions can be removed');

    await app.evaluate(({ app, dialog }) => { app.__smokeMessageBox = dialog.showMessageBox; dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: true }); });
    try {
      await inSite('new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve("located"), error => resolve(error.code), {timeout:1000}))');
      await page.waitForFunction(async origin => (await window.browser.getState()).permissions.some(entry => entry.origin === origin && entry.permission === 'geolocation'), origin);
    } finally { await app.evaluate(({ app, dialog }) => { dialog.showMessageBox = app.__smokeMessageBox; delete app.__smokeMessageBox; }); }

    await inSite('document.cookie="clear_test=remove; Max-Age=3600; Path=/"; localStorage.setItem("clear_test","remove")');
    await page.evaluate(() => window.browser.clearBrowsingData({ history: true, cookies: true, cache: true, permissions: true }));
    assert.deepEqual((await state()).history, []); assert.deepEqual((await state()).permissions, []);
    assert.equal(await inSite('document.cookie'), ''); assert.equal(await inSite('localStorage.getItem("clear_test")'), null);
    const cacheSize = await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find(contents => contents.getURL().startsWith(origin) && contents.session.isPersistent()).session.getCacheSize(), origin);
    assert.equal(cacheSize, 0);
    passed('Browsing-data controls clear website cookies, storage, cache and history');

    const homeTab = await active();
    const priorContents = (await siteDetails()).id;
    await inSite('setTimeout(()=>location.href="/unexpected-home-timer",500)');
    await page.evaluate(() => window.browser.updateSettings({ homeUrl: '' }));
    await page.evaluate(() => window.browser.goHome());
    await waitUntil(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL() === 'about:blank', priorContents), 'the previous website document unloads on Home');
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal((await active()).id, homeTab.id);
    assert.equal((await active()).url, '');
    assert.equal(await visibleWebsite(), false);
    assert.equal(await nativeTitle(), 'مِدار');
    await page.locator('#home-page').waitFor({ state: 'visible' });
    passed('Home unloads the old website so delayed scripts cannot revive it');
    await page.screenshot({ path: path.join(artifacts, 'browsing.png') });
    console.log(`Completed ${checks} functional checks.`);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (app) await app.close();
    for (const timer of streams) clearInterval(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
