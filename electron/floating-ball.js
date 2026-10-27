'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const SIZE = 64;
const COLLAPSE_DELAY = 250;

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
  }

  function positionPanel() {
    const anchor = ball.getBounds();
    const work = screen.getDisplayMatching(anchor).workArea;
    const [width, height] = panel.getSize();
    const left = anchor.x - width;
    const right = anchor.x + SIZE;
    const preferred = left >= work.x ? left : right;
    const px = Math.max(work.x, Math.min(preferred, work.x + work.width - width));
    const py = Math.max(work.y, Math.min(anchor.y, work.y + work.height - height));
    panel.setPosition(px, py);
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
    ball.showInactive();
    pointerTimer = setInterval(trackPointer, 80);
  });
  ball.on('show', pinBall);
  ball.on('move', () => {
    if (panel.isVisible()) positionPanel();
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const bounds = ball.getBounds();
      const work = screen.getDisplayMatching(bounds).workArea;
      const px = Math.max(work.x, Math.min(bounds.x, work.x + work.width - SIZE));
      const py = Math.max(work.y, Math.min(bounds.y, work.y + work.height - SIZE));
      if (px !== bounds.x || py !== bounds.y) ball.setPosition(px, py);
      onMove({ x: px, y: py });
    }, 300);
  });
  panel.on('resize', positionPanel);
  panel.on('hide', resetHover);
  ball.loadFile(path.join(__dirname, '..', 'renderer', 'floating-ball.html'));

  return {
    window: ball,
    showPanel,
    destroy() {
      clearInterval(pointerTimer);
      clearTimeout(moveTimer);
      cancelCollapse();
      panel.removeListener('resize', positionPanel);
      panel.removeListener('hide', resetHover);
      ball.destroy();
    },
  };
}

module.exports = { createFloatingBall };
