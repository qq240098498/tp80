// 版本解析、版本比较与版本区间的校验、判定、文字描述
// 区间有四种写法：不低于某个版本（min）、不高于某个版本（max）、
// 介于两个版本之间且两端含不含分别指定（between）、只允许某一段主版本号（major）
const { ApiError, pickText } = require('./errors');

// 版本写法固定成三段数字，后面可选择带一段预发布后缀，与依赖登记的口径一致
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
// 区间里写的版本与登记里的版本共用一个长度上限
const MAX_VERSION_LENGTH = 40;
const RANGE_KINDS = ['min', 'max', 'between', 'major'];

// 把版本文本拆成可比较的结构，写法不合规时返回 null
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(pickText(text));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

// 预发布段按 semver 口径比较：正式版高于预发布版，数字段按数值比且排在文字段前面
function comparePrerelease(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

// 比较两个版本文本：a 低返回 -1，相等返回 0，a 高返回 1；任一边写法不合规返回 null
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  const keys = ['major', 'minor', 'patch'];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1;
  }
  return comparePrerelease(va.prerelease, vb.prerelease);
}

// 区间端点的版本校验，codePrefix 用来区分是下限还是上限出的问题
function validateBound(value, field, label, codePrefix) {
  const version = pickText(value);
  if (!version) throw new ApiError(400, `${codePrefix}_REQUIRED`, `请填写${label}`, field);
  if (version.length > MAX_VERSION_LENGTH) {
    throw new ApiError(400, `${codePrefix}_TOO_LONG`, `${label}不能超过 ${MAX_VERSION_LENGTH} 个字符`, field);
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new ApiError(400, `${codePrefix}_INVALID`, `${label}要写成三段数字，例如 2.7.18，需要时可以带一段预发布后缀`, field);
  }
  return version;
}

// 主版本号要是不小于 0 的整数，允许数字或数字文本两种提交方式
function validateMajor(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : pickText(value);
  if (!/^\d+$/.test(text)) {
    throw new ApiError(400, 'RANGE_MAJOR_INVALID', '主版本号要写成不小于 0 的整数，例如 2', 'rangeMajor');
  }
  return Number(text);
}

// 端点含不含缺省按含处理，兼容布尔与文本两种提交方式
function pickBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
}

// 校验并整理一份区间设定，不成立时抛出带出错位置的业务异常
function validateRange(input) {
  const source = input && typeof input === 'object' ? input : {};
  const kind = pickText(source.kind);
  if (!RANGE_KINDS.includes(kind)) {
    throw new ApiError(400, 'RANGE_KIND_INVALID', '区间类型只能是：不低于某个版本、不高于某个版本、介于两个版本之间、同一主版本号', 'rangeKind');
  }
  if (kind === 'min') {
    return { kind, min: validateBound(source.min, 'rangeMin', '最低版本', 'RANGE_MIN') };
  }
  if (kind === 'max') {
    return { kind, max: validateBound(source.max, 'rangeMax', '最高版本', 'RANGE_MAX') };
  }
  if (kind === 'major') {
    return { kind, major: validateMajor(source.major) };
  }
  const min = validateBound(source.min, 'rangeMin', '下限版本', 'RANGE_MIN');
  const max = validateBound(source.max, 'rangeMax', '上限版本', 'RANGE_MAX');
  const minInclusive = pickBool(source.minInclusive, true);
  const maxInclusive = pickBool(source.maxInclusive, true);
  const order = compareVersions(min, max);
  if (order > 0) {
    throw new ApiError(400, 'RANGE_ORDER_INVALID', '下限版本不能高于上限版本', 'rangeMin');
  }
  if (order === 0 && (!minInclusive || !maxInclusive)) {
    throw new ApiError(400, 'RANGE_EMPTY', '上下限是同一个版本，两端必须都含，否则区间里一个版本都装不下', 'rangeMax');
  }
  return { kind, min, minInclusive, max, maxInclusive };
}

// 不抛错的整理方式：数据文件里读出的区间不合法时按未设定处理
function parseRange(input) {
  try {
    return validateRange(input);
  } catch (err) {
    return null;
  }
}

// 判定版本是否落在区间内；没设区间或版本写法不合规时返回 null，表示无法判定
function checkVersion(version, range) {
  if (!range || typeof range !== 'object') return null;
  const parsed = parseVersion(version);
  if (!parsed) return null;
  if (range.kind === 'major') return parsed.major === range.major;
  if (range.kind === 'min') {
    const order = compareVersions(version, range.min);
    return order === null ? null : order >= 0;
  }
  if (range.kind === 'max') {
    const order = compareVersions(version, range.max);
    return order === null ? null : order <= 0;
  }
  if (range.kind === 'between') {
    const lower = compareVersions(version, range.min);
    const upper = compareVersions(version, range.max);
    if (lower === null || upper === null) return null;
    const aboveMin = range.minInclusive ? lower >= 0 : lower > 0;
    const belowMax = range.maxInclusive ? upper <= 0 : upper < 0;
    return aboveMin && belowMax;
  }
  return null;
}

// 区间的文字写法：≥ ≤ 表示含端点，方括号表示含、圆括号表示不含，x 表示整段主版本号
function describeRange(range) {
  if (!range || typeof range !== 'object') return '';
  if (range.kind === 'min') return `≥ ${range.min}`;
  if (range.kind === 'max') return `≤ ${range.max}`;
  if (range.kind === 'major') return `${range.major}.x`;
  if (range.kind === 'between') {
    const left = range.minInclusive ? '[' : '(';
    const right = range.maxInclusive ? ']' : ')';
    return `${left}${range.min}, ${range.max}${right}`;
  }
  return '';
}

module.exports = {
  VERSION_PATTERN,
  RANGE_KINDS,
  parseVersion,
  compareVersions,
  validateRange,
  parseRange,
  checkVersion,
  describeRange,
};
