/* ============================================================
   MOL 船舶管理リスト — app.js  v2.0
   All-in-one: CSV parse, data analysis, charts, gantt, table,
               + per-vessel order-status editor (localStorage)
   ============================================================ */

'use strict';

// ============================================================
// CONSTANTS & CONFIG
// ============================================================
const TODAY = new Date();
TODAY.setHours(0,0,0,0);

const DAYS_90  = 90  * 86400000;
const DAYS_180 = 180 * 86400000;

// ============================================================
// ORDER STATUS — サーバー共有ストア (API 経由)
// ============================================================
// Shape: { [vesselUID]: { status, quoteDate, orderedDate, note, updatedAt } }
let orderStatusStore = {};

// サーバーが使えるかどうかを初回チェック
let _useServer = false;
async function detectServer() {
  try {
    const r = await fetch('/api/order-status', { signal: AbortSignal.timeout(2000) });
    _useServer = r.ok;
  } catch(e) { _useServer = false; }
}

// 2つのストアをupdatedAtで比較マージするヘルパー（破壊的でない）
// ルール: updatedAtが新しい方を採用。両方ともupdatedAtなし→既存を優先
function _mergeStores(base, ...sources) {
  const result = { ...base };
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [key, rec] of Object.entries(src)) {
      if (!rec) continue;
      if (!result[key]) {
        result[key] = rec;
      } else {
        const baseTime = result[key].updatedAt ? new Date(result[key].updatedAt).getTime() : -1;
        const srcTime  = rec.updatedAt         ? new Date(rec.updatedAt).getTime()          : -1;
        // srcの方が明確に新しい場合だけ上書き（同じ・不明なら既存を保持）
        if (srcTime > baseTime) result[key] = rec;
      }
    }
  }
  return result;
}

async function loadOrderStatusStore() {
  // 1. 現在メモリ上にあるデータを退避（絶対に失わない）
  const memData = { ...orderStatusStore };

  // 2. localStorageから読み込む
  let localData = {};
  try {
    const raw = localStorage.getItem('molShipOrderStatus_v1');
    if (raw) localData = JSON.parse(raw);
  } catch(e) { localData = {}; }

  // 3. サーバーから読み込む
  let serverData = {};
  if (_useServer) {
    try {
      const r = await fetch('/api/order-status', { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      if (j.ok && j.data) serverData = j.data;
    } catch(e) {
      console.warn('サーバーからの受注状態読み込みに失敗。メモリ+localStorageを使用:', e);
    }
  }

  // 4. 全ソースをマージ（メモリ・localStorage・サーバーの最新を保持）
  orderStatusStore = _mergeStores({}, memData, localData, serverData);

  // 5. マージ結果をlocalStorageに保存（サーバーが落ちても次回復元できる）
  _saveLocalStorage();
}

function _saveLocalStorage() {
  try { localStorage.setItem('molShipOrderStatus_v1', JSON.stringify(orderStatusStore)); } catch(e) {}
}

async function saveOrderStatusRecord(key, record) {
  if (!key) return;
  // updatedAtを必ずセット（マージ時に「新しいデータ」と正しく判定されるよう）
  const recWithTs = { ...record, updatedAt: record.updatedAt || new Date().toISOString() };
  orderStatusStore[key] = recWithTs;
  // 常にlocalStorageに保存（サーバーが落ちてもデータを保持）
  _saveLocalStorage();
  if (_useServer) {
    try {
      await fetch('/api/order-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, ...recWithTs }),
      });
    } catch(e) {
      console.warn('サーバーへの受注状態保存に失敗。localStorageに保存済みです:', e);
    }
  }
}

function getVesselKey(row) {
  return row.VESSEL_UID || row.BUILDERS_VESSEL_NUMBER || row.VESSEL_NAME || '';
}

// HTML属性に安全に埋め込むためのエスケープ
function escAttr(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// CSV の ORDER_STATUS 列 / VESSEL_STATUS_OF_USE からの自動判定マップ
const ORDER_STATUS_MAP = {
  '見積提出済み': 'quote', '見積中': 'quote', '見積提出': 'quote',
  '提案中': 'quote', '商談中': 'quote',
  '受注済み': 'ordered', '受注': 'ordered',
  '契約締結済': 'ordered', '契約締結済み': 'ordered',
  '建造中': 'ordered', '建造完了': 'ordered',
  '就航済み': 'ordered', '基本設計中': 'ordered',
  '詳細設計中': 'ordered', '設計中': 'ordered',
};

function getOrderStatus(row) {
  // 1. 手動設定が優先
  const key = getVesselKey(row);
  if (key && orderStatusStore[key] && orderStatusStore[key].status && orderStatusStore[key].status !== 'other') {
    return orderStatusStore[key].status;
  }
  // 2. CSV 列から自動判定
  const raw = (row.ORDER_STATUS || row.VESSEL_STATUS_OF_USE || '').trim();
  return ORDER_STATUS_MAP[raw] || 'other';
}

function getOrderStatusRecord(row) {
  const key = getVesselKey(row);
  const base = { status: 'other', quoteDate: '', orderedDate: '', note: '', notBoarded: false };
  return orderStatusStore[key] ? { ...base, ...orderStatusStore[key] } : base;
}

// 非搭載フラグを取得するヘルパー
function isNotBoarded(row) {
  const rec = getOrderStatusRecord(row);
  return !!rec.notBoarded;
}

async function setOrderStatusRecord(row, record) {
  const key = getVesselKey(row);
  if (!key) return;
  // updatedAtを必ずセットしてからメモリ・localStorage・サーバーに保存
  const recWithTs = { ...record, updatedAt: new Date().toISOString() };
  orderStatusStore[key] = recWithTs;
  _saveLocalStorage();
  await saveOrderStatusRecord(key, recWithTs);
}

const ORDER_STATUS_LABEL = { quote: '見積提出済み', ordered: '受注済み', other: '—' };

// ============================================================
// COLUMN DEFINITIONS
// ============================================================
const COLUMN_DEFS = [
  { key:'VESSEL_NAME',                    label:'船名',             group:'基本',   default:true  },
  { key:'VESSEL_TYPE',                    label:'船種',             group:'基本',   default:true  },
  { key:'BUILDER',                        label:'造船所',           group:'基本',   default:true  },
  { key:'BUILDERS_VESSEL_NUMBER',         label:'建造番号',         group:'基本',   default:true  },
  { key:'OWNERSHIP_TYPE_BEFORE_DELIVERY', label:'所有形態',         group:'基本',   default:true  },
  { key:'VESSEL_FLAG_STATE',              label:'船籍',             group:'基本',   default:false },
  { key:'VESSEL_CLASS_NAME',              label:'船級',             group:'基本',   default:false },
  { key:'CONSTRUCTION_START_DATE',        label:'起工日',           group:'工程',   default:true  },
  { key:'PLANNED_CONSTRUCTION_START_DATE',label:'起工予定日',       group:'工程',   default:true  },
  { key:'LAUNCH_DATE',                    label:'進水日',           group:'工程',   default:true  },
  { key:'PLANNED_LAUNCH_DATE',            label:'進水予定日',       group:'工程',   default:true  },
  { key:'PLANNED_SEA_TRIALS_DATE',        label:'試運転予定日',     group:'工程',   default:true  },
  { key:'PLANNED_DATE_OF_BUILD_DATE',     label:'竣工予定日',       group:'工程',   default:true  },
  { key:'CONTRACT_DELIVERY_DATE_FROM',    label:'契約引渡(From)',   group:'工程',   default:true  },
  { key:'CONTRACT_DELIVERY_DATE_TO',      label:'契約引渡(To)',     group:'工程',   default:true  },
  { key:'LOA',                            label:'LOA(m)',           group:'船型',   default:false },
  { key:'BEAM',                           label:'幅(m)',            group:'船型',   default:false },
  { key:'DRAFT_DESIGN',                   label:'吃水(設計)(m)',    group:'船型',   default:false },
  { key:'GROSS_TON',                      label:'GT',               group:'船型',   default:false },
  { key:'DWT_GUARANTEE_MT',               label:'DWT(MT)',          group:'船型',   default:false },
  { key:'PLANNED_SAILING_SPEED_KTS',      label:'速力(kts)',        group:'船型',   default:false },
  { key:'IMO_NO',                         label:'IMO番号',          group:'その他', default:false },
  { key:'VESSEL_STATUS_OF_USE',           label:'使用状態',         group:'その他', default:false },
  { key:'_orderStatus',                   label:'受注状態',         group:'基本',   default:true  },
  { key:'SHIPBUILDING_CONTRUCT_PURCHASER',label:'発注者',           group:'その他', default:false },
  { key:'REMARKS_TECHNICAL_DIV',          label:'技術部備考',       group:'その他', default:false },
];

const DATE_KEYS = [
  'SHIPBUILDING_CONTRUCT_DATE','CONSTRUCTION_START_DATE_ON_CERTIFICATE',
  'PLANNED_CONSTRUCTION_START_DATE','CONSTRUCTION_START_DATE',
  'PLANNED_LAUNCH_DATE','LAUNCH_DATE','PLANNED_SEA_TRIALS_DATE',
  'PLANNED_CONSTRUCTION_COMPLETE_DATE','PLANNED_DATE_OF_BUILD_DATE',
  'CONTRACT_DELIVERY_DATE_FROM','CONTRACT_DELIVERY_DATE_TO',
  'VESSEL_NAME_FIX_DEADLINE',
];

const MILESTONES = [
  { key:'CONSTRUCTION_START_DATE',     planned:'PLANNED_CONSTRUCTION_START_DATE', label:'起工',   cls:'keel'     },
  { key:'LAUNCH_DATE',                 planned:'PLANNED_LAUNCH_DATE',             label:'進水',   cls:'launch'   },
  { key:'PLANNED_SEA_TRIALS_DATE',     planned:'PLANNED_SEA_TRIALS_DATE',         label:'試運転', cls:'trial'    },
  { key:'CONTRACT_DELIVERY_DATE_FROM', planned:'PLANNED_DATE_OF_BUILD_DATE',      label:'引渡',   cls:'delivery' },
];

// ============================================================
// STATE
// ============================================================
let allData     = [];
let filtered    = [];
let sortKey     = '';
let sortDir     = 1;
let currentPage = 1;
let PAGE_SIZE   = 25;
let showAll     = false;
let visibleCols = COLUMN_DEFS.filter(c => c.default).map(c => c.key);
let charts      = {};

// Gantt range
let ganttRange = { from: null, to: null };

// Filter state
const filterState = {
  type:        new Set(),
  ownership:   new Set(),
  year:        new Set(),
  status:      new Set(),
  orderStatus: new Set(),
};

const MDD_DEFS = [
  { id:'mddType',        stateKey:'type',        labelId:'mddTypeLabel',        listId:'mddTypeList',        menuId:'mddTypeMenu',        allLabel:'船種',     hasSearch:true,  fixed:null },
  { id:'mddOwnership',   stateKey:'ownership',   labelId:'mddOwnershipLabel',   listId:'mddOwnershipList',   menuId:'mddOwnershipMenu',   allLabel:'所有形態', hasSearch:false, fixed:null },
  { id:'mddYear',        stateKey:'year',        labelId:'mddYearLabel',        listId:'mddYearList',        menuId:'mddYearMenu',        allLabel:'納期年',   hasSearch:false, fixed:null },
  { id:'mddStatus',      stateKey:'status',      labelId:'mddStatusLabel',      listId:'mddStatusList',      menuId:'mddStatusMenu',      allLabel:'ステータス', hasSearch:false,
    fixed:[ {value:'upcoming90',label:'工事予定 90日以内'},{value:'upcoming180',label:'工事予定 180日以内'},{value:'delivery90',label:'引渡 90日以内'} ] },
  { id:'mddOrderStatus', stateKey:'orderStatus', labelId:'mddOrderStatusLabel', listId:'mddOrderStatusList', menuId:'mddOrderStatusMenu', allLabel:'受注状態', hasSearch:false,
    fixed:[ {value:'quote',label:'見積提出済み'},{value:'ordered',label:'受注済み'} ] },
];

// ============================================================
// UTILITY
// ============================================================
function parseDate(str) {
  if (!str || str.trim() === '' || str.trim() === '-') return null;
  const s = str.trim().replace(/\//g,'-').replace(/年/g,'-').replace(/月/g,'-').replace(/日/g,'');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return new Date(+m[3], +m[1]-1, +m[2]);
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2]-1, 1);
  return null;
}

function formatDate(d, fallback='—') {
  if (!d) return fallback;
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function formatDateInput(d, fallback='') {
  if (!d) return fallback;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function diffDays(d) {
  if (!d) return null;
  return Math.round((d - TODAY) / 86400000);
}

function getNextMilestoneDate(row) {
  for (const m of MILESTONES) {
    const d = row._dates[m.key] || row._dates[m.planned];
    if (d && d >= TODAY) return { date: d, label: m.label, cls: m.cls };
  }
  return null;
}

function getDeliveryDate(row) {
  return row._dates['CONTRACT_DELIVERY_DATE_FROM']
      || row._dates['CONTRACT_DELIVERY_DATE_TO']
      || row._dates['PLANNED_DATE_OF_BUILD_DATE'];
}

function daysLabel(days) {
  if (days === null) return '—';
  if (days < 0)  return `${Math.abs(days)}日前`;
  if (days === 0) return '本日';
  return `${days}日後`;
}

function daysStatus(days) {
  if (days === null) return 'normal';
  if (days < 0)   return 'done';
  if (days <= 30) return 'urgent';
  if (days <= 90) return 'warning';
  return 'normal';
}

function toast(msg, type='info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fas fa-${type==='success'?'check-circle':type==='error'?'exclamation-circle':'info-circle'}"></i>${msg}`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ============================================================
// CSV PARSER
// ============================================================
function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, j) => { obj[h.trim()] = (cells[j]||'').trim(); });
    obj._dates = {};
    DATE_KEYS.forEach(k => {
      const d = parseDate(obj[k]);
      if (d) obj._dates[k] = d;
    });
    rows.push(obj);
  }
  return rows;
}

function splitCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      result.push(cur); cur = '';
    } else { cur += c; }
  }
  result.push(cur);
  return result;
}

// ============================================================
// DATA ANALYSIS
// ============================================================
function analyzeData(rows) {
  const now = TODAY.getTime();
  let upcoming90=0, upcoming180=0, delivery90=0, quoteCount=0, orderedCount=0, notBoardedCount=0;
  const typeCount={}, ownerCount={}, yearCount={};

  rows.forEach(r => {
    const keel = r._dates['CONSTRUCTION_START_DATE'] || r._dates['PLANNED_CONSTRUCTION_START_DATE'];
    if (keel) {
      const diff = keel - now;
      if (diff >= 0 && diff <= DAYS_90)  upcoming90++;
      if (diff >= 0 && diff <= DAYS_180) upcoming180++;
    }
    const del = getDeliveryDate(r);
    if (del) {
      const diff = del - now;
      if (diff >= 0 && diff <= DAYS_90) delivery90++;
    }
    const os = getOrderStatus(r);
    if (os === 'quote')   quoteCount++;
    if (os === 'ordered') orderedCount++;
    if (isNotBoarded(r)) notBoardedCount++;
    const vt = r.VESSEL_TYPE || '不明';
    typeCount[vt] = (typeCount[vt]||0)+1;
    const ow = r.OWNERSHIP_TYPE_BEFORE_DELIVERY || '不明';
    ownerCount[ow] = (ownerCount[ow]||0)+1;
    if (del) {
      const y = del.getFullYear();
      yearCount[y] = (yearCount[y]||0)+1;
    }
  });

  return { upcoming90, upcoming180, delivery90, quoteCount, orderedCount, notBoardedCount, typeCount, ownerCount, yearCount };
}

// ============================================================
// RENDER KPI
// ============================================================
function renderKPI(rows, stats) {
  document.getElementById('kpiTotalVal').textContent    = rows.length;
  document.getElementById('kpiUpcomingVal').textContent = stats.upcoming90;
  document.getElementById('kpiDeliveryVal').textContent = stats.delivery90;
  document.getElementById('kpiTypesVal').textContent    = Object.keys(stats.typeCount).length;
  const qEl  = document.getElementById('kpiQuoteVal');
  const oEl  = document.getElementById('kpiOrderedVal');
  const nbEl = document.getElementById('kpiNotBoardedVal');
  if (qEl)  qEl.textContent  = stats.quoteCount;
  if (oEl)  oEl.textContent  = stats.orderedCount;
  if (nbEl) nbEl.textContent = stats.notBoardedCount;
  document.getElementById('totalCount').innerHTML = `<i class="fas fa-ship"></i> ${rows.length} 隻`;
  document.getElementById('lastUpdated').innerHTML = `<i class="fas fa-clock"></i> ${formatDate(TODAY)} 現在`;
}

// ============================================================
// RENDER TIMELINE BANNER
// ============================================================
function renderBanner(rows) {
  const banner = document.getElementById('timelineBanner');
  const alerts = [];
  rows.forEach(r => {
    const next = getNextMilestoneDate(r);
    if (!next) return;
    const days = diffDays(next.date);
    if (days === null) return;
    if (days >= 0 && days <= 30)
      alerts.push({ name: r.VESSEL_NAME||'—', label: next.label, days, cls:'urgent', icon:'fa-exclamation-triangle' });
    else if (days >= 0 && days <= 90)
      alerts.push({ name: r.VESSEL_NAME||'—', label: next.label, days, cls:'warning', icon:'fa-clock' });
  });
  alerts.sort((a,b) => a.days - b.days);
  if (alerts.length === 0) { banner.innerHTML = ''; return; }
  banner.innerHTML = alerts.slice(0,8).map(a =>
    `<span class="alert-chip ${a.cls}">
      <i class="fas ${a.icon}"></i>
      <strong>${a.name}</strong>&nbsp;${a.label}：${daysLabel(a.days)}
    </span>`
  ).join('');
}

// ============================================================
// RENDER CHARTS
// ============================================================
const CHART_COLORS = [
  '#3b82f6','#22c55e','#f97316','#8b5cf6','#ec4899',
  '#14b8a6','#f59e0b','#64748b','#ef4444','#06b6d4',
];

function renderCharts(stats) {
  Object.values(charts).forEach(c => c.destroy());
  charts = {};

  const typeLabels = Object.keys(stats.typeCount);
  const typeVals   = typeLabels.map(k => stats.typeCount[k]);
  charts.type = new Chart(document.getElementById('chartVesselType'), {
    type: 'bar',
    data: {
      labels: typeLabels,
      datasets: [{ data: typeVals, backgroundColor: CHART_COLORS.slice(0, typeLabels.length), borderRadius: 6, borderSkipped: false }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display:false }, tooltip: { callbacks: { label: ctx => `${ctx.parsed.y} 隻` }}},
      scales: {
        x: { grid:{display:false}, ticks:{font:{size:11},color:'#64748b'} },
        y: { grid:{color:'#f1f5f9'}, ticks:{stepSize:1,font:{size:11},color:'#64748b'} }
      }
    }
  });

  const ownerLabels = Object.keys(stats.ownerCount);
  const ownerVals   = ownerLabels.map(k => stats.ownerCount[k]);
  charts.owner = new Chart(document.getElementById('chartOwnership'), {
    type: 'doughnut',
    data: { labels: ownerLabels, datasets: [{ data: ownerVals, backgroundColor: CHART_COLORS, borderWidth:2, borderColor:'#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout:'60%',
      plugins: {
        legend: { position:'bottom', labels:{font:{size:10},color:'#64748b',boxWidth:10,padding:8} },
        tooltip: { callbacks:{ label: ctx => `${ctx.label}: ${ctx.parsed} 隻` }}
      }
    }
  });

  const years    = Object.keys(stats.yearCount).sort();
  const yearVals = years.map(y => stats.yearCount[y]);
  charts.year = new Chart(document.getElementById('chartDeliveryYear'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [{ data: yearVals, backgroundColor:'rgba(59,130,246,.15)', borderColor:'#3b82f6', borderWidth:2, borderRadius:5, fill:true }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{display:false}, tooltip:{ callbacks:{ label: ctx => `${ctx.parsed.y} 隻` }}},
      scales: {
        x: { grid:{display:false}, ticks:{font:{size:11},color:'#64748b'} },
        y: { grid:{color:'#f1f5f9'}, ticks:{stepSize:1,font:{size:11},color:'#64748b'} }
      }
    }
  });
}

// ============================================================
// GANTT
// ============================================================
function calcDataRange(rows) {
  let minDate = null, maxDate = null;
  rows.forEach(r => {
    MILESTONES.forEach(m => {
      const d = r._dates[m.key] || r._dates[m.planned];
      if (!d) return;
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    });
  });
  return { minDate, maxDate };
}

function initGanttRangeInputs() {
  const { minDate, maxDate } = calcDataRange(allData);
  if (!minDate) return;
  const fromVal = `${minDate.getFullYear()}-${String(minDate.getMonth()+1).padStart(2,'0')}`;
  const toVal   = `${maxDate.getFullYear()}-${String(maxDate.getMonth()+1).padStart(2,'0')}`;
  const fromEl  = document.getElementById('ganttFrom');
  const toEl    = document.getElementById('ganttTo');
  fromEl.min = fromVal; fromEl.max = toVal;
  toEl.min   = fromVal; toEl.max   = toVal;
  fromEl.value = fromVal;
  toEl.value   = toVal;
}

function renderGantt(rows) {
  const container = document.getElementById('ganttContainer');

  let startMonth, endMonth;
  if (ganttRange.from && ganttRange.to) {
    startMonth = new Date(ganttRange.from);
    endMonth   = new Date(ganttRange.to.getFullYear(), ganttRange.to.getMonth() + 1, 1);
  } else {
    const { minDate, maxDate } = calcDataRange(rows);
    if (!minDate) {
      startMonth = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
      endMonth   = new Date(TODAY.getFullYear(), TODAY.getMonth() + 12, 1);
    } else {
      startMonth = new Date(minDate.getFullYear(), minDate.getMonth() - 1, 1);
      endMonth   = new Date(maxDate.getFullYear(), maxDate.getMonth() + 2, 1);
    }
  }

  const rangeDisp = document.getElementById('ganttRangeDisplay');
  if (rangeDisp) {
    const fmt = d => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
    const endLabel = new Date(endMonth.getFullYear(), endMonth.getMonth() - 1, 1);
    rangeDisp.textContent = `（${fmt(startMonth)} 〜 ${fmt(endLabel)}）`;
  }

  const months = [];
  let cur = new Date(startMonth);
  while (cur < endMonth) {
    months.push(new Date(cur));
    cur.setMonth(cur.getMonth() + 1);
  }

  const ganttRows = rows.filter(r =>
    MILESTONES.some(m => r._dates[m.key] != null || r._dates[m.planned] != null)
  );

  if (ganttRows.length === 0) {
    container.innerHTML = '<p class="empty-msg">表示できる工程予定データがありません</p>';
    return;
  }

  // Header
  let headerCells = `<th class="gantt-name-col">船名 / 受注状態</th>`;
  months.forEach(m => {
    const isToday = (m.getFullYear() === TODAY.getFullYear() && m.getMonth() === TODAY.getMonth());
    headerCells += `<th class="month-cell${isToday?' month-today':''}">${m.getFullYear()}/${String(m.getMonth()+1).padStart(2,'0')}</th>`;
  });

  // Body
  let bodyRows = '';
  ganttRows.forEach(r => {
    const os = getOrderStatus(r);
    const rec = getOrderStatusRecord(r);
    const osRowCls = os === 'ordered' ? ' gantt-row-ordered' : os === 'quote' ? ' gantt-row-quote' : '';

    // Order status badge in name cell
    let osBadge = '';
    if (os === 'quote')   osBadge = `<span class="badge badge-quote" style="font-size:.65rem"><i class="fas fa-file-alt"></i> 見積提出済み</span>`;
    if (os === 'ordered') osBadge = `<span class="badge badge-ordered" style="font-size:.65rem"><i class="fas fa-handshake"></i> 受注済み</span>`;

    // date sub-labels under name
    let dateSub = '';
    if (os === 'quote' && rec.quoteDate)   dateSub = `<span class="gantt-os-date">見積: ${rec.quoteDate}</span>`;
    if (os === 'ordered' && rec.orderedDate) dateSub = `<span class="gantt-os-date">受注: ${rec.orderedDate}</span>`;

    let cells = `<td>
      <div class="gantt-name">${r.VESSEL_NAME||'—'} ${osBadge}</div>
      <div class="gantt-yard">${r.BUILDER||''} ${r.BUILDERS_VESSEL_NUMBER||''} ${dateSub}</div>
    </td>`;

    months.forEach((m, i) => {
      const cellStart = m;
      const cellEnd   = months[i+1] || endMonth;
      const cellMs    = cellEnd - cellStart;

      let barsHTML = '';
      MILESTONES.forEach(mil => {
        const d = r._dates[mil.key] || r._dates[mil.planned];
        if (!d) return;
        if (d < cellStart || d >= cellEnd) return;
        const pct = ((d - cellStart) / cellMs * 100).toFixed(1);
        const isPast = d < TODAY;
        barsHTML += `<div class="gantt-bar ${mil.cls}${isPast?' past':''}"
          style="left:${pct}%;width:8px;margin-left:-4px;"
          title="${r.VESSEL_NAME||'—'} — ${mil.label}: ${formatDate(d)}"></div>`;
      });

      const isToday = (m.getFullYear() === TODAY.getFullYear() && m.getMonth() === TODAY.getMonth());
      let todayLine = '';
      if (isToday) {
        const pct = ((TODAY - cellStart) / cellMs * 100).toFixed(1);
        todayLine = `<div class="gantt-today-line" style="left:${pct}%"></div>`;
      }
      cells += `<td class="gantt-cell month-cell${isToday?' month-today':''}" style="position:relative;">${todayLine}${barsHTML}</td>`;
    });

    bodyRows += `<tr class="gantt-row${osRowCls}" data-name="${r.VESSEL_NAME||''}">${cells}</tr>`; // osRowCls already includes not-boarded
  });

  container.innerHTML = `
    <table class="gantt-table">
      <thead><tr class="gantt-header-row">${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

// ============================================================
// ORDER STATUS PANEL (per-vessel editor)
// ============================================================
function renderOrderStatusPanel() {
  const panel = document.getElementById('orderStatusPanel');
  if (!panel || allData.length === 0) return;

  const rows = allData;
  let html = `
    <div class="osp-toolbar">
      <span class="osp-count" id="ospCount"></span>
      <div class="osp-toolbar-right">
        <button class="btn-action osp-export-btn" id="ospExportBtn"><i class="fas fa-download"></i> 受注状態エクスポート</button>
      </div>
    </div>
    <div class="osp-table-wrap">
    <table class="osp-table">
      <thead>
        <tr>
          <th class="osp-nb-col">非搭載</th>
          <th>船名</th>
          <th>船種</th>
          <th>造船所</th>
          <th>引渡予定</th>
          <th class="osp-status-col">受注状態</th>
          <th class="osp-date-col">見積提出日</th>
          <th class="osp-date-col">受注日</th>
          <th class="osp-note-col">メモ</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="ospBody">
      </tbody>
    </table>
    </div>`;
  panel.innerHTML = html;

  renderOspBody(rows);

  document.getElementById('ospExportBtn').addEventListener('click', exportOrderStatus);
}

function renderOspBody(rows) {
  const tbody = document.getElementById('ospBody');
  if (!tbody) return;

  let quoteCount = 0, orderedCount = 0;
  let html = rows.map(r => {
    const key = getVesselKey(r);
    const rec = getOrderStatusRecord(r);
    const os  = getOrderStatus(r);
    if (os === 'quote')   quoteCount++;
    if (os === 'ordered') orderedCount++;

    const del = getDeliveryDate(r);

    const statusBadgeHtml = os === 'quote'
      ? `<span class="badge badge-quote"><i class="fas fa-file-alt"></i> 見積提出済み</span>`
      : os === 'ordered'
      ? `<span class="badge badge-ordered"><i class="fas fa-handshake"></i> 受注済み</span>`
      : `<span class="badge badge-grey">—</span>`;

    // Determine effective dates to show (manual first, then CSV)
    const csvQDate = ORDER_STATUS_MAP[(r.ORDER_STATUS||r.VESSEL_STATUS_OF_USE||'').trim()] === 'quote'  ? '' : '';
    const quoteDate   = rec.quoteDate   || '';
    const orderedDate = rec.orderedDate || '';

    const nb  = rec.notBoarded === true;
    const ek = escAttr(key);
    const rowCls = nb ? 'osp-row osp-row-not-boarded'
                     : `osp-row${os==='ordered'?' osp-row-ordered':os==='quote'?' osp-row-quote':''}`;
    return `<tr class="${rowCls}" data-key="${ek}">
      <td class="osp-nb-col">
        <label class="osp-nb-label" title="非搭載にマーク">
          <input type="checkbox" class="osp-nb-chk" data-key="${ek}" ${nb?'checked':''}>
          <span class="osp-nb-icon">${nb ? '<i class="fas fa-ban"></i>' : ''}</span>
        </label>
      </td>
      <td class="osp-name${nb?' nb-text':''}">${r.VESSEL_NAME||'—'}</td>
      <td>${r.VESSEL_TYPE||'—'}</td>
      <td>${r.BUILDER||'—'}</td>
      <td>${del ? formatDate(del) : '—'}</td>
      <td class="osp-status-col">
        <select class="osp-status-select" data-key="${ek}">
          <option value="other"   ${os==='other'   ?'selected':''}>—</option>
          <option value="quote"   ${os==='quote'   ?'selected':''}>見積提出済み</option>
          <option value="ordered" ${os==='ordered' ?'selected':''}>受注済み</option>
        </select>
      </td>
      <td class="osp-date-col">
        <input type="date" class="osp-date-input osp-quote-date" data-key="${ek}" value="${quoteDate}" title="見積提出日" />
      </td>
      <td class="osp-date-col">
        <input type="date" class="osp-date-input osp-ordered-date" data-key="${ek}" value="${orderedDate}" title="受注日" />
      </td>
      <td class="osp-note-col">
        <input type="text" class="osp-note-input" data-key="${ek}" value="${(rec.note||'').replace(/"/g,'&quot;')}" placeholder="メモ…" maxlength="100" />
      </td>
      <td>
        <button class="osp-save-btn btn-action" data-key="${ek}" style="font-size:.75rem;padding:4px 10px;">
          <i class="fas fa-save"></i> 保存
        </button>
      </td>
    </tr>`;
  }).join('');
  tbody.innerHTML = html;

  // Update count
  const countEl = document.getElementById('ospCount');
  if (countEl) {
    countEl.innerHTML = `全 <strong>${rows.length}</strong> 隻 ／ 見積: <strong style="color:var(--purple-600)">${quoteCount}</strong> ／ 受注: <strong style="color:var(--teal-600)">${orderedCount}</strong>`;
  }

  // Events: notBoarded checkbox → auto-save
  tbody.querySelectorAll('.osp-nb-chk').forEach(chk => {
    chk.addEventListener('change', () => ospSaveRow(chk.dataset.key));
  });

  // Events: status select → auto-save
  tbody.querySelectorAll('.osp-status-select').forEach(sel => {
    sel.addEventListener('change', () => ospSaveRow(sel.dataset.key));
  });

  // Events: date/note inputs → debounced auto-save
  tbody.querySelectorAll('.osp-date-input, .osp-note-input').forEach(inp => {
    let timer;
    inp.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => ospSaveRow(inp.dataset.key), 800);
    });
  });

  // Save button
  tbody.querySelectorAll('.osp-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await ospSaveRow(btn.dataset.key);
      toast('保存しました', 'success');
    });
  });
}

async function ospSaveRow(key) {
  const tbody = document.getElementById('ospBody');
  if (!tbody) return;
  // data-key はエスケープ済みなので querySelectorAll + find で安全に照合
  const row = [...tbody.querySelectorAll('tr[data-key]')].find(tr => tr.dataset.key === key);
  if (!row) return;

  const status      = row.querySelector('.osp-status-select').value;
  const quoteDate   = row.querySelector('.osp-quote-date').value;
  const orderedDate = row.querySelector('.osp-ordered-date').value;
  const note        = row.querySelector('.osp-note-input').value;
  const nbChk       = row.querySelector('.osp-nb-chk');
  const notBoarded  = nbChk ? nbChk.checked : false;

  // Find vessel row
  const vesselRow = allData.find(r => getVesselKey(r) === key);
  if (!vesselRow) return;

  // メモリに即時反映（await前に反映しておくことで画面と不整合にならない）
  const key2 = getVesselKey(vesselRow);
  if (key2) {
    orderStatusStore[key2] = { status, quoteDate, orderedDate, note, notBoarded, updatedAt: new Date().toISOString() };
    _saveLocalStorage();
  }

  // Update OSP row highlight immediately
  if (notBoarded) {
    row.className = 'osp-row osp-row-not-boarded';
    const nbIcon = row.querySelector('.osp-nb-icon');
    if (nbIcon) nbIcon.innerHTML = '<i class="fas fa-ban"></i>';
    const nameCell = row.querySelector('.osp-name');
    if (nameCell) nameCell.classList.add('nb-text');
  } else {
    row.className = `osp-row${status==='ordered'?' osp-row-ordered':status==='quote'?' osp-row-quote':''}`;
    const nbIcon = row.querySelector('.osp-nb-icon');
    if (nbIcon) nbIcon.innerHTML = '';
    const nameCell = row.querySelector('.osp-name');
    if (nameCell) nameCell.classList.remove('nb-text');
  }

  // サーバーに非同期保存（UIをブロックしない）
  if (_useServer) {
    fetch('/api/order-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, status, quoteDate, orderedDate, note, notBoarded, updatedAt: orderStatusStore[key2]?.updatedAt }),
    }).catch(e => console.warn('サーバー保存失敗（localStorageには保存済み）:', e));
  }

  // Refresh KPI / gantt / table（メモリ更新後なので正しい値で描画される）
  const stats = analyzeData(allData);
  renderKPI(allData, stats);
  if (allData.length) renderGantt(filtered.length ? filtered : allData);
  renderTable();
}

// ============================================================
// EXPORT ORDER STATUS
// ============================================================
function exportOrderStatus() {
  const rows = allData;
  const header = ['船名','船種','造船所','建造番号','引渡予定','非搭載','受注状態','見積提出日','受注日','メモ'];
  const lines = rows.map(r => {
    const rec = getOrderStatusRecord(r);
    const os  = getOrderStatus(r);
    const del = getDeliveryDate(r);
    return [
      r.VESSEL_NAME||'',
      r.VESSEL_TYPE||'',
      r.BUILDER||'',
      r.BUILDERS_VESSEL_NUMBER||'',
      del ? formatDate(del) : '',
      rec.notBoarded ? '非搭載' : '',
      rec.notBoarded ? '—' : ORDER_STATUS_LABEL[os],
      rec.quoteDate||'',
      rec.orderedDate||'',
      rec.note||'',
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');
  });
  const blob = new Blob(['\uFEFF' + header.join(',') + '\n' + lines.join('\n')], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `MOL_受注状態_${formatDate(TODAY).replace(/\//g,'')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('受注状態CSVをエクスポートしました', 'success');
}

// ============================================================
// FILTER DROPDOWNS
// ============================================================
function updateMddLabel(def) {
  const sel   = filterState[def.stateKey];
  const btn   = document.getElementById(def.id).querySelector('.mdd-btn');
  const label = document.getElementById(def.labelId);
  btn.querySelectorAll('.mdd-badge').forEach(b => b.remove());
  if (sel.size === 0) {
    label.textContent = def.allLabel;
    btn.classList.remove('active');
  } else {
    label.textContent = def.allLabel;
    const badge = document.createElement('span');
    badge.className = 'mdd-badge';
    badge.textContent = sel.size;
    btn.appendChild(badge);
    btn.classList.add('active');
  }
}

function syncMddCheckboxes(def) {
  const sel  = filterState[def.stateKey];
  const list = document.getElementById(def.listId);
  const allCb = document.getElementById(def.menuId).querySelector('.mdd-all input');
  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = sel.size === 0 || sel.has(cb.value);
  });
  if (allCb) allCb.checked = sel.size === 0;
}

// イベント登録済みフラグ（二重登録防止）
const _mddEventsRegistered = new Set();

function buildMddEvents(def) {
  // 同じ def.id に対してイベントを二重登録しない
  if (_mddEventsRegistered.has(def.id)) return;
  _mddEventsRegistered.add(def.id);

  const menuEl = document.getElementById(def.menuId);
  const listEl = document.getElementById(def.listId);

  // 「すべて選択」チェックボックス — イベント委任で menuEl に付ける
  menuEl.addEventListener('change', e => {
    const cb  = e.target;
    if (!cb || cb.type !== 'checkbox') return;

    const sel = filterState[def.stateKey];

    // 「すべて選択」チェックボックス（value="__all__"）
    if (cb.value === '__all__') {
      sel.clear();
      listEl.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = true; });
      cb.checked = true;
      updateMddLabel(def);
      applyFilters();
      return;
    }

    // 個別チェックボックス
    const val = cb.value;
    const allItems = [...listEl.querySelectorAll('input[type="checkbox"]')];

    if (cb.checked) {
      // チェックON
      if (sel.size === 0) {
        // 「全選択」状態でチェックON → 他の全アイテムを選択済みに追加してから今回分を除去
        // (= 今回以外を全部セレクト → ただし全部チェック済みになるので sel をリセット)
        // 実際には何もしなくて良い (全選択のまま)
        // → 何もしない: 全選択状態を維持
      } else {
        sel.add(val);
      }
    } else {
      // チェックOFF
      if (sel.size === 0) {
        // 「全選択」状態でチェックOFF → 他の全アイテムだけを sel に追加する
        allItems.forEach(c => {
          if (c.value !== val && c.value !== '__all__') sel.add(c.value);
        });
      } else {
        sel.delete(val);
      }
    }

    // 全アイテムがチェック済み = "すべて選択" と同義 → sel をリセット
    if (allItems.length > 0 && allItems.filter(c => c.value !== '__all__').every(c => sel.has(c.value) || sel.size === 0)) {
      // sel が全アイテムを含む場合はリセット
      const nonAllItems = allItems.filter(c => c.value !== '__all__');
      if (nonAllItems.length > 0 && nonAllItems.every(c => sel.has(c.value))) {
        sel.clear();
      }
    }

    syncMddCheckboxes(def);
    updateMddLabel(def);
    applyFilters();
  });

  // 検索ボックス（船種フィルター用）
  if (def.hasSearch) {
    const searchInput = menuEl.querySelector('.mdd-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        listEl.querySelectorAll('.mdd-item').forEach(item => {
          item.classList.toggle('hidden-item', q !== '' && !item.textContent.toLowerCase().includes(q));
        });
      });
    }
  }
}

function populateMddList(def, values) {
  const listEl = document.getElementById(def.listId);
  if (!def.fixed) {
    // 動的リスト（船種・所有形態・納期年）はデータロードのたびに再生成
    listEl.innerHTML = values.map(v =>
      `<label class="mdd-item"><input type="checkbox" value="${String(v).replace(/"/g,'&quot;')}" />${v}</label>`
    ).join('');
  }
  // fixed リストは HTML に既に存在するのでそのまま使う
  syncMddCheckboxes(def);
  buildMddEvents(def); // 二重登録防止フラグで1回だけ実行
}

let _mddTogglesRegistered = false;
function setupMddToggles() {
  if (_mddTogglesRegistered) return;
  _mddTogglesRegistered = true;

  MDD_DEFS.forEach(def => {
    const wrap = document.getElementById(def.id);
    const btn  = wrap.querySelector('.mdd-btn');
    const menu = document.getElementById(def.menuId);
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = !menu.classList.contains('hidden');
      MDD_DEFS.forEach(d => {
        document.getElementById(d.menuId).classList.add('hidden');
        document.getElementById(d.id).querySelector('.mdd-btn').classList.remove('open');
      });
      if (!isOpen) { menu.classList.remove('hidden'); btn.classList.add('open'); }
    });
  });
  document.addEventListener('click', () => {
    MDD_DEFS.forEach(d => {
      document.getElementById(d.menuId).classList.add('hidden');
      document.getElementById(d.id).querySelector('.mdd-btn').classList.remove('open');
    });
  });
  document.querySelectorAll('.mdd-dropdown').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation());
  });
}

function renderActiveFiltersBar() {
  const bar   = document.getElementById('activeFiltersBar');
  const chips = document.getElementById('afChips');
  const labelMap = { type:'船種', ownership:'所有形態', year:'年', status:'ステータス', orderStatus:'受注状態' };
  const statusLabel = { upcoming90:'工事90日', upcoming180:'工事180日', delivery90:'引渡90日', quote:'見積提出済み', ordered:'受注済み' };
  let html = ''; let any = false;
  MDD_DEFS.forEach(def => {
    const sel = filterState[def.stateKey];
    if (sel.size === 0) return;
    any = true;
    [...sel].forEach(v => {
      const disp = (def.stateKey === 'status' || def.stateKey === 'orderStatus') ? (statusLabel[v]||v) : v;
      html += `<span class="af-chip" data-key="${def.stateKey}" data-val="${v}">
        ${labelMap[def.stateKey]}: ${disp} <i class="fas fa-times"></i>
      </span>`;
    });
  });
  chips.innerHTML = html;
  bar.classList.toggle('hidden', !any);
  chips.querySelectorAll('.af-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      filterState[chip.dataset.key].delete(chip.dataset.val);
      const def = MDD_DEFS.find(d => d.stateKey === chip.dataset.key);
      if (def) { syncMddCheckboxes(def); updateMddLabel(def); }
      applyFilters();
    });
  });
}

function buildFilters(rows) {
  const types  = [...new Set(rows.map(r => r.VESSEL_TYPE).filter(Boolean))].sort();
  const owners = [...new Set(rows.map(r => r.OWNERSHIP_TYPE_BEFORE_DELIVERY).filter(Boolean))].sort();
  const years  = [...new Set(rows.map(r => { const d = getDeliveryDate(r); return d ? d.getFullYear() : null; }).filter(Boolean))].sort((a,b) => a-b);

  populateMddList(MDD_DEFS[0], types);
  populateMddList(MDD_DEFS[1], owners);
  populateMddList(MDD_DEFS[2], years.map(String));
  populateMddList(MDD_DEFS[3], []);
  populateMddList(MDD_DEFS[4], []);
  setupMddToggles();
}

// ============================================================
// TABLE
// ============================================================
function buildTableHead() {
  const cols = COLUMN_DEFS.filter(c => visibleCols.includes(c.key));
  const statusCol = `<th data-key="_status" class="status-col">ステータス <i class="fas fa-sort sort-icon"></i></th>`;
  const nextCol   = `<th data-key="_next">次工程 <i class="fas fa-sort sort-icon"></i></th>`;
  return `<tr>${statusCol}${nextCol}${cols.map(c =>
    `<th data-key="${c.key}">${c.label} <i class="fas fa-sort sort-icon"></i></th>`
  ).join('')}</tr>`;
}

function buildTableRows(rows) {
  if (rows.length === 0) return `<tr><td colspan="99" class="empty-msg">該当する船舶はありません</td></tr>`;
  const cols = COLUMN_DEFS.filter(c => visibleCols.includes(c.key));

  return rows.map(r => {
    const nb   = isNotBoarded(r);
    const next = getNextMilestoneDate(r);
    const days = next ? diffDays(next.date) : null;
    const st   = daysStatus(days);
    // 非搭載はグレーアウトを最優先，それ以外は絷急/注意
    let rowCls = nb ? 'row-not-boarded' : (st==='urgent' ? 'row-urgent' : st==='warning' ? 'row-warning' : '');

    let statusBadge = '';
    if (nb) {
      statusBadge = `<span class="badge badge-not-boarded"><i class="fas fa-ban"></i> 非搭載</span>`;
    } else {
      if (days===null) statusBadge = `<span class="badge badge-grey">未定</span>`;
      else if (days<0) statusBadge = `<span class="badge badge-done"><i class="fas fa-check"></i> 完了</span>`;
      else if (st==='urgent')  statusBadge = `<span class="badge badge-urgent"><i class="fas fa-exclamation"></i> 緊急</span>`;
      else if (st==='warning') statusBadge = `<span class="badge badge-warning"><i class="fas fa-clock"></i> 注意</span>`;
      else statusBadge = `<span class="badge badge-normal">予定</span>`;
    }

    let nextCell = '—';
    if (!nb && next) nextCell = `<span class="badge badge-${daysStatus(days)}">${next.label} ${daysLabel(days)}</span>`;

    const cells = cols.map(c => {
      if (c.key === '_orderStatus') {
        const os  = nb ? 'other' : getOrderStatus(r);
        const rec = getOrderStatusRecord(r);
        const key = getVesselKey(r);
        const ek  = escAttr(key);

        let badge = '';
        if (!nb && os==='quote')   badge = `<span class="badge badge-quote"><i class="fas fa-file-alt"></i> 見積提出済み</span>`;
        if (!nb && os==='ordered') badge = `<span class="badge badge-ordered"><i class="fas fa-handshake"></i> 受注済み</span>`;
        if (nb) badge = `<span class="badge badge-not-boarded"><i class="fas fa-ban"></i> 非搭載</span>`;

        // Inline quick-edit dropdown（select 初期値は getOrderStatus 結果に合わせる）
        return `<td class="os-cell">
          <div class="os-cell-inner">
            ${badge || '<span class="badge badge-grey">—</span>'}
            <button class="os-edit-btn" data-key="${ek}" title="受注状態を編集">
              <i class="fas fa-edit"></i>
            </button>
          </div>
          <div class="os-inline-editor hidden" id="osEditor_${ek}">
            <select class="os-inline-select" data-key="${ek}">
              <option value="other"   ${os==='other'  ?'selected':''}>—</option>
              <option value="quote"   ${os==='quote'  ?'selected':''}>見積提出済み</option>
              <option value="ordered" ${os==='ordered'?'selected':''}>受注済み</option>
            </select>
            <input type="date" class="os-inline-date os-inline-qdate" data-key="${ek}" value="${rec.quoteDate||''}" title="見積提出日" placeholder="見積日" />
            <input type="date" class="os-inline-date os-inline-odate" data-key="${ek}" value="${rec.orderedDate||''}" title="受注日" placeholder="受注日" />
            <button class="os-inline-save btn-action" data-key="${ek}" style="font-size:.72rem;padding:3px 8px;"><i class="fas fa-check"></i></button>
          </div>
        </td>`;
      }
      let val = r[c.key] || '—';
      if (DATE_KEYS.includes(c.key)) {
        const d = r._dates[c.key];
        val = d ? formatDate(d) : (r[c.key]||'—');
      }
      return `<td>${val}</td>`;
    }).join('');

    return `<tr class="${rowCls}" data-uid="${r.VESSEL_UID||''}" data-name="${r.VESSEL_NAME||''}">
      <td>${statusBadge}</td>
      <td>${nextCell}</td>
      ${cells}
    </tr>`;
  }).join('');
}

function renderTable() {
  const pageRows = showAll ? filtered : filtered.slice((currentPage-1)*PAGE_SIZE, currentPage*PAGE_SIZE);
  document.getElementById('tableHead').innerHTML = buildTableHead();
  document.getElementById('tableBody').innerHTML = buildTableRows(pageRows);

  const hasFilter = !!(document.getElementById('searchInput').value || Object.values(filterState).some(s => s.size > 0));
  const countEl = document.getElementById('tableCount');
  if (hasFilter) {
    countEl.innerHTML = `<span style="color:var(--blue-600);font-weight:700">${filtered.length}</span> <span style="color:var(--slate-400)">/</span> ${allData.length} 件<span style="color:var(--slate-400);font-size:.75rem;margin-left:4px">（絞込中）</span>`;
  } else {
    countEl.innerHTML = `${allData.length} 件（全件）`;
  }
  const psEl = document.getElementById('pageSizeSelect');
  if (psEl) psEl.value = showAll ? 'all' : String(PAGE_SIZE);
  renderPagination();

  // Sort
  document.querySelectorAll('#tableHead th').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.key;
      if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
      applySort();
      renderTable();
    });
    if (th.dataset.key === sortKey) th.classList.add(sortDir===1?'sorted-asc':'sorted-desc');
  });

  // Row click → modal (not on os-cell)
  document.querySelectorAll('#tableBody tr[data-name]').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('.os-cell')) return;
      const name = tr.dataset.name;
      const row = allData.find(r => r.VESSEL_NAME === name);
      if (row) openModal(row);
    });
  });

  // Inline editor toggle
  document.querySelectorAll('.os-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      // ボタンの親 td 内の .os-inline-editor を探す（id は escAttr 済みなので直接取得しない）
      const editor = btn.closest('td').querySelector('.os-inline-editor');
      if (editor) editor.classList.toggle('hidden');
    });
  });

  // Inline save
  document.querySelectorAll('.os-inline-save').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const rawKey = btn.dataset.key;
      const editor = btn.closest('.os-inline-editor');
      if (!editor) return;
      const status      = editor.querySelector('.os-inline-select').value;
      const quoteDate   = editor.querySelector('.os-inline-qdate').value;
      const orderedDate = editor.querySelector('.os-inline-odate').value;
      const vesselRow   = allData.find(r => getVesselKey(r) === rawKey);
      if (vesselRow) {
        const oldRec = getOrderStatusRecord(vesselRow);
        setOrderStatusRecord(vesselRow, { ...oldRec, status, quoteDate, orderedDate });
        toast('受注状態を保存しました', 'success');
        const stats = analyzeData(allData);
        renderKPI(allData, stats);
        renderOspBody(allData);
        applyFilters();
      }
    });
  });
}

function renderPagination() {
  const pg = document.getElementById('pagination');
  if (showAll) { pg.innerHTML = ''; return; }
  const total = Math.ceil(filtered.length / PAGE_SIZE);
  if (total <= 1) { pg.innerHTML = ''; return; }

  let html = `<button class="page-btn" id="pgPrev" ${currentPage===1?'disabled':''}><i class="fas fa-chevron-left"></i></button>`;
  const range = [];
  for (let i = 1; i <= total; i++) {
    if (i===1 || i===total || Math.abs(i-currentPage)<=2) range.push(i);
    else if (range[range.length-1] !== '...') range.push('...');
  }
  range.forEach(p => {
    if (p === '...') html += `<span class="page-btn" style="border:none;background:none;cursor:default">…</span>`;
    else html += `<button class="page-btn${p===currentPage?' active':''}" data-p="${p}">${p}</button>`;
  });
  html += `<button class="page-btn" id="pgNext" ${currentPage===total?'disabled':''}><i class="fas fa-chevron-right"></i></button>`;
  pg.innerHTML = html;
  pg.querySelectorAll('[data-p]').forEach(b => { b.addEventListener('click', () => { currentPage = +b.dataset.p; renderTable(); }); });
  const prev = pg.querySelector('#pgPrev');
  const next = pg.querySelector('#pgNext');
  if (prev) prev.addEventListener('click', () => { currentPage--; renderTable(); });
  if (next) next.addEventListener('click', () => { currentPage++; renderTable(); });
}

// ============================================================
// SORT & FILTER
// ============================================================
function applySort() {
  if (!sortKey) return;
  filtered.sort((a, b) => {
    let av, bv;
    if (DATE_KEYS.includes(sortKey) || sortKey.startsWith('_')) {
      if (sortKey === '_status') {
        const an = getNextMilestoneDate(a); av = an ? an.date : new Date(9999,0,1);
        const bn = getNextMilestoneDate(b); bv = bn ? bn.date : new Date(9999,0,1);
        return (av - bv) * sortDir;
      }
      av = a._dates[sortKey] || new Date(9999,0,1);
      bv = b._dates[sortKey] || new Date(9999,0,1);
      return (av - bv) * sortDir;
    }
    av = (a[sortKey]||'').toLowerCase();
    bv = (b[sortKey]||'').toLowerCase();
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });
}

function applyFilters() {
  const q          = document.getElementById('searchInput').value.toLowerCase();
  const types      = filterState.type;
  const owners     = filterState.ownership;
  const years      = filterState.year;
  const stats      = filterState.status;
  const orderStats = filterState.orderStatus;

  filtered = allData.filter(r => {
    if (q && ![r.VESSEL_NAME,r.BUILDER,r.BUILDERS_VESSEL_NUMBER,r.YARD,r.BUILDER_YARD].some(v => (v||'').toLowerCase().includes(q))) return false;
    if (types.size  && !types.has(r.VESSEL_TYPE))  return false;
    if (owners.size && !owners.has(r.OWNERSHIP_TYPE_BEFORE_DELIVERY)) return false;
    if (years.size) {
      const d = getDeliveryDate(r);
      if (!d || !years.has(String(d.getFullYear()))) return false;
    }
    if (stats.size) {
      const keel = r._dates['CONSTRUCTION_START_DATE'] || r._dates['PLANNED_CONSTRUCTION_START_DATE'];
      const del  = getDeliveryDate(r);
      const now  = TODAY.getTime();
      const pass = [...stats].some(st => {
        if (st==='upcoming90'  && keel && keel-now>=0 && keel-now<=DAYS_90)  return true;
        if (st==='upcoming180' && keel && keel-now>=0 && keel-now<=DAYS_180) return true;
        if (st==='delivery90'  && del  && del-now>=0  && del-now<=DAYS_90)   return true;
        return false;
      });
      if (!pass) return false;
    }
    if (orderStats.size && !orderStats.has(getOrderStatus(r))) return false;
    return true;
  });
  applySort();
  currentPage = 1;
  renderTable();
  renderActiveFiltersBar();
  if (allData.length) renderGantt(filtered.length ? filtered : allData);
}

// ============================================================
// COLUMN TOGGLE
// ============================================================
function buildColToggle() {
  const menu = document.getElementById('colToggleMenu');
  menu.innerHTML = COLUMN_DEFS.map(c =>
    `<label class="col-toggle-item">
      <input type="checkbox" data-key="${c.key}" ${visibleCols.includes(c.key)?'checked':''} />
      ${c.label}
    </label>`
  ).join('');
  menu.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      const k = inp.dataset.key;
      if (inp.checked) { if (!visibleCols.includes(k)) visibleCols.push(k); }
      else visibleCols = visibleCols.filter(x => x !== k);
      renderTable();
    });
  });
}

// ============================================================
// DETAIL MODAL
// ============================================================
function openModal(r) {
  const os = getOrderStatus(r);
  const rec = getOrderStatusRecord(r);
  const key = getVesselKey(r);

  const osBadge = os === 'quote'
    ? `<span class="badge badge-quote" style="margin-left:8px;font-size:.75rem"><i class="fas fa-file-alt"></i> 見積提出済み</span>`
    : os === 'ordered'
    ? `<span class="badge badge-ordered" style="margin-left:8px;font-size:.75rem"><i class="fas fa-handshake"></i> 受注済み</span>`
    : '';

  document.getElementById('modalHeader').innerHTML = `
    <div class="modal-title">${r.VESSEL_NAME||'（船名未定）'}${osBadge}</div>
    <div class="modal-subtitle">
      ${r.VESSEL_TYPE||''} ｜ ${r.BUILDER||''} ｜ 建造番号: ${r.BUILDERS_VESSEL_NUMBER||'—'} ｜ IMO: ${r.IMO_NO||'—'}
    </div>`;

  const milestoneHTML = MILESTONES.map(m => {
    const actual  = r._dates[m.key];
    const planned = r._dates[m.planned];
    const d = actual || planned;
    const days = d ? diffDays(d) : null;
    const isDone = d && d < TODAY;
    const isNext = !isDone && d && d >= TODAY;
    const label  = actual ? '実績' : (planned?'予定':'—');
    return `<div class="milestone-item${isDone?' done':''}${isNext?' next':''}">
      <div class="milestone-dot ${m.cls}"></div>
      <div class="milestone-label">${m.label} <small style="color:var(--slate-400)">(${label})</small></div>
      <div class="milestone-date">${formatDate(d)} ${days!==null&&!isDone?`<small>(${daysLabel(days)})</small>`:''}</div>
    </div>`;
  }).join('');

  const specs = [
    ['LOA', r.LOA||'—','m'], ['幅', r.BEAM||'—','m'], ['吃水(設計)', r.DRAFT_DESIGN||'—','m'],
    ['GT', r.GROSS_TON?Number(r.GROSS_TON).toLocaleString()+'T':'—',''],
    ['DWT', r.DWT_GUARANTEE_MT?Number(r.DWT_GUARANTEE_MT).toLocaleString()+'MT':'—',''],
    ['速力', r.PLANNED_SAILING_SPEED_KTS?r.PLANNED_SAILING_SPEED_KTS+' kts':'—',''],
    ['主機出力', r.MAIN_ENGINE_MAX_OUTPUT_KW?Number(r.MAIN_ENGINE_MAX_OUTPUT_KW).toLocaleString()+' kW':'—',''],
  ];

  document.getElementById('modalBody').innerHTML = `
    <div class="modal-section">
      <div class="modal-section-title">基本情報</div>
      <div class="modal-grid">
        ${[
          ['船名', r.VESSEL_NAME||'—', true],
          ['船種', r.VESSEL_TYPE||'—', false],
          ['所有形態', r.OWNERSHIP_TYPE_BEFORE_DELIVERY||'—', false],
          ['船籍', r.VESSEL_FLAG_STATE||'—', false],
          ['船級', r.VESSEL_CLASS_NAME||'—', false],
          ['発注者', r.SHIPBUILDING_CONTRUCT_PURCHASER||'—', false],
          ['使用状態', r.VESSEL_STATUS_OF_USE||'—', false],
          ['受注状態', ORDER_STATUS_LABEL[os], os!=='other'],
        ].map(([l,v,hl]) => `<div class="modal-field">
          <div class="modal-field-label">${l}</div>
          <div class="modal-field-value${hl?' highlight':''}">${v}</div>
        </div>`).join('')}
      </div>
    </div>

    <!-- 受注状態 編集パネル（モーダル内） -->
    <div class="modal-section modal-os-section">
      <div class="modal-section-title"><i class="fas fa-edit"></i> 受注状態を編集</div>
      <div class="modal-os-form" id="modalOsForm">
        <div class="modal-os-row modal-nb-row">
          <label class="modal-os-label">&nbsp;</label>
          <label class="modal-nb-check-label">
            <input type="checkbox" id="modalNbChk" ${rec.notBoarded?'checked':''}>
            <span class="modal-nb-icon"><i class="fas fa-ban"></i></span>
            非搭載（未対象船）にマークする
          </label>
        </div>
        <div class="modal-os-row">
          <label class="modal-os-label">ステータス</label>
          <select class="modal-os-select" id="modalOsSelect">
            <option value="other"   ${os==='other'  ?'selected':''}>—（未設定）</option>
            <option value="quote"   ${os==='quote'  ?'selected':''}>見積提出済み</option>
            <option value="ordered" ${os==='ordered'?'selected':''}>受注済み</option>
          </select>
        </div>
        <div class="modal-os-row">
          <label class="modal-os-label">見積提出日</label>
          <input type="date" class="modal-os-date" id="modalOsQuoteDate" value="${rec.quoteDate||''}" />
        </div>
        <div class="modal-os-row">
          <label class="modal-os-label">受注日</label>
          <input type="date" class="modal-os-date" id="modalOsOrderedDate" value="${rec.orderedDate||''}" />
        </div>
        <div class="modal-os-row modal-os-note-row">
          <label class="modal-os-label">メモ</label>
          <input type="text" class="modal-os-note" id="modalOsNote" value="${(rec.note||'').replace(/"/g,'&quot;')}" placeholder="メモを入力…" maxlength="200" />
        </div>
        <button class="btn-action modal-os-save" id="modalOsSave" data-key="${escAttr(key)}">
          <i class="fas fa-save"></i> 保存する
        </button>
        <span class="modal-os-saved hidden" id="modalOsSaved"><i class="fas fa-check-circle" style="color:var(--green-500)"></i> 保存済み</span>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">工程マイルストーン</div>
      <div class="milestone-list">${milestoneHTML}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">船型諸元</div>
      <div class="modal-grid">
        ${specs.map(([l,v]) => `<div class="modal-field">
          <div class="modal-field-label">${l}</div>
          <div class="modal-field-value">${v}</div>
        </div>`).join('')}
      </div>
    </div>

    ${r.REMARKS_TECHNICAL_DIV ? `
    <div class="modal-section">
      <div class="modal-section-title">技術部備考</div>
      <p style="font-size:.85rem;color:var(--slate-700);line-height:1.7">${r.REMARKS_TECHNICAL_DIV}</p>
    </div>` : ''}`;

  document.getElementById('modalOverlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Modal save button
  document.getElementById('modalOsSave').addEventListener('click', async () => {
    const k = document.getElementById('modalOsSave').dataset.key;
    const status      = document.getElementById('modalOsSelect').value;
    const quoteDate   = document.getElementById('modalOsQuoteDate').value;
    const orderedDate = document.getElementById('modalOsOrderedDate').value;
    const note        = document.getElementById('modalOsNote').value;
    const notBoarded  = document.getElementById('modalNbChk')?.checked || false;
    const vRow = allData.find(rr => getVesselKey(rr) === k);
    if (vRow) {
      // メモリに即時反映（awaitより前に書いておく）
      orderStatusStore[k] = { status, quoteDate, orderedDate, note, notBoarded, updatedAt: new Date().toISOString() };
      _saveLocalStorage();
      if (_useServer) {
        fetch('/api/order-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: k, ...orderStatusStore[k] }),
        }).catch(e => console.warn('モーダル保存失敗（localStorageには保存済み）:', e));
      }
      const savedEl = document.getElementById('modalOsSaved');
      if (savedEl) { savedEl.classList.remove('hidden'); setTimeout(() => savedEl.classList.add('hidden'), 2000); }
      const stats2 = analyzeData(allData);
      renderKPI(allData, stats2);
      renderOspBody(allData);
      renderGantt(filtered.length ? filtered : allData);
      renderTable();
    }
  });
}

function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
  document.body.style.overflow = '';
}

// ============================================================
// EXPORT CSV
// ============================================================
function exportCSV() {
  const cols   = COLUMN_DEFS.filter(c => visibleCols.includes(c.key));
  const header = ['ステータス','次工程',...cols.map(c => c.label)].join(',');
  const rows   = filtered.map(r => {
    const next = getNextMilestoneDate(r);
    const days = next ? diffDays(next.date) : null;
    const st   = next ? `${next.label} ${daysLabel(days)}` : '—';
    return [
      daysStatus(days), st,
      ...cols.map(c => {
        let v = r[c.key] || '';
        if (DATE_KEYS.includes(c.key)) v = formatDate(r._dates[c.key]);
        if (c.key === '_orderStatus') v = ORDER_STATUS_LABEL[getOrderStatus(r)];
        return `"${String(v).replace(/"/g,'""')}"`;
      })
    ].join(',');
  });
  const blob = new Blob(['\uFEFF'+header+'\n'+rows.join('\n')], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `MOL_船舶管理リスト_${formatDate(TODAY).replace(/\//g,'')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSVをエクスポートしました','success');
}

// ============================================================
// LOCAL → SERVER RESTORE
// ============================================================
async function _restoreLocalToServer() {
  // localStorageから直接読む（orderStatusStoreはすでにマージ済みだが念のため）
  let localData = {};
  try {
    const raw = localStorage.getItem('molShipOrderStatus_v1');
    if (raw) localData = JSON.parse(raw);
  } catch(e) { return; }

  const localKeys = Object.keys(localData).filter(k => {
    const rec = localData[k];
    return rec && rec.status && rec.status !== 'other';
  });

  if (localKeys.length === 0) return; // 保存済みデータなし

  if (_useServer) {
    // サーバーに存在しないキーを自動アップロード
    try {
      const serverRes = await fetch('/api/order-status');
      const serverJson = await serverRes.json();
      const serverKeys = serverJson.ok ? Object.keys(serverJson.data || {}) : [];
      const missingKeys = localKeys.filter(k => !serverKeys.includes(k));
      if (missingKeys.length > 0) {
        const uploadPromises = missingKeys.map(key =>
          fetch('/api/order-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, ...localData[key] }),
          }).catch(() => {})
        );
        await Promise.all(uploadPromises);
        console.log(`localStorageから${missingKeys.length}件の受注状態をサーバーに自動復元しました`);
        toast(`${missingKeys.length}件の受注状態をサーバーに自動復元しました`, 'success');
      }
    } catch(e) {
      console.warn('サーバーへの自動復元に失敗:', e);
      // 失敗した場合は手動復元UIを表示
      _showLocalRestoreUI(localData, localKeys);
    }
  } else {
    // サーバーなし→手動復元UIも不要（localStorageから直接使う）
  }
}

// 手動復元UI表示（サーバーへの自動復元が失敗した場合）
function _showLocalRestoreUI(localData, localKeys) {
  const area = document.getElementById('localRestoreArea');
  const countEl = document.getElementById('localRestoreCount');
  if (!area || !countEl) return;

  const quoteCount = localKeys.filter(k => localData[k].status === 'quote').length;
  const orderedCount = localKeys.filter(k => localData[k].status === 'ordered').length;
  countEl.textContent = `見積提出済み: ${quoteCount}件、受注済み: ${orderedCount}件（合計${localKeys.length}件）`;
  area.style.display = 'block';

  document.getElementById('btnRestoreToServer')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnRestoreToServer');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 復元中...'; }
    try {
      const uploads = localKeys.map(key =>
        fetch('/api/order-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, ...localData[key] }),
        }).catch(() => {})
      );
      await Promise.all(uploads);
      area.style.display = 'none';
      toast(`${localKeys.length}件の受注状態をサーバーに復元しました`, 'success');
    } catch(e) {
      toast('復元に失敗しました。再度お試しください。', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> サーバーに復元する'; }
    }
  });

  document.getElementById('btnIgnoreLocal')?.addEventListener('click', () => {
    area.style.display = 'none';
  });
}

// ============================================================
// SHARED SERVER SYNC (polling)
// ============================================================
let _pollTimer = null;
let _lastOrderStatusUpdatedAt = '';  // サーバー側の最終更新時刻を追跡

// サーバーとlocalStorageをマージするヘルパー
function _mergeServerData(serverData) {
  if (!serverData || typeof serverData !== 'object') return false;
  // サーバーデータが空（{}）の場合はマージしない（サーバー再起動対策）
  if (Object.keys(serverData).length === 0) return false;
  const before = JSON.stringify(orderStatusStore);
  orderStatusStore = _mergeStores(orderStatusStore, serverData);
  const changed = JSON.stringify(orderStatusStore) !== before;
  if (changed) _saveLocalStorage();
  return changed;
}

async function syncFromServer() {
  if (!_useServer || allData.length === 0) return;
  try {
    const r = await fetch('/api/order-status');
    const j = await r.json();
    if (j.ok && j.data) {
      _mergeServerData(j.data);
      // 画面を静かに更新
      const stats = analyzeData(allData);
      renderKPI(allData, stats);
      renderOspBody(allData);
      renderTable();
    }
  } catch(e) {}
}

function startPolling() {
  if (_pollTimer) return; // 二重起動防止
  _pollTimer = setInterval(async () => {
    if (!_useServer || allData.length === 0) return;
    try {
      const r = await fetch('/api/order-status');
      const j = await r.json();
      if (j.ok && j.data) {
        // マージして変更があった場合のみ更新
        const oldData = JSON.stringify(orderStatusStore);
        const changed = _mergeServerData(j.data);
        const newData = JSON.stringify(orderStatusStore);
        if (changed || newData !== oldData) {
          const stats = analyzeData(allData);
          renderKPI(allData, stats);
          renderOspBody(allData);
          renderTable();
          // 小さな通知（トーストは出さず、バッジだけ点滅）
          const badge = document.getElementById('sharedModeBadge');
          if (badge) {
            badge.innerHTML = '<i class="fas fa-sync-alt"></i> 更新されました';
            setTimeout(() => { badge.innerHTML = '<i class="fas fa-users"></i> 共有モード'; }, 3000);
          }
        }
      }
    } catch(e) {}
  }, 30000); // 30秒ごと
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ============================================================
// SAMPLE DATA
// ============================================================
async function loadSampleData() {
  const today = TODAY;
  const d = (offsetDays) => {
    const dt = new Date(today); dt.setDate(dt.getDate() + offsetDays);
    return `${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
  };

  const csvLines = [
    'BUILDER_YARD,BUILDER,YARD,BUILDERS_VESSEL_NUMBER,VESSEL_NAME,VESSEL_TYPE,VESSEL_TYPE_FOR_TECHNICAL_DIV,OWNERSHIP_TYPE_BEFORE_DELIVERY,VESSEL_STATUS_OF_USE,VESSEL_NAME_FIX_DEADLINE,VESSEL_FLAG_STATE,VESSEL_CLASS_NAME,PORT_OF_REGISTRY,SHIPBUILDING_CONTRUCT_DATE,CONSTRUCTION_START_DATE_ON_CERTIFICATE,PLANNED_CONSTRUCTION_START_DATE,CONSTRUCTION_START_DATE,PLANNED_LAUNCH_DATE,LAUNCH_DATE,PLANNED_SEA_TRIALS_DATE,PLANNED_CONSTRUCTION_COMPLETE_DATE,PLANNED_DATE_OF_BUILD_DATE,CONTRACT_DELIVERY_DATE_FROM,CONTRACT_DELIVERY_DATE_TO,SHIPBUILDING_CONTRUCT_PURCHASER,REMARKS_TECHNICAL_DIV,LOA,LPP,BEAM,DEPTH,DRAFT_DESIGN,DRAFT_SCANTLING,GROSS_TON,NET_TON,DWT_GUARANTEE_MT,PLANNED_SAILING_SPEED_KTS,MAIN_ENGINE_MAX_OUTPUT_KW,IMO_NO,FLEET_OPTIMIZATION_EXECUTION_EXECTIVE_COMMITTEE_RESOLUTION_NUMBER,FLEET_OPTIMIZATION_EXECUTION_BOARD_RESOLUTION_NUMBER,ORIGINAL_USER,ORIGINAL_STAMP,UPDATE_USER,UPDATE_STAMP,VESSEL_UID',
    `IMABARI-1,今治造船,今治工場,1001,MOL TRIUMPH,コンテナ船,CONT,MOL,建造中,${d(-30)},パナマ,NK,パナマ,${d(-400)},${d(-380)},${d(-380)},${d(-375)},${d(60)},,,${d(120)},${d(150)},${d(140)},${d(160)},MOL Containership Ltd.,,400.0,380.0,59.0,33.5,16.0,16.5,210000,65000,200000,22.0,68000,9000001,,,,MOL,${d(-400)},MOL,${d(-100)},UID001`,
    `IMABARI-2,今治造船,今治工場,1002,MOL COSMOS,コンテナ船,CONT,MOL,建造中,,パナマ,NK,パナマ,${d(-300)},${d(-280)},${d(-280)},${d(-270)},${d(90)},,,${d(150)},${d(180)},${d(170)},${d(190)},MOL Containership Ltd.,,400.0,380.0,59.0,33.5,16.0,16.5,210000,65000,200000,22.0,68000,9000002,,,,MOL,${d(-300)},MOL,${d(-80)},UID002`,
    `JMU-1,Japan Marine United,横浜工場,2001,MOL MATRIX,自動車船,PCC,MOL,契約締結済,,パナマ,NK,東京,${d(-200)},,,${d(20)},${d(200)},,,${d(280)},${d(310)},${d(300)},${d(320)},MOL ACE Ltd.,,199.9,192.0,38.0,14.5,8.5,9.0,71000,21000,,18.5,16000,9000003,,,,MOL,${d(-200)},MOL,${d(-60)},UID003`,
    `JMU-2,Japan Marine United,横浜工場,2002,MOL VECTOR,自動車船,PCC,MOL,契約締結済,,パナマ,NK,東京,${d(-180)},,,${d(45)},${d(220)},,,${d(300)},${d(330)},${d(320)},${d(340)},MOL ACE Ltd.,次世代CO2削減型,199.9,192.0,38.0,14.5,8.5,9.0,71000,21000,,18.5,16000,9000004,,,,MOL,${d(-180)},MOL,${d(-50)},UID004`,
    `NAMURA-1,名村造船,佐世保工場,3001,MOL LEGACY,バルクキャリア,BC,MOL,基本設計中,,パナマ,NK,パナマ,${d(-100)},,,${d(80)},${d(350)},,,${d(420)},${d(450)},${d(440)},${d(460)},MOL Bulk Carriers Ltd.,,299.9,296.0,50.0,25.0,18.1,18.5,90000,54000,180000,14.5,11000,9000005,,,,MOL,${d(-100)},MOL,${d(-30)},UID005`,
    `NAMURA-2,名村造船,佐世保工場,3002,MOL LIBERTY,バルクキャリア,BC,MOL,基本設計中,,パナマ,NK,パナマ,${d(-90)},,,${d(100)},${d(380)},,,${d(450)},${d(480)},${d(470)},${d(490)},MOL Bulk Carriers Ltd.,,299.9,296.0,50.0,25.0,18.1,18.5,90000,54000,180000,14.5,11000,9000006,,,,MOL,${d(-90)},MOL,${d(-20)},UID006`,
    `MHI-1,三菱重工業,長崎工場,4001,MOL WONDER,クルーズ客船,CR,MOL,設計中,,バハマ,LR,ナッソー,${d(-50)},,,${d(150)},${d(500)},,,${d(600)},${d(640)},${d(630)},${d(650)},MOL Ferry Co.,,330.0,310.0,40.0,12.5,8.0,8.5,105000,42000,,22.0,62000,9000007,,,,MOL,${d(-50)},MOL,${d(-10)},UID007`,
    `OSHIMA-1,大島造船,大島工場,5001,MOL BRAVE,タンカー,TC,MOL,契約締結済,,パナマ,NK,パナマ,${d(-120)},,,${d(10)},${d(200)},,,${d(280)},${d(310)},${d(300)},${d(320)},MOL Chemical Tankers Ltd.,,249.9,243.0,43.8,21.0,14.8,15.5,60000,36000,105000,15.0,12000,9000008,,,,MOL,${d(-120)},MOL,${d(-40)},UID008`,
    `IMABARI-3,今治造船,今治工場,1003,MOL SPIRIT,コンテナ船,CONT,MOL,契約締結済,,パナマ,NK,パナマ,${d(-60)},,,${d(5)},${d(180)},,,${d(250)},${d(280)},${d(270)},${d(290)},MOL Containership Ltd.,メタノール対応型,366.0,350.0,51.0,30.0,14.5,15.2,150000,45000,145000,21.0,45000,9000009,,,,MOL,${d(-60)},MOL,${d(-5)},UID009`,
    `IMABARI-4,今治造船,今治工場,1004,MOL FUTURE,コンテナ船,CONT,MOL,基本設計中,,パナマ,NK,パナマ,${d(-30)},,,${d(30)},${d(210)},,,${d(280)},${d(310)},${d(300)},${d(320)},MOL Containership Ltd.,アンモニア対応型,366.0,350.0,51.0,30.0,14.5,15.2,150000,45000,145000,21.0,45000,9000010,,,,MOL,${d(-30)},MOL,${d(-3)},UID010`,
    `KAWASAKI-1,川崎重工業,神戸工場,6001,MOL HORIZON,LNG船,LNG,MOL,見積提出済み,${d(30)},パナマ,NK,パナマ,,,,,,,,,,,${d(500)},${d(520)},MOL LNG Transport Ltd.,LNG二元燃料,295.0,284.0,46.0,26.0,11.5,12.5,100000,62000,,19.5,28000,,,,,MOL,,MOL,,UID011`,
    `KAWASAKI-2,川崎重工業,神戸工場,6002,MOL AURORA,LNG船,LNG,MOL,見積提出済み,${d(60)},パナマ,NK,パナマ,,,,,,,,,,,${d(540)},${d(560)},MOL LNG Transport Ltd.,LNG二元燃料,295.0,284.0,46.0,26.0,11.5,12.5,100000,62000,,19.5,28000,,,,,MOL,,MOL,,UID012`,
    `NSU-1,日本造船,長崎工場,7001,MOL SEEKER,バルクキャリア,BC,MOL,商談中,${d(45)},パナマ,NK,パナマ,,,,,,,,,,,${d(480)},${d(500)},MOL Bulk Carriers Ltd.,アンモニア対応型,230.0,225.0,43.0,20.0,13.5,14.2,80000,48000,82000,14.0,9500,,,,,MOL,,MOL,,UID013`,
  ];

  await loadData(csvLines.join('\n'));
  toast('サンプルデータを読み込みました','success');
}

// ============================================================
// MAIN LOAD
// ============================================================
async function loadData(csvText, { skipServerSave = false } = {}) {
  try {
    // 最新の受注状態を読み直す（メモリ・localStorage・サーバーを全マージ）
    // ※ loadOrderStatusStore内でメモリ上の既存データも保持するので消えない
    await loadOrderStatusStore();

    allData = parseCSV(csvText);
    if (allData.length === 0) { toast('データが見つかりませんでした','error'); return; }

    // CSV をサーバーに保存して全員と共有（自分がアップした場合のみ）
    if (!skipServerSave && _useServer) {
      try {
        const nameEl = document.getElementById('userName');
        const updatedBy = (nameEl && nameEl.value.trim()) || 'ユーザー';
        // ユーザー名をlocalStorageに保存（次回も使えるように）
        if (nameEl && nameEl.value.trim()) localStorage.setItem('molShipUserName', nameEl.value.trim());
        await fetch('/api/csv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: csvText, updatedBy }),
        });
      } catch(e) {}
    }

    filtered = [...allData];
    Object.keys(filterState).forEach(k => filterState[k].clear());

    const stats = analyzeData(allData);

    document.getElementById('uploadSection').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');

    renderKPI(allData, stats);
    renderBanner(allData);
    renderCharts(stats);
    ganttRange.from = null; ganttRange.to = null;
    document.querySelectorAll('.gantt-quick-btn').forEach(b => b.classList.remove('active'));
    const allBtn = document.querySelector('.gantt-quick-btn[data-months="0"]');
    if (allBtn) allBtn.classList.add('active');
    initGanttRangeInputs();
    renderGantt(allData);
    buildFilters(allData);
    buildColToggle();
    renderActiveFiltersBar();

    // 受注状態パネル
    renderOrderStatusPanel();

    sortKey = '_status'; sortDir = 1;
    applySort();
    renderTable();

    toast(`${allData.length} 隻のデータを読み込みました`, 'success');

    // 共有サーバー使用時はポーリング開始
    if (_useServer) startPolling();
  } catch(e) {
    console.error(e);
    toast('CSVの読み込みに失敗しました: ' + e.message, 'error');
  }
}

// ============================================================
// EVENT LISTENERS
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // ユーザー名を復元
  const savedName = localStorage.getItem('molShipUserName');
  const userNameEl = document.getElementById('userName');
  if (savedName && userNameEl) userNameEl.value = savedName;

  // サーバー検出 → 受注状態読み込み
  await detectServer();
  await loadOrderStatusStore();

  // localStorageに受注状態データがあるか確認し、サーバーに復元
  await _restoreLocalToServer();

  // サーバーに保存済み CSV があれば自動ロード
  if (_useServer) {
    try {
      const r = await fetch('/api/csv');
      const j = await r.json();
      if (j.ok && j.data && j.data.csv) {
        const info = j.data;
        const dtStr = info.updatedAt
          ? new Date(info.updatedAt).toLocaleString('ja-JP')
          : '';
        // サーバーにCSVがあれば自動的にロード（共有モード）
        await loadData(info.csv, { skipServerSave: true });
        toast(`サーバーのCSVを自動ロードしました（最終更新: ${dtStr} by ${info.updatedBy || '不明'}）`, 'success');
        // 30秒ごとに受注状態を自動同期
        startPolling();
      } else {
        // CSV未保存 → アップロード画面にヒントを表示
        const hint = document.querySelector('.upload-hint');
        if (hint) {
          hint.innerHTML += `<br><span style="color:var(--teal-600);font-weight:600"><i class="fas fa-cloud-upload-alt"></i> 共有モード：CSVをアップロードすると全員に共有されます</span>`;
        }
      }
    } catch(e) {}
  }

  // 共有モード表示バッジ
  if (_useServer) {
    const meta = document.getElementById('headerMeta');
    if (meta) {
      const badge = document.createElement('span');
      badge.className = 'meta-badge';
      badge.id = 'sharedModeBadge';
      badge.style.cssText = 'background:var(--teal-100);color:var(--teal-600);cursor:pointer;';
      badge.title = 'クリックで受注状態を今すぐ同期';
      badge.innerHTML = '<i class="fas fa-users"></i> 共有モード';
      badge.addEventListener('click', async () => {
        badge.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 同期中...';
        await syncFromServer();
        badge.innerHTML = '<i class="fas fa-users"></i> 共有モード';
        toast('受注状態を同期しました', 'success');
      });
      meta.insertBefore(badge, meta.firstChild);
    }
  }

  // File input
  const csvInput = document.getElementById('csvInput');
  csvInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadData(ev.target.result);
    reader.onerror = () => {
      const r2 = new FileReader();
      r2.onload = ev2 => loadData(ev2.target.result);
      r2.readAsText(file, 'Shift_JIS');
    };
    reader.readAsText(file, 'UTF-8');
  });

  // Drag & Drop
  const dropZone = document.getElementById('dropZone');
  ['dragenter','dragover'].forEach(ev => {
    dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  });
  ['dragleave','drop'].forEach(ev => {
    dropZone.addEventListener(ev, e => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
  });
  dropZone.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.csv')) { toast('CSVファイルを選択してください','error'); return; }
    const reader = new FileReader();
    reader.onload = ev => loadData(ev.target.result);
    reader.readAsText(file, 'UTF-8');
  });

  // Sample data
  document.getElementById('btnSample').addEventListener('click', () => loadSampleData());

  // Search
  document.getElementById('searchInput').addEventListener('input', applyFilters);

  // Active filter bar clear
  document.getElementById('afClearAll').addEventListener('click', () => {
    Object.keys(filterState).forEach(k => filterState[k].clear());
    MDD_DEFS.forEach(def => { syncMddCheckboxes(def); updateMddLabel(def); });
    applyFilters();
  });

  // Export
  document.getElementById('btnExport').addEventListener('click', exportCSV);

  // Reset
  document.getElementById('btnReset').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    Object.keys(filterState).forEach(k => filterState[k].clear());
    MDD_DEFS.forEach(def => { syncMddCheckboxes(def); updateMddLabel(def); });
    applyFilters();
    toast('フィルターをリセットしました','info');
  });

  // Back
  document.getElementById('btnBack').addEventListener('click', () => {
    stopPolling(); // ポーリング停止
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('uploadSection').classList.remove('hidden');
    document.getElementById('csvInput').value = '';
    allData = []; filtered = [];
    showAll = false; PAGE_SIZE = 25;
    Object.values(charts).forEach(c => c.destroy()); charts = {};
  });

  // Page size
  document.getElementById('pageSizeSelect').addEventListener('change', e => {
    const val = e.target.value;
    if (val === 'all') { showAll = true; }
    else { showAll = false; PAGE_SIZE = parseInt(val, 10); }
    currentPage = 1;
    renderTable();
  });

  // Column toggle
  document.getElementById('btnColToggle').addEventListener('click', () => {
    document.getElementById('colToggleMenu').classList.toggle('hidden');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.col-toggle-wrap')) document.getElementById('colToggleMenu').classList.add('hidden');
  });

  // Gantt quick buttons
  document.querySelectorAll('.gantt-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.gantt-quick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const months = parseInt(btn.dataset.months, 10);
      if (months === 0) {
        ganttRange.from = null; ganttRange.to = null;
        initGanttRangeInputs();
      } else {
        const from = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
        const to   = new Date(TODAY.getFullYear(), TODAY.getMonth() + months - 1, 1);
        ganttRange.from = from; ganttRange.to = to;
        const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        const fromEl = document.getElementById('ganttFrom');
        const toEl   = document.getElementById('ganttTo');
        if (fromEl) fromEl.value = fmt(from);
        if (toEl)   toEl.value   = fmt(to);
      }
      renderGantt(filtered.length ? filtered : allData);
    });
  });

  // Gantt custom apply
  document.getElementById('ganttApply').addEventListener('click', () => {
    const fromEl = document.getElementById('ganttFrom');
    const toEl   = document.getElementById('ganttTo');
    const fromVal = fromEl ? fromEl.value : '';
    const toVal   = toEl   ? toEl.value   : '';
    if (!fromVal || !toVal) { toast('開始・終了年月を両方入力してください','error'); return; }
    const [fy, fm] = fromVal.split('-').map(Number);
    const [ty, tm] = toVal.split('-').map(Number);
    const from = new Date(fy, fm-1, 1);
    const to   = new Date(ty, tm-1, 1);
    if (from > to) { toast('開始年月は終了年月以前にしてください','error'); return; }
    ganttRange.from = from; ganttRange.to = to;
    document.querySelectorAll('.gantt-quick-btn').forEach(b => b.classList.remove('active'));
    renderGantt(filtered.length ? filtered : allData);
  });

  // Order status panel tab toggle
  const ospToggleBtn = document.getElementById('ospToggleBtn');
  const ospPanel     = document.getElementById('orderStatusPanel');
  if (ospToggleBtn && ospPanel) {
    ospToggleBtn.addEventListener('click', () => {
      ospPanel.classList.toggle('hidden');
      const isOpen = !ospPanel.classList.contains('hidden');
      ospToggleBtn.innerHTML = isOpen
        ? '<i class="fas fa-chevron-up"></i> 受注状態管理を閉じる'
        : '<i class="fas fa-list-check"></i> 受注状態を管理する';
    });
  }

  // ポーリング開始（CSVロード後に呼ばれる場合もあるので再確認）
  if (_useServer && allData.length > 0) startPolling();

  // Modal close
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay')) closeModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
});
