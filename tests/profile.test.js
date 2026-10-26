'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProfileStore } = require('../src/profile');

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('migrates legacy bookmarks once without altering the legacy file and persists settings', t => {
  const directory = folder(t);
  const legacy = JSON.stringify([{ title: 'Example', url: 'https://example.com' }]);
  fs.writeFileSync(path.join(directory, 'bookmarks.json'), legacy);
  const store = createProfileStore(directory);
  assert.deepEqual(store.data.bookmarks, [{ title: 'Example', url: 'https://example.com/' }]);
  store.updateSettings({ searchEngine: 'duckduckgo', theme: 'dark', restoreSession: false, homeUrl: 'https://example.org' });
  const reloaded = createProfileStore(directory);
  assert.equal(reloaded.data.settings.searchEngine, 'duckduckgo');
  assert.equal(reloaded.data.settings.homeUrl, 'https://example.org/');
  assert.equal(reloaded.data.settings.restoreSession, false);
  assert.equal(fs.readFileSync(path.join(directory, 'bookmarks.json'), 'utf8'), legacy);
  fs.writeFileSync(path.join(directory, 'bookmarks.json'), JSON.stringify([{ title: 'Later legacy change', url: 'https://later.example' }]));
  assert.equal(createProfileStore(directory).data.bookmarks[0].title, 'Example');
});

test('restores normal tabs and visits while excluding private and privileged state', t => {
  const directory = folder(t);
  const store = createProfileStore(directory);
  store.data.session = { tabs: [
    { url: 'https://example.com/', title: 'Normal', zoomFactor: 1.25, pinned: true },
    { url: 'https://private.example/', title: 'Private', private: true },
    { url: 'https://secret.example/', isPrivate: true },
    { url: 'file:///etc/passwd' },
    { url: '', title: 'Home' },
  ], activeIndex: 4 };
  store.data.bookmarks = [{ title: 'Unsafe', url: 'https://name:password@example.com' }, { title: 'Safe', url: 'https://safe.example/' }];
  store.recordVisit({ url: 'https://private.example/', private: true });
  store.recordVisit({ url: 'https://private.example/', isPrivate: true });
  store.recordVisit({ url: 'javascript:alert(1)' });
  const visit = store.recordVisit({ url: 'https://normal.example/', title: 'Visited', visitedAt: 100 });
  store.save();
  const reloaded = createProfileStore(directory);
  assert.equal(reloaded.data.session.tabs.length, 2);
  assert.equal(reloaded.data.session.activeIndex, 1);
  assert.equal(reloaded.data.session.tabs[0].zoomFactor, 1.25);
  assert.equal(reloaded.data.bookmarks.length, 1);
  assert.deepEqual(reloaded.data.history.map(item => item.url), ['https://normal.example/']);
  assert.equal(reloaded.data.history[0].id, visit.id);
  const serialized = fs.readFileSync(path.join(directory, 'browser-data.json'), 'utf8');
  assert.ok(!serialized.includes('private.example'));
  assert.ok(!serialized.includes('secret.example'));
  assert.ok(!serialized.includes('password'));
});

test('rejects invalid settings atomically and normalizes site permission scope', t => {
  const directory = folder(t);
  const store = createProfileStore(directory);
  const before = { ...store.data.settings };
  assert.throws(() => store.updateSettings({ theme: 'dark', homeUrl: 'file:///etc/passwd' }));
  assert.deepEqual(store.data.settings, before);
  assert.throws(() => store.updateSettings({ searchEngine: 'unknown' }));
  assert.throws(() => store.updateSettings({ restoreSession: 'true' }));
  assert.throws(() => store.updateSettings({ unknown: true }));
  assert.equal(store.getPermission('https://example.com/path', 'media'), 'ask');
  store.setPermission('https://example.com/path?q=private', 'media', 'allow');
  assert.equal(store.getPermission('https://example.com/another', 'media'), 'allow');
  assert.deepEqual(Object.keys(store.data.permissions), ['https://example.com']);
  assert.equal(store.setPermission('https://example.com', 'media', 'ask'), 'ask');
  assert.deepEqual(store.data.permissions, {});
  assert.throws(() => store.setPermission('javascript:alert(1)', 'media', 'allow'));
  assert.throws(() => store.setPermission('https://example.com', '__proto__', 'allow'));
  assert.throws(() => store.setPermission('https://example.com', 'media:arbitrary', 'allow'));
  assert.throws(() => store.setPermission('https://example.com', 'constructor', 'allow'));
  for (const name of ['media:audio', 'media:video', 'pointerLock']) store.setPermission('https://example.com', name, 'allow');
  const reloaded = createProfileStore(directory);
  for (const name of ['media:audio', 'media:video', 'pointerLock']) assert.equal(reloaded.getPermission('https://example.com', name), 'allow');
  reloaded.setPermission('https://example.com', 'media:video', 'ask');
  assert.equal(createProfileStore(directory).getPermission('https://example.com', 'media:video'), 'ask');
  store.setPermission('https://example.com', 'notifications', 'block');
  store.clearPermissions();
  assert.equal(store.getPermission('https://example.com', 'notifications'), 'ask');
});

test('caps and deduplicates stored history by most recent visit', t => {
  const directory = folder(t);
  const store = createProfileStore(directory);
  store.data.history = Array.from({ length: 2050 }, (_, index) => ({ id: `visit-${index}`, url: `https://example.com/${index}`, title: String(index), visitedAt: index }));
  store.save();
  assert.equal(store.data.history.length, 2000);
  assert.equal(store.data.history[0].url, 'https://example.com/2049');
  const originalId = store.data.history[100].id;
  const url = store.data.history[100].url;
  store.recordVisit({ url, title: 'Revisited' });
  assert.equal(store.data.history.length, 2000);
  assert.equal(store.data.history[0].id, originalId);
  assert.equal(store.data.history[0].title, 'Revisited');
  store.removeHistory(originalId);
  assert.ok(!store.data.history.some(item => item.id === originalId));
  store.clearHistory();
  assert.deepEqual(createProfileStore(directory).data.history, []);
  assert.deepEqual(store.data.history, []);
});

test('preserves malformed and unsafe original profiles before recovery', t => {
  const directory = folder(t);
  const filename = path.join(directory, 'browser-data.json');
  fs.writeFileSync(filename, '{broken JSON');
  const store = createProfileStore(directory);
  assert.equal(store.data.settings.searchEngine, 'google');
  const backups = fs.readdirSync(directory).filter(name => name.startsWith('browser-data.recovered-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), 'utf8'), '{broken JSON');
  store.resetSession();
  assert.deepEqual(store.data.session, { tabs: [], activeIndex: 0 });
  const unsafe = { version: 1, settings: { homeUrl: 'data:text/html,unsafe' }, bookmarks: [{ url: 'file:///secret' }], permissions: { 'https://user:pass@example.com': { media: 'allow' } } };
  fs.writeFileSync(filename, JSON.stringify(unsafe));
  const recovered = createProfileStore(directory);
  assert.equal(recovered.data.settings.homeUrl, '');
  assert.deepEqual(recovered.data.bookmarks, []);
  assert.deepEqual(recovered.data.permissions, {});
  assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('browser-data.recovered-')).length, 2);
});
