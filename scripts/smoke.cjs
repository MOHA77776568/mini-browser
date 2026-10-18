const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

async function readDownloadedFile(filePath, expected, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let contents;
  let lastError;
  while (true) {
    try {
      contents = await fs.readFile(filePath, 'utf8');
      lastError = null;
      if (contents === expected) return contents;
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) {
      if (lastError) throw lastError;
      assert.equal(contents, expected, 'The downloaded file must contain the exact response bytes.');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function main() {
  const root = path.resolve(__dirname, '..');
  // Windows runners may expose the temporary directory through an 8.3 alias.
  const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mini-browser-test-')));
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const server = http.createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="browser-test.txt"' });
      response.end('Mini Browser download works.');
      return;
    }
    const label = request.url === '/second' ? 'Second page' : request.url === '/popup' ? 'Popup page' : 'First page';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>${label}</title></head><body><h1>${label}</h1><a id="next" href="/second">Next</a><a id="popup" target="_blank" href="/popup">Open tab</a><a id="download" href="/download">Download</a><button onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1">Count</button><output id="count">0</output></body></html>`);
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
  const launch = async () => {
    app = await electron.launch({ args, chromiumSandbox: process.env.MINI_BROWSER_CI_NO_SANDBOX !== '1', env: { ...process.env, MINI_BROWSER_USER_DATA: profile }, timeout: 30000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => Boolean(window.browser));
    await page.getByTestId('address-input').waitFor();
  };
  const state = () => page.evaluate(() => window.browser.getState());
  const waitURL = async (url, timeout = 10000) => {
    await page.waitForFunction(async expected => { const state = await window.browser.getState(); const tab = state.tabs.find(tab => tab.id === state.activeTabId); return tab && tab.url === expected && !tab.loading && !tab.error; }, url, { timeout });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(contents => contents.getURL() === url && !contents.isLoading()), url)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Website did not finish loading ${url}`);
  };
  const inSite = script => app.evaluate(async ({ webContents }, { origin, script }) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(origin));
    if (!contents) throw new Error(`Expected actual website WebContents for ${origin}; found ${JSON.stringify(webContents.getAllWebContents().map(content => ({ id: content.id, url: content.getURL(), type: content.getType() })))}`);
    return contents.executeJavaScript(script, true);
  }, { origin, script });
  let checks = 0;
  const passed = label => { checks++; console.log(`PASS ${label}`); };
  try {
    await launch();
    assert.equal((await state()).tabs.length, 1);
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
    const preferences = await app.evaluate(({ webContents }, origin) => { const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(origin)); const prefs = contents.getLastWebPreferences(); return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity }; }, origin);
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    passed('Websites cannot access Node.js or the browser control bridge');

    await inSite('document.querySelector("#next").click()');
    await waitURL(`${origin}/second`);
    await page.getByTestId('back').click();
    await waitURL(`${origin}/`);
    await page.getByTestId('forward').click();
    await waitURL(`${origin}/second`);
    passed('Links and history back/forward work');

    await page.getByTestId('bookmark').click();
    await page.waitForFunction(async url => (await window.browser.getState()).bookmarks.some(bookmark => bookmark.url === url), `${origin}/second`);
    await page.getByTestId('reload').click();
    await waitURL(`${origin}/second`);
    await page.screenshot({ path: path.join(artifacts, 'browsing.png') });
    passed('Bookmarks and reload work');

    const firstTabId = (await state()).activeTabId;
    await inSite('document.cookie = "mini_browser_smoke=remembered; Max-Age=3600; Path=/"');
    await inSite('document.querySelector("#popup").click()');
    await waitURL(`${origin}/popup`);
    assert.equal((await state()).tabs.length, 2);
    await page.evaluate(async () => { const state = await window.browser.getState(); await window.browser.closeTab(state.activeTabId); });
    assert.equal((await state()).activeTabId, firstTabId);
    passed('Popup links open tabs; closing them restores the previous tab');

    // Stub only the OS picker, so download bytes, completion and filesystem output are real.
    const downloadPath = path.join(profile, 'browser-test.txt');
    await app.evaluate(({ session }, filePath) => {
      globalThis.__miniBrowserSmokeDownload = null;
      session.fromPartition('persist:mini-browser').once('will-download', (_event, item) => {
        item.setSavePath(filePath);
        const result = { requestedPath: filePath, savePath: item.getSavePath(), state: item.getState() };
        globalThis.__miniBrowserSmokeDownload = result;
        item.once('done', (_doneEvent, downloadState) => {
          result.savePath = item.getSavePath();
          result.state = downloadState;
          result.receivedBytes = item.getReceivedBytes();
        });
      });
    }, downloadPath);
    try {
      await inSite('document.querySelector("#download").click()');
      await page.waitForFunction(async () => (await window.browser.getState()).downloads.some(download => download.state === 'completed'));
      const result = await app.evaluate(() => globalThis.__miniBrowserSmokeDownload);
      assert.equal(result?.state, 'completed', 'The native download must report successful completion.');
      assert.ok(result.savePath, 'Electron must report the actual download destination.');
      assert.equal(await readDownloadedFile(result.savePath, 'Mini Browser download works.'), 'Mini Browser download works.');
      const actualPath = await fs.realpath(result.savePath);
      const requestedPath = await fs.realpath(downloadPath);
      assert.equal(process.platform === 'win32' ? actualPath.toLowerCase() : actualPath,
        process.platform === 'win32' ? requestedPath.toLowerCase() : requestedPath,
        'The download must be saved at the requested destination.');
    } catch (error) {
      const result = await app.evaluate(() => globalThis.__miniBrowserSmokeDownload).catch(() => null);
      const profileFiles = await fs.readdir(profile).catch(() => []);
      throw new Error(`Download verification failed. Native download: ${JSON.stringify(result)}; test profile files: ${JSON.stringify(profileFiles)}. ${error.message}`, { cause: error });
    }
    passed('Download saves the correct bytes and reports completion');

    const unsafe = await page.evaluate(async () => { try { const state = await window.browser.navigate('file:///etc/passwd'); return Boolean(state.tabs.find(tab => tab.id === state.activeTabId).error); } catch { return true; } });
    assert.equal(unsafe, true);
    passed('Address bar rejects local file URLs');

    if (process.env.MINI_BROWSER_TEST_HTTPS_URL) {
      const url = process.env.MINI_BROWSER_TEST_HTTPS_URL;
      await page.evaluate(url => window.browser.navigate(url), url);
      await waitURL(url, 45000);
      await page.waitForFunction(async () => { const state = await window.browser.getState(); const tab = state.tabs.find(tab => tab.id === state.activeTabId); return !tab.loading && (tab.error || tab.title); }, null, { timeout: 45000 });
      const current = await state();
      const tab = current.tabs.find(tab => tab.id === current.activeTabId);
      assert.ok(!tab.error, `HTTPS browsing failed: ${tab.error}`);
      assert.ok(tab.url.startsWith('https://'));
      const remote = await app.evaluate(async ({ webContents }, url) => {
        const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(new URL(url).origin));
        if (!contents) throw new Error('No HTTPS website loaded.');
        return contents.executeJavaScript('({ protocol: location.protocol, text: document.body.innerText.length, title: document.title })');
      }, url);
      assert.equal(remote.protocol, 'https:');
      assert.ok(remote.text > 200, 'External HTTPS page must contain real content.');
      await page.screenshot({ path: path.join(artifacts, 'https.png') });
      passed('External HTTPS browsing through the existing cloud proxy (TLS verification enabled)');
    }

    await app.close();
    app = null;
    await launch();
    assert.ok((await state()).bookmarks.some(bookmark => bookmark.url === `${origin}/second`));
    passed('Bookmarks survive a full application restart');
    await page.evaluate(url => window.browser.navigate(url), `${origin}/second`);
    await waitURL(`${origin}/second`);
    assert.ok((await inSite('document.cookie')).includes('mini_browser_smoke=remembered'));
    passed('Website cookies survive a full application restart');
    console.log(`Completed ${checks} functional checks.`);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (app) await app.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
