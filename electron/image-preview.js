'use strict';

const path = require('node:path');

function isImageSource(src) {
  if (typeof src !== 'string') return false;
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml);base64,[a-z0-9+/]+={0,2}$/i.test(src)) return true;
  if (!/^https?:\/\//i.test(src) || !URL.canParse(src)) return false;
  const url = new URL(src);
  return !url.username && !url.password;
}

function wireImagePreview({ BrowserWindow, ipcMain, screen, getPanel, isMainSender }) {
  let viewer = null;
  let source = '';
  let ready = false;

  ipcMain.on('image:ready', event => {
    if (!viewer || event.sender !== viewer.webContents || event.senderFrame !== viewer.webContents.mainFrame) return;
    ready = true;
    viewer.webContents.send('image:show', source);
  });

  ipcMain.handle('image:open', async (event, src) => {
    if (!isMainSender(event)) return { ok: false, error: '图片预览请求来源无效' };
    if (!isImageSource(src)) return { ok: false, error: '图片地址无效，无法预览' };
    source = src;
    if (viewer) {
      if (ready) viewer.webContents.send('image:show', source);
      if (viewer.isMinimized()) viewer.restore();
      viewer.show();
      viewer.focus();
      return { ok: true };
    }

    const panel = getPanel();
    const area = screen.getDisplayMatching(panel.getBounds()).workArea;
    const width = Math.min(1000, area.width);
    const height = Math.min(760, area.height);
    const created = new BrowserWindow({
      width, height,
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + Math.floor((area.height - height) / 2),
      title: '图片预览',
      backgroundColor: '#181a1e',
      autoHideMenuBar: true,
      show: false,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'image-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    viewer = created;
    // 独立窗口不随悬浮面板自动收起；置顶层级与面板一致。
    created.setAlwaysOnTop(panel.isAlwaysOnTop(), process.platform === 'win32' ? 'pop-up-menu' : 'floating');
    created.webContents.on('will-navigate', event => event.preventDefault());
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const closeWithPanel = () => created.destroy();
    panel.once('closed', closeWithPanel);
    created.once('closed', () => {
      panel.removeListener('closed', closeWithPanel);
      viewer = null;
      source = '';
      ready = false;
    });
    try {
      await created.loadFile(path.join(__dirname, '..', 'renderer', 'image-preview.html'));
      created.show();
      created.focus();
      return { ok: true };
    } catch {
      if (!created.isDestroyed()) created.destroy();
      return { ok: false, error: '图片预览打开失败，请重试' };
    }
  });
}

module.exports = { wireImagePreview };
