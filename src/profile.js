'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isAllowedUrl } = require('./navigation');

const DEFAULT_SETTINGS = Object.freeze({ searchEngine: 'google', restoreSession: true, homeUrl: '', theme: 'light' });
const MAX_HISTORY = 2000;
const MAX_BOOKMARKS = 2000;

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function website(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value) || !isAllowedUrl(value)) return null;
  return new URL(value).href;
}

function origin(value) {
  const url = website(value);
  return url ? new URL(url).origin : null;
}

function title(value, url) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 250) : (url ? new URL(url).hostname : 'New tab');
}

function permissionName(value) {
  if (typeof value !== 'string') return false;
  if (['media:audio', 'media:video', 'pointerLock'].includes(value)) return true;
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value) && !['constructor', 'prototype'].includes(value);
}

function settings(value) {
  const source = object(value) ? value : {};
  return {
    searchEngine: ['google', 'duckduckgo', 'bing'].includes(source.searchEngine) ? source.searchEngine : DEFAULT_SETTINGS.searchEngine,
    restoreSession: typeof source.restoreSession === 'boolean' ? source.restoreSession : DEFAULT_SETTINGS.restoreSession,
    homeUrl: source.homeUrl === '' ? '' : (website(source.homeUrl) || ''),
    theme: ['light', 'dark', 'system'].includes(source.theme) ? source.theme : DEFAULT_SETTINGS.theme,
  };
}

function sanitize(value) {
  const source = object(value) ? value : {};
  const seenBookmarks = new Set();
  const bookmarks = [];
  for (const item of Array.isArray(source.bookmarks) ? source.bookmarks : []) {
    const url = object(item) ? website(item.url) : null;
    if (!url || seenBookmarks.has(url)) continue;
    seenBookmarks.add(url);
    bookmarks.push({ title: title(item.title, url), url });
    if (bookmarks.length >= MAX_BOOKMARKS) break;
  }

  const seenHistory = new Set();
  const history = (Array.isArray(source.history) ? source.history : [])
    .filter(item => object(item) && !item.private && !item.isPrivate && website(item.url))
    .map(item => ({
      id: typeof item.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/u.test(item.id) ? item.id : randomUUID(),
      url: website(item.url),
      title: title(item.title, website(item.url)),
      visitedAt: typeof item.visitedAt === 'number' && Number.isFinite(item.visitedAt) && item.visitedAt >= 0
        ? Math.min(item.visitedAt, Date.now() + 86400000) : Date.now(),
    }))
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .filter(item => { if (seenHistory.has(item.url)) return false; seenHistory.add(item.url); return true; })
    .slice(0, MAX_HISTORY);

  const savedSession = object(source.session) ? source.session : {};
  const savedTabs = Array.isArray(savedSession.tabs) ? savedSession.tabs : [];
  const active = Number.isInteger(savedSession.activeIndex) ? savedSession.activeIndex : 0;
  const kept = [];
  for (let index = 0; index < savedTabs.length && kept.length < 50; index++) {
    const tab = savedTabs[index];
    if (!object(tab) || tab.private || tab.isPrivate) continue;
    const url = tab.url === '' ? '' : website(tab.url);
    if (url === null) continue;
    kept.push({ index, tab: {
      url,
      title: title(tab.title, url),
      pinned: tab.pinned === true,
      zoomFactor: typeof tab.zoomFactor === 'number' && Number.isFinite(tab.zoomFactor) ? Math.max(0.25, Math.min(5, tab.zoomFactor)) : 1,
    } });
  }
  let activeIndex = kept.findIndex(item => item.index === active);
  if (activeIndex === -1) {
    activeIndex = Math.max(0, kept.findLastIndex(item => item.index < active));
  }

  const permissions = {};
  if (object(source.permissions)) {
    for (const [address, decisions] of Object.entries(source.permissions)) {
      const site = origin(address);
      if (!site || !object(decisions)) continue;
      const allowed = {};
      for (const [name, decision] of Object.entries(decisions).slice(0, 32)) {
        if (permissionName(name) && ['allow', 'block'].includes(decision)) allowed[name] = decision;
      }
      if (Object.keys(allowed).length) permissions[site] = { ...permissions[site], ...allowed };
      if (Object.keys(permissions).length >= 500) break;
    }
  }
  return { version: 1, settings: settings(source.settings), bookmarks, history, session: { tabs: kept.map(item => item.tab), activeIndex }, permissions };
}

function createProfileStore(directory) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('A profile directory is required.');
  const folder = path.resolve(directory);
  fs.mkdirSync(folder, { recursive: true });
  const filename = path.join(folder, 'browser-data.json');
  let data;
  let recover = false;
  let existing = false;
  try {
    const stat = fs.statSync(filename);
    existing = true;
    if (stat.size > 64 * 1024 * 1024) throw new SyntaxError('Profile file is too large.');
    const source = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!object(source) || (source.version !== undefined && source.version !== 1)) throw new SyntaxError('Unsupported profile format.');
    data = sanitize(source);
    recover = JSON.stringify(data) !== JSON.stringify(source);
  } catch (error) {
    if (error.code === 'ENOENT' && !existing) {
      let bookmarks = [];
      try {
        const legacy = path.join(folder, 'bookmarks.json');
        if (fs.statSync(legacy).size <= 32 * 1024 * 1024) bookmarks = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      } catch (legacyError) {
        if (legacyError.code !== 'ENOENT' && !(legacyError instanceof SyntaxError)) throw legacyError;
      }
      data = sanitize({ bookmarks });
    } else if (error instanceof SyntaxError) {
      data = sanitize({});
      recover = true;
    } else {
      throw error;
    }
  }

  if (recover && existing) {
    const backup = path.join(folder, `browser-data.recovered-${Date.now()}-${randomUUID()}.json`);
    fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
  }

  function save() {
    const cleaned = sanitize(data);
    Object.assign(data, cleaned);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(cleaned, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, filename);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return data;
  }

  function change(operation) {
    const before = structuredClone(data);
    try { operation(); save(); } catch (error) { Object.assign(data, before); throw error; }
  }

  const store = {
    data,
    save,
    recordVisit(visit) {
      if (!object(visit) || visit.private || visit.isPrivate) return null;
      const url = website(visit.url);
      if (!url) return null;
      const previous = data.history.find(item => item.url === url);
      const entry = { id: previous?.id || randomUUID(), url, title: title(visit.title, url), visitedAt: visit.visitedAt ?? Date.now() };
      change(() => { data.history = [entry, ...data.history.filter(item => item.url !== url)].slice(0, MAX_HISTORY); });
      return data.history.find(item => item.url === url) || null;
    },
    updateSettings(patch) {
      if (!object(patch)) throw new TypeError('Settings must be an object.');
      const next = { ...data.settings };
      for (const [name, value] of Object.entries(patch)) {
        if (!Object.hasOwn(DEFAULT_SETTINGS, name)) throw new TypeError('Unknown browser setting.');
        if (name === 'searchEngine' && !['google', 'duckduckgo', 'bing'].includes(value)) throw new TypeError('Unknown search engine.');
        if (name === 'theme' && !['light', 'dark', 'system'].includes(value)) throw new TypeError('Unknown theme.');
        if (name === 'restoreSession' && typeof value !== 'boolean') throw new TypeError('Session restoration must be a boolean.');
        if (name === 'homeUrl' && value !== '' && !website(value)) throw new TypeError('The home page must use HTTP or HTTPS.');
        next[name] = name === 'homeUrl' && value ? website(value) : value;
      }
      change(() => { data.settings = next; });
      return data.settings;
    },
    removeHistory(id) { change(() => { data.history = data.history.filter(item => item.id !== id); }); return data.history; },
    clearHistory() { change(() => { data.history = []; }); return data.history; },
    getPermission(address, name) {
      const site = origin(address);
      const value = site && permissionName(name) ? data.permissions[site]?.[name] : null;
      return ['allow', 'block'].includes(value) ? value : 'ask';
    },
    setPermission(address, name, decision) {
      const site = origin(address);
      if (!site || !permissionName(name) || !['allow', 'block', 'ask'].includes(decision)) throw new TypeError('Invalid website permission.');
      change(() => {
        if (decision === 'ask') {
          if (data.permissions[site]) delete data.permissions[site][name];
          if (data.permissions[site] && !Object.keys(data.permissions[site]).length) delete data.permissions[site];
        } else {
          data.permissions[site] = { ...data.permissions[site], [name]: decision };
        }
      });
      return store.getPermission(site, name);
    },
    clearPermissions() { change(() => { data.permissions = {}; }); },
    resetSession() { change(() => { data.session = { tabs: [], activeIndex: 0 }; }); },
  };
  if (!existing || recover) save();
  return store;
}

module.exports = { createProfileStore, DEFAULT_SETTINGS };
