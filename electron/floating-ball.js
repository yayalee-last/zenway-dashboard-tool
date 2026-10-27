'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const { isDone, compareItems, urgentOf } = require('../renderer/item-order');

const SIZE = 64;
const COLLAPSE_DELAY = 250;
const PREVIEW_WIDTH = 280;
const PREVIEW_GAP = 6;

function contains(bounds, point) {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width
    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

function createFloatingBall(panel, savedPosition, onMove) {
  const saved = savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y);
  const area = (saved ? screen.getDisplayNearestPoint(savedPosition) : screen.getPrimaryDisplay()).workArea;
  const x = saved ? savedPosition.x : area.x + area.width - SIZE - 20;
  const y = saved ? savedPosition.y : area.y + 48;
  const ball = new BrowserWindow({
    x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - SIZE))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - SIZE))),
    width: SIZE,
    height: SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    title: '禅道悬浮球',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let engaged = false;
  let collapseTimer = null;
  let moveTimer = null;
  let pointerTimer = null;
  let ballReady = false;
  let preview = null;
  let previewReady = false;
  let previewEnabled = false;
  let previewSide = 'left';
  let previewItems = [];
  let displayMode = null;

  function pinBall() {
    ball.setAlwaysOnTop(true, process.platform === 'win32' ? 'pop-up-menu' : 'floating');
  }

  function cancelCollapse() {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }

  function resetHover() {
    engaged = false;
    cancelCollapse();
    syncPreview();
  }

  function positionBeside(target, side = 'left', gap = 0) {
    const anchor = ball.getBounds();
    const work = screen.getDisplayMatching(anchor).workArea;
    const [width, height] = target.getSize();
    const left = anchor.x - width - gap;
    const right = anchor.x + SIZE + gap;
    const preferred = side === 'right' ? right : left;
    const alternate = side === 'right' ? left : right;
    const fits = preferred >= work.x && preferred + width <= work.x + work.width;
    const px = Math.max(work.x, Math.min(fits ? preferred : alternate, work.x + work.width - width));
    const py = Math.max(work.y, Math.min(anchor.y, work.y + work.height - height));
    target.setPosition(px, py);
  }

  function positionPanel() {
    if (displayMode === 'panel') keepOnScreen(panel);
    else positionBeside(panel);
  }

  function keepOnScreen(target) {
    const bounds = target.getBounds();
    const work = screen.getDisplayMatching(bounds).workArea;
    const px = Math.max(work.x, Math.min(bounds.x, work.x + work.width - bounds.width));
    const py = Math.max(work.y, Math.min(bounds.y, work.y + work.height - bounds.height));
    if (px !== bounds.x || py !== bounds.y) target.setPosition(px, py);
    return { x: px, y: py };
  }

  function hidePreview() {
    preview?.hide();
  }

  function syncPreview() {
    if (!preview || !previewReady) return;
    if (!previewEnabled || !previewItems.length || panel.isVisible() || !ball.isVisible()) {
      preview.hide();
      return;
    }
    preview.setBounds({ width: PREVIEW_WIDTH, height: 44 + previewItems.length * 36 });
    positionBeside(preview, previewSide, PREVIEW_GAP);
    preview.webContents.send('preview-items', previewItems);
    preview.showInactive();
  }

  function createPreview() {
    preview = new BrowserWindow({
      width: PREVIEW_WIDTH,
      height: 152,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      title: '禅道常驻待办',
      webPreferences: {
        preload: path.join(__dirname, 'preview-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    preview.setAlwaysOnTop(true, process.platform === 'win32' ? 'pop-up-menu' : 'floating');
    preview.webContents.on('ipc-message', (_event, channel, requested) => {
      if (channel !== 'preview:open') return;
      const item = previewItems.find(item => item.id === requested?.id && item.kind === requested?.kind);
      if (!item) return;
      showPanel(true);
      panel.webContents.send('open-item', { id: item.id, kind: item.kind });
    });
    preview.once('ready-to-show', () => {
      previewReady = true;
      syncPreview();
    });
    preview.loadFile(path.join(__dirname, '..', 'renderer', 'floating-preview.html'));
  }

  function updatePreview(config, items) {
    previewEnabled = Boolean(config.showTopThree);
    previewSide = config.previewSide === 'right' ? 'right' : 'left';
    previewItems = items.filter(item => !isDone(item)).sort(compareItems).slice(0, 3)
      .map(item => ({ id: item.id, kind: item.kind || 'task', name: item.name, urgent: urgentOf(item) }));
    if (previewEnabled && previewItems.length && !preview) createPreview();
    keepOnScreen(ball);
    syncPreview();
  }

  function setDisplayMode(mode) {
    if (displayMode === mode) return;
    displayMode = mode;
    cancelCollapse();
    engaged = panel.isVisible();
    if (mode === 'panel') {
      if (ballReady) ball.hide();
      showPanel();
    } else if (ballReady) {
      ball.showInactive();
    }
  }
  function showPanel(focus = false) {
    cancelCollapse();
    positionPanel();
    if (focus) {
      panel.show();
      panel.focus();
    } else {
      panel.showInactive();
    }
  }

  function trackPointer() {
    if (displayMode !== 'ball') return;
    const point = screen.getCursorScreenPoint();
    const overBall = contains(ball.getBounds(), point);
    const overPanel = panel.isVisible() && contains(panel.getBounds(), point);
    if (overBall || overPanel) {
      engaged = true;
      cancelCollapse();
      if (overBall && !panel.isVisible()) showPanel();
    } else if (engaged && panel.isVisible() && !collapseTimer) {
      collapseTimer = setTimeout(() => {
        panel.hide();
      }, COLLAPSE_DELAY);
    }
  }

  pinBall();
  ball.once('ready-to-show', () => {
    ballReady = true;
    if (displayMode === 'ball') ball.showInactive();
    pointerTimer = setInterval(trackPointer, 80);
  });
  ball.on('show', pinBall);
  ball.on('show', syncPreview);
  ball.on('hide', hidePreview);
  ball.on('move', () => {
    if (panel.isVisible()) positionPanel();
    syncPreview();
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      onMove(keepOnScreen(ball));
    }, 300);
  });
  panel.on('resize', positionPanel);
  panel.on('hide', resetHover);
  panel.on('show', hidePreview);
  ball.loadFile(path.join(__dirname, '..', 'renderer', 'floating-ball.html'));

  return {
    window: ball,
    showPanel,
    updatePreview,
    setDisplayMode,
    destroy() {
      clearInterval(pointerTimer);
      clearTimeout(moveTimer);
      cancelCollapse();
      panel.removeListener('resize', positionPanel);
      panel.removeListener('hide', resetHover);
      panel.removeListener('show', hidePreview);
      preview?.destroy();
      ball.destroy();
    },
  };
}

module.exports = { createFloatingBall };
