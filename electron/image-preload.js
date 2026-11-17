'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ztImage', {
  onImage: callback => {
    ipcRenderer.on('image:show', (_event, src) => callback(src));
    ipcRenderer.send('image:ready');
  },
});
