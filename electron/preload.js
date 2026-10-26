'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zt', {
  boot: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('zentao:refresh'),
  testConfig: (patch) => ipcRenderer.invoke('config:test', patch),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  open: (url) => ipcRenderer.invoke('open:external', url),
  taskDetail: (id) => ipcRenderer.invoke('task:detail', id),
  taskAction: (payload) => ipcRenderer.invoke('task:action', payload),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  resize: (h) => ipcRenderer.invoke('win:resize', h),
  quit: () => ipcRenderer.invoke('win:close'),
  togglePin: () => ipcRenderer.invoke('win:toggle-pin'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onOpenSettings: (fn) => ipcRenderer.on('open-settings', () => fn()),
});
