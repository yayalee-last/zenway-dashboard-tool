'use strict';

const image = document.getElementById('image');
const viewport = document.getElementById('viewport');
const status = document.getElementById('status');
const zoom = document.getElementById('zoom');
const controls = ['zoom-out', 'zoom-in', 'fit', 'actual'].map(id => document.getElementById(id));
let scale = 1;
let fitting = true;

function setScale(value) {
  scale = value;
  image.style.width = `${image.naturalWidth * scale}px`;
  image.style.height = `${image.naturalHeight * scale}px`;
  zoom.value = `${Math.round(scale * 100)}%`;
}

function fitImage() {
  fitting = true;
  setScale(Math.min(1, Math.max(1, viewport.clientWidth - 48) / image.naturalWidth,
    Math.max(1, viewport.clientHeight - 48) / image.naturalHeight));
}

function changeZoom(factor) {
  if (image.hidden) return;
  fitting = false;
  setScale(Math.min(8, Math.max(.05, scale * factor)));
}

image.addEventListener('load', () => {
  status.hidden = true;
  image.hidden = false;
  for (const button of controls) button.disabled = false;
  fitImage();
});
image.addEventListener('error', () => {
  image.hidden = true;
  for (const button of controls) button.disabled = true;
  zoom.value = '—';
  status.textContent = '图片加载失败，请关闭后重新打开';
  status.hidden = false;
});
document.getElementById('zoom-out').addEventListener('click', () => changeZoom(1 / 1.2));
document.getElementById('zoom-in').addEventListener('click', () => changeZoom(1.2));
document.getElementById('fit').addEventListener('click', fitImage);
document.getElementById('actual').addEventListener('click', () => {
  fitting = false;
  setScale(1);
});
document.getElementById('close').addEventListener('click', () => window.close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.close();
});
viewport.addEventListener('wheel', event => {
  event.preventDefault();
  if (event.deltaY) changeZoom(event.deltaY < 0 ? 1.2 : 1 / 1.2);
}, { passive: false });
window.addEventListener('resize', () => {
  if (fitting && !image.hidden) fitImage();
});
window.ztImage.onImage(src => {
  image.hidden = true;
  for (const button of controls) button.disabled = true;
  zoom.value = '—';
  status.textContent = '正在加载图片…';
  status.hidden = false;
  viewport.scrollTo(0, 0);
  image.src = src;
});
