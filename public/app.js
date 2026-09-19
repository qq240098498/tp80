// 页面交互：项目清单与依赖登记都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  projects: [],
  deps: [],
  allDeps: [],
  licenses: [],
  statuses: [],
  ranges: [],
  editingId: '',
  editingRangeId: '',
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：项目区、依赖区与区间区共用一套标记；
// 区间表单里同名字段在不同写法下各有一份，优先标当前看得见的那份
function markField(field) {
  if (!field) return;
  const targets = Array.from(document.querySelectorAll(`[data-field="${field}"]`));
  if (!targets.length) return;
  const target = targets.find((node) => !node.closest('.hidden')) || targets[0];
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' ? target : target.querySelector('input, select');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 操作者名字记在浏览器里，刷新之后还在，保存时随请求一起带上
const OPERATOR_KEY = 'dep-ledger-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadProjects() {
  const payload = await request('/api/projects');
  state.projects = payload.projects || [];
  renderProjects();
  renderProjectOptions();
}

async function loadDeps() {
  const params = new URLSearchParams();
  const projectId = el('filter-project').value;
  const status = el('filter-status').value;
  const license = el('filter-license').value;
  const keyword = el('filter-keyword').value.trim();
  if (projectId) params.set('projectId', projectId);
  if (status) params.set('status', status);
  if (license) params.set('license', license);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/deps${query ? `?${query}` : ''}`);
  state.deps = payload.deps || [];
  state.licenses = payload.licenses || [];
  state.statuses = payload.statuses || [];
  renderDepFilterOptions();
  renderDeps();
}

async function loadRanges() {
  // 区间下拉要列全部登记，不能受依赖区筛选条件影响，这里单独拉一份完整清单
  const [rangePayload, depPayload] = await Promise.all([
    request('/api/ranges'),
    request('/api/deps'),
  ]);
  state.ranges = rangePayload.ranges || [];
  state.allDeps = depPayload.deps || [];
  renderDeps();
  renderRanges();
  renderRangeDepOptions();
}

// 登记表里的核查列：同一条登记最多一条区间，直接按 depId 找
function rangeOfDep(depId) {
  return state.ranges.find((item) => item.depId === depId) || null;
}

function renderRangeCheck(dep) {
  const range = rangeOfDep(dep.id);
  if (!range) return '<span class="missing">未设范围</span>';
  if (range.inRange) {
    return `<span class="tag range-ok" title="允许范围：${escapeHtml(range.text)}">在范围内</span>`;
  }
  return `<span class="tag range-bad" title="允许范围：${escapeHtml(range.text)}">已超界</span>`;
}

function renderProjects() {
  const body = el('project-body');
  body.innerHTML = state.projects.map((item) => `<tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.owner) || '<span class="missing">未指定</span>'}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${item.depCount} 条</td>
      <td class="mono">${escapeHtml(formatTime(item.createdAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-project-rename="${escapeHtml(item.id)}">改名</button>
        <button type="button" class="link" data-project-owner="${escapeHtml(item.id)}">改负责人</button>
        <button type="button" class="link danger" data-project-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('project-empty').classList.toggle('hidden', state.projects.length > 0);
}

function renderProjectOptions() {
  const select = el('dep-project');
  const current = select.value;
  select.innerHTML = state.projects
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join('');
  if (state.projects.some((item) => item.id === current)) select.value = current;

  const filter = el('filter-project');
  const filterCurrent = filter.value;
  filter.innerHTML = '<option value="">全部项目</option>'
    + state.projects.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  if (state.projects.some((item) => item.id === filterCurrent)) filter.value = filterCurrent;
}

function renderDepFilterOptions() {
  const statusSelect = el('filter-status');
  const statusCurrent = statusSelect.value;
  statusSelect.innerHTML = '<option value="">全部状态</option>'
    + state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(statusCurrent)) statusSelect.value = statusCurrent;

  const licenseSelect = el('filter-license');
  const licenseCurrent = licenseSelect.value;
  licenseSelect.innerHTML = '<option value="">全部许可</option>'
    + state.licenses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.licenses.includes(licenseCurrent)) licenseSelect.value = licenseCurrent;

  const statusForm = el('dep-status');
  const statusFormCurrent = statusForm.value;
  statusForm.innerHTML = state.statuses
    .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    .join('');
  if (state.statuses.includes(statusFormCurrent)) statusForm.value = statusFormCurrent;
}

function projectName(projectId) {
  const found = state.projects.find((item) => item.id === projectId);
  return found ? found.name : projectId;
}

function renderDeps() {
  const body = el('dep-body');
  body.innerHTML = state.deps.map((item) => {
    const statusTag = item.status === '已弃用' ? 'off' : 'on';
    return `<tr>
      <td>${escapeHtml(projectName(item.projectId))}</td>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td class="mono">${escapeHtml(item.version)}</td>
      <td>${renderRangeCheck(item)}</td>
      <td>${item.license ? escapeHtml(item.license) : '<span class="missing">未填</span>'}</td>
      <td>${item.owner ? escapeHtml(item.owner) : '<span class="missing">未指定</span>'}</td>
      <td><span class="tag ${statusTag}">${escapeHtml(item.status)}</span></td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-dep-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-dep-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('dep-empty').classList.toggle('hidden', state.deps.length > 0);
}

function openDepForm(dep) {
  state.editingId = dep ? dep.id : '';
  el('dep-form-title').textContent = dep ? `编辑登记：${dep.name}` : '新建登记';
  if (state.projects.length) {
    el('dep-project').value = dep ? dep.projectId : state.projects[0].id;
  }
  el('dep-name').value = dep ? dep.name : '';
  el('dep-version').value = dep ? dep.version : '';
  el('dep-license').value = dep ? dep.license : '';
  el('dep-owner').value = dep ? dep.owner : currentOperator();
  el('dep-status').value = dep ? dep.status : (state.statuses[0] || '在用');
  el('dep-note').value = dep ? dep.note : '';
  el('dep-form').classList.remove('hidden');
  el('dep-name').focus();
}

function closeDepForm() {
  state.editingId = '';
  el('dep-form').classList.add('hidden');
  clearFieldMarks();
}

// 区间设定区：按登记列一条，当前版本超界时整行核查列标红
function renderRanges() {
  const body = el('range-body');
  body.innerHTML = state.ranges.map((item) => {
    const check = item.inRange
      ? '<span class="tag range-ok">在范围内</span>'
      : '<span class="tag range-bad">已超界</span>';
    return `<tr>
      <td>${escapeHtml(item.projectName)}</td>
      <td class="mono">${escapeHtml(item.depName)}</td>
      <td class="mono">${escapeHtml(item.depVersion)}</td>
      <td class="mono">${escapeHtml(item.text)}</td>
      <td>${check}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-range-edit="${escapeHtml(item.id)}">改写</button>
        <button type="button" class="link danger" data-range-delete="${escapeHtml(item.id)}">清除</button>
      </td>
    </tr>`;
  }).join('');
  el('range-empty').classList.toggle('hidden', state.ranges.length > 0);
}

// 下拉里只放还没设过区间的登记；改写某条时该条本身要重新放回来
function renderRangeDepOptions() {
  const select = el('range-dep');
  const editing = state.editingRangeId;
  const rangedIds = new Set(
    state.ranges.filter((item) => item.id !== editing).map((item) => item.depId),
  );
  const current = select.value;
  const options = state.allDeps
    .filter((item) => !rangedIds.has(item.id))
    .map((item) => {
      const label = `${projectName(item.projectId)} / ${item.name}（当前 ${item.version}）`;
      return `<option value="${escapeHtml(item.id)}">${escapeHtml(label)}</option>`;
    })
    .join('');
  select.innerHTML = options;
  if (Array.from(select.options).some((opt) => opt.value === current)) select.value = current;
}

// 按选定的写法只显示对应的那组输入项
function applyRangeKindVisibility() {
  const kind = el('range-kind').value;
  document.querySelectorAll('.range-fields').forEach((node) => {
    node.classList.toggle('hidden', node.dataset.rangeKind !== kind);
  });
}

// 读区间表单：下限/上限在"之间"写法下各有独立输入框，要按写法取对应那份
function collectRangePayload() {
  const kind = el('range-kind').value;
  const payload = { depId: el('range-dep').value, kind };
  if (kind === 'atLeast') {
    payload.lower = el('range-lower').value;
    payload.lowerInclusive = el('range-lower-inclusive').value === 'true';
  } else if (kind === 'atMost') {
    payload.upper = el('range-upper').value;
    payload.upperInclusive = el('range-upper-inclusive').value === 'true';
  } else if (kind === 'between') {
    payload.lower = el('range-between-lower').value;
    payload.lowerInclusive = el('range-between-lower-inclusive').value === 'true';
    payload.upper = el('range-between-upper').value;
    payload.upperInclusive = el('range-between-upper-inclusive').value === 'true';
  } else {
    payload.major = el('range-major').value;
  }
  payload.note = el('range-note').value;
  return payload;
}

function resetRangeFields() {
  ['range-lower', 'range-upper', 'range-between-lower', 'range-between-upper', 'range-major', 'range-note']
    .forEach((id) => { el(id).value = ''; });
  ['range-lower-inclusive', 'range-upper-inclusive', 'range-between-lower-inclusive', 'range-between-upper-inclusive']
    .forEach((id) => { el(id).value = 'true'; });
}

function openRangeForm(range) {
  state.editingRangeId = range ? range.id : '';
  el('range-form-title').textContent = range
    ? `改写区间：${range.projectName} / ${range.depName}`
    : '新增区间';
  el('range-dep').disabled = Boolean(range);
  el('range-kind').value = range ? range.kind : 'atLeast';
  resetRangeFields();
  applyRangeKindVisibility();
  renderRangeDepOptions();
  if (range) {
    el('range-dep').value = range.depId;
    if (range.kind === 'atLeast') {
      el('range-lower').value = range.lower;
      el('range-lower-inclusive').value = String(range.lowerInclusive);
    } else if (range.kind === 'atMost') {
      el('range-upper').value = range.upper;
      el('range-upper-inclusive').value = String(range.upperInclusive);
    } else if (range.kind === 'between') {
      el('range-between-lower').value = range.lower;
      el('range-between-lower-inclusive').value = String(range.lowerInclusive);
      el('range-between-upper').value = range.upper;
      el('range-between-upper-inclusive').value = String(range.upperInclusive);
    } else {
      el('range-major').value = range.major;
    }
    el('range-note').value = range.note;
  } else if (el('range-dep').options.length) {
    el('range-dep').value = el('range-dep').options[0].value;
  }
  el('range-form').classList.remove('hidden');
  el('range-kind').focus();
}

function closeRangeForm() {
  state.editingRangeId = '';
  el('range-form').classList.add('hidden');
  el('range-dep').disabled = false;
  clearFieldMarks();
}

async function submitRange(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  try {
    await request('/api/ranges', { method: 'PUT', body: JSON.stringify(collectRangePayload()) });
    notify(state.editingRangeId ? '区间已改写' : '区间已保存', 'ok');
    closeRangeForm();
    await loadRanges();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitProject(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('project-name').value,
    owner: el('project-owner').value,
    note: el('project-note').value,
  };
  try {
    await request('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    el('project-name').value = '';
    el('project-owner').value = '';
    el('project-note').value = '';
    notify('项目已新增', 'ok');
    await loadProjects();
    await loadDeps();
    await loadRanges();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitDep(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    projectId: el('dep-project').value,
    name: el('dep-name').value,
    version: el('dep-version').value,
    license: el('dep-license').value,
    owner: el('dep-owner').value,
    status: el('dep-status').value,
    note: el('dep-note').value,
  };
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/deps/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('依赖登记已保存', 'ok');
    } else {
      await request('/api/deps', { method: 'POST', body: JSON.stringify(payload) });
      notify('依赖登记已新增', 'ok');
    }
    closeDepForm();
    await loadProjects();
    await loadDeps();
    await loadRanges();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  const projectId = node.dataset.projectRename || node.dataset.projectOwner || node.dataset.projectDelete;
  if (projectId) {
    clearNotice();
    const found = state.projects.find((item) => item.id === projectId);
    if (!found) return;
    try {
      if (node.dataset.projectRename) {
        const next = window.prompt(`把 ${found.name} 的名称改成`, found.name);
        if (next === null) return;
        await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
        notify('项目名称已更新', 'ok');
      } else if (node.dataset.projectOwner) {
        const next = window.prompt(`把 ${found.name} 的负责人改成`, found.owner || '');
        if (next === null) return;
        await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ owner: next }) });
        notify('项目负责人已更新', 'ok');
      } else {
        if (!window.confirm(`确定删除项目 ${found.name} 吗？`)) return;
        await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
        notify('项目已删除', 'ok');
      }
      await loadProjects();
      await loadDeps();
      await loadRanges();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.depEdit) {
    clearNotice();
    const found = state.deps.find((item) => item.id === node.dataset.depEdit);
    if (found) openDepForm(found);
    return;
  }

  if (node.dataset.depDelete) {
    clearNotice();
    const found = state.deps.find((item) => item.id === node.dataset.depDelete);
    if (!window.confirm(`确定删除登记 ${found ? found.name : ''} 吗？该登记上的区间设定会一并清除。`)) return;
    try {
      await request(`/api/deps/${encodeURIComponent(node.dataset.depDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.depDelete) closeDepForm();
      notify('登记已删除', 'ok');
      await loadProjects();
      await loadDeps();
      await loadRanges();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.rangeEdit) {
    clearNotice();
    const found = state.ranges.find((item) => item.id === node.dataset.rangeEdit);
    if (found) openRangeForm(found);
    return;
  }

  if (node.dataset.rangeDelete) {
    clearNotice();
    const found = state.ranges.find((item) => item.id === node.dataset.rangeDelete);
    const label = found ? `${found.depName}（${found.text}）` : '';
    if (!window.confirm(`确定清除 ${label} 的允许范围吗？`)) return;
    try {
      await request(`/api/ranges/${encodeURIComponent(node.dataset.rangeDelete)}`, { method: 'DELETE' });
      if (state.editingRangeId === node.dataset.rangeDelete) closeRangeForm();
      notify('区间已清除', 'ok');
      await loadRanges();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('project-form').addEventListener('submit', submitProject);
el('dep-form').addEventListener('submit', submitDep);
el('range-form').addEventListener('submit', submitRange);
el('dep-new').addEventListener('click', () => {
  clearNotice();
  if (!state.projects.length) {
    notify('请先登记一个项目，再登记依赖', 'error');
    return;
  }
  openDepForm(null);
});
el('dep-cancel').addEventListener('click', closeDepForm);
el('filter-apply').addEventListener('click', () => {
  clearNotice();
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('filter-reset').addEventListener('click', () => {
  el('filter-project').value = '';
  el('filter-status').value = '';
  el('filter-license').value = '';
  el('filter-keyword').value = '';
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('dep-refresh').addEventListener('click', () => {
  clearNotice();
  loadProjects()
    .then(loadDeps)
    .then(loadRanges)
    .catch((err) => notify(err.message, 'error'));
});
el('range-new').addEventListener('click', () => {
  clearNotice();
  if (!state.allDeps.length) {
    notify('请先登记依赖，再为登记设定区间', 'error');
    return;
  }
  if (state.ranges.length >= state.allDeps.length) {
    notify('每条登记都已经设过允许范围了，要改请直接在列表里点改写', 'error');
    return;
  }
  openRangeForm(null);
});
el('range-cancel').addEventListener('click', closeRangeForm);
el('range-refresh').addEventListener('click', () => {
  clearNotice();
  loadRanges().catch((err) => notify(err.message, 'error'));
});
el('range-kind').addEventListener('change', applyRangeKindVisibility);
el('filter-project').addEventListener('change', () => {
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('filter-status').addEventListener('change', () => {
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('filter-license').addEventListener('change', () => {
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把项目、依赖登记与区间设定拉一遍，项目决定登记表单里能选哪些归属
restoreOperator();
loadHealth();
loadProjects()
  .then(loadDeps)
  .then(loadRanges)
  .catch((err) => notify(err.message, 'error'));
