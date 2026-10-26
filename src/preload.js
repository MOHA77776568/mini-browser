'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('browser', Object.freeze({
  getState: () => ipcRenderer.invoke('browser:get-state'),
  onState: (callback) => subscribe('browser:state', callback),
  onFocusAddress: (callback) => subscribe('browser:focus-address', callback),
  onFindResult: (callback) => subscribe('browser:find-result', callback),
  onShowPanel: (callback) => subscribe('browser:show-panel', callback),
  navigate: (input) => ipcRenderer.invoke('browser:navigate', input),
  newTab: (input = '') => ipcRenderer.invoke('browser:new-tab', input),
  newPrivateTab: (input = '') => ipcRenderer.invoke('browser:new-private-tab', input),
  activateTab: (id) => ipcRenderer.invoke('browser:activate-tab', id),
  closeTab: (id) => ipcRenderer.invoke('browser:close-tab', id),
  reopenClosedTab: () => ipcRenderer.invoke('browser:reopen-closed-tab'),
  duplicateTab: (id) => ipcRenderer.invoke('browser:duplicate-tab', id),
  pinTab: (id) => ipcRenderer.invoke('browser:pin-tab', id),
  muteTab: (id) => ipcRenderer.invoke('browser:mute-tab', id),
  goBack: () => ipcRenderer.invoke('browser:back'),
  goForward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  stop: () => ipcRenderer.invoke('browser:stop'),
  setBounds: (bounds) => ipcRenderer.invoke('browser:set-bounds', bounds),
  toggleBookmark: () => ipcRenderer.invoke('browser:toggle-bookmark'),
  removeBookmark: (url) => ipcRenderer.invoke('browser:remove-bookmark', url),
  removeHistory: (id) => ipcRenderer.invoke('browser:remove-history', id),
  clearHistory: () => ipcRenderer.invoke('browser:clear-history'),
  findInPage: (text, forward = true) => ipcRenderer.invoke('browser:find-in-page', text, forward),
  stopFind: () => ipcRenderer.invoke('browser:stop-find'),
  setZoom: (factor) => ipcRenderer.invoke('browser:set-zoom', factor),
  printPage: () => ipcRenderer.invoke('browser:print-page'),
  savePDF: () => ipcRenderer.invoke('browser:save-pdf'),
  savePage: () => ipcRenderer.invoke('browser:save-page'),
  updateSettings: (patch) => ipcRenderer.invoke('browser:update-settings', patch),
  clearBrowsingData: (options) => ipcRenderer.invoke('browser:clear-browsing-data', options),
  resetSitePermission: (origin, permission) => ipcRenderer.invoke('browser:reset-site-permission', origin, permission),
  downloadAction: (id, action) => ipcRenderer.invoke('browser:download-action', id, action),
  setPanelOpen: (open) => ipcRenderer.invoke('browser:set-panel-open', open),
  goHome: () => ipcRenderer.invoke('browser:go-home'),
  openDownloads: () => ipcRenderer.invoke('browser:open-downloads'),
}));
