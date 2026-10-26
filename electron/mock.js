'use strict';

/** 调试用假数据：electron.exe . --mock --shot=xxx.png */

function d(offset) {
  const t = new Date();
  t.setDate(t.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

const MOCK_ITEMS = [
  { id: 10231, name: '技能释放打断后动作未复位，角色卡在施法姿态', status: 'doing', pri: 1, deadline: d(-2), left: 3, consumed: 5, estimate: 8, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
  { id: 10188, name: '背包格子数量超过 200 时滚动卡顿', status: 'doing', pri: 2, deadline: d(0), left: 6, consumed: 2, estimate: 8, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
  { id: 10240, name: '主界面红点刷新时机与服务器推送不同步', status: 'wait', pri: 2, deadline: d(0), left: 4, consumed: 0, estimate: 4, execution: '仙逆-主城迭代2', project: '仙逆', url: '' },
  { id: 10202, name: 'FairyGUI 列表复用后子项事件绑定丢失', status: 'doing', pri: 3, deadline: d(2), left: 2, consumed: 6, estimate: 8, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
  { id: 10156, name: '断线重连后技能冷却显示错误', status: 'pause', pri: 3, deadline: d(4), left: 5, consumed: 1, estimate: 6, execution: '仙逆-网络', project: '仙逆', url: '' },
  { id: 10109, name: '新手引导第 7 步在 4:3 分辨率下遮挡按钮', status: 'wait', pri: 4, deadline: d(6), left: 3, consumed: 0, estimate: 3, execution: '仙逆-主城迭代2', project: '仙逆', url: '' },
  { id: 10087, name: '战斗结算界面数值滚动动画缺少音效', status: 'doing', pri: 3, deadline: null, left: 1, consumed: 2, estimate: 3, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
  { id: 10042, name: '技能图标资源打包后部分图集丢失 alpha', status: 'done', pri: 2, deadline: d(-6), left: 0, consumed: 4, estimate: 4, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
];

module.exports = { MOCK_ITEMS };
