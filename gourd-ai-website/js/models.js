'use strict';

const script = document.currentScript;
const API_BASE = (script && script.dataset.apiBase) || '';
const API_PATH = '/api/v1/model-stats';
const REQUEST_TIMEOUT = 10000;

const $ = id => document.getElementById(id);
const hasValue = value => value !== undefined && value !== null && value !== '';
const numberValue = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(number) ? number : null;
  }
  return null;
};
const formatNumber = value => {
  const number = numberValue(value);
  return number === null ? '—' : number.toLocaleString('zh-CN');
};
const formatTokens = value => {
  const number = numberValue(value);
  if (number === null) return '—';
  if (number >= 1000000000) return (number / 1000000000).toFixed(2).replace(/\.00$/, '') + 'B';
  if (number >= 1000000) return (number / 1000000).toFixed(2).replace(/\.00$/, '') + 'M';
  if (number >= 1000) return (number / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return formatNumber(number);
};

function formatDate(value) {
  if (!hasValue(value)) return '—';
  let date;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
    const timestamp = Number(value);
    date = new Date(timestamp < 100000000000 ? timestamp * 1000 : timestamp);
  } else date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

function unwrap(payload) {
  if (payload && payload.code !== undefined && Number(payload.code) !== 200) throw new Error('business error');
  const data = payload && payload.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : payload;
}
function field(object, key) { return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : null; }
function displayPercent(value) {
  const number = numberValue(value);
  return number === null ? '—' : number + '%';
}
function renderStats(data) {
  const summary = data.summary || {};
  const grid = $('statsGrid');
  grid.textContent = '';
  [['totalTokens', '总 token', formatTokens], ['calls', '调用次数', formatNumber], ['modelCount', '模型数', formatNumber]].forEach(([key, label, formatter]) => {
    const card = document.createElement('article');
    card.className = 'stat-card';
    const title = document.createElement('div');
    title.className = 'stat-label';
    title.textContent = label;
    const value = document.createElement('div');
    value.className = 'stat-value';
    value.textContent = formatter(field(summary, key));
    card.append(title, value);
    grid.appendChild(card);
  });
  $('updatedAt').textContent = '数据更新于 ' + formatDate(field(data, 'updatedAt'));
}
function appendCell(row, value, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value;
  row.appendChild(cell);
}
function renderRows(data) {
  const rows = field(data, 'models');
  if (!Array.isArray(rows)) throw new Error('invalid models payload');
  const body = $('modelRows');
  body.textContent = '';
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7; cell.className = 'table-state'; cell.textContent = '暂无模型统计';
    row.appendChild(cell); body.appendChild(row); return;
  }
  rows.forEach(item => {
    const row = document.createElement('tr');
    appendCell(row, formatNumber(field(item, 'rank')));
    appendCell(row, hasValue(field(item, 'model')) ? String(field(item, 'model')) : '—');
    appendCell(row, formatTokens(field(item, 'totalTokens')));
    appendCell(row, formatTokens(field(item, 'inputTokens')) + ' / ' + formatTokens(field(item, 'outputTokens')));
    appendCell(row, formatNumber(field(item, 'calls')));
    appendCell(row, displayPercent(field(item, 'percentage')));
    const trend = numberValue(field(item, 'trendPercentage'));
    appendCell(row, trend === null ? '—' : (trend > 0 ? '+' : '') + trend + '%', trend > 0 ? 'trend-up' : trend < 0 ? 'trend-down' : '');
    body.appendChild(row);
  });
}

let requestId = 0;
let activeController = null;
async function loadStats(period) {
  const currentId = ++requestId;
  if (activeController) activeController.abort();
  const controller = new AbortController();
  activeController = controller;
  const table = document.querySelector('.model-table');
  $('errorMessage').hidden = true;
  table.setAttribute('aria-busy', 'true');
  $('modelRows').textContent = '';
  const loadingRow = document.createElement('tr');
  const loadingCell = document.createElement('td');
  loadingCell.colSpan = 7; loadingCell.className = 'table-state'; loadingCell.textContent = '正在加载统计…';
  loadingRow.appendChild(loadingCell); $('modelRows').appendChild(loadingRow);
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const base = API_BASE.replace(/\/$/, '');
    const response = await fetch(base + API_PATH + '?period=' + encodeURIComponent(period), { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = unwrap(await response.json());
    if (!data || typeof data !== 'object' || !data.summary || !Array.isArray(data.models)) throw new Error('invalid payload');
    if (currentId !== requestId) return;
    renderStats(data); renderRows(data);
  } catch (error) {
    if (currentId !== requestId) return;
    $('statsGrid').textContent = '';
    $('modelRows').textContent = '';
    $('errorMessage').hidden = false;
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7; cell.className = 'table-state'; cell.textContent = '统计服务暂不可用';
    row.appendChild(cell); $('modelRows').appendChild(row);
  } finally {
    clearTimeout(timeout);
    if (currentId === requestId) { table.setAttribute('aria-busy', 'false'); activeController = null; }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-period]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    loadStats(button.dataset.period);
  }));
  const toggle = $('navToggle'), links = $('navLinks');
  if (toggle && links) toggle.addEventListener('click', () => { const open = links.classList.toggle('open'); toggle.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open)); });
  loadStats('24h');
});
