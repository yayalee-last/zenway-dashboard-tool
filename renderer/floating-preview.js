'use strict';

window.ztPreview.onItems((items) => {
  const list = document.getElementById('preview-list');
  list.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement('li');
    row.dataset.id = String(item.id);
    row.dataset.kind = item.kind;
    row.dataset.urgent = item.urgent;
    const button = document.createElement('button');
    button.type = 'button';
    button.title = item.name;
    button.addEventListener('click', () => window.ztPreview.openItem({ id: item.id, kind: item.kind }));
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    button.append(rank, name);
    row.append(button);
    list.append(row);
  });
});