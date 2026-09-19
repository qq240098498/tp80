const crypto = require('crypto');
const {
  load,
  save,
  RANGE_KINDS,
  MAX_RANGE_NOTE_LENGTH,
} = require('./store');
const { ApiError, pickText } = require('./errors');

// 区间端点允许一到三段数字（登记版本固定三段，少的段按 0 补齐），同样可以带预发布后缀
const BOUND_PATTERN = /^\d+(\.\d+){0,2}(-[0-9A-Za-z.]+)?$/;

// 把版本文字拆成数字段与预发布后缀，数字段一律补齐到三段再比较
function parseVersion(text) {
  const raw = pickText(text);
  const match = raw.match(/^(\d+(?:\.\d+){0,2})(?:-([0-9A-Za-z.]+))?$/);
  if (!match) return null;
  const parts = match[1].split('.').map((item) => Number(item));
  while (parts.length < 3) parts.push(0);
  return { parts, pre: match[2] === undefined ? null : match[2] };
}

// 预发布后缀按点拆成标识符逐段比：数字段按数值比，数字段排在文字段前面
function comparePreRelease(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = a.split('.');
  const right = b.split('.');
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i += 1) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const leftIsNum = /^\d+$/.test(left[i]);
    const rightIsNum = /^\d+$/.test(right[i]);
    if (leftIsNum && rightIsNum) {
      const diff = Number(left[i]) - Number(right[i]);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (leftIsNum !== rightIsNum) {
      return leftIsNum ? -1 : 1;
    } else if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
  }
  return comparePreRelease(a.pre, b.pre);
}

function validateBound(value, field, label) {
  const text = pickText(value);
  if (!text) throw new ApiError(400, 'RANGE_BOUND_REQUIRED', `请填写${label}版本`, field);
  if (!BOUND_PATTERN.test(text)) {
    throw new ApiError(400, 'RANGE_BOUND_INVALID', `${label}版本要写成数字段形式，例如 2.7.0 或 4.1.100`, field);
  }
  return text;
}

function validateRangeInput(input) {
  const kind = pickText(input.kind);
  if (!RANGE_KINDS.includes(kind)) {
    throw new ApiError(400, 'RANGE_KIND_INVALID', '区间类型只能是不低于、不高于、两版本之间或主版本段其中之一', 'rangeKind');
  }

  const range = {
    kind,
    lower: '',
    lowerInclusive: true,
    upper: '',
    upperInclusive: true,
    major: '',
  };

  if (kind === 'atLeast') {
    range.lower = validateBound(input.lower, 'rangeLower', '下限');
    range.lowerInclusive = input.lowerInclusive !== false;
  } else if (kind === 'atMost') {
    range.upper = validateBound(input.upper, 'rangeUpper', '上限');
    range.upperInclusive = input.upperInclusive !== false;
  } else if (kind === 'between') {
    range.lower = validateBound(input.lower, 'rangeLower', '下限');
    range.upper = validateBound(input.upper, 'rangeUpper', '上限');
    range.lowerInclusive = input.lowerInclusive !== false;
    range.upperInclusive = input.upperInclusive !== false;
    const lower = parseVersion(range.lower);
    const upper = parseVersion(range.upper);
    const order = compareVersions(lower, upper);
    if (order > 0) {
      throw new ApiError(400, 'RANGE_ORDER_INVALID', '下限版本不能高于上限版本', 'rangeLower');
    }
    // 两端相同又有任一端不含时，区间里没有任何版本，直接挡下
    if (order === 0 && (!range.lowerInclusive || !range.upperInclusive)) {
      throw new ApiError(400, 'RANGE_EMPTY', '下限与上限相同的时候，两端都要设为包含', 'rangeLower');
    }
  } else {
    const major = pickText(input.major);
    if (!/^\d+$/.test(major)) {
      throw new ApiError(400, 'RANGE_MAJOR_INVALID', '主版本号要写成一个非负整数，例如 5 或 18', 'rangeMajor');
    }
    range.major = String(Number(major));
  }

  const note = input.note === undefined || input.note === null ? '' : input.note;
  if (typeof note !== 'string') throw new ApiError(400, 'RANGE_NOTE_INVALID', '区间说明需要是文本', 'rangeNote');
  if (note.length > MAX_RANGE_NOTE_LENGTH) {
    throw new ApiError(400, 'RANGE_NOTE_TOO_LONG', `区间说明不能超过 ${MAX_RANGE_NOTE_LENGTH} 个字符`, 'rangeNote');
  }
  range.note = note.trim();
  return range;
}

// 判定一个登记版本是否落在区间内
function isVersionInRange(version, range) {
  const current = parseVersion(version);
  if (!current) return false;

  if (range.kind === 'major') {
    return current.parts[0] === Number(range.major);
  }

  const meetsLower = (inclusive) => {
    const bound = parseVersion(range.lower);
    const order = compareVersions(current, bound);
    return inclusive ? order >= 0 : order > 0;
  };
  const meetsUpper = (inclusive) => {
    const bound = parseVersion(range.upper);
    const order = compareVersions(current, bound);
    return inclusive ? order <= 0 : order < 0;
  };

  if (range.kind === 'atLeast') return meetsLower(range.lowerInclusive);
  if (range.kind === 'atMost') return meetsUpper(range.upperInclusive);
  return meetsLower(range.lowerInclusive) && meetsUpper(range.upperInclusive);
}

// 区间的简明白话写法，列表上直接展示
function describeRange(range) {
  if (range.kind === 'major') return `主版本 ${range.major}.x`;
  if (range.kind === 'atLeast') return `${range.lowerInclusive ? '≥' : '>'} ${range.lower}`;
  if (range.kind === 'atMost') return `${range.upperInclusive ? '≤' : '<'} ${range.upper}`;
  const left = range.lowerInclusive ? '[' : '(';
  const right = range.upperInclusive ? ']' : ')';
  return `${left}${range.lower}, ${range.upper}${right}（方括号含端点，圆括号不含）`;
}

function findDep(data, depId) {
  const value = pickText(depId);
  if (!value) throw new ApiError(400, 'DEP_REQUIRED', '请选择要设定区间的依赖登记', 'rangeDep');
  const found = data.deps.find((item) => item.id === value);
  if (!found) throw new ApiError(404, 'DEP_NOT_FOUND', '这条依赖登记不存在或已被删除', 'rangeDep');
  return found;
}

// 区间清单：带上登记的项目、名称、当前版本，并直接给出是否还在允许范围内
function listRanges() {
  const data = load();
  const projectNames = new Map(data.projects.map((item) => [item.id, item.name]));
  const depById = new Map(data.deps.map((item) => [item.id, item]));

  const ranges = data.ranges
    .map((range) => {
      const dep = depById.get(range.depId);
      if (!dep) return null;
      return {
        ...range,
        projectId: dep.projectId,
        projectName: projectNames.get(dep.projectId) || dep.projectId,
        depName: dep.name,
        depVersion: dep.version,
        text: describeRange(range),
        inRange: isVersionInRange(dep.version, range),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
      if (a.depName !== b.depName) return a.depName < b.depName ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

  return { ranges, kinds: RANGE_KINDS.slice() };
}

// 一条登记最多只有一个区间：按登记保存，已有就整体改写成新写法，没有就新建
function putRange(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const dep = findDep(data, input.depId);
  const fields = validateRangeInput(input);

  const now = new Date().toISOString();
  const existing = data.ranges.find((item) => item.depId === dep.id);
  if (existing) {
    Object.assign(existing, fields, { updatedAt: now });
    save(data);
    return { ...existing, replaced: true };
  }

  const created = {
    id: crypto.randomUUID(),
    depId: dep.id,
    ...fields,
    createdAt: now,
    updatedAt: now,
  };
  data.ranges.push(created);
  save(data);
  return { ...created, replaced: false };
}

function deleteRange(id) {
  const data = load();
  const index = data.ranges.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'RANGE_NOT_FOUND', '这条区间设定不存在或已被删除', '');
  const [removed] = data.ranges.splice(index, 1);
  save(data);
  return { id: removed.id, depId: removed.depId };
}

module.exports = {
  listRanges,
  putRange,
  deleteRange,
  isVersionInRange,
  parseVersion,
  compareVersions,
  describeRange,
};
