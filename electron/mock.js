'use strict';

/** 调试用假数据：electron.exe . --mock --shot=xxx.png */

function d(offset) {
  const t = new Date();
  t.setDate(t.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

const MOCK_TASKS = [
  { id: 10231, name: '技能释放打断后动作未复位，角色卡在施法姿态', status: 'doing', pri: 1, deadline: d(-2), left: 3, consumed: 5, estimate: 8, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
  { id: 10188, name: '背包格子数量超过 200 时滚动卡顿', status: 'doing', pri: 2, deadline: d(0), left: 6, consumed: 2, estimate: 8, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
  { id: 10240, name: '主界面红点刷新时机与服务器推送不同步', status: 'wait', pri: 2, deadline: d(0), left: 4, consumed: 0, estimate: 4, execution: '仙逆-主城迭代2', project: '仙逆', url: '' },
  { id: 10202, name: 'FairyGUI 列表复用后子项事件绑定丢失', status: 'doing', pri: 3, deadline: d(2), left: 2, consumed: 6, estimate: 8, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
  { id: 10156, name: '断线重连后技能冷却显示错误', status: 'pause', pri: 3, deadline: d(4), left: 5, consumed: 1, estimate: 6, execution: '仙逆-网络', project: '仙逆', url: '' },
  { id: 10109, name: '新手引导第 7 步在 4:3 分辨率下遮挡按钮', status: 'wait', pri: 4, deadline: d(6), left: 3, consumed: 0, estimate: 3, execution: '仙逆-主城迭代2', project: '仙逆', url: '' },
  { id: 10087, name: '战斗结算界面数值滚动动画缺少音效', status: 'doing', pri: 3, deadline: null, left: 1, consumed: 2, estimate: 3, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
  { id: 10042, name: '技能图标资源打包后部分图集丢失 alpha', status: 'done', pri: 2, deadline: d(-6), left: 0, consumed: 4, estimate: 4, execution: '仙逆-战斗迭代3', project: '仙逆', url: '' },
];

const MOCK_BUGS = [
  { id: 1049, name: '【宠物】宠物星级没有对齐（微小线上）', status: 'active', statusName: '激活', severity: 3, pri: 3, deadline: d(-1), product: '仙逆手游', confirmed: 0, url: '' },
  { id: 1046, name: '【宠物-吞噬】此处数值未居中，与左右两侧偏移 2px', status: 'active', statusName: '激活', severity: 2, pri: 2, deadline: d(0), product: '仙逆手游', confirmed: 0, url: '' },
  { id: 1034, name: '【宠物-吞噬】直接吞 5 星的给了 10 个天赋', status: 'active', statusName: '激活', severity: 1, pri: 1, deadline: null, product: '仙逆手游', confirmed: 1, url: '' },
  { id: 1048, name: '【宠物-吞噬】当前 4800 阶/配表最大上限 5000 未做拦截', status: 'resolved', statusName: '已解决', severity: 2, pri: 2, deadline: d(2), product: '仙逆手游', confirmed: 1, url: '' },
];

const MOCK_ITEMS = [...MOCK_TASKS.map((t) => ({ ...t, kind: 'task' })), ...MOCK_BUGS.map((b) => ({ ...b, kind: 'bug' }))];

const MOCK_BUG_DETAIL = {
  id: 1049,
  title: '【宠物】宠物星级没有对齐（微小线上）',
  status: 'active',
  statusName: '激活',
  severity: 3,
  pri: 3,
  type: 'codeerror',
  productName: '仙逆手游',
  moduleTitle: '/ 宠物 / 星级',
  projectName: '仙逆',
  executionName: '',
  openedBy: '余飞',
  openedDate: '2026-10-26 10:45:25',
  assignedTo: '杨成',
  assignedDate: '2026-10-26 10:46:02',
  deadline: d(-1),
  resolvedBy: '',
  resolution: '',
  resolvedBuild: '',
  resolvedDate: null,
  closedDate: null,
  activatedCount: 1,
  confirmed: 0,
  storyTitle: '',
  steps:
    '<p><span>[步骤]</span></p><p>1. 打开宠物界面，选一只 5 星宠物</p><p>2. 看星级条与 5 颗星的位置关系</p>' +
    '<p><span>[结果]</span>星级文字偏右下，和星星不在一条基准线上（见图）</p>' +
    '<p><span>[期望]</span>文字与星星垂直居中</p>',
  files: [{ id: 0, name: '截图1.png（示例）', url: '' }],
  history: [
    { actor: '余飞', date: '2026-10-26 10:46:02', action: 'assigned', text: '由 <strong>余飞</strong> 指派给 <strong>杨成</strong>。', comment: '' },
    { actor: '余飞', date: '2026-10-26 10:45:25', action: 'opened', text: '由 <strong>余飞</strong> 创建。', comment: '<p>微小线上也能复现，麻烦看下富文本里的排版容器。</p>' },
  ],
  url: '',
};

module.exports = { MOCK_ITEMS, MOCK_BUG_DETAIL };
