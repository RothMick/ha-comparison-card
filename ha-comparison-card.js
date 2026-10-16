/**
 * ha-comparison-card v0.4.0
 * Compares a date range of this year with the same range of previous years:
 * stacked bars from long-term statistics, previous years as offset ghost bars or side by side.
 * No dependencies. Details: README.md
 */

const CARD_VERSION = '0.4.0';
const GROUPS = ['hour', 'day', 'month'];
const LAYOUTS = ['behind', 'side_by_side'];
const STAT_TYPES = ['change', 'mean', 'min', 'max'];
const MAX_YEARS_BACK = 5;
const GHOST_OPACITY = [0.45, 0.3, 0.2, 0.13, 0.08];
// Validated categorical palettes (fixed order); series colors can be set per series.
const PALETTE_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const PALETTE_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const RESERVED_VARS = new Set(['year', 'label', 'days', 'current', 'series', 'and', 'or', 'not', 'in', 'is',
  'if', 'else', 'none', 'true', 'false', 'for', 'loop', 'self']);
const DAY_MS = 86400000;
const CURRENT_TTL = 5 * 60000;
const REFRESH_AFTER_MIDNIGHT = 20 * 60000;
const TODAY_REFRESH = 10 * 60000;
const SIDE_GAP = 1;
const ROW_ICON = 'mdi:function-variant';

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ---------- calendar (plain {y, m, d} dates, m = 1..12) ----------

const pad2 = n => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const cmpDate = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
const utcOf = dt => Date.UTC(dt.y, dt.m - 1, dt.d);
const addDays = (dt, n) => {
  const t = new Date(utcOf(dt) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const daysBetween = (a, b) => Math.round((utcOf(b) - utcOf(a)) / DAY_MS);
// Clamps 02-29 to 02-28 in common years.
const onYear = (y, md) => ({ y, m: md.m, d: Math.min(md.d, daysInMonth(y, md.m)) });

const parseMonthDay = s => {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(2000, mo)) return null;
  return { m: mo, d };
};

// Position of a calendar day within a cycle that starts in baseYear. Uses a leap
// reference year, so the same month-day lines up in every year and 02-29 keeps its own slot.
const dayPos = (dt, baseYear) =>
  Math.round((Date.UTC(2000, dt.m - 1, dt.d) - Date.UTC(2000, 0, 1)) / DAY_MS) + (dt.y > baseYear ? 366 : 0);

class Zone {
  constructor(tz) {
    this.tz = tz;
    this.fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
  }

  parts(ms) {
    const o = {};
    for (const p of this.fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
    return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, min: o.minute };
  }

  date(ms) {
    const p = this.parts(ms);
    return { y: p.y, m: p.m, d: p.d };
  }

  _offset(ms) {
    const p = this.parts(ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(ms / 60000) * 60000;
  }

  // Epoch ms of 00:00 local time on the given day.
  midnight(dt) {
    const guess = utcOf(dt);
    const first = guess - this._offset(guess);
    return guess - this._offset(first);
  }
}

// ---------- configuration ----------

const varName = s => {
  let v = String(s ?? '').toLowerCase()
    .replace(/\u00e4/g, 'ae').replace(/\u00f6/g, 'oe').replace(/\u00fc/g, 'ue').replace(/\u00df/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (/^[0-9]/.test(v)) v = `s_${v}`;
  if (RESERVED_VARS.has(v)) v = `${v}_value`;
  return v;
};

const numOrNull = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

// ghost_opacity per years back: { 1: 30, 2: 15 } in percent (values up to 1 count as fractions);
// a list is read as 1, 2, 3 ... years back.
function parseOpacities(raw) {
  const out = {};
  const entries = Array.isArray(raw) ? raw.map((v, i) => [i + 1, v]) : Object.entries(raw && typeof raw === 'object' ? raw : {});
  for (const [k, v] of entries) {
    const n = numOrNull(v);
    if (n != null && Number(k) >= 1) out[Number(k)] = Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
  }
  return out;
}

const ghostOpacity = (cfg, k) => cfg.ghost_opacity[k] ?? GHOST_OPACITY[k - 1] ?? 0.05;

function normalizeConfig(raw) {
  const group = raw.group_by || 'month';
  if (!GROUPS.includes(group)) throw new Error(`group_by must be one of: ${GROUPS.join(', ')}`);
  if (raw.layout && !LAYOUTS.includes(raw.layout)) throw new Error(`layout must be one of: ${LAYOUTS.join(', ')}`);
  if (raw.start && !parseMonthDay(raw.start)) throw new Error('start must be a day as MM-DD');
  if (raw.end && raw.end !== 'yesterday' && raw.end !== 'today' && !parseMonthDay(raw.end)) {
    throw new Error('end must be MM-DD, yesterday or today');
  }

  const backsRaw = raw.compare_years == null ? [1] : [].concat(raw.compare_years);
  const backs = [...new Set(backsRaw.map(Number))]
    .filter(n => Number.isInteger(n) && n >= 1 && n <= MAX_YEARS_BACK)
    .sort((a, b) => a - b);

  const used = new Set();
  const series = (Array.isArray(raw.series) ? raw.series : []).map((s, i) => {
    let id = varName(s?.id) || varName(s?.name) || `s${i + 1}`;
    const base = id;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return {
      id,
      name: String(s?.name || id),
      statistics: [].concat(s?.statistics ?? s?.statistic ?? []).filter(Boolean).map(String),
      template: String(s?.template ?? '').trim() ? String(s.template) : null,
      color: s?.color ? String(s.color) : null,
      below_zero: s?.below_zero === true,
    };
  });

  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .filter(r => r && String(r.template ?? '').trim())
    .map((r, i) => ({
      name: String(r.name || `Row ${i + 1}`),
      icon: r.icon ? String(r.icon) : null,
      template: String(r.template),
      unit: r.unit != null ? String(r.unit) : null,
      decimals: numOrNull(r.decimals),
    }));

  const height = numOrNull(raw.chart_height);
  return {
    title: raw.title ? String(raw.title) : '',
    start: parseMonthDay(raw.start) || { m: 1, d: 1 },
    end: parseMonthDay(raw.end),
    // Only end: yesterday sticks to whole days; empty, today and a fixed last day include the running day.
    include_today: raw.end !== 'yesterday',
    group_by: group,
    compare: backs,
    series,
    rows,
    headline: raw.headline ? String(raw.headline) : null,
    stat_type: STAT_TYPES.includes(raw.stat_type) ? raw.stat_type : 'auto',
    unit: raw.unit ? String(raw.unit) : null,
    decimals: numOrNull(raw.decimals),
    chart_height: Math.min(600, Math.max(80, height ?? 200)),
    show_table: raw.show_table !== false,
    ghost_opacity: parseOpacities(raw.ghost_opacity),
    layout: raw.layout || 'behind',
  };
}

// ---------- series templates ----------

// Series templates run in the browser for every day (or hour) and year, so they cost Home Assistant
// nothing. They understand the expression part of Jinja2 (details in the README).

const TPL_TOKEN = /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_]\w*)|('[^']*'|"[^"]*")|(\*\*|\/\/|==|!=|<=|>=|[-+*/%()<>,|[\].]))/y;
const TPL_WORDS = new Set(['if', 'else', 'and', 'or', 'not']);
const TPL_CONST = { none: null, None: null, true: true, True: true, false: false, False: false };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const tplShow = v => (v == null ? 'none' : typeof v === 'string' ? `'${v}'` : Array.isArray(v) ? 'a list' : String(v));
const tplNum = v => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return Number(v);
  throw new Error(`${tplShow(v)} is not a number`);
};
const tplToNumber = (v, fallback) => {
  const n = typeof v === 'number' || typeof v === 'boolean' ? Number(v) : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (Number.isFinite(n)) return n;
  if (fallback !== undefined) return fallback;
  throw new Error(`${tplShow(v)} is not a number`);
};
const tplList = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(tplNum);
const tplExtreme = (name, pick) => (...args) => {
  const l = tplList(args);
  if (!l.length) throw new Error(`${name}() of an empty list`);
  return pick(...l);
};
// Usable as function and as filter: max(a, b), [a, b] | max, x | round(1).
const TPL_FUNCS = {
  float: (v, fallback) => tplToNumber(v, fallback),
  int: (v, fallback) => Math.trunc(tplToNumber(v, fallback)),
  abs: v => Math.abs(tplNum(v)),
  round: (v, p = 0) => {
    const f = 10 ** tplNum(p);
    const x = tplNum(v);
    return Math.sign(x) * Math.round(Math.abs(x) * f) / f;
  },
  max: tplExtreme('max', Math.max),
  min: tplExtreme('min', Math.min),
  sum: (...args) => tplList(args).reduce((a, b) => a + b, 0),
  default: (v, fallback = '') => (v == null ? fallback : v),
};
TPL_FUNCS.d = TPL_FUNCS.default;

const tplTruthy = v => (Array.isArray(v) ? v.length > 0 : !!v);
const tplItem = (o, k) => {
  if (o != null && typeof o === 'object' && own(o, k)) return o[k];
  throw new Error(`${tplShow(o)} has no item ${tplShow(k)}`);
};
const tplArith = (op, a, b) => {
  const x = tplNum(a);
  const y = tplNum(b);
  if (op === '+') return x + y;
  if (op === '-') return x - y;
  if (op === '*') return x * y;
  if (op === '**') return x ** y;
  if (y === 0) throw new Error('Division by zero');
  return op === '/' ? x / y : op === '//' ? Math.floor(x / y) : x - y * Math.floor(x / y);
};
const tplCompare = (op, a, b) => {
  if (op === '==') return a === b;
  if (op === '!=') return a !== b;
  const x = tplNum(a);
  const y = tplNum(b);
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
};

// Compiles "{{ expression }}" into a function of the variables. `names` are the variables it reads.
function compileTemplate(src) {
  const m = /^\s*\{\{-?([\s\S]*?)-?\}\}\s*$/.exec(String(src));
  if (!m || /\{\{|\}\}|\{%/.test(m[1])) throw new Error('Write the value as one {{ ... }} expression');
  const text = m[1];
  const toks = [];
  TPL_TOKEN.lastIndex = 0;
  while (text.slice(TPL_TOKEN.lastIndex).trim()) {
    const at = TPL_TOKEN.lastIndex;
    const t = TPL_TOKEN.exec(text);
    if (!t) throw new Error(`Unexpected "${text.slice(at).trim()[0]}"`);
    toks.push(t[1] != null ? { k: 'num', v: Number(t[1]) } : t[2] != null ? { k: 'name', v: t[2] }
      : t[3] != null ? { k: 'str', v: t[3].slice(1, -1) } : { k: 'op', v: t[4] });
  }

  let i = 0;
  const names = new Set();
  const is = (k, v) => toks[i]?.k === k && toks[i].v === v;
  const isOp = (...ops) => toks[i]?.k === 'op' && ops.includes(toks[i].v);
  const take = v => {
    if (!is('op', v)) throw new Error(`Expected "${v}"${toks[i] ? ` before "${toks[i].v}"` : ' at the end'}`);
    i++;
  };
  const list = end => {
    const out = [];
    while (!is('op', end)) {
      out.push(expr());
      if (!is('op', ',')) break;
      i++;
    }
    take(end);
    return out;
  };
  const primary = () => {
    const t = toks[i++];
    if (!t) throw new Error('The expression ends too early');
    if (t.k === 'num' || t.k === 'str') return () => t.v;
    if (t.k === 'op' && t.v === '(') {
      const e = expr();
      take(')');
      return e;
    }
    if (t.k === 'op' && t.v === '[') {
      const items = list(']');
      return env => items.map(f => f(env));
    }
    if (t.k === 'name' && !TPL_WORDS.has(t.v)) {
      if (own(TPL_CONST, t.v)) return () => TPL_CONST[t.v];
      if (is('op', '(')) {
        if (!own(TPL_FUNCS, t.v)) throw new Error(`Unknown function ${t.v}()`);
        const fn = TPL_FUNCS[t.v];
        i++;
        const args = list(')');
        return env => fn(...args.map(f => f(env)));
      }
      names.add(t.v);
      return env => {
        if (!own(env, t.v)) throw new Error(`Unknown variable ${t.v}`);
        return env[t.v];
      };
    }
    throw new Error(`Unexpected "${t.v}"`);
  };
  const postfix = () => {
    let a = primary();
    for (;;) {
      const o = a;
      if (is('op', '[')) {
        i++;
        const key = expr();
        take(']');
        a = env => tplItem(o(env), key(env));
      } else if (is('op', '.') && toks[i + 1]?.k === 'name') {
        const key = toks[i + 1].v;
        i += 2;
        a = env => tplItem(o(env), key);
      } else return a;
    }
  };
  // As in Jinja2, filters bind to the operand including its sign: -x | abs is abs(-x).
  const unary = (withFilters = true) => {
    let a;
    if (isOp('-', '+')) {
      const neg = toks[i++].v === '-';
      const inner = unary(false);
      a = neg ? env => -tplNum(inner(env)) : env => tplNum(inner(env));
    } else a = postfix();
    while (withFilters && is('op', '|')) {
      i++;
      const t = toks[i++];
      if (t?.k !== 'name' || !own(TPL_FUNCS, t.v)) throw new Error(`Unknown filter ${t ? t.v : ''}`.trim());
      const fn = TPL_FUNCS[t.v];
      let args = [];
      if (is('op', '(')) {
        i++;
        args = list(')');
      }
      const o = a;
      a = env => fn(o(env), ...args.map(f => f(env)));
    }
    return a;
  };
  const binary = (next, ops, apply) => () => {
    let a = next();
    while (isOp(...ops)) {
      const op = toks[i++].v;
      const l = a;
      const r = next();
      a = env => apply(op, l(env), r(env));
    }
    return a;
  };
  const pow = binary(unary, ['**'], tplArith);
  const mul = binary(pow, ['*', '/', '//', '%'], tplArith);
  const add = binary(mul, ['+', '-'], tplArith);
  const cmp = binary(add, ['==', '!=', '<', '<=', '>', '>='], tplCompare);
  const not = () => {
    if (!is('name', 'not')) return cmp();
    i++;
    const a = not();
    return env => !tplTruthy(a(env));
  };
  const logic = (next, word, stop) => () => {
    let a = next();
    while (is('name', word)) {
      i++;
      const l = a;
      const r = next();
      a = env => {
        const v = l(env);
        return tplTruthy(v) === stop ? v : r(env);
      };
    }
    return a;
  };
  const and = logic(not, 'and', false);
  const or = logic(and, 'or', true);
  function expr() {
    const a = or();
    if (!is('name', 'if')) return a;
    i++;
    const c = or();
    let b = () => null;
    if (is('name', 'else')) {
      i++;
      b = expr();
    }
    return env => (tplTruthy(c(env)) ? a(env) : b(env));
  }

  const fn = expr();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}"`);
  return { fn, names };
}

const tplResult = v => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v)
    : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`The result ${tplShow(v)} is not a number`);
  return n;
};

// Evaluates a series template for every day (or hour) with data. A series without a value there
// counts as 0 for meters; for mean/min/max that day is left out.
function applyTemplate(series, raw, at, tpl, type, fail) {
  const out = new Map();
  if (!tpl.fn) return out;
  const all = tpl.names.has('series');
  const used = series.map(s => all || tpl.names.has(s.id));
  for (const rk of at.keys()) {
    const env = { series: {} };
    let have = false;
    let gap = false;
    series.forEach((s, i) => {
      let v = raw[i].get(rk);
      if (v == null) {
        if (used[i]) gap = true;
        v = type === 'change' ? 0 : null;
      } else if (used[i]) have = true;
      env[s.id] = v;
      env.series[s.id] = v;
    });
    if (!have || (gap && type !== 'change')) continue;
    try {
      const v = tplResult(tpl.fn(env));
      if (v != null) out.set(rk, v);
    } catch (err) {
      fail(err);
    }
  }
  return out;
}

// ---------- cycles ----------

// Cycle 0 is the latest range that has already begun; cycle k is the same range k years earlier.
// `until` is the last day that counts: in the current year lastDay at most (today, or yesterday with
// end: yesterday), in previous years their last day. Without a fixed end that is the month-day of lastDay.
function buildCycles(cfg, lastDay) {
  const startMd = cfg.start;
  let s0 = onYear(lastDay.y, startMd);
  if (cmpDate(s0, lastDay) > 0) s0 = onYear(lastDay.y - 1, startMd);
  const endMd = cfg.end;
  const wraps = endMd && (endMd.m < startMd.m || (endMd.m === startMd.m && endMd.d < startMd.d));
  const lMd = { m: lastDay.m, d: lastDay.d };

  const make = k => {
    const start = onYear(s0.y - k, startMd);
    const end = endMd ? onYear(start.y + (wraps ? 1 : 0), endMd) : onYear(lastDay.y - k, lMd);
    const until = k === 0 && cmpDate(end, lastDay) > 0 ? lastDay : end;
    const label = start.y === end.y ? String(start.y) : `${start.y}/${String(end.y).slice(-2)}`;
    return { k, start, end, until, label };
  };
  return [0, ...cfg.compare].map(make);
}

// ---------- statistics fetch with a module-wide cache ----------

const wsCache = new Map();
const WS_CACHE_MAX = 80;

function cachedWS(hass, msg, ttl) {
  const key = JSON.stringify(msg);
  const hit = wsCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = hass.callWS(msg);
  wsCache.set(key, { at: Date.now(), promise });
  promise.catch(() => wsCache.delete(key));
  if (wsCache.size > WS_CACHE_MAX) wsCache.delete(wsCache.keys().next().value);
  return promise;
}

const rowStart = r => (typeof r.start === 'number' ? r.start : Date.parse(r.start));

const newAgg = () => ({ sum: 0, n: 0, min: Infinity, max: -Infinity });
const addAgg = (a, v) => { a.sum += v; a.n++; if (v < a.min) a.min = v; if (v > a.max) a.max = v; };
const aggValue = (a, type) => {
  if (!a || !a.n) return null;
  if (type === 'mean') return a.sum / a.n;
  if (type === 'min') return a.min;
  if (type === 'max') return a.max;
  return a.sum;
};

// Turns the raw rows of every cycle into bucket values, totals and coverage. Each year counts its own
// range up to `until`: the current year up to today or yesterday, previous years up to their last day.
function processData(cfg, cycles, results, zone, type) {
  const group = cfg.group_by;
  const hourly = group === 'hour';
  const errors = new Map();
  const fail = (s, err) => { if (!errors.has(s.name)) errors.set(s.name, err?.message || String(err)); };
  const templates = cfg.series.map(s => {
    if (!s.template) return null;
    try {
      return compileTemplate(s.template);
    } catch (err) {
      fail(s, err);
      return { fn: null, names: new Set() };
    }
  });
  const bucketOf = (dt, h, cy) => {
    if (group === 'month') return (dt.y - cy.start.y) * 12 + dt.m - 1;
    const pos = dayPos(dt, cy.start.y);
    return hourly ? pos * 24 + h : pos;
  };

  const slotMap = new Map();
  for (const cy of cycles) {
    cy.expected = new Map();
    cy.expectedDays = 0;
    const n = daysBetween(cy.start, cy.end);
    for (let i = 0; i <= n; i++) {
      const dt = addDays(cy.start, i);
      const pos = dayPos(dt, cy.start.y);
      for (let h = 0; h < (hourly ? 24 : 1); h++) {
        const key = bucketOf(dt, h, cy);
        if (!slotMap.has(key)) slotMap.set(key, { key, dt, h, days: [] });
        if (cy.k === 0) slotMap.get(key).days.push(dt);
      }
      if (cy.k === 0 && cmpDate(dt, cy.until) > 0) continue;
      const key = bucketOf(dt, 0, cy);
      if (!cy.expected.has(key)) cy.expected.set(key, new Set());
      cy.expected.get(key).add(pos);
      cy.expectedDays++;
    }
  }
  const slots = [...slotMap.values()].sort((a, b) => a.key - b.key);

  cycles.forEach((cy, ci) => {
    const res = results[ci] || {};
    const fetchStart = zone.midnight(cy.start);
    const fetchEnd = zone.midnight(addDays(cy.until, 1));
    // One row per day (or hour): `at` knows where it belongs, `raw` holds each series' summed statistics.
    const at = new Map();
    const raw = cfg.series.map(s => {
      const rows = new Map();
      for (const id of s.statistics) {
        for (const r of res[id] || []) {
          const ms = rowStart(r);
          const v = r[type];
          if (!(ms >= fetchStart && ms < fetchEnd) || v == null || isNaN(v)) continue;
          const p = zone.parts(ms);
          const dt = { y: p.y, m: p.m, d: p.d };
          const pos = dayPos(dt, cy.start.y);
          const rk = hourly ? pos * 24 + p.h : pos;
          if (!at.has(rk)) at.set(rk, { b: bucketOf(dt, p.h, cy), pos, day: bucketOf(dt, 0, cy) });
          rows.set(rk, (rows.get(rk) ?? 0) + Number(v));
        }
      }
      return rows;
    });
    const values = cfg.series.map((s, si) =>
      (templates[si] ? applyTemplate(cfg.series, raw, at, templates[si], type, err => fail(s, err)) : raw[si]));

    cy.buckets = [];
    cy.totals = [];
    for (const rows of values) {
      const buckets = new Map();
      const total = newAgg();
      for (const [rk, v] of rows) {
        const b = at.get(rk).b;
        if (!buckets.has(b)) buckets.set(b, newAgg());
        addAgg(buckets.get(b), v);
        addAgg(total, v);
      }
      cy.buckets.push(new Map([...buckets].map(([k, a]) => [k, aggValue(a, type)])));
      cy.totals.push(aggValue(total, type));
    }

    // Coverage is counted in days with data from any statistic.
    const seen = new Map();
    for (const x of at.values()) {
      if (!seen.has(x.day)) seen.set(x.day, new Set());
      seen.get(x.day).add(x.pos);
    }
    cy.partial = new Set();
    let covered = 0;
    for (const [key, days] of cy.expected) {
      const have = seen.get(key);
      const n = have ? [...days].filter(p => have.has(p)).length : 0;
      if (n && n < days.size) cy.partial.add(key);
      covered += n;
    }
    cy.coveredDays = covered;
    cy.complete = covered >= cy.expectedDays;
  });

  // For hourly groups the day-level partial marker applies to all hours of that day.
  if (hourly) {
    for (const cy of cycles) {
      const hours = new Set();
      for (const key of cy.partial) for (let h = 0; h < 24; h++) hours.add(key + h);
      cy.partialSlots = hours;
    }
  } else {
    for (const cy of cycles) cy.partialSlots = cy.partial;
  }

  return { cycles, slots, type, errors: [...errors] };
}

// ---------- formatting ----------

function numberLocale(hass) {
  const lang = hass?.locale?.language || hass?.language || 'en';
  switch (hass?.locale?.number_format) {
    case 'comma_decimal': return ['en-US', {}];
    case 'decimal_comma': return ['de', {}];
    case 'space_comma': return ['fr', {}];
    case 'system': return [undefined, {}];
    case 'none': return [lang, { useGrouping: false }];
    default: return [lang, {}];
  }
}

const autoDecimals = v => {
  const a = Math.abs(v);
  return a >= 100 ? 0 : a >= 10 ? 1 : 2;
};

// ---------- SVG helpers ----------

// Bar path with rounded data end(s); y0 is the top edge, y1 the bottom edge.
function barPath(x, w, y0, y1, roundTop, roundBottom) {
  const h = y1 - y0;
  if (h <= 0.4 || w <= 0) return '';
  const r = Math.min(4, h / 2, w / 2);
  const a = roundTop ? r : 0;
  const b = roundBottom ? r : 0;
  const f = n => Math.round(n * 100) / 100;
  return `M${f(x)},${f(y0 + a)}Q${f(x)},${f(y0)} ${f(x + a)},${f(y0)}L${f(x + w - a)},${f(y0)}`
    + `Q${f(x + w)},${f(y0)} ${f(x + w)},${f(y0 + a)}L${f(x + w)},${f(y1 - b)}`
    + `Q${f(x + w)},${f(y1)} ${f(x + w - b)},${f(y1)}L${f(x + b)},${f(y1)}`
    + `Q${f(x)},${f(y1)} ${f(x)},${f(y1 - b)}Z`;
}

// Stacked segments of one bar without gaps. With `overlap` each segment reaches that far under
// the next one (drawn later), so no anti-aliasing seam shows between opaque segments.
function stackPaths(values, series, x, w, y, overlap = 0) {
  const out = [];
  const y0 = y(0);
  const up = series.map((s, i) => i).filter(i => !series[i].below_zero && values[i] > 0);
  const down = series.map((s, i) => i).filter(i => series[i].below_zero && values[i] > 0);
  let acc = 0;
  let prevTop = y0;
  up.forEach((i, n) => {
    const last = n === up.length - 1;
    const top = y(acc + values[i]);
    const bottom = n ? prevTop : y0;
    acc += values[i];
    prevTop = top;
    out.push({ i, d: barPath(x, w, last ? top : top - overlap, bottom, last, false) });
  });
  acc = 0;
  let prevBottom = y0;
  down.forEach((i, n) => {
    const last = n === down.length - 1;
    const bottom = y(-(acc + values[i]));
    const top = n ? prevBottom : y0;
    acc += values[i];
    prevBottom = bottom;
    out.push({ i, d: barPath(x, w, top, last ? bottom : bottom + overlap, false, last) });
  });
  return out.filter(p => p.d);
}

function niceStep(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

const CARD_CSS = `
  :host { display: block; }
  ha-card { position: relative; padding: 16px 16px 12px; box-sizing: border-box; height: 100%; overflow: hidden; }
  .head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
  .title { font-size: 16px; font-weight: 500; line-height: 1.3; color: var(--primary-text-color); }
  .sub { font-size: 13px; color: var(--secondary-text-color); margin-top: 2px; }
  .hl { text-align: right; flex-shrink: 0; }
  .hl-label, .hl-delta { font-size: 12px; color: var(--secondary-text-color); }
  .hl-value { font-size: 22px; font-weight: 500; line-height: 1.25; color: var(--primary-text-color); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chips:empty { display: none; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; font: inherit; font-size: 12px;
    border: 1px solid var(--divider-color); border-radius: 999px; background: none;
    color: var(--secondary-text-color); cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  .chip.on { color: var(--primary-text-color); border-color: var(--secondary-text-color); }
  .chip.current { cursor: default; }
  .chip svg { display: block; }
  .chart { position: relative; margin-top: 6px; }
  .chart svg { display: block; width: 100%; overflow: visible; touch-action: pan-y; }
  .msg { font-size: 13px; color: var(--secondary-text-color); padding: 24px 0; text-align: center; }
  .msg:empty { display: none; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; margin-top: 8px; }
  th, td { padding: 3px 0 3px 12px; text-align: right; white-space: nowrap; font-weight: 400; color: var(--primary-text-color); }
  th { font-size: 12px; color: var(--secondary-text-color); }
  th:first-child, td:first-child { text-align: left; padding-left: 0; white-space: normal; }
  tr.calc td { border-top: 1px solid var(--divider-color); padding-top: 6px; }
  .d { font-size: 12px; color: var(--secondary-text-color); }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 8px; vertical-align: -1px; }
  .rl { display: inline-flex; align-items: baseline; gap: 4px; }
  .rl ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text-color); display: flex; align-self: center; }
  .err { color: var(--error-color, #db4437); cursor: help; }
  .note { font-size: 12px; color: var(--secondary-text-color); margin-top: 4px; }
  .note:empty { display: none; }
  .tip {
    position: absolute; z-index: 2; pointer-events: none; white-space: nowrap;
    padding: 8px 10px; font-size: 12px; line-height: 1.5; font-variant-numeric: tabular-nums;
    background: var(--card-background-color, var(--ha-card-background, #1c1c1c));
    color: var(--primary-text-color); border: 1px solid var(--divider-color); border-radius: 8px;
  }
  .tip[hidden] { display: none; }
  .tip .t { font-weight: 500; margin-bottom: 4px; }
  .tip .g { display: grid; gap: 1px 12px; text-align: right; }
  .tip .g .l { text-align: left; color: var(--secondary-text-color); }
  .tip .g .h { color: var(--secondary-text-color); }
`;

class HaComparisonCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement('ha-comparison-card-editor');
  }

  static getStubConfig(hass) {
    const id = Object.keys(hass?.states || {}).find(e => {
      const a = hass.states[e].attributes || {};
      return e.startsWith('sensor.') && a.device_class === 'energy' && /^total/.test(a.state_class || '');
    });
    return {
      group_by: 'month',
      compare_years: [1],
      series: id ? [{ name: hass.states[id].attributes.friendly_name || id, statistics: [id] }] : [],
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hidden = new Set();
    this._tpl = new Map();
    this._width = 0;
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
    const cfg = normalizeConfig(config);
    const sig = JSON.stringify(cfg);
    if (sig === this._cfgSig) return;
    this._cfgSig = sig;
    this._config = cfg;
    this._hidden = new Set();
    this._data = null;
    this._staleAt = 0;
    if (!this._els) this._build();
    if (this._hass) {
      this._syncZone();
      this._load();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    // Bars only change once a day, so state updates do not re-render anything.
    if (this._syncZone() || !this._loadToken || (this._staleAt && Date.now() >= this._staleAt && !this._loading)) this._load();
  }

  // Dates follow the time zone of the HA server, like the recorder does. Returns true on change.
  _syncZone() {
    const tz = this._hass.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (this._zone?.tz === tz) return false;
    this._zone = new Zone(tz);
    return true;
  }

  getCardSize() {
    const rows = this._config ? this._config.series.length + this._config.rows.length + 1 : 0;
    return Math.ceil(((this._config?.chart_height ?? 200) + 90 + (this._config?.show_table ? rows * 24 : 0)) / 50);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: 'auto' };
  }

  connectedCallback() {
    if (this._els && typeof ResizeObserver !== 'undefined') {
      this._ro = this._ro || new ResizeObserver(entries => {
        const w = Math.round(entries[0].contentRect.width);
        if (w && w !== this._width) {
          this._width = w;
          if (this._data) this._renderChart();
        }
      });
      this._ro.observe(this._els.chart);
    }
    if (this._data) this._syncTemplates();
  }

  disconnectedCallback() {
    this._ro?.disconnect();
    for (const t of this._tpl.values()) t.unsub?.();
    this._tpl.clear();
  }

  _build() {
    this.shadowRoot.innerHTML = `
      <style>${CARD_CSS}</style>
      <ha-card>
        <div class="head">
          <div class="titles"><div class="title"></div><div class="sub"></div></div>
          <div class="hl"><div class="hl-label"></div><div class="hl-value"></div><div class="hl-delta"></div></div>
        </div>
        <div class="chips"></div>
        <div class="chart"><svg role="img"></svg><div class="msg"></div></div>
        <table></table>
        <div class="note"></div>
        <div class="tip" hidden></div>
      </ha-card>`;
    const q = s => this.shadowRoot.querySelector(s);
    this._els = {
      card: q('ha-card'), title: q('.title'), sub: q('.sub'), hl: q('.hl'), hlLabel: q('.hl-label'),
      hlValue: q('.hl-value'), hlDelta: q('.hl-delta'), chips: q('.chips'), chart: q('.chart'),
      svg: q('svg'), msg: q('.msg'), table: q('table'), note: q('.note'), tip: q('.tip'),
    };
    this._els.chips.addEventListener('click', e => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      const k = Number(b.dataset.k);
      if (this._hidden.has(k)) this._hidden.delete(k); else this._hidden.add(k);
      this._render();
    });
    const svg = this._els.svg;
    svg.addEventListener('pointermove', e => this._showTip(e));
    svg.addEventListener('pointerdown', e => this._showTip(e));
    svg.addEventListener('pointerleave', () => this._hideTip());
    if (this.isConnected) this.connectedCallback();
  }

  _message(text) {
    this._els.msg.textContent = text;
    this._els.svg.style.display = text ? 'none' : '';
  }

  async _load() {
    const c = this._config;
    const hass = this._hass;
    if (!c || !hass || !this._zone) return;
    const token = {};
    this._loadToken = token;
    this._els.title.textContent = c.title;
    if (!c.series.some(s => s.statistics.length)) {
      this._data = null;
      this._clear();
      this._message('Add a series with at least one statistic in the card editor.');
      return;
    }
    this._loading = true;
    if (!this._data) this._message('Loading\u2026');
    try {
      const zone = this._zone;
      const now = Date.now();
      const today = zone.date(now);
      const cycles = buildCycles(c, c.include_today ? today : addDays(today, -1));
      const ids = [...new Set(c.series.flatMap(s => s.statistics))];
      const meta = await cachedWS(hass, { type: 'recorder/get_statistics_metadata', statistic_ids: ids }, CURRENT_TTL);
      if (this._loadToken !== token) return;
      const metaById = new Map((meta || []).map(m => [m.statistic_id, m]));
      const first = metaById.get(ids.find(id => metaById.has(id)));
      const type = c.stat_type !== 'auto' ? c.stat_type : first?.has_sum ? 'change' : 'mean';
      const unit = c.unit ?? first?.display_unit_of_measurement ?? first?.statistics_unit_of_measurement ?? '';
      const units = first?.unit_class && unit ? { [first.unit_class]: unit } : undefined;
      const period = c.group_by === 'hour' ? 'hour' : 'day';

      const results = await Promise.all(cycles.map(cy => {
        const end = cy.k === 0 ? cy.until : cy.end;
        const msg = {
          type: 'recorder/statistics_during_period',
          start_time: new Date(zone.midnight(cy.start)).toISOString(),
          end_time: new Date(zone.midnight(addDays(end, 1))).toISOString(),
          statistic_ids: ids,
          period,
          types: [type],
          ...(units ? { units } : {}),
        };
        return cachedWS(hass, msg, cy.k === 0 ? CURRENT_TTL : Infinity);
      }));
      if (this._loadToken !== token) return;

      this._data = processData(c, cycles, results, zone, type);
      this._data.unit = unit;
      this._data.missing = ids.filter(id => !metaById.has(id));
      const todayStart = zone.midnight(today);
      // While the range still runs through today, the current value keeps changing.
      const running = cmpDate(cycles[0].until, today) === 0;
      this._staleAt = running ? now + TODAY_REFRESH : now < todayStart + REFRESH_AFTER_MIDNIGHT
        ? todayStart + REFRESH_AFTER_MIDNIGHT
        : zone.midnight(addDays(today, 1));
      this._message('');
      this._render();
    } catch (err) {
      if (this._loadToken !== token) return;
      this._data = null;
      this._staleAt = Date.now() + 60000;
      this._clear();
      this._message(`Could not load statistics: ${err?.message || err}`);
    } finally {
      if (this._loadToken === token) this._loading = false;
    }
  }

  _clear() {
    const e = this._els;
    e.sub.textContent = '';
    e.hl.hidden = true;
    e.chips.innerHTML = '';
    e.table.innerHTML = '';
    e.note.textContent = '';
    e.svg.innerHTML = '';
  }

  _visible() {
    return this._data.cycles.filter(cy => cy.k === 0 || !this._hidden.has(cy.k));
  }

  _colors() {
    const pal = this._hass?.themes?.darkMode ? PALETTE_DARK : PALETTE_LIGHT;
    return this._config.series.map((s, i) => s.color || pal[i % pal.length]);
  }

  _formatters() {
    const [loc, extra] = numberLocale(this._hass);
    const lang = this._hass?.locale?.language || this._hass?.language || 'en';
    const key = JSON.stringify([loc, extra, lang]);
    if (this._fmtKey === key) return this._fmt;
    const nf = {};
    const num = (v, dec) => {
      const d = dec ?? autoDecimals(v);
      if (!nf[d]) nf[d] = new Intl.NumberFormat(loc, { ...extra, minimumFractionDigits: d, maximumFractionDigits: d });
      return nf[d].format(v);
    };
    const pct = new Intl.NumberFormat(loc, { ...extra, maximumFractionDigits: 0, signDisplay: 'exceptZero' });
    const pct1 = new Intl.NumberFormat(loc, { ...extra, maximumFractionDigits: 1, signDisplay: 'exceptZero' });
    const df = o => new Intl.DateTimeFormat(lang, { timeZone: 'UTC', ...o });
    this._fmtKey = key;
    this._fmt = {
      num,
      pct: v => `${(Math.abs(v) < 10 ? pct1 : pct).format(v)} %`,
      monthShort: df({ month: 'short' }),
      monthLong: df({ month: 'long' }),
      day: df({ day: 'numeric' }),
      dayMonth: df({ day: 'numeric', month: 'short' }),
      range: df({ day: 'numeric', month: 'short', year: 'numeric' }),
    };
    return this._fmt;
  }

  _render() {
    if (!this._data) return;
    this._renderHead();
    this._renderChips();
    this._renderChart();
    this._renderTable();
    this._syncTemplates();
  }

  _renderHead() {
    const c = this._config;
    const e = this._els;
    const f = this._formatters();
    const cur = this._data.cycles[0];
    e.title.textContent = c.title;
    const a = new Date(utcOf(cur.start));
    const b = new Date(utcOf(cur.end));
    let sub = typeof f.range.formatRange === 'function' ? f.range.formatRange(a, b) : `${f.range.format(a)} \u2013 ${f.range.format(b)}`;
    const days = daysBetween(cur.start, cur.until) + 1;
    sub += ` \u00b7 ${days} ${days === 1 ? 'day' : 'days'}`;
    e.sub.textContent = sub;
    this._renderHeadline();
  }

  _headlineItem() {
    const want = this._config.headline;
    if (!want) return null;
    const w = want.toLowerCase();
    const si = this._config.series.findIndex(s => s.name.toLowerCase() === w || s.id === w);
    if (si >= 0) return { name: this._config.series[si].name, series: si };
    const ri = this._config.rows.findIndex(r => r.name.toLowerCase() === w);
    if (ri >= 0) return { name: this._config.rows[ri].name, row: ri };
    return null;
  }

  _itemValue(item, cy) {
    if (item.series != null) return { v: cy.totals[item.series], unit: this._data.unit, dec: this._config.decimals };
    const r = this._tpl.get(`${item.row}|${cy.k}`)?.result;
    const row = this._config.rows[item.row];
    return { v: r, unit: row.unit ?? this._data.unit, dec: row.decimals };
  }

  _renderHeadline() {
    const e = this._els;
    const item = this._headlineItem();
    e.hl.hidden = !item;
    if (!item) return;
    const f = this._formatters();
    const vis = this._visible();
    const cur = vis[0];
    const { v, unit, dec } = this._itemValue(item, cur);
    e.hlLabel.textContent = `${item.name} ${cur.label}`;
    e.hlValue.textContent = typeof v === 'number' ? `${f.num(v, dec)} ${unit}`.trim() : (v ?? '\u2013');
    const prev = vis[1];
    if (!prev) { e.hlDelta.textContent = ''; return; }
    const pv = this._itemValue(item, prev).v;
    if (!prev.complete) e.hlDelta.textContent = `vs ${prev.label}: incomplete`;
    else if (typeof v === 'number' && typeof pv === 'number' && pv !== 0) {
      e.hlDelta.textContent = `${f.pct((v / pv - 1) * 100)} vs ${prev.label}`;
    } else e.hlDelta.textContent = '';
  }

  _renderChips() {
    const cycles = this._data.cycles;
    if (cycles.length < 2) { this._els.chips.innerHTML = ''; return; }
    const side = this._config.layout === 'side_by_side';
    const sw = (op, color = 'var(--primary-text-color)') => `<svg width="14" height="12" aria-hidden="true"><rect x="1" y="1" width="12" height="10" rx="2"
      style="fill: ${color}; fill-opacity: ${op}"></rect></svg>`;
    this._els.chips.innerHTML = cycles.map(cy => {
      if (cy.k === 0) return `<span class="chip on current">${sw(1, 'var(--secondary-text-color)')}${escapeHtml(cy.label)}</span>`;
      const on = !this._hidden.has(cy.k);
      return `<button class="chip${on ? ' on' : ''}" data-k="${cy.k}" aria-pressed="${on}"
        title="${on ? 'Hide' : 'Show'} ${escapeHtml(cy.label)}">${side ? sw(on ? 1 : 0, 'var(--secondary-text-color)') : sw(on ? ghostOpacity(this._config, cy.k) : 0)}${escapeHtml(cy.label)}</button>`;
    }).join('');
  }

  _renderChart() {
    const c = this._config;
    const d = this._data;
    const e = this._els;
    const f = this._formatters();
    const colors = this._colors();
    const vis = this._visible();
    const ghosts = vis.slice(1);
    const slots = d.slots;
    const n = slots.length;
    const W = this._width || e.chart.clientWidth || 500;
    const H = c.chart_height;

    const valuesAt = (cy, key) => c.series.map((s, i) => {
      const v = cy.buckets[i].get(key);
      return v == null ? null : v;
    });
    let maxUp = 0;
    let maxDown = 0;
    for (const cy of vis) {
      for (const slot of slots) {
        const vals = valuesAt(cy, slot.key);
        let up = 0;
        let down = 0;
        vals.forEach((v, i) => { if (v > 0) { if (c.series[i].below_zero) down += v; else up += v; } });
        maxUp = Math.max(maxUp, up);
        maxDown = Math.max(maxDown, down);
      }
    }
    if (!maxUp && !maxDown) maxUp = 1;
    const step = niceStep((maxUp + maxDown) / 5);
    const top = maxUp * 1.06;
    const bottom = maxDown ? maxDown * 1.08 : 0;
    const ticks = [];
    for (let t = -Math.floor(bottom / step) * step; t <= top + 1e-9; t += step) ticks.push(Math.abs(t) < 1e-9 ? 0 : t);

    const stepDec = (String(Math.round(step * 1e6) / 1e6).split('.')[1] || '').length;
    const tickText = ticks.map(t => f.num(t, stepDec));
    const ML = Math.max(28, Math.max(...tickText.map(t => t.length)) * 6.5 + 10);
    const MR = 4;
    const MT = 14;
    const labels = this._axisLabels(W - ML - MR);
    const MB = labels.some(l => l.sub) ? 32 : 18;
    const ph = H - MT - MB;
    const y = v => MT + (top - v) / (top + bottom) * ph;
    const pw = W - ML - MR;
    const sw = pw / n;
    const k = ghosts.length;
    const side = c.layout === 'side_by_side';
    const nY = vis.length;
    const bw = side
      ? Math.max(1, Math.min(nY > 1 ? 16 : 24, (sw * 0.8 - SIDE_GAP * (nY - 1)) / nY))
      : Math.max(1, Math.min(24, (sw * 0.8) / (1 + 0.45 * k)));
    const off = bw * 0.45;
    const r1 = v => Math.round(v * 10) / 10;

    let g = `<rect class="hl-slot" x="0" y="${MT}" width="${r1(sw)}" height="${r1(ph)}" rx="4"
      style="fill: var(--primary-text-color); fill-opacity: .06" visibility="hidden"></rect>`;
    ticks.forEach((t, i) => {
      const yy = r1(y(t));
      g += `<line x1="${r1(ML)}" x2="${r1(W - MR)}" y1="${yy}" y2="${yy}"
        style="stroke: var(--divider-color); stroke-width: ${t === 0 ? 1 : 0.5}"></line>`;
      // A tick right below the unit label would collide with it.
      if (d.unit && yy < MT + 10) return;
      g += `<text x="${r1(ML - 6)}" y="${yy + 4}" text-anchor="end" font-size="11"
        style="fill: var(--secondary-text-color)">${escapeHtml(tickText[i])}</text>`;
    });
    if (d.unit) g += `<text x="${r1(ML - 6)}" y="${MT - 4}" text-anchor="end" font-size="11" style="fill: var(--secondary-text-color)">${escapeHtml(d.unit)}</text>`;

    let bars = '';
    slots.forEach((slot, i) => {
      const cx = ML + sw * i + sw / 2;
      if (side) {
        // One fully visible bar per year, oldest first.
        const g0 = cx - (bw * nY + SIDE_GAP * (nY - 1)) / 2;
        [...vis].reverse().forEach((cy, j) => {
          const vals = valuesAt(cy, slot.key);
          if (vals.every(v => v == null)) return;
          for (const p of stackPaths(vals.map(v => Math.max(0, v ?? 0)), c.series, g0 + j * (bw + SIDE_GAP), bw, y, 0.75)) {
            bars += `<path d="${p.d}" style="fill: ${escapeHtml(colors[p.i])}"></path>`;
          }
        });
        return;
      }
      const x0 = cx - (bw + off * k) / 2;
      // Previous years stand behind the current bar in the series colors, translucent,
      // each year one step further back.
      for (let r = k - 1; r >= 0; r--) {
        const vals = valuesAt(ghosts[r], slot.key);
        if (vals.every(v => v == null)) continue;
        const op = ghostOpacity(c, ghosts[r].k);
        for (const p of stackPaths(vals.map(v => Math.max(0, v ?? 0)), c.series, x0 + off * (r + 1), bw, y)) {
          bars += `<path d="${p.d}" style="fill: ${escapeHtml(colors[p.i])}; fill-opacity: ${op}"></path>`;
        }
      }
      const cur = valuesAt(vis[0], slot.key);
      for (const p of stackPaths(cur.map(v => Math.max(0, v ?? 0)), c.series, x0, bw, y, 0.75)) {
        bars += `<path d="${p.d}" style="fill: ${escapeHtml(colors[p.i])}"></path>`;
      }
    });

    let axis = '';
    for (const l of labels) {
      const cx = r1(ML + sw * l.i + sw / 2);
      if (l.text) axis += `<text x="${cx}" y="${H - MB + 14}" text-anchor="middle" font-size="11" style="fill: var(--secondary-text-color)">${escapeHtml(l.text)}</text>`;
      if (l.sub) axis += `<text x="${cx}" y="${H - MB + 28}" text-anchor="middle" font-size="11" style="fill: var(--secondary-text-color); fill-opacity: .8">${escapeHtml(l.sub)}</text>`;
    }

    let hits = '';
    slots.forEach((s, i) => {
      hits += `<rect data-i="${i}" x="${r1(ML + sw * i)}" y="${MT}" width="${Math.max(r1(sw), 0.5)}" height="${r1(ph)}" style="fill: transparent"></rect>`;
    });

    e.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    e.svg.setAttribute('height', H);
    e.svg.setAttribute('aria-label', `${c.series.map(s => s.name).join(', ')}: ${vis.map(cy => cy.label).join(' vs ')}`);
    e.svg.innerHTML = g + bars + axis + hits;
    this._geo = { ML, sw, MT, ph };
  }

  // Axis labels, thinned so they do not overlap.
  _axisLabels(pw) {
    const f = this._formatters();
    const group = this._config.group_by;
    const slots = this._data.slots;
    const n = slots.length;
    const sw = pw / Math.max(1, n);
    const out = [];
    if (group === 'month') {
      slots.forEach((s, i) => {
        const text = f.monthShort.format(new Date(Date.UTC(2000, s.dt.m - 1, 15)));
        let sub = '';
        const days = s.days;
        if (days.length && days.length < daysInMonth(days[0].y, days[0].m) && typeof f.day.formatRange === 'function') {
          const a = days[0];
          const b = days[days.length - 1];
          sub = a.d === b.d ? f.day.format(new Date(utcOf(a))) : f.day.formatRange(new Date(utcOf(a)), new Date(utcOf(b)));
        }
        out.push({ i, text, sub });
      });
      const step = Math.max(1, Math.ceil(44 / sw));
      return out.map(l => (l.i % step === 0 || (l.sub && sw >= 30) ? l : { ...l, text: '', sub: '' }));
    }
    const hourly = group === 'hour';
    const minPx = hourly ? 26 : 24;
    const choices = hourly ? [1, 2, 3, 6, 12, 24, 48, 168, 336, 720] : [1, 2, 5, 7, 14, 30, 61, 91, 182];
    const step = choices.find(c => c * sw >= minPx) || choices[choices.length - 1];
    let lastSub = -Infinity;
    slots.forEach((s, i) => {
      const text = i % step === 0 ? (hourly ? `${s.h}` : f.day.format(new Date(utcOf(s.dt)))) : '';
      let sub = '';
      const boundary = hourly ? s.h === 0 : s.dt.d === 1;
      if ((i === 0 || boundary) && (i - lastSub) * sw >= 56) {
        sub = hourly ? f.dayMonth.format(new Date(utcOf(s.dt))) : f.monthShort.format(new Date(utcOf(s.dt)));
        lastSub = i;
      }
      if (text || sub) out.push({ i, text, sub });
    });
    return out;
  }

  _slotLabel(slot) {
    const f = this._formatters();
    const group = this._config.group_by;
    if (group === 'month') return f.monthLong.format(new Date(Date.UTC(2000, slot.dt.m - 1, 15)));
    const day = f.dayMonth.format(new Date(utcOf(slot.dt)));
    return group === 'hour' ? `${day}, ${pad2(slot.h)}:00` : day;
  }

  _showTip(ev) {
    const hit = ev.target.closest?.('[data-i]');
    if (!hit || !this._data) { this._hideTip(); return; }
    const i = Number(hit.dataset.i);
    const slot = this._data.slots[i];
    const c = this._config;
    const f = this._formatters();
    const vis = this._visible();
    const hl = this._els.svg.querySelector('.hl-slot');
    const { ML, sw } = this._geo;
    hl.setAttribute('x', ML + sw * i);
    hl.setAttribute('width', Math.max(sw, 1));
    hl.setAttribute('visibility', 'visible');

    let h = `<div class="t">${escapeHtml(this._slotLabel(slot))}</div>`;
    h += `<div class="g" style="grid-template-columns: auto repeat(${c.series.length}, auto)"><span></span>`;
    h += c.series.map(s => `<span class="h">${escapeHtml(s.name)}</span>`).join('');
    for (const cy of vis) {
      const vals = c.series.map((s, si) => cy.buckets[si].get(slot.key));
      const mark = cy.partialSlots.has(slot.key) ? '*' : '';
      h += `<span class="l">${escapeHtml(cy.label)}${mark}</span>`;
      h += vals.every(v => v == null)
        ? `<span class="h" style="grid-column: span ${c.series.length}">no data</span>`
        : vals.map(v => `<span>${v == null ? '\u2013' : escapeHtml(f.num(v, c.decimals))}</span>`).join('');
    }
    h += '</div>';
    const tip = this._els.tip;
    tip.innerHTML = h;
    tip.hidden = false;
    const card = this._els.card.getBoundingClientRect();
    const w = tip.offsetWidth;
    let left = ev.clientX - card.left + 14;
    if (left + w > card.width - 8) left = ev.clientX - card.left - w - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${ev.clientY - card.top + 14}px`;
  }

  _hideTip() {
    this._els.tip.hidden = true;
    this._els.svg.querySelector('.hl-slot')?.setAttribute('visibility', 'hidden');
  }

  _renderTable() {
    const c = this._config;
    const e = this._els;
    const d = this._data;
    if (!c.show_table) { e.table.innerHTML = ''; this._renderNote(); return; }
    const f = this._formatters();
    const colors = this._colors();
    const vis = this._visible();
    const cur = vis[0];
    // Previous years show the change of the current value against them; * = incomplete data.
    const cell = (v, curV, cy, dec, suffix = '') => {
      if (v == null) return '<td>\u2013</td>';
      if (typeof v !== 'number') return `<td>${escapeHtml(v)}</td>`;
      let out = escapeHtml(`${f.num(v, dec)}${suffix}`);
      if (!cy.complete) out += '<span class="d">*</span>';
      else if (cy !== cur && typeof curV === 'number' && v !== 0) {
        out += ` <span class="d">${escapeHtml(f.pct((curV / v - 1) * 100))}</span>`;
      }
      return `<td>${out}</td>`;
    };

    let h = `<tr><th>${escapeHtml(d.unit)}</th>${vis.map(cy => `<th>${escapeHtml(cy.label)}</th>`).join('')}</tr>`;
    c.series.forEach((s, si) => {
      h += `<tr><td><span class="sw" style="background: ${escapeHtml(colors[si])}"></span>${escapeHtml(s.name)}</td>`;
      h += vis.map(cy => cell(cy.totals[si], cur.totals[si], cy, c.decimals)).join('');
      h += '</tr>';
    });
    c.rows.forEach((r, ri) => {
      const curR = this._tpl.get(`${ri}|${cur.k}`);
      h += `<tr class="calc"><td><span class="rl"><ha-icon icon="${escapeHtml(r.icon || ROW_ICON)}"></ha-icon>${escapeHtml(r.name)}</span></td>`;
      h += vis.map(cy => {
        const t = this._tpl.get(`${ri}|${cy.k}`);
        if (t?.error) return `<td><span class="err" title="${escapeHtml(t.error)}">\u26a0</span></td>`;
        const suffix = r.unit != null && r.unit !== (d.unit || '') ? ` ${r.unit}` : '';
        return cell(t?.result, curR?.result, cy, r.decimals, suffix);
      }).join('');
      h += '</tr>';
    });
    e.table.innerHTML = h;
    this._renderNote();
  }

  _renderNote() {
    const d = this._data;
    const vis = this._visible();
    const notes = vis.filter(cy => !cy.complete)
      .map(cy => `* ${cy.label}: data for ${cy.coveredDays} of ${cy.expectedDays} days`);
    if (d.missing.length) notes.push(`No long-term statistics for ${d.missing.join(', ')}`);
    for (const [name, msg] of d.errors) notes.push(`${name}: ${msg}`);
    this._els.note.textContent = notes.join(' \u00b7 ');
  }

  // Extra rows: one server-side template per row and year, fed with that year's totals.
  _syncTemplates() {
    const c = this._config;
    const d = this._data;
    const conn = this._hass?.connection;
    const want = new Map();
    if (d && conn && this.isConnected) {
      c.rows.forEach((r, ri) => {
        for (const cy of d.cycles) {
          const vars = { year: cy.start.y, label: cy.label, days: daysBetween(cy.start, cy.until) + 1, current: cy.k === 0, series: {} };
          c.series.forEach((s, si) => {
            const v = cy.totals[si];
            const val = v == null ? null : Math.round(v * 1e6) / 1e6;
            vars[s.id] = val;
            vars.series[s.id] = val;
          });
          want.set(`${ri}|${cy.k}`, { template: r.template, variables: vars });
        }
      });
    }
    for (const [key, t] of this._tpl) {
      const w = want.get(key);
      if (!w || JSON.stringify(w) !== t.sig) {
        t.unsub?.();
        this._tpl.delete(key);
      }
    }
    for (const [key, w] of want) {
      if (this._tpl.has(key)) continue;
      const entry = { sig: JSON.stringify(w), result: undefined, error: null };
      this._tpl.set(key, entry);
      conn.subscribeMessage(msg => {
        if (this._tpl.get(key) !== entry) return;
        if (msg.error) { entry.error = msg.error.message ?? String(msg.error); entry.result = undefined; }
        else if (msg.result !== undefined) {
          entry.error = null;
          const r = msg.result;
          entry.result = typeof r === 'number' ? r
            : (typeof r === 'string' && r.trim() !== '' && !isNaN(Number(r)) ? Number(r) : r);
        } else return;
        this._scheduleTableRender();
      }, { type: 'render_template', template: w.template, variables: w.variables, report_errors: true })
        .then(unsub => { if (this._tpl.get(key) === entry) entry.unsub = unsub; else unsub(); })
        .catch(err => {
          if (this._tpl.get(key) !== entry) return;
          entry.error = err?.message || String(err);
          this._scheduleTableRender();
        });
    }
  }

  _scheduleTableRender() {
    if (this._tableQueued) return;
    this._tableQueued = true;
    Promise.resolve().then(() => {
      this._tableQueued = false;
      if (!this._data) return;
      this._renderTable();
      this._renderHeadline();
    });
  }
}

// ---------- editor ----------

const EDITOR_CSS = `
  :host { display: block; }
  ha-form { --ha-form-grid-padding: 0; display: block; margin-bottom: 8px; }
  .section {
    margin: 20px 0 8px; font-size: 12px; font-weight: 600; letter-spacing: .05em;
    text-transform: uppercase; color: var(--secondary-text-color);
  }
  .hint { font-size: 12px; color: var(--secondary-text-color); margin: 0 0 10px; }
  .sub { margin: 14px 0 6px; font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
  .hint code { font-family: var(--code-font-family, monospace); }
  .box {
    border: 1px solid var(--divider-color); border-radius: 12px; overflow: hidden;
    background: var(--card-background-color); margin-bottom: 12px;
  }
  .box-head {
    display: flex; justify-content: space-between; align-items: center; gap: 4px;
    padding: 0 8px 0 0; background: var(--secondary-background-color);
  }
  .box.open .box-head { border-bottom: 1px solid var(--divider-color); }
  .box-toggle {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
    padding: 10px 4px 10px 12px; border: none; background: none; cursor: pointer;
    text-align: left; font-family: inherit; color: inherit;
  }
  .chevron {
    flex-shrink: 0; width: 14px; font-size: 13px; line-height: 1;
    color: var(--secondary-text-color); transition: transform .15s ease;
  }
  .box.open .chevron { transform: rotate(90deg); }
  .dot { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
  .box-toggle ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); flex-shrink: 0; }
  .box-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .box-title {
    font-weight: 600; font-size: 14px; color: var(--primary-text-color);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .box-meta {
    font-size: 12px; color: var(--secondary-text-color);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .box-body { padding: 12px 12px 4px; }
  .box-body[hidden] { display: none; }
  .box-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .icon-btn {
    background: none; border: none; cursor: pointer; color: var(--secondary-text-color);
    font-size: 13px; padding: 2px 6px; line-height: 1; border-radius: 4px;
  }
  .icon-btn:hover:not(:disabled) { color: var(--primary-text-color); background: var(--card-background-color); }
  .icon-btn:disabled { opacity: .3; cursor: default; }
  .icon-btn.danger:hover { color: var(--error-color, #db4437); }
  .color-field { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .color-field ha-form { flex: 1; margin-bottom: 0; }
  .color-swatch {
    width: 36px; height: 36px; flex-shrink: 0; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--divider-color, rgba(0, 0, 0, .12)); position: relative; overflow: hidden;
  }
  .color-swatch.no-color {
    background: repeating-linear-gradient(-45deg, rgba(120, 120, 120, .5) 0px, rgba(120, 120, 120, .5) 4px, transparent 4px, transparent 8px);
  }
  .color-swatch input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; padding: 0; border: none; }
  .addbtn {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    width: 100%; padding: 10px; border: 1px dashed var(--divider-color);
    border-radius: 12px; background: none; cursor: pointer;
    color: var(--primary-color); font-size: 14px; font-weight: 500;
  }
  .addbtn:hover { background: var(--secondary-background-color); }
`;

const LABELS = {
  title: 'Title',
  start: 'First day (MM-DD)',
  end: 'Last day (MM-DD)',
  group_by: 'One bar per',
  stat_type: 'Statistic',
  headline: 'Headline value',
  unit: 'Unit',
  decimals: 'Decimals',
  chart_height: 'Chart height (px)',
  layout: 'Previous years',
  show_table: 'Show value table',
  name: 'Name',
  statistics: 'Statistics (summed up)',
  id: 'Template variable',
  below_zero: 'Draw below the zero line',
  color: 'Color',
  template: 'Jinja2 template',
  icon: 'Icon',
};

const HELPERS = {
  start: 'Empty = 01-01',
  end: 'Empty = today, including the running day. "yesterday" = whole days only. A last day before the first day spans the turn of the year.',
  stat_type: 'Auto: change for meters, mean otherwise',
  unit: 'Empty = unit of the statistic',
  decimals: 'Empty = automatic',
};

class HaComparisonCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._echoes = [];
  }

  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll('ha-form').forEach(f => { f.hass = hass; });
  }

  setConfig(config) {
    // HA echoes every change back asynchronously; only a foreign config re-renders.
    const json = JSON.stringify(config ?? {});
    const i = this._echoes.indexOf(json);
    if (i >= 0) { this._echoes.splice(0, i + 1); return; }
    this._echoes = [];
    this._config = JSON.parse(json);
    this._open = null;
    this._render();
  }

  // Open/closed state of the series and row boxes. Filled entries start closed, empty ones open.
  _openState(kind) {
    if (!this._open) this._open = { series: [], rows: [] };
    const list = this._list(kind);
    const st = this._open[kind];
    list.forEach((x, i) => {
      if (st[i] == null) st[i] = kind === 'series' ? ![].concat(x.statistics ?? []).length : !x.template;
    });
    st.length = list.length;
    return st;
  }

  _fire() {
    const json = JSON.stringify(this._config);
    this._echoes.push(json);
    if (this._echoes.length > 50) this._echoes.shift();
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: JSON.parse(json) }, bubbles: true, composed: true }));
  }

  _patch(values, target = this._config) {
    Object.assign(target, values);
    Object.keys(target).forEach(k => {
      const v = target[k];
      if (v === '' || v == null || (Array.isArray(v) && !v.length && k !== 'compare_years')) delete target[k];
    });
  }

  _list(key) {
    if (!Array.isArray(this._config[key])) this._config[key] = [];
    return this._config[key];
  }

  _el(sel) { return this.shadowRoot.querySelector(sel); }

  _render() {
    const series = this._list('series');
    const rows = this._list('rows');
    this.shadowRoot.innerHTML = `
      <style>${EDITOR_CSS}</style>
      <ha-form id="f-general"></ha-form>
      <div class="section">Compare with</div>
      <ha-form id="f-compare"></ha-form>
      <div class="section">Bars</div>
      <div class="hint">Each series is one segment of the stacked bar and one line of the value table, in this order. Its value is
        the sum of its statistics, or a value template over all series, e.g. <code>{{ solar - feed_in }}</code>.</div>
      ${series.map((s, i) => this._seriesHtml(i, series.length)).join('')}
      <button class="addbtn" id="add-series">+ Add series</button>
      <div class="section">Value table</div>
      <ha-form id="f-table"></ha-form>
      <div class="sub">Calculated rows</div>
      <div class="hint">Extra lines below the series, calculated per year with a Jinja2 template. Every series is available by its
        template variable, e.g. <code>{{ grid + solar }}</code>, plus <code>year</code>, <code>days</code> and <code>current</code>.</div>
      ${rows.map((r, i) => this._rowHtml(i, rows.length)).join('')}
      <button class="addbtn" id="add-row">+ Add row</button>
      <div class="section"></div>
      ${this._panelHtml('display', 'Display', 'Chart height, headline value, unit', '<ha-form id="f-display"></ha-form>')}
    `;
    this._initForms();
    this._wire();
  }

  // Collapsible box as in the BVG card editor: header with toggle, meta line and move/remove buttons.
  _boxHtml(kind, i, count, icon, body) {
    const open = this._openState(kind)[i];
    const b = (act, label, text, dis, cls = '') => `<button class="icon-btn${cls}" data-act="${act}" data-kind="${kind}"
      data-i="${i}" title="${label}" aria-label="${label}" ${dis ? 'disabled' : ''}>${text}</button>`;
    return `
      <div class="box${open ? ' open' : ''}" id="box-${kind}-${i}">
        <div class="box-head">
          <button class="box-toggle" data-toggle="${kind}" data-i="${i}" aria-expanded="${open}">
            <span class="chevron">\u25b8</span>${icon}
            <span class="box-text"><span class="box-title" id="${kind}-title-${i}"></span>
              <span class="box-meta" id="${kind}-meta-${i}"></span></span>
          </button>
          <span class="box-actions">${b('up', 'Move up', '\u25b2', i === 0)}${b('down', 'Move down', '\u25bc', i === count - 1)}${b('del', 'Remove', '\u2715', false, ' danger')}</span>
        </div>
        <div class="box-body" id="body-${kind}-${i}" ${open ? '' : 'hidden'}>${body}</div>
      </div>`;
  }

  _panelHtml(key, title, meta, body) {
    const open = !!this._panels?.[key];
    return `
      <div class="box${open ? ' open' : ''}" id="box-${key}-0">
        <div class="box-head">
          <button class="box-toggle" data-toggle="${key}" data-i="0" aria-expanded="${open}">
            <span class="chevron">\u25b8</span>
            <span class="box-text"><span class="box-title">${title}</span><span class="box-meta">${meta}</span></span>
          </button>
        </div>
        <div class="box-body" id="body-${key}-0" ${open ? '' : 'hidden'}>${body}</div>
      </div>`;
  }

  _seriesHtml(i, count) {
    return this._boxHtml('series', i, count, `<span class="dot" id="dot-${i}"></span>`, `
      <ha-form id="f-series-${i}"></ha-form>
      <div class="color-field">
        <div class="color-swatch" id="swatch-${i}" title="Pick color"><input type="color" id="picker-${i}" aria-label="Color of series ${i + 1}"></div>
        <ha-form id="f-color-${i}"></ha-form>
      </div>`);
  }

  _rowHtml(i, count) {
    return this._boxHtml('rows', i, count, `<ha-icon id="ricon-${i}" icon="${ROW_ICON}"></ha-icon>`,
      `<ha-form id="f-row-${i}"></ha-form>`);
  }

  _toggleBox(kind, i) {
    const st = kind === 'series' || kind === 'rows' ? this._openState(kind) : (this._panels = this._panels || {});
    if (st === this._panels) i = kind;
    st[i] = !st[i];
    const n = st === this._panels ? 0 : i;
    this._el(`#box-${kind}-${n}`)?.classList.toggle('open', st[i]);
    const body = this._el(`#body-${kind}-${n}`);
    if (body) body.hidden = !st[i];
    this._el(`[data-toggle="${kind}"][data-i="${n}"]`)?.setAttribute('aria-expanded', String(st[i]));
  }

  _setupForm(sel, schema, data, onChange) {
    const form = this._el(sel);
    if (!form) return;
    form.hass = this._hass;
    form.schema = schema;
    form.data = data;
    form.computeLabel = s => s.label ?? LABELS[s.name] ?? s.name;
    form.computeHelper = s => s.helper ?? HELPERS[s.name];
    form.addEventListener('value-changed', ev => onChange(ev.detail.value || {}));
  }

  _compareYears() {
    const c = this._config.compare_years;
    return (c == null ? [1] : [].concat(c)).map(Number).filter(k => k >= 1 && k <= MAX_YEARS_BACK);
  }

  _headlineOptions() {
    const names = [...this._list('series'), ...this._list('rows')].map(x => x.name).filter(Boolean);
    return [{ value: '', label: 'None' }, ...[...new Set(names)].map(n => ({ value: n, label: n }))];
  }

  _generalSchema() {
    return [
      { name: 'title', selector: { text: {} } },
      { type: 'grid', name: '', schema: [
        { name: 'start', selector: { text: {} } },
        { name: 'end', selector: { text: {} } },
      ] },
      { name: 'group_by', required: true, selector: { select: { mode: 'dropdown', options: [
        { value: 'hour', label: 'Hour' }, { value: 'day', label: 'Day' }, { value: 'month', label: 'Month' },
      ] } } },
      { name: 'stat_type', required: true, selector: { select: { mode: 'dropdown', options: [
        { value: 'auto', label: 'Auto' }, { value: 'change', label: 'Change (meters)' },
        { value: 'mean', label: 'Mean' }, { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' },
      ] } } },
    ];
  }

  // Layout choice, then one line per previous year: switch plus the opacity of its ghost bars in percent.
  _compareSchema() {
    const on = new Set(this._compareYears());
    const side = this._config.layout === 'side_by_side';
    const y = new Date().getFullYear();
    return [
      { name: 'layout', required: true, selector: { select: { mode: 'dropdown', options: [
        { value: 'behind', label: 'Behind the current bar (ghosts)' },
        { value: 'side_by_side', label: 'Side by side, fully visible' },
      ] } } },
      ...Array.from({ length: MAX_YEARS_BACK }, (_, i) => ({
        type: 'grid', name: '', column_min_width: '120px', schema: [
          { name: `year_${i + 1}`, label: `${y - i - 1} (${i + 1} ${i ? 'years' : 'year'} back)`, selector: { boolean: {} } },
          { name: `opacity_${i + 1}`, label: 'Opacity', disabled: side || !on.has(i + 1),
            selector: { number: { min: 0, max: 100, step: 1, mode: 'box', unit_of_measurement: '%' } } },
        ],
      })),
    ];
  }

  _compareData() {
    const on = new Set(this._compareYears());
    const cur = parseOpacities(this._config.ghost_opacity);
    const data = { layout: this._config.layout || 'behind' };
    for (let k = 1; k <= MAX_YEARS_BACK; k++) {
      data[`year_${k}`] = on.has(k);
      data[`opacity_${k}`] = Math.round((cur[k] ?? GHOST_OPACITY[k - 1] ?? 0.05) * 100);
    }
    return data;
  }

  _displaySchema() {
    return [
      { name: 'chart_height', selector: { number: { min: 80, max: 600, step: 10, mode: 'box' } } },
      { name: 'headline', selector: { select: { mode: 'dropdown', options: this._headlineOptions() } } },
      { type: 'grid', name: '', schema: [
        { name: 'unit', selector: { text: {} } },
        { name: 'decimals', selector: { number: { min: 0, max: 4, step: 1, mode: 'box' } } },
      ] },
    ];
  }

  _initForms() {
    const c = this._config;
    this._setupForm('#f-general', this._generalSchema(), {
      title: c.title ?? '', start: c.start ?? '', end: c.end ?? '',
      group_by: c.group_by ?? 'month', stat_type: c.stat_type ?? 'auto',
    }, v => {
      this._patch({
        title: v.title,
        start: v.start?.trim(),
        end: v.end?.trim(),
        group_by: v.group_by,
        stat_type: v.stat_type === 'auto' ? null : v.stat_type,
      });
      this._fire();
    });

    this._setupForm('#f-compare', this._compareSchema(), this._compareData(), v => {
      const before = `${this._compareYears().join()}|${this._config.layout}`;
      const years = [];
      const opacity = {};
      for (let k = 1; k <= MAX_YEARS_BACK; k++) {
        if (!v[`year_${k}`]) continue;
        years.push(k);
        // Only opacities that differ from the default are stored.
        const pct = numOrNull(v[`opacity_${k}`]);
        if (pct != null && pct !== Math.round((GHOST_OPACITY[k - 1] ?? 0.05) * 100)) opacity[k] = pct;
      }
      this._patch({
        compare_years: years,
        ghost_opacity: Object.keys(opacity).length ? opacity : null,
        layout: v.layout === 'side_by_side' ? 'side_by_side' : null,
      });
      this._fire();
      if (`${years.join()}|${this._config.layout}` !== before) {
        const form = this._el('#f-compare');
        if (form) form.schema = this._compareSchema();
      }
    });

    this._list('series').forEach((s, i) => this._initSeries(i));
    this._list('rows').forEach((r, i) => this._initRow(i));

    this._setupForm('#f-table', [{ name: 'show_table', selector: { boolean: {} } }], { show_table: c.show_table !== false }, v => {
      this._patch({ show_table: v.show_table === false ? false : null });
      this._fire();
    });

    this._setupForm('#f-display', this._displaySchema(), {
      chart_height: c.chart_height ?? 200, headline: c.headline ?? '', unit: c.unit ?? '', decimals: c.decimals,
    }, v => {
      this._patch({
        chart_height: v.chart_height === 200 ? null : v.chart_height,
        headline: v.headline, unit: v.unit, decimals: v.decimals,
      });
      this._fire();
    });
  }

  _initSeries(i) {
    const s = this._config.series[i];
    this._setupForm(`#f-series-${i}`, [
      { name: 'name', selector: { text: {} } },
      { name: 'statistics', selector: { statistic: { multiple: true } } },
      { name: 'template', label: 'Value template', selector: { template: {} },
        helper: 'Empty = sum of the statistics. Every series by its template variable, e.g. {{ solar - feed_in }}' },
      { name: 'id', selector: { text: {} }, helper: 'Empty = derived from the name' },
      { name: 'below_zero', selector: { boolean: {} } },
    ], {
      name: s.name ?? '', statistics: [].concat(s.statistics ?? []), template: s.template ?? '', id: s.id ?? '',
      below_zero: s.below_zero === true,
    }, v => {
      // Look up the item at event time: the list may have been re-rendered since.
      const cur = this._config.series[i];
      if (!cur) return;
      this._patch({
        name: v.name, id: v.id, statistics: (v.statistics || []).filter(Boolean), template: v.template,
        below_zero: v.below_zero ? true : null,
      }, cur);
      this._fire();
      this._syncSeriesHead(i);
      this._refreshHeadlineOptions();
    });
    this._setupForm(`#f-color-${i}`, [{ name: 'color', selector: { text: {} } }], { color: s.color ?? '' }, v => {
      const cur = this._config.series[i];
      if (!cur) return;
      this._patch({ color: v.color?.trim() }, cur);
      this._fire();
      this._syncSeriesHead(i);
    });
    this._syncSeriesHead(i);
  }

  _initRow(i) {
    const r = this._config.rows[i];
    this._setupForm(`#f-row-${i}`, [
      { type: 'grid', name: '', schema: [
        { name: 'name', selector: { text: {} } },
        { name: 'icon', selector: { icon: { placeholder: ROW_ICON } }, helper: 'Empty = function symbol' },
      ] },
      { name: 'template', selector: { template: {} } },
      { type: 'grid', name: '', schema: [
        { name: 'unit', selector: { text: {} }, helper: 'Empty = unit of the statistics' },
        { name: 'decimals', selector: { number: { min: 0, max: 4, step: 1, mode: 'box' } } },
      ] },
    ], { name: r.name ?? '', icon: r.icon ?? '', template: r.template ?? '', unit: r.unit ?? '', decimals: r.decimals }, v => {
      const cur = this._config.rows[i];
      if (!cur) return;
      this._patch({ name: v.name, icon: v.icon, template: v.template, unit: v.unit, decimals: v.decimals }, cur);
      this._fire();
      this._syncRowHead(i);
      this._refreshHeadlineOptions();
    });
    this._syncRowHead(i);
  }

  _syncRowHead(i) {
    const r = this._config.rows[i];
    this._el(`#rows-title-${i}`).textContent = r.name || `Row ${i + 1}`;
    const icon = this._el(`#ricon-${i}`);
    if (icon && icon.icon !== (r.icon || ROW_ICON)) icon.icon = r.icon || ROW_ICON;
    this._el(`#rows-meta-${i}`).textContent = String(r.template || 'No template yet').replace(/\s+/g, ' ');
  }

  _syncSeriesHead(i) {
    const s = this._config.series[i];
    const ids = normalizeConfig({ series: this._config.series }).series;
    const n = [].concat(s.statistics ?? []).filter(Boolean).length;
    this._el(`#series-title-${i}`).textContent = s.name || `Series ${i + 1}`;
    this._el(`#series-meta-${i}`).textContent =
      `{{ ${ids[i].id} }} \u00b7 ${n ? `${n} ${n === 1 ? 'statistic' : 'statistics'}` : 'no statistic yet'}`
      + `${s.template ? ` \u00b7 = ${String(s.template).replace(/\s+/g, ' ')}` : ''}${s.below_zero ? ' \u00b7 below zero' : ''}`;
    const pal = this._hass?.themes?.darkMode ? PALETTE_DARK : PALETTE_LIGHT;
    const color = s.color || pal[i % pal.length];
    this._el(`#dot-${i}`).style.background = color;
    const swatch = this._el(`#swatch-${i}`);
    swatch.style.background = s.color || '';
    swatch.classList.toggle('no-color', !s.color);
    const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : null;
    if (hex) this._el(`#picker-${i}`).value = hex;
  }

  _refreshHeadlineOptions() {
    const form = this._el('#f-display');
    if (form) form.schema = this._displaySchema();
  }

  _wire() {
    this._list('series').forEach((s, i) => {
      this._el(`#picker-${i}`).addEventListener('input', e => {
        const cur = this._config.series[i];
        if (!cur) return;
        cur.color = e.target.value;
        const form = this._el(`#f-color-${i}`);
        if (form) form.data = { color: cur.color };
        this._fire();
        this._syncSeriesHead(i);
      });
    });
    this.shadowRoot.querySelectorAll('[data-toggle]').forEach(btn => btn.addEventListener('click', () =>
      this._toggleBox(btn.dataset.toggle, Number(btn.dataset.i))));
    this.shadowRoot.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      const list = this._list(kind);
      const open = this._openState(kind);
      const i = Number(btn.dataset.i);
      const act = btn.dataset.act;
      if (act === 'del') {
        list.splice(i, 1);
        open.splice(i, 1);
      } else {
        const j = act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        [open[i], open[j]] = [open[j], open[i]];
      }
      this._fire();
      this._render();
    }));
    this._el('#add-series').addEventListener('click', () => {
      this._list('series').push({ name: `Series ${this._config.series.length + 1}`, statistics: [] });
      this._openState('series')[this._config.series.length - 1] = true;
      this._fire();
      this._render();
    });
    this._el('#add-row').addEventListener('click', () => {
      const first = normalizeConfig({ series: this._list('series') }).series[0];
      this._list('rows').push({ name: 'Total', template: first ? `{{ ${first.id} }}` : '{{ 0 }}' });
      this._openState('rows')[this._config.rows.length - 1] = true;
      this._fire();
      this._render();
    });
  }
}

customElements.define('ha-comparison-card', HaComparisonCard);
customElements.define('ha-comparison-card-editor', HaComparisonCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'ha-comparison-card',
  name: 'Comparison Card',
  description: 'Compares a date range with the same range of previous years: stacked bars with ghost bars. No dependencies.',
  preview: true,
});

console.info(`%c COMPARISON-CARD %c v${CARD_VERSION} `,
  'color:white;background:#2a78d6;font-weight:700', 'color:#2a78d6;background:white');
