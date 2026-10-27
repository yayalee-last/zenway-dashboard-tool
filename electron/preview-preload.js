'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ztPreview', {
  onItems: (fn) => ipcRenderer.on('preview-items', (_event, items) => fn(items)),
  openItem: (item) => ipcRenderer.send('preview:open', item),
});