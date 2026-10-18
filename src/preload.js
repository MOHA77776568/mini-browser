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
  navigate: (input) => ipcRenderer.invoke('browser:navigate', input),
  newTab: (input = '') => ipcRenderer.invoke('browser:new-tab', input),
  activateTab: (id) => ipcRenderer.invoke('browser:activate-tab', id),
  closeTab: (id) => ipcRenderer.invoke('browser:close-tab', id),
  goBack: () => ipcRenderer.invoke('browser:back'),
  goForward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  stop: () => ipcRenderer.invoke('browser:stop'),
  setBounds: (bounds) => ipcRenderer.invoke('browser:set-bounds', bounds),
  toggleBookmark: () => ipcRenderer.invoke('browser:toggle-bookmark'),
  openDownloads: () => ipcRenderer.invoke('browser:open-downloads'),
}));
