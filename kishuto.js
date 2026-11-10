// ==============================================================================
// 影探聚合（Kishuto）· JS 插件版
//   移植自 影探聚合.py，插件契约对齐 影探4k.js：
//     export default { meta:{key,name,type:3}, api: async (fastify) => { 7 个 POST 路由 } }
//   路由：/init /home /homeVod /category /detail /play /search
//
// 源清单（10 个，均以真实请求验证）
//   第一组 影探   : 影探4K(cms.lyyytv.cn) · 咕噜咕噜(T3) · 橘汁4K(T3) · 找剧AI(zhaoju4.com)
//   第二组 稀饭   : 稀饭动漫(next/api.xifanacg.com) · GiriGiri(m3u8.girigirilove.com)
//                   · 次元城(cycani.org) · OmoFun(omofun.in)
//   第三组 小鸡   : 小鸡看看(xjggg.top，五头签名 + 播放令牌换链)
//   第四组 枫奇   : 枫奇4K(maihaolian.com，至臻4K / 蓝光2K)
//   第五组 橘汁新 : 橘汁新网关(juziapp.hzhcbkj.cn，protobuf + RSA + AES) —— 默认关闭
//
// 目录
//   基础工具 / 缓存 / HTTP / 密码学·protobuf
//   第一组 影探4K → 咕噜+橘汁(T3) → 找剧AI → 4 源聚合门面
//   第二组 稀饭动漫 → GiriGiri → 次元城 → OmoFun → 4 源聚合门面
//   第三组 小鸡看看
//   第四组 枫奇4K
//   第五组 橘汁新网关（可选）
//   多组门面（k1/k2 编解码 + 跨组补线路）→ 插件入口
//
// 配置（/init 的 body，全部可省略；写 false 即关闭该组）
//   {"xj": false}          关闭小鸡
//   {"fq": false}          关闭枫奇
//   {"jn": true}           启用橘汁新（默认关闭：握手被服务端判签失败）
//   {"xifan": {"host": "…", "api": "…"}}   稀饭自定义域名
//   {"cyc_username": "…", "cyc_password": "…"}  次元城账号（不填则线路标「需登录」）
//   {"cyc_token": "…"}     次元城浏览器复制的 Bearer
//
// 已知限制
//   · 枫奇列表页/搜索页有图形验证码，只有详情+播放可用；分类第 1 页回退读首页卡片
//   · 次元城播放需登录：未配置账号时线路名带「(需登录)」，播放返回空
//   · 橘汁新：/api/v5/find/app/zone 返回 100001「请求时间戳过期」，签名未通过，默认关闭
//   · 小山影视 / 四源4K专线 / FoFo影院：上游已下线，未接入
// ==============================================================================
import { constants as cryptoConstants, createCipheriv, createDecipheriv, createECDH, createHash, createHmac, createPublicKey, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync, deflateRawSync, inflateRawSync } from 'node:zlib';

const NL = '\n';
const US = '\x1f';
const KEY = 'kishuto';

// ============================== 基础工具 ==============================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const text = (value) => (value == null ? '' : String(value).trim());
const asList = (value) => (Array.isArray(value) ? value : []);
const asDict = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

function loads(value) {
  try {
    if (!value) return {};
    if (Buffer.isBuffer(value)) value = value.toString('utf8');
    let str = String(value).trim();
    if (!/^[\[{]/.test(str)) {
      const match = str.match(/[\{\[][\s\S]*[\}\]]/);
      if (!match) return {};
      str = match[0];
    }
    return JSON.parse(str);
  } catch { return {}; }
}

function pageOf(value) {
  const match = String(value == null ? '' : value).match(/^\s*[+-]?\d+/);
  const num = match ? Number.parseInt(match[0], 10) : 0;
  return num > 0 ? num : 1;
}

// 线路/标题清洗：去掉 $ # | 以及多余空白，避免破坏分隔符
function cleanName(value) {
  let str = text(value);
  str = str.replace(/\$\$\$/g, ' ').replace(/[$#|]/g, ' ');
  return str.replace(/\s+/g, ' ').trim();
}

function normTitle(value) {
  let str = text(value).toLowerCase();
  str = str.replace(/[\s\-_:：·,，.。!！?？"“”'’()（）\[\]【】]+/g, '');
  str = str.replace(/(第[一二三四五六七八九十\d]+季|season\s*\d+|s\d{1,2})$/, '');
  return str;
}

function lcsLength(a, b) {
  if (!a || !b) return 0;
  const prev = new Array(b.length + 1).fill(0);
  const cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length];
}

function ratio(a, b) {
  if (!a || !b) return 0;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

function sim(a, b) {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.82;
  const sx = new Set(x.split(''));
  const sy = new Set(y.split(''));
  let inter = 0;
  for (const ch of sx) if (sy.has(ch)) inter += 1;
  const union = new Set([...sx, ...sy]).size;
  return union ? inter / union : 0;
}

function bestMatch(title, items, floor = 0.62) {
  let best = null;
  let score = 0;
  for (const item of asList(items)) {
    if (!item || typeof item !== 'object') continue;
    const got = sim(title, item.vod_name || item.name || '');
    if (got > score) { best = item; score = got; }
  }
  return score >= floor ? best : null;
}

const SEASON_RE = /(第[一二三四五六七八九十\d]+季|season\s*\d+|s\d{1,2})/i;
const QUALITY_RE = /(4k|8k|2160p?|1080p?|720p?|uhd|hdr\d*|蓝光|高清|超清|国语|粤语|中字|字幕|完整版|未删减|合集|正片|bd|hd|dvd|web|remux)/i;

// 详情页跨源补线路：只认「同一部片」，禁止片名包含式扩展匹配
function strictMatch(title, items) {
  const core = (value) => {
    let str = normTitle(String(value || ''));
    str = str.replace(/[（(][^）)]*[）)]/g, '');
    str = str.replace(QUALITY_RE, '');
    str = str.replace(/(19|20)\d{2}$/, '');
    str = str.replace(/第[一二三四五六七八九十\d]+[季部篇]$/, '');
    return str.trim();
  };
  const want = core(title);
  if (!want) return null;
  const wantSeason = SEASON_RE.exec(String(title || ''));
  const wantTag = wantSeason ? wantSeason[0].toLowerCase() : '';
  const exact = [];
  const near = [];
  for (const item of asList(items)) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.vod_name || item.name || '');
    const gotSeason = SEASON_RE.exec(name);
    const gotTag = gotSeason ? gotSeason[0].toLowerCase() : '';
    if (wantTag && gotTag && wantTag !== gotTag) continue;
    const got = core(name);
    if (!got) continue;
    if (got === want) exact.push(item);
    else if (Math.abs(got.length - want.length) <= 2 && ratio(got, want) >= 0.97) near.push(item);
  }
  return exact[0] || near[0] || null;
}

function isUrl(value) {
  try {
    const url = new URL(text(value));
    return ['http:', 'https:'].includes(url.protocol);
  } catch { return false; }
}

const STREAM_RE = /\.(?:m3u8|mpd)$/i;
const MEDIA_RE = /\.(?:mp4|m3u8|mpd|flv|avi|mkv|ts|mov|wmv|webm|m4v)$/i;

function pathOf(url) {
  try { return new URL(text(url)).pathname; } catch { return ''; }
}

const isStreamUrl = (url) => isUrl(url) && STREAM_RE.test(pathOf(url));
const isMediaUrl = (url) => isUrl(url) && MEDIA_RE.test(pathOf(url));

const b64urlEncode = (value) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function b64urlDecode(value) {
  let str = text(value).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// ============================== 缓存 ==============================
const CACHE = new Map();
const CACHE_MAX = 600;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return undefined;
  if (hit.exp && hit.exp < Date.now()) { CACHE.delete(key); return undefined; }
  return hit.value;
}

function cachePut(key, value, ttlSeconds) {
  if (CACHE.size >= CACHE_MAX) {
    for (const key2 of CACHE.keys()) { CACHE.delete(key2); if (CACHE.size < CACHE_MAX - 40) break; }
  }
  CACHE.set(key, { value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
}

async function httpCached(key, ttlSeconds, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const got = await fn();
  if (got && (!Array.isArray(got) || got.length)) cachePut(key, got, ttlSeconds);
  return got;
}

// ============================== HTTP ==============================
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-S9080) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// 宿主若有自己的 req 工具（同 影探4k.js），优先复用；否则退回全局 fetch
let REQ_UTIL = null;
async function resolveReqUtil() {
  if (REQ_UTIL !== null) return REQ_UTIL;
  try {
    const mod = await import('../../util/req.js');
    REQ_UTIL = mod?.default || mod || false;
  } catch { REQ_UTIL = false; }
  return REQ_UTIL;
}

async function rawRequest(url, options = {}) {
  const { method = 'GET', headers = {}, body = null, timeout = 9000, retries = 1 } = options;
  let lastError = null;
  for (let attempt = 0; attempt < Math.max(1, retries); attempt += 1) {
    if (attempt) await sleep(120 * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeout) || 9000));
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body == null ? undefined : body,
        signal: controller.signal,
        redirect: 'follow',
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: buf, headers: res.headers };
    } catch (error) {
      lastError = error;
    } finally { clearTimeout(timer); }
  }
  return { status: 0, body: Buffer.alloc(0), headers: null, error: lastError };
}

async function httpText(url, method = 'GET', headers = {}, data = null, timeout = 9000, retries = 1) {
  const res = await rawRequest(url, { method, headers, body: data, timeout, retries });
  return { status: res.status, text: res.body.toString('utf8') };
}

async function httpJson(url, headers = {}, timeout = 9000, retries = 2) {
  const got = await httpText(url, 'GET', headers, null, timeout, retries);
  if (!got.status || got.status >= 400 || !got.text) return {};
  return asDict(loads(got.text));
}

// ============================== 密码学 / protobuf ==============================
function aesCbcDecrypt(key, iv, data, unpad = true) {
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  decipher.setAutoPadding(unpad);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function aesCbcEncrypt(key, iv, data) {
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

const PB_BIG = (value) => (typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0)));

function pbVarint(value) {
  let num = PB_BIG(value);
  if (num < 0n) num = (1n << 64n) + num;
  const bytes = [];
  while (num >= 0x80n) { bytes.push(Number((num & 0x7fn) | 0x80n)); num >>= 7n; }
  bytes.push(Number(num));
  return Buffer.from(bytes);
}

const pbTag = (field, wire) => pbVarint((field << 3) | wire);
const pbVar = (field, value) => Buffer.concat([pbTag(field, 0), pbVarint(value)]);

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ''), 'utf8');
}

const pbBytes = (field, value) => {
  const buf = asBuffer(value);
  return Buffer.concat([pbTag(field, 2), pbVarint(buf.length), buf]);
};

function pbReadVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let index = pos;
  while (index < buf.length) {
    const byte = buf[index];
    index += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, index];
    shift += 7n;
    if (shift > 63n) break;
  }
  throw new Error('pb: bad varint');
}

// 解出 {field: [{wire, value}]}，value 对 wire=2 是 Buffer，wire=0 是 Number
function pbDecode(buf) {
  const out = new Map();
  let pos = 0;
  const push = (field, wire, value) => {
    if (!out.has(field)) out.set(field, []);
    out.get(field).push({ wire, value });
  };
  while (pos < buf.length) {
    const [tag, next] = pbReadVarint(buf, pos);
    pos = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const [value, np] = pbReadVarint(buf, pos);
      pos = np;
      push(field, 0, Number(value));
    } else if (wire === 2) {
      const [len, np] = pbReadVarint(buf, pos);
      pos = np;
      const size = Number(len);
      push(field, 2, buf.subarray(pos, pos + size));
      pos += size;
    } else if (wire === 1) { pos += 8; }
    else if (wire === 5) { pos += 4; }
    else break;
  }
  return out;
}

function pbField(buf, field, wire) {
  if (!buf || !buf.length) return undefined;
  let map;
  try { map = pbDecode(buf); } catch { return undefined; }
  const list = map.get(field);
  if (!list) return undefined;
  const hit = wire == null ? list[0] : list.find((item) => item.wire === wire);
  if (!hit) return undefined;
  if (wire === 2 || hit.wire === 2) return hit.value;
  return hit.value;
}

function pbFields(buf, field, wire) {
  if (!buf || !buf.length) return [];
  let map;
  try { map = pbDecode(buf); } catch { return []; }
  const list = map.get(field) || [];
  return list.filter((item) => wire == null || item.wire === wire).map((item) => item.value);
}

const pbStr = (buf, field, fallback = '') => {
  const got = pbField(buf, field, 2);
  return got ? Buffer.from(got).toString('utf8') : fallback;
};

// ============================================================
// 第一组 / 源 1：影探4K（CMS + fys 解析）
// ============================================================
const YT = {
  NAME: '影探',
  HOST: 'http://cms.lyyytv.cn',
  CMS_KEY: 'wP5bvxoc3yv7FoBQENFZuAF0EUYr4LTy',
  PARSE_API: 'http://fys.lyyytv.cn/api/index?appid=10001&videoUrl=',
  PARSE_ID_WEB: 5,
  PARSE_ID_4K: 6,
  HEADERS: { 'User-Agent': 'okhttp/4.12.0' },
  PARSE_HEADERS: { 'User-Agent': 'okhttp/4.12.0', 'Accept-Encoding': 'identity' },
  DEC_PREFIX: 'https://baidu.con/',
  PAGE_LIMIT: 20,
  HOME_TTL: 6 * 3600,
  PLAY_TTL: 120,
  FILTER_NAMES: { class: '类型', area: '地区', lang: '语言', year: '年份', letter: '字母', by: '排序', sort: '顺序' },
  B64_RE: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  LDMAX_RE: /^https?:\/\/ldmax\.cooom\//i,
  K4_HOST_RE: /(?:^|\.)(?:ym4kjx|hd4kjx|sd4kjx|mm4kjx|mv4kjx|vk4kjx)\.lyyytv\.cn$/i,
};

function ytUnb64(value) {
  const clean = text(value).replace(/\s+/g, '');
  if (!clean || !YT.B64_RE.test(clean)) return null;
  try { return Buffer.from(clean, 'base64'); } catch { return null; }
}

function ytDecryptLvdou(value) {
  const original = text(value);
  if (!original.startsWith('lvdou+') || !YT.CMS_KEY) return original;
  try {
    const encrypted = ytUnb64(original.slice(6));
    if (!encrypted || !encrypted.length) return original;
    const key = Buffer.from(YT.CMS_KEY.slice(0, 16), 'utf8');
    const iv = YT.CMS_KEY.length >= 32 ? Buffer.from(YT.CMS_KEY.slice(16, 32), 'utf8') : key;
    const plain = aesCbcDecrypt(key, iv, encrypted, true).toString('utf8').trim();
    return plain.startsWith('http') ? plain : original;
  } catch { return original; }
}

function ytDecryptLdmax(value, depth = 0) {
  if (depth > 5) return '';
  let url = text(value);
  const decoded = ytUnb64(url);
  if (decoded) url = decoded.toString('utf8').replace(/\s+/g, '');
  if (!YT.LDMAX_RE.test(url)) return url;
  const path = url.replace(YT.LDMAX_RE, '');
  if (path.length <= 16) return '';
  try {
    const key = Buffer.from(path.slice(0, 16).split('').reverse().join(''), 'utf8');
    const encrypted = ytUnb64(path.slice(16));
    if (!encrypted || !encrypted.length || encrypted.length % 16) return '';
    const cipher = createDecipheriv('aes-128-cbc', key, key);
    cipher.setAutoPadding(false);
    let plain = Buffer.concat([cipher.update(encrypted), cipher.final()]);
    const pad = plain.length ? plain[plain.length - 1] : 0;
    if (pad > 0 && pad <= 16) plain = plain.subarray(0, plain.length - pad);
    const result = plain.toString('utf8').trim();
    return YT.LDMAX_RE.test(result) ? ytDecryptLdmax(result, depth + 1) : result;
  } catch { return ''; }
}

// 解析响应：JSON 包裹取 url；baidu.con 前缀走 AES；否则视为明文
function ytResolveParse(body) {
  const source = text(body);
  if (!source) return '';
  let candidate = source;
  if (source.startsWith('{')) {
    const parsed = asDict(loads(source));
    let hit = '';
    for (const key of ['url', 'playUrl', 'link']) {
      if (parsed[key]) { hit = text(parsed[key]); break; }
    }
    if (!hit) {
      for (const key of ['url', 'playUrl', 'link']) {
        if (asDict(parsed.data)[key]) { hit = text(asDict(parsed.data)[key]); break; }
      }
    }
    if (hit) candidate = hit;
  }
  if (!candidate.startsWith(YT.DEC_PREFIX)) return candidate;
  const rest = candidate.slice(YT.DEC_PREFIX.length);
  if (rest.length <= 16) return '';
  const key = Buffer.from(rest.slice(0, 16), 'utf8');
  try {
    const encrypted = Buffer.from(rest.slice(16), 'base64');
    const plain = aesCbcDecrypt(key, key, encrypted, true).toString('utf8').trim();
    if (plain.startsWith('http')) return plain;
  } catch { /* ignore */ }
  return '';
}

function ytIs4kSource(url) {
  if (!isUrl(url)) return false;
  try {
    const host = new URL(text(url)).hostname.toLowerCase();
    if (host && YT.K4_HOST_RE.test(host)) return true;
  } catch { /* ignore */ }
  return isMediaUrl(url) && !isStreamUrl(url);
}

async function ytParseUrl(raw, parseId) {
  if (!raw) return '';
  const target = `${YT.PARSE_API}${encodeURIComponent(raw).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}&parsesId=${parseId}`;
  const got = await httpText(target, 'GET', YT.PARSE_HEADERS, null, 20000, 2);
  if (got.status && got.status < 400 && got.text) {
    const resolved = ytResolveParse(got.text);
    if (resolved && resolved.startsWith('http')) return resolved;
  }
  return '';
}

async function ytCms(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v ?? '')])).toString();
  const url = `${YT.HOST}/api.php/app/${path}?${query}`;
  const cached = cacheGet(`yt:cms:${url}`);
  if (cached) return cached;
  const data = await httpJson(url, YT.HEADERS, 9000, 2);
  if (!data || !Object.keys(data).length) return {};
  if (data.code != null && ![1, 200].includes(Number(data.code))) return {};
  cachePut(`yt:cms:${url}`, data, 60);
  return data;
}

function ytPaginate(data, page) {
  const list = asList(data.list);
  const limit = Number(data.limit) > 0 ? Number(data.limit) : YT.PAGE_LIMIT;
  const pageNow = Number(data.page) > 0 ? Number(data.page) : page;
  const pagecountRaw = Number(data.pagecount) > 0 ? Number(data.pagecount) : 0;
  const pagecount = pagecountRaw || pageNow + (list.length >= limit ? 1 : 0);
  const total = Number.isFinite(Number(data.total)) && data.total != null
    ? Number(data.total)
    : (pageNow - 1) * limit + list.length + (pagecount > pageNow ? 1 : 0);
  return { list, page: pageNow, pagecount, limit, total };
}

async function ytHome() {
  const build = async () => {
    const data = await ytCms('nav', { token: '' });
    const classes = [];
    const filters = {};
    for (const item of asList(data.list)) {
      if (!item || typeof item !== 'object') continue;
      if (item.type_id == null || !text(item.type_name)) continue;
      const id = text(item.type_id);
      classes.push({ type_id: id, type_name: text(item.type_name) });
      const ext = asDict(item.type_extend);
      const groups = [];
      for (const [key, name] of Object.entries(YT.FILTER_NAMES)) {
        const values = [...new Set(text(ext[key]).split(',').map(text).filter(Boolean))];
        if (values.length) {
          groups.push({ key, name, init: '', value: [{ n: '全部', v: '' }, ...values.map((v) => ({ n: v, v }))] });
        }
      }
      if (groups.length) filters[id] = groups;
    }
    return classes.length ? { class: classes, filters } : {};
  };
  const got = await httpCached('yt:nav', YT.HOME_TTL, build);
  return got && got.class ? got : { class: [], filters: {} };
}

async function ytHomeVod() {
  const build = async () => {
    const data = await ytCms('index_video', { token: '' });
    const list = [];
    for (const item of asList(data.list)) if (item && typeof item === 'object') list.push(...asList(item.vlist));
    return list.length ? { list } : {};
  };
  const got = await httpCached('yt:index', 600, build);
  return got && got.list ? got : { list: [] };
}

async function ytCategory(tid, pg, extend) {
  const page = pageOf(pg);
  const id = text(tid);
  if (!id) return { list: [], page, pagecount: 0, limit: YT.PAGE_LIMIT, total: 0 };
  const ext = typeof extend === 'string' ? asDict(loads(extend)) : asDict(extend);
  const params = { tid: id, pg: String(page), limit: '18' };
  for (const key of Object.keys(YT.FILTER_NAMES)) {
    const value = text(ext[key]);
    if (value && value !== 'all') params[key] = value;
  }
  return ytPaginate(await ytCms('video', params), page);
}

async function ytSearch(key, pg) {
  const wd = text(key);
  const page = pageOf(pg);
  if (!wd) return { list: [], page, pagecount: 0, limit: YT.PAGE_LIMIT, total: 0 };
  const data = await ytCms('search', { text: wd, pg: String(page) });
  const list = asList(data.list)
    .filter((item) => item && typeof item === 'object')
    .map(({ type, ...vod }) => vod);
  return ytPaginate({ ...data, list }, page);
}

function ytPlaylist(value) {
  return text(value).split('#').flatMap((entry) => {
    const sep = entry.indexOf('$');
    if (sep <= 0 || !text(entry.slice(sep + 1))) return [];
    return [`${text(entry.slice(0, sep))}$${ytDecryptLvdou(entry.slice(sep + 1))}`];
  }).join('#');
}

async function ytDetail(vid) {
  const id = text(vid);
  if (!id) return {};
  const data = asDict((await ytCms('video_detail', { id })).data);
  if (!Object.keys(data).length) return {};
  const players = data.vod_url_with_player;
  const vod = { ...data };
  delete vod.vod_url_with_player;
  const names = text(vod.vod_play_from).split('$$$');
  const sources = Array.isArray(players)
    ? players
    : text(vod.vod_play_url).split('$$$').map((url, i) => ({ name: names[i] || '', url }));
  const froms = [];
  const urls = [];
  sources.forEach((source, index) => {
    if (!source || typeof source !== 'object') return;
    const url = ytPlaylist(source.url);
    if (!url) return;
    froms.push(cleanName(text(source.name) || text(source.code) || `线路${index + 1}`));
    urls.push(url);
  });
  vod.vod_play_from = froms.join('$$$');
  vod.vod_play_url = urls.join('$$$');
  return vod;
}

async function ytPlay(playId) {
  let original = ytDecryptLvdou(playId);
  if (!original) return { parse: 0, url: '', header: { ...YT.PARSE_HEADERS } };
  if (YT.LDMAX_RE.test(original)) {
    const decrypted = ytDecryptLdmax(original);
    if (decrypted) original = decrypted;
  }
  const cacheKey = `yt:play:${original}`;
  const hit = cacheGet(cacheKey);
  if (hit) return { parse: 0, url: hit, header: { ...YT.PARSE_HEADERS } };
  let resolved = '';
  if (ytIs4kSource(original)) resolved = (await ytParseUrl(original, YT.PARSE_ID_4K)) || original;
  else if (isStreamUrl(original)) resolved = original;
  else {
    resolved = await ytParseUrl(original, YT.PARSE_ID_WEB);
    if (!resolved && isMediaUrl(original)) resolved = original;
  }
  if (resolved) cachePut(cacheKey, resolved, YT.PLAY_TTL);
  return { parse: 0, url: resolved || '', header: { ...YT.PARSE_HEADERS } };
}

// ============================================================
// 第一组 / 源 2、3：咕噜咕噜 + 橘汁4K（T3 私有协议）
//   ECDH(secp256r1) 握手 → HMAC-HKDF("v2-session") → AES-256-GCM + raw-deflate → protobuf
// ============================================================
const T3_HOST_HEADER = '103.45.132.22:19987';
const T3_BASE = `http://${T3_HOST_HEADER}/app/bn/v2`;

const T3_LINE_NAMES = {
  dyttm3u8: '电影天堂', bfzym3u8: '暴风资源', lzm3u8: '量子资源', ffm3u8: '非凡资源',
  qq: '腾讯视频', qiyi: '爱奇艺', youku: '优酷', mgtv: '芒果TV',
  newxfyun: '咕噜4K', xfyun: '咕噜4K二线', CO4K: '咖啡4K超清', jplink: '金牌极速',
  rose: '玫瑰4K', NBY: '蚂蚁资源', qsvip: '旋风VIP', qingshan: '青山资源',
  JD4K: '鲸宝4K', iyf4k: '爱壹帆4K',
};

const T3_PROFILES = {
  gg: {
    label: '咕噜',
    ua: 'Dart/3.10 (dart:io)',
    app_name: '咕噜咕噜', version: '2.2.5', package: 'com.himrsc.viz',
    signature: '32E0AB4FF93A29CE0E6F0BFB01F2F1B788E76262731F3F30F509CB822428ED58',
    build: '20109',
    device_build: 'pangu-build-component-system-513739-s9vkd-rlxnj-p3rhm',
    sort: 'vod_hits_month', boot: 'gg', detail: 'gg',
  },
  jz: {
    label: '橘汁',
    ua: 'Dalvik/2.1.0 (Linux; U; Android 11; Pixel 4)',
    app_name: '咕噜咕噜', version: '2.1.2', package: 'com.jymqfh.xee',
    signature: '', build: '212', device_build: 'unknown',
    sort: 'vod_hits_week', boot: 'jz', detail: 'jz',
  },
};

class T3Client {
  constructor(profile, timeout = 12000) {
    this.p = profile;
    this.timeout = timeout;
    this.sessionId = '';
    this.key = null;
    this.deviceId = randomBytes(8).toString('hex');
    this.requestId = 0;
    this.players = {};
    this.parsers = {};
    this.booted = false;
    this.queue = Promise.resolve();
  }

  async post(body, extra = {}) {
    const headers = {
      'User-Agent': this.p.ua,
      'Content-Type': 'application/x-protobuf',
      'Accept-Encoding': 'gzip',
      ...extra,
    };
    const res = await rawRequest(T3_BASE, { method: 'POST', headers, body, timeout: this.timeout, retries: 1 });
    if (!res.body || !res.body.length) throw new Error(`empty response (status ${res.status})`);
    return res.body;
  }

  async handshake() {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const pub = ecdh.getPublicKey();
    const caps = Buffer.concat([pbVar(1, 1), pbVar(2, 0), pbVar(3, 1)]);
    const request = Buffer.concat([pbBytes(1, pub), pbBytes(2, '1.0.0'), pbBytes(3, caps)]);
    const hk = randomBytes(16).toString('hex');           // 32 字符 = AES-256 key
    const iv = randomBytes(16);
    const payload = Buffer.concat([iv, aesCbcEncrypt(Buffer.from(hk, 'ascii'), iv, deflateSync(request, { level: 4 }))]);
    const content = await this.post(Buffer.from(payload.toString('base64'), 'utf8'), { 'x-handshake-key': hk });
    const raw = Buffer.from(content.toString('utf8').trim(), 'base64');
    if (!raw || raw.length < 17) throw new Error('bad handshake body');
    const plain = inflateSync(aesCbcDecrypt(Buffer.from(hk, 'ascii'), raw.subarray(0, 16), raw.subarray(16), true));
    const sidBuf = pbField(plain, 1, 2);
    const peerBuf = pbField(plain, 2, 2);
    if (!sidBuf || !peerBuf) throw new Error('bad handshake response');
    this.sessionId = sidBuf.toString('utf8');
    const shared = ecdh.computeSecret(Buffer.from(peerBuf));
    const prk = createHmac('sha256', Buffer.from(this.sessionId, 'ascii')).update(shared).digest();
    this.key = createHmac('sha256', prk).update(Buffer.from('v2-session\x01')).digest();
    this.requestId = 0;
  }

  async request(method, payload = Buffer.alloc(0), scope = 3) {
    const run = async () => {
      if (!this.sessionId || !this.key) await this.handshake();
      this.requestId += 1;
      const rid = this.requestId;
      const core = Buffer.concat([
        pbVar(1, rid), pbVar(2, scope), pbVar(3, method),
        pbBytes(4, Buffer.from(this.deviceId, 'ascii')), pbBytes(5, Buffer.alloc(0)),
        pbBytes(6, payload), pbVar(7, Date.now()),
      ]);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      const sealed = Buffer.concat([cipher.update(deflateRawSync(core)), cipher.final()]);
      const tag = cipher.getAuthTag();
      const body = Buffer.concat([pbVar(1, rid), pbBytes(2, Buffer.concat([nonce, sealed, tag]))]);
      const content = await this.post(body, { 'x-session-id': this.sessionId, 'x-player-page-protection': '1' });
      const enc = pbField(content, 2, 2);
      if (!enc || enc.length < 28) throw new Error(pbStr(content, 3) || 'request rejected');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(enc.subarray(0, 12)));
      decipher.setAuthTag(Buffer.from(enc.subarray(enc.length - 16)));
      const decrypted = Buffer.concat([decipher.update(Buffer.from(enc.subarray(12, enc.length - 16))), decipher.final()]);
      const plain = inflateRawSync(decrypted);
      const status = pbStr(plain, 3);
      if (status && !['ok', 'success'].includes(status)) throw new Error(status);
      return plain;
    };
    // 串行化：握手 + request_id 递增不能并发交错
    const task = this.queue.then(run, run);
    this.queue = task.then(() => {}, () => {});
    return task;
  }

  async boot() {
    const p = this.p;
    const nowUs = Date.now() * 1000;
    const aid = this.deviceId;
    let response;
    if (p.boot === 'gg') {
      const app = Buffer.concat([
        pbBytes(1, p.app_name), pbBytes(2, p.version), pbBytes(3, p.package),
        pbBytes(4, p.signature), pbBytes(5, p.build), pbVar(6, nowUs), pbVar(7, nowUs),
      ]);
      const device = Buffer.concat([
        pbBytes(1, aid), pbVar(2, 1), pbBytes(3, '15'), pbBytes(4, 'Redmi K50 Ultra'),
        pbBytes(5, 'Redmi/diting/diting:15/AQ3A.240912.001/OS2.0.215.0.VOACNXM:user/release-keys'),
        pbBytes(6, 'Redmi'), pbBytes(7, 'qcom'), pbVar(8, 0), pbBytes(9, 'unknown'),
        pbBytes(10, p.device_build), pbVar(11, 0), pbVar(12, 35),
      ]);
      const payload = Buffer.concat([
        pbBytes(1, 'v2'), pbBytes(2, 'android'), pbBytes(3, 'gulu'),
        pbBytes(4, app), pbBytes(5, device),
      ]);
      response = await this.request(0, payload, 1);
    } else {
      const info = Buffer.concat([
        pbBytes(1, p.app_name), pbBytes(2, p.version), pbBytes(3, p.package),
        pbBytes(4, aid), pbBytes(5, p.build),
      ]);
      const state = Buffer.concat([
        pbBytes(1, aid), pbVar(2, 0), pbBytes(3, '11'), pbBytes(4, 'Pixel 4'),
        pbBytes(5, 'google/redfin/redfin:11/RQ3A.211001.001'),
        pbBytes(6, 'google'), pbBytes(7, 'redfin'), pbVar(8, 0), pbBytes(9, 'unknown'),
        pbBytes(10, p.device_build), pbVar(11, 0), pbVar(12, 30),
      ]);
      const payload = Buffer.concat([
        pbBytes(1, 'v1'), pbBytes(2, 'Android 11'), pbBytes(3, 'gulu'),
        pbBytes(4, info), pbBytes(5, state),
      ]);
      response = await this.request(0, payload, 1);
    }

    const config = pbField(response, 4, 2);
    const players = {};
    const parsers = {};
    if (config) {
      for (const item of pbFields(config, 4, 2)) {
        const code = pbStr(item, 3);
        if (!code) continue;
        const parserIds = [];
        for (const packed of pbFields(item, 8, 2)) {
          let pos = 0;
          while (pos < packed.length) {
            try {
              const [val, np] = pbReadVarint(packed, pos);
              parserIds.push(Number(val));
              pos = np;
            } catch { break; }
          }
        }
        players[code] = { id: pbField(item, 1, 0) || 0, name: pbStr(item, 4), parser_ids: parserIds };
      }
      for (const item of pbFields(config, 7, 2)) {
        const pid = pbField(item, 1, 0) || 0;
        if (!pid) continue;
        parsers[pid] = {
          name: pbStr(item, 2), url: pbStr(item, 3), mode: pbStr(item, 4),
          result_key: pbStr(item, 10) || 'url',
          server: Boolean(pbField(item, 20, 0) || 0),
        };
      }
    }
    this.players = players;
    this.parsers = parsers;
    this.booted = true;
  }

  async ensure() {
    if (this.booted && this.key) return;
    if (!this.sessionId || !this.key) await this.handshake();
    if (!this.booted) await this.boot();
  }

  reset() {
    this.sessionId = '';
    this.key = null;
    this.requestId = 0;
    this.booted = false;
    this.players = {};
    this.parsers = {};
  }

  async search(keyword, page = 1, limit = 21) {
    const p = this.p;
    let filters;
    if (p.boot === 'gg') filters = Buffer.concat([pbBytes(18, Buffer.from(p.sort, 'utf8')), pbVar(19, 1)]);
    else filters = Buffer.concat([pbVar(1, 1), pbVar(2, 0), pbBytes(3, Buffer.from(p.sort, 'utf8'))]);
    const payload = Buffer.concat([pbBytes(1, keyword), pbVar(2, page), pbVar(3, limit), pbBytes(5, filters)]);
    const response = await this.request(61, payload);
    const data = pbField(response, 4, 2);
    const videos = [];
    if (data) {
      for (const item of pbFields(data, 1, 2)) {
        videos.push({
          vod_id: String(pbField(item, 1, 0) || ''),
          vod_name: pbStr(item, 3),
          vod_pic: pbStr(item, 6),
          vod_remarks: pbStr(item, 11) || pbStr(item, 9),
        });
      }
    }
    const info = data ? pbField(data, 2, 2) : null;
    const pageNo = (info && pbField(info, 1, 0)) || page;
    const pagecount = (info && pbField(info, 3, 0)) || 1;
    const total = (info && pbField(info, 4, 0)) || videos.length;
    return {
      list: videos.filter((v) => v.vod_id && v.vod_name),
      page: pageNo, pagecount, total,
    };
  }

  async detail(vodId) {
    const p = this.p;
    const vid = Number.parseInt(String(vodId).trim(), 10);
    if (!Number.isFinite(vid)) return {};
    let payload;
    if (p.detail === 'gg') {
      payload = Buffer.concat([pbVar(1, vid), pbBytes(3, p.version), pbBytes(4, '1'), pbVar(5, 1)]);
    } else {
      payload = Buffer.concat([pbVar(1, vid), pbBytes(4, 'APP_PLATFORM_ANDROID_TV'), pbVar(5, 0)]);
    }
    const response = await this.request(62, payload);
    const data = pbField(response, 4, 2);
    if (!data) return {};
    const name = pbStr(data, 5);
    if (!name || name.startsWith('最新版本下载地址')) return {};
    const blob = [
      pbStr(data, 5), pbStr(data, 13), pbStr(data, 21),
      ...pbFields(data, 75, 2).map((src) => pbStr(src, 1)),
    ].join(' ').toLowerCase();
    if (blob.includes('glgl.tv') || blob.includes('shu.jpg') || blob.includes('__v99_')) return {};

    const lines = [];
    for (const src of pbFields(data, 75, 2)) {
      const code = pbStr(src, 1);
      if (!code || code.startsWith('__v99_')) continue;
      const cfg = this.players[code] || {};
      const eps = [];
      for (const ep of pbFields(src, 2, 2)) {
        const epId = pbStr(ep, 3);
        if (!epId) continue;
        const idx = pbField(ep, 1, 0) || (eps.length + 1);
        eps.push(`${cleanName(pbStr(ep, 4) || `第${idx}集`)}$${epId}`);
      }
      if (!eps.length) continue;
      const parserIds = (cfg.parser_ids && cfg.parser_ids.length) ? cfg.parser_ids : [0];
      lines.push({
        name: cleanName(cfg.name || T3_LINE_NAMES[code] || code),
        parser_id: parserIds[0] || 0,
        eps,
        code,
      });
    }
    return {
      vod_id: String(pbField(data, 1, 0) || vodId),
      vod_name: name,
      vod_pic: pbStr(data, 13),
      vod_remarks: pbStr(data, 22),
      vod_content: pbStr(data, 21),
      vod_area: pbStr(data, 28),
      vod_year: pbStr(data, 30),
      lines,
    };
  }

  async play(parserId, playId) {
    const payload = Buffer.concat([pbVar(1, Number(parserId) || 0), pbBytes(2, playId)]);
    const response = await this.request(69, payload);
    const data = pbField(response, 4, 2);
    return data ? pbStr(data, 2) : '';
  }
}

function t3Dig(value, preferred = 'url') {
  if (typeof value === 'string') return isUrl(value) ? value : '';
  if (Array.isArray(value)) {
    for (const item of value) { const got = t3Dig(item, preferred); if (got) return got; }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const key of [preferred, 'url', 'play_url', 'playUrl', 'm3u8', 'data']) {
      if (key in value) { const got = t3Dig(value[key], preferred); if (got) return got; }
    }
    for (const item of Object.values(value)) { const got = t3Dig(item, preferred); if (got) return got; }
  }
  return '';
}

class T3Source {
  constructor(tag, timeout = 12000) {
    this.tag = tag;
    this.p = T3_PROFILES[tag];
    this.label = this.p.label;
    this.client = new T3Client(this.p, timeout);
  }

  async call(fn, ...args) {
    try {
      await this.client.ensure();
      return await fn.apply(this.client, args);
    } catch {
      try {
        this.client.reset();
        await this.client.ensure();
        return await fn.apply(this.client, args);
      } catch { return null; }
    }
  }

  async search(keyword, page = 1) {
    const cacheKey = `t3:${this.tag}:q:${text(keyword)}|${page}`;
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return hit;
    const got = await this.call(this.client.search, keyword, page);
    const items = asList((got || {}).list);
    if (items.length) cachePut(cacheKey, items, 600);
    return items;
  }

  async detail(vodId) {
    return (await this.call(this.client.detail, vodId)) || {};
  }

  async play(parserId, playId) {
    const id = text(playId);
    if (isMediaUrl(id) || id.startsWith('m.php') || id.includes('?data=')) return id;
    const url = (await this.call(this.client.play, parserId, id)) || '';
    if (url) return url;
    const parser = this.client.parsers[Number(parserId) || 0] || {};
    const api = text(parser.url);
    if (!api) return '';
    const target = api.includes('{url}')
      ? api.replace('{url}', encodeURIComponent(id))
      : api + encodeURIComponent(id);
    const got = await httpText(target, 'GET', { 'User-Agent': this.p.ua }, null, 15000, 1);
    if (got.status && got.status < 400 && got.text) {
      return t3Dig(loads(got.text), parser.result_key || 'url');
    }
    return '';
  }
}

// ============================================================
// 第一组 / 源 4：找剧AI（zhaoju4.com）—— HMAC 签名的 REST，官方线路需登录态
// ============================================================
const ZJ = {
  NAME: '找剧',
  HOST: 'https://zhaoju4.com',
  SIGN_KEY: '8f18c8e472a9fefbab7108f5c447f69b48a4b5d34f662ed83163167fc10fb3b8',
  UA: UA_WEB,
  CLIENT_NAME: 'movie-search-frontend',
  CLIENT_VERSION: '1.0.0',
  BUILD_VERSION: '20261021T204524Z-98df10a3f414-98df10a3f414-98df10a3f414',
  PROTOCOL_VERSION: '2026-07-05.library-v2.playback-v1',
  PAGE_SIZE: 18,
  MAX_LINES: 4,
  MAX_PREMIUM: 4,
  MAX_EPISODES: 120,
  TIMEOUT: 12000,
  CACHE_TTL: 300,
  PREMIUM: ['bytedance', 'bytevod-lv2', 'bytevod-lv3', 'bytevod-lv5', 'bytevod-cloudflare', 'bytevod-cloudflare-4k', 'official-v', 'official-r', 'dong'],
  EXT_HOSTS: ['v.qq.com', 'qq.com', 'youku.com', 'iqiyi.com', 'bilibili.com', 'mgtv.com', 'sohu.com', 'pptv.com', 'le.com', 'wasu.cn', 'tudou.com', '1905.com'],
};

class ZJSource {
  constructor(cookie = '', timeout = 0) {
    this.cookie = text(cookie);
    this.timeout = timeout || ZJ.TIMEOUT;
    this.anonId = `anon_${randomBytes(16).toString('hex')}`;
    this.sessionEnsure = null;
    this.sessionOk = false;
    this.sessionCheckedAt = 0;
  }

  mergeCookie(setCookies) {
    const jar = {};
    for (const part of String(this.cookie || '').split(';')) {
      if (part.includes('=')) { const [k, ...rest] = part.split('='); jar[k.trim()] = rest.join('=').trim(); }
    }
    for (const raw of setCookies || []) {
      const first = String(raw).split(';')[0];
      if (first.includes('=')) {
        const [k, ...rest] = first.split('=');
        const value = rest.join('=').trim();
        if (value) jar[k.trim()] = value;
      }
    }
    this.cookie = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  sign(method, pathQuery) {
    const [pathPart, queryPart] = pathQuery.split('?');
    const search = queryPart ? `?${queryPart}` : '';
    const ts = String(Date.now());
    const nonce = randomBytes(16).toString('hex');
    const message = `${method}\n${pathPart || '/'}${search}\n${ts}\n${nonce}`;
    const signature = createHmac('sha256', Buffer.from(ZJ.SIGN_KEY, 'utf8')).update(message).digest('hex');
    return { ts, nonce, signature };
  }

  headers(method, pathQuery, withCookie = true) {
    const base = {
      'User-Agent': ZJ.UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `${ZJ.HOST}/`,
      'x-platform': 'web',
      'x-requested-with': 'XMLHttpRequest',
      'x-ai-movie-client-name': ZJ.CLIENT_NAME,
      'x-ai-movie-client-version': ZJ.CLIENT_VERSION,
      'x-ai-movie-build-version': ZJ.BUILD_VERSION,
      'x-ai-movie-protocol-version': ZJ.PROTOCOL_VERSION,
    };
    if (withCookie && this.cookie) base.Cookie = this.cookie;
    if (pathQuery.startsWith('/v1/')) {
      const { ts, nonce, signature } = this.sign(method, pathQuery);
      base['x-ai-movie-timestamp'] = ts;
      base['x-ai-movie-nonce'] = nonce;
      base['x-ai-movie-signature'] = signature;
    }
    return base;
  }

  // 503/空响应自动重试——站点约 30% 概率返回 503
  async req(path, params = null, method = 'GET', body = null, withCookie = true, attempts = 3) {
    let url = path;
    if (params) {
      const clean = Object.entries(params).filter(([, v]) => v != null && v !== '');
      if (clean.length) {
        url += (url.includes('?') ? '&' : '?') + new URLSearchParams(clean.map(([k, v]) => [k, String(v)])).toString();
      }
    }
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = this.headers(method, url, withCookie);
    if (data) headers['Content-Type'] = 'application/json; charset=utf-8';
    let parsed = {};
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      if (attempt) await sleep(120 * attempt);
      const got = await httpText(ZJ.HOST + url, method, headers, data, this.timeout, 1);
      if (got.status >= 200 && got.status < 300 && got.text) {
        parsed = loads(got.text);
        if (parsed && Object.keys(parsed).length) return { status: got.status, data: parsed };
        continue;
      }
      if (got.status === 401 || got.status === 403) return { status: got.status, data: {} };
    }
    return { status: 0, data: parsed };
  }

  ensureSession() {
    if (this.sessionEnsure) return this.sessionEnsure;
    this.sessionEnsure = (async () => {
      const now = Date.now();
      if (this.sessionCheckedAt && now - this.sessionCheckedAt < 600000) return this.sessionOk;
      let ok = true;
      const me = await this.req('/v1/users/me', null, 'GET', null, true, 1);
      if (me.status === 401 || me.status === 403) ok = false;
      if (!ok) {
        const anon = await this.req('/v1/users/anonymous', null, 'POST', { anonymous_id: this.anonId }, false, 1);
        if (anon.status >= 200 && anon.status < 300) ok = true;
      }
      this.sessionOk = ok;
      this.sessionCheckedAt = Date.now();
      return ok;
    })().catch(() => false).finally(() => { this.sessionEnsure = null; });
    return this.sessionEnsure;
  }

  static pick(obj, keys, fallback = '') {
    if (!obj || typeof obj !== 'object') return fallback;
    for (const key of keys) {
      const got = obj[key];
      if (got !== undefined && got !== null && got !== '' && !(Array.isArray(got) && !got.length)
        && !(typeof got === 'object' && !Array.isArray(got) && !Object.keys(got).length)) return got;
    }
    return fallback;
  }

  static join(value) {
    if (Array.isArray(value)) return value.map((x) => text(x)).filter(Boolean).join(',');
    return text(value);
  }

  card(item) {
    if (!item || typeof item !== 'object') return null;
    const vid = text(ZJSource.pick(item, ['id', 'variant_id', 'selected_variant_id']));
    if (!vid) return null;
    const avail = asDict(item.availability);
    const remarks = text(ZJSource.pick(item, ['remarks', 'episode_progress_text'])) || text(avail.label);
    return {
      vod_id: vid,
      vod_name: text(ZJSource.pick(item, ['title', 'name', 'normalized_title'])),
      vod_pic: text(ZJSource.pick(item, ['poster_url', 'poster', 'pic', 'cover'])),
      vod_remarks: remarks,
      vod_year: text(ZJSource.pick(item, ['year'])),
      vod_area: text(ZJSource.pick(item, ['area'])),
      vod_actor: ZJSource.join(ZJSource.pick(item, ['actors', 'actor'], [])),
      vod_director: ZJSource.join(ZJSource.pick(item, ['directors'], [])),
      vod_content: text(ZJSource.pick(item, ['description', 'intro'])),
      vod_score: text(ZJSource.pick(item, ['rating', 'score'])),
    };
  }

  cards(items) {
    const out = [];
    for (const item of asList(items)) {
      const card = this.card(item);
      if (card) out.push(card);
    }
    return out;
  }

  static validUrl(url) {
    const str = text(url);
    if (!str.startsWith('http')) return false;
    const path = pathOf(str).toLowerCase();
    if (/\.(jpg|jpeg|png|webp|gif|svg)$/.test(path)) return false;
    if (path.includes('~tplv-') && path.includes('image')) return false;
    return true;
  }

  isExt(url) {
    try {
      const host = new URL(text(url)).hostname.toLowerCase();
      return ZJ.EXT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    } catch { return false; }
  }

  async search(keyword, page = 1) {
    const wd = text(keyword);
    if (!wd) return [];
    const pg = Math.max(1, Number(page) || 1);
    const cacheKey = `zj:q:${wd}|${pg}`;
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return hit;
    const { data } = await this.req('/v1/browse/catalog', {
      q: wd, page: pg, limit: ZJ.PAGE_SIZE, offset: (pg - 1) * ZJ.PAGE_SIZE,
    });
    const cards = asList(asDict(data).cards);
    const out = cards.filter((it) => {
      const avail = asDict(it.availability);
      return avail.playable !== false && avail.disabled !== true;
    });
    const cardsOut = this.cards(out);
    if (cardsOut.length || pg > 1) {
      if (cardsOut.length) cachePut(cacheKey, cardsOut, 600);
      return cardsOut;
    }
    // 直搜无结果 → 联想词兜底
    const sug = await this.req('/v1/suggest', { q: wd, limit: 10, mode: 'home' });
    const result = [];
    for (const item of asList(asDict(sug.data).suggestions)) {
      const target = asDict(item.target);
      const vid = text(target.variant_id);
      if (!vid) continue;
      result.push({
        vod_id: vid,
        vod_name: text(item.label || target.title),
        vod_pic: '',
        vod_remarks: text(item.subtitle),
      });
    }
    return result;
  }

  async episodes(vid) {
    const out = [];
    const seen = new Set();
    let offset = 0;
    while (out.length < ZJ.MAX_EPISODES) {
      const { data } = await this.req(`/v1/catalog/${encodeURIComponent(String(vid))}/episodes`, { limit: 48, offset });
      const eps = asList(asDict(data).episodes);
      if (!eps.length) break;
      let added = 0;
      for (const ep of eps) {
        if (!ep || typeof ep !== 'object') continue;
        const token = text(ep.token);
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push({
          token,
          title: text(ep.title),
          number: Number.isInteger(ep.number) ? ep.number : null,
          track: text(ep.episode_track),
          rawNumber: ep.number,
        });
        added += 1;
      }
      const pagination = asDict(data.episode_pagination);
      if (!pagination.has_more || !added) break;
      offset += eps.length;
    }
    const main = out.filter((e) => e.track === 'main')
      .sort((a, b) => (Number.isInteger(a.rawNumber) ? a.rawNumber : 1 << 30) - (Number.isInteger(b.rawNumber) ? b.rawNumber : 1 << 30));
    const rest = out.filter((e) => e.track !== 'main');
    return [...main, ...rest];
  }

  async resolve(token) {
    const tok = text(token);
    if (!tok) return {};
    const cacheKey = `zj:rv:${tok}`;
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return hit;
    const { data } = await this.req(`/v1/playback/resolve/${encodeURIComponent(tok)}`, { view: 'compact' });
    if (data && typeof data === 'object' && asList(data.line_options).length) cachePut(cacheKey, data, ZJ.CACHE_TTL);
    return data && typeof data === 'object' ? data : {};
  }

  async resolveLine(ticket) {
    let ticketId = text(ticket);
    if (ticketId.startsWith('resolve://')) ticketId = ticketId.slice('resolve://'.length);
    if (!ticketId) return {};
    const cacheKey = `zj:tk:${ticketId}`;
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return hit;
    const { status, data } = await this.req('/v1/playback/resolve-line?view=compact', null, 'POST', { ticket: ticketId });
    let line = asDict(asDict(data).line);
    if (!Object.keys(line).length && (status === 401 || status === 403)) line = { _error: 'need_login' };
    if (Object.keys(line).length) cachePut(cacheKey, line, ZJ.CACHE_TTL);
    return line;
  }

  static optDirect(option) {
    return ZJSource.validUrl(option.url) && !option.resolve_required && text(option.url_kind) !== 'resolve_ticket';
  }

  static optTicket(option) {
    return Boolean(option.resolve_required) || text(option.url).startsWith('resolve://');
  }

  static weight(option) {
    const got = Number(option.preference_weight || 0);
    return Number.isFinite(got) ? got : 0;
  }

  static lineKey(option) { return [text(option.provider_id), text(option.play_from)]; }

  static lineLabel(option) {
    let str = text(option.label || option.provider_id || option.play_from || '线路');
    for (const ch of ['$', '#', '|']) str = str.split(ch).join(' ');
    return str.replace(/\s+/g, ' ').trim() || '线路';
  }

  isPremium(option) {
    const label = text(option.label).toUpperCase();
    const pid = text(option.provider_id);
    const ticketed = Boolean(option.resolve_required) || text(option.url).startsWith('resolve://');
    return ticketed && (ZJ.PREMIUM.includes(pid) || label.includes('4K') || label.includes('1080P') || text(option.label).includes('官方'));
  }

  // 实测直链首段速度（KB/s），0 = 不可用
  async speed(url) {
    const key = text(url);
    if (!key) return 0;
    const hit = this.probe && this.probe[key];
    const now = Date.now();
    if (hit && now - hit.at < hit.ttl * 1000) return hit.kbps;
    this.probe = this.probe || {};
    let current = key;
    let kbps = 0;
    for (let round = 0; round < 3; round += 1) {
      const started = Date.now();
      const res = await rawRequest(current, {
        headers: { 'User-Agent': ZJ.UA, Referer: `${ZJ.HOST}/`, Accept: '*/*', Range: 'bytes=0-32767' },
        timeout: 1600, retries: 1,
      });
      const dt = Math.max(0.05, (Date.now() - started) / 1000);
      if (!res.body || !res.body.length) break;
      if (res.body.subarray(0, 256).includes('#EXTM3U')) {
        const lines = res.body.toString('utf8').split(/\r?\n/);
        let next = '';
        for (const line of lines) {
          const str = line.trim();
          if (str && !str.startsWith('#')) { next = str; break; }
        }
        if (!next) break;
        try { current = new URL(next, current).toString(); } catch { break; }
        continue;
      }
      if (res.body.length > 4096) kbps = Math.round(res.body.length / dt / 1024);
      break;
    }
    this.probe[key] = { at: now, kbps, ttl: kbps > 0 ? 600 : 120 };
    return kbps;
  }

  async lines(options) {
    const opts = asList(options).filter((o) => o && typeof o === 'object');
    const lines = [];
    const seen = new Set();
    const used = {};
    const add = (label, prov, frm, mode) => {
      let name = cleanName(label) || '线路';
      const key = `${name}|${prov}|${frm}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (used[name]) { used[name] += 1; name = `${name}${used[name]}`; } else { used[name] = 1; }
      lines.push({ label: name, provider_id: prov, play_from: frm, mode });
    };

    const premium = opts.filter((o) => this.isPremium(o));
    if (premium.length && await this.ensureSession()) {
      premium.sort((a, b) => (ZJSource.weight(b) - ZJSource.weight(a))
        || (text(b.label).toUpperCase().includes('4K') ? 1 : 0) - (text(a.label).toUpperCase().includes('4K') ? 1 : 0));
      for (const option of premium.slice(0, ZJ.MAX_PREMIUM)) {
        const [prov, frm] = ZJSource.lineKey(option);
        add(ZJSource.lineLabel(option), prov, frm, 'parse');
      }
    }

    const directs = opts.filter((o) => ZJSource.optDirect(o));
    if (directs.length) {
      const groups = new Map();
      for (const option of directs) {
        const url = text(option.url);
        if (!url) continue;
        const current = groups.get(url);
        if (!current || ZJSource.weight(option) > ZJSource.weight(current)) groups.set(url, option);
      }
      const cand = [...groups.values()].sort((a, b) => ZJSource.weight(b) - ZJSource.weight(a)).slice(0, 6);
      const speeds = new Map();
      await Promise.all(cand.map(async (option) => {
        speeds.set(text(option.url), await this.speed(text(option.url)));
      }));
      const alive = cand.map((option) => ({ kbps: speeds.get(text(option.url)) || 0, option }))
        .sort((a, b) => b.kbps - a.kbps);
      const picked = [...alive.filter((x) => x.kbps > 0), ...alive.filter((x) => x.kbps <= 0)]
        .slice(0, ZJ.MAX_LINES).map((x) => x.option);
      for (const option of picked) {
        const [prov, frm] = ZJSource.lineKey(option);
        add(ZJSource.lineLabel(option), prov, frm, 'direct');
      }
    } else {
      const tickets = opts.filter((o) => ZJSource.optTicket(o)).sort((a, b) => ZJSource.weight(b) - ZJSource.weight(a));
      for (const option of tickets.slice(0, ZJ.MAX_LINES)) {
        const [prov, frm] = ZJSource.lineKey(option);
        add(ZJSource.lineLabel(option), prov, frm, 'parse');
      }
    }

    add('解析线路', '', '', 'generic');
    return lines;
  }

  async detail(vid) {
    const id = text(vid);
    if (!id) return {};
    const { data } = await this.req(`/v1/catalog/${encodeURIComponent(id)}/detail`);
    const meta = data && typeof data === 'object' ? data : {};
    const epVid = text(ZJSource.pick(meta, ['selected_variant_id', 'variant_id', 'id'])) || id;
    const eps = await this.episodes(epVid);
    const vod = {
      vod_id: id,
      vod_name: text(ZJSource.pick(meta, ['title', 'normalized_title'])) || id,
      vod_pic: text(ZJSource.pick(meta, ['poster_url', 'poster'])),
      vod_year: text(ZJSource.pick(meta, ['year'])),
      vod_area: text(ZJSource.pick(meta, ['area'])),
      vod_remarks: text(ZJSource.pick(meta, ['episode_progress_text', 'remarks'])),
      vod_actor: ZJSource.join(ZJSource.pick(meta, ['actors'], [])),
      vod_director: ZJSource.join(ZJSource.pick(meta, ['directors'], [])),
      vod_content: text(ZJSource.pick(meta, ['description', 'intro'])),
      vod_score: text(ZJSource.pick(meta, ['rating', 'score'])),
    };
    if (!eps.length) return { vod, lines: [] };

    let options = [];
    for (const ep of eps.slice(0, 2)) {
      const resolved = await this.resolve(ep.token);
      const cand = asList(resolved.line_options);
      if (cand.length) { options = cand; break; }
    }
    if (!options.length) return { vod, lines: [] };
    const lines = await this.lines(options);

    const genKey = (lines.find((ln) => ln.mode === 'direct') || {}).provider_id !== undefined
      ? (() => { const ln = lines.find((l) => l.mode === 'direct'); return ln ? [ln.provider_id, ln.play_from] : null; })()
      : null;

    const out = [];
    for (const ln of lines) {
      const epsOut = [];
      eps.forEach((ep, idx) => {
        let ref;
        if (ln.mode === 'generic') {
          ref = genKey
            ? `zjoff|${ep.token}|${b64urlEncode(genKey[0])}|${b64urlEncode(genKey[1])}`
            : `zjoff|${ep.token}`;
        } else {
          ref = `zjres|${ep.token}|${b64urlEncode(ln.provider_id)}|${b64urlEncode(ln.play_from)}|${b64urlEncode(ln.label)}`;
        }
        const name = cleanName(ep.title) || `第${idx + 1}集`;
        epsOut.push(`${name}$${ref}`);
      });
      if (epsOut.length) out.push({ label: ln.label, eps: epsOut });
    }
    return { vod, lines: out };
  }

  async playLine(token, prov, frm, label, generic = false) {
    const key = `zj:ln:${token}|${prov}|${frm}|${label}`;
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
    const resolved = await this.resolve(token);
    const opts = asList(resolved.line_options).filter((o) => o && typeof o === 'object');
    if (!opts.length) return '';
    const directs = opts.filter((o) => ZJSource.optDirect(o));
    const tickets = opts.filter((o) => ZJSource.optTicket(o));

    const pickDirect = (items) => {
      for (const option of items) {
        const url = text(option.url);
        if (ZJSource.validUrl(url)) return url;
      }
      return '';
    };
    const pickTicket = async (items) => {
      for (const option of items) {
        const line = await this.resolveLine(option.url);
        const url = text(line.url);
        if (ZJSource.validUrl(url)) return url;
      }
      return '';
    };

    let url = '';
    if (label) url = pickDirect(directs.filter((o) => ZJSource.lineLabel(o) === label));
    if (!url && (prov || frm)) {
      url = pickDirect(directs.filter((o) => {
        const [p2, f2] = ZJSource.lineKey(o);
        return p2 === prov && f2 === frm;
      }));
    }
    if (!url && label) url = await pickTicket(tickets.filter((o) => ZJSource.lineLabel(o) === label));
    if (!url && (prov || frm)) {
      url = await pickTicket(tickets.filter((o) => {
        const [p2, f2] = ZJSource.lineKey(o);
        return p2 === prov && f2 === frm;
      }));
    }
    if (!url && (generic || !prov)) url = (await pickTicket(tickets.slice(0, 5))) || pickDirect(directs.slice(0, 2));
    if (url) cachePut(key, url, ZJ.CACHE_TTL);
    return url;
  }

  async play(ref) {
    let raw = text(ref);
    if (/%7C/i.test(raw) || /%3A/i.test(raw)) { try { raw = decodeURIComponent(raw); } catch { /* ignore */ } }
    const parts = raw.split('|');
    const kind = parts[0] || '';
    const token = parts[1] || '';
    const prov = parts[2] ? b64urlDecode(parts[2]).toString('utf8') : '';
    const frm = parts[3] ? b64urlDecode(parts[3]).toString('utf8') : '';
    const label = parts[4] ? b64urlDecode(parts[4]).toString('utf8') : '';
    if (!token) return { url: '', parse: 0 };
    let url = await this.playLine(token, prov, frm, label, kind === 'zjoff');
    if (!url) { await sleep(150); url = await this.playLine(token, prov, frm, label, kind === 'zjoff'); }
    if (!url) return { url: '', parse: 0 };
    const ext = this.isExt(url);
    return { url, parse: ext ? 1 : 0, header: { 'User-Agent': ZJ.UA, Referer: `${ZJ.HOST}/` } };
  }
}

// ============================================================
// 第一组 / 聚合门面：影探 4 源
//   首页/分类/筛选/搜索：影探4K
//   详情线路：影探 → 咕噜 → 橘汁 → 找剧
// ============================================================
const YT_AGG = {
  LABELS: { yt: '影探', gg: '咕噜', jz: '橘汁', zj: '找剧' },
  ORDER: ['yt', 'gg', 'jz', 'zj'],
  DETAIL_BUDGET: 6000,
  SEARCH_BUDGET: 1400,
  CACHE_TTL: 300,
  MAX_LINES_PER_SRC: 8,
  NAME_NOISE: ['手语版', '字幕助听版', '字幕版', '助听版', '无字幕', '国语版', '粤语版', '日语版', '英语版', '普通话版', '双语版', '真人版', '动画版', '重制版', '剧版', '电影版', '电视版', '完整版', '未删减', '无删减', '高清版', '蓝光版', '合集', '正片', '解说', '精彩分享', '剧情揭秘', '揭秘', '预告', '花絮', '片段'],
};

function ytAggBaseName(name) {
  let str = normTitle(name);
  if (!str) return '';
  str = str.replace(/[（(][^）)]*[）)]/g, '');
  for (let round = 0; round < 3; round += 1) {
    for (const word of YT_AGG.NAME_NOISE) {
      if (str.endsWith(word) && str.length > word.length) str = str.slice(0, -word.length);
      else if (str.startsWith(word) && str.length > word.length) str = str.slice(word.length);
    }
  }
  str = str.replace(/(19|20)\d{2}$/, '');
  str = str.replace(/之$/, '');
  return str.trim() || normTitle(name);
}

class YtAggregator {
  constructor() {
    this.sources = {};
    this.order = [...YT_AGG.ORDER];
    this.maxLines = YT_AGG.MAX_LINES_PER_SRC;
    this.detailBudget = YT_AGG.DETAIL_BUDGET;
    this.zjCookie = '';
  }

  src(tag) {
    if (this.sources[tag]) return this.sources[tag];
    let got = null;
    if (tag === 'yt') got = { kind: 'yt' };
    else if (tag === 'gg' || tag === 'jz') got = new T3Source(tag);
    else if (tag === 'zj') got = new ZJSource(this.zjCookie);
    if (got) this.sources[tag] = got;
    return got;
  }

  configure(config = {}) {
    const cfg = asDict(typeof config === 'string' ? loads(config) : config);
    const lines = asList(cfg.lines).filter((tag) => YT_AGG.LABELS[tag]);
    if (lines.length) {
      this.order = [...new Set(lines.concat(YT_AGG.ORDER.filter((tag) => !lines.includes(tag))))];
    }
    const budget = Number(cfg.detail_budget);
    if (Number.isFinite(budget) && budget > 0) this.detailBudget = budget * 1000;
    const maxLines = Number.parseInt(cfg.max_lines, 10);
    if (Number.isFinite(maxLines) && maxLines > 0) this.maxLines = maxLines;
    const cookie = text(cfg.zj_cookie || cfg.cookie);
    if (cookie && cookie !== this.zjCookie) {
      this.zjCookie = cookie;
      delete this.sources.zj;
    }
  }

  // 首页阶段偷偷把咕噜/橘汁的握手+boot、找剧的游客会话做完，
  // 搜索/详情就不用再付这笔开销（失败无所谓，用到时会自己重试）
  prewarm() {
    if (this.warmed) return;
    this.warmed = true;
    for (const tag of ['gg', 'jz']) {
      if (!this.order.includes(tag)) continue;
      const src = this.src(tag);
      if (src && src.client) src.client.ensure().catch(() => {});
    }
    if (this.order.includes('zj')) {
      const src = this.src('zj');
      if (src && src.ensureSession) src.ensureSession().catch(() => {});
    }
  }

  async itemsOf(tag, keyword, page = 1) {
    const src = this.src(tag);
    if (!src) return [];
    if (tag === 'yt') {
      const got = await ytSearch(keyword, page);
      return asList(got.list);
    }
    const got = await src.search(keyword, page);
    if (Array.isArray(got)) return got;
    return asList(asDict(got).list);
  }

  // 取基准源详情 → {title, vod, lines:[{tag,name,eps:[[name,raw]]}]}
  async base(tag, vid) {
    const src = this.src(tag);
    if (!src) return null;
    if (tag === 'yt') {
      const vod = await ytDetail(vid);
      if (!vod || !Object.keys(vod).length) return null;
      const lines = [];
      const froms = text(vod.vod_play_from).split('$$$');
      const urls = text(vod.vod_play_url).split('$$$');
      froms.forEach((name, i) => {
        const eps = splitEps(urls[i]);
        if (eps.length) lines.push({ tag, name, eps });
      });
      return { title: text(vod.vod_name), vod: { ...vod, vod_id: text(vid) }, lines };
    }
    if (tag === 'gg' || tag === 'jz') {
      const data = await src.detail(vid);
      if (!data || !Object.keys(data).length) return null;
      const lines = [];
      for (const ln of asList(data.lines)) {
        const eps = [];
        for (const seg of asList(ln.eps)) {
          const sep = seg.indexOf('$');
          if (sep > 0 && seg.slice(sep + 1)) eps.push([seg.slice(0, sep), `${ln.parser_id || 0}${US}${seg.slice(sep + 1)}`]);
        }
        if (eps.length) lines.push({ tag, name: ln.name, eps });
      }
      const vod = {
        vod_id: vid,
        vod_name: data.vod_name,
        vod_pic: data.vod_pic,
        vod_year: data.vod_year,
        vod_area: data.vod_area,
        vod_remarks: data.vod_remarks,
        vod_content: data.vod_content,
      };
      return { title: text(data.vod_name), vod, lines };
    }
    if (tag === 'zj') {
      const data = await src.detail(vid);
      if (!data || !Object.keys(data).length) return null;
      const lines = asList(data.lines)
        .map((ln) => ({ tag, name: ln.label, eps: splitEps(ln.eps) }))
        .filter((ln) => ln.eps.length);
      return { title: text(asDict(data.vod).vod_name), vod: asDict(data.vod), lines };
    }
    return null;
  }

  async collect(tag, title) {
    try {
      const items = await this.itemsOf(tag, title);
      const match = strictMatch(title, items);
      if (!match) return [];
      const got = await this.base(tag, text(match.vod_id));
      return got ? got.lines.slice(0, this.maxLines) : [];
    } catch { return []; }
  }

  async home() {
    this.prewarm();
    let data;
    try { data = await ytHome(); } catch { data = { class: [], filters: {} }; }
    if (!youtubeList(data)) {
      try { data = { ...data, list: (await ytHomeVod()).list.slice(0, 30) }; } catch { /* ignore */ }
    }
    return data;
  }

  async homeVod() {
    try { return await ytHomeVod(); } catch { return { list: [] }; }
  }

  async category(tid, pg, extend) {
    try { return await ytCategory(tid, pg, extend); }
    catch { return { list: [], page: 1, pagecount: 0, limit: 18, total: 0 }; }
  }

  async search(keyword, pg) {
    const kw = text(keyword);
    if (!kw) return { list: [] };
    const page = pageOf(pg);
    let out = [];
    try { out = asList((await ytSearch(kw, page)).list); } catch { out = []; }
    if (out.length >= 5 || page > 1) return { list: out };

    const found = {};
    const tags = ['gg', 'jz', 'zj'].filter((tag) => this.order.includes(tag));
    const jobs = tags.map(async (tag) => {
      try { found[tag] = await this.itemsOf(tag, kw, page); } catch { found[tag] = []; }
    });
    await Promise.race([Promise.all(jobs), sleep(YT_AGG.SEARCH_BUDGET)]);
    const seen = new Set(out.map((item) => normTitle(item.vod_name)));
    for (const tag of tags) {
      for (const card of asList(found[tag])) {
        const name = text(card.vod_name);
        if (!name || seen.has(normTitle(name))) continue;
        seen.add(normTitle(name));
        out.push({ ...card, vod_id: `${tag}:${text(card.vod_id)}` });
      }
    }
    return { list: out };
  }

  splitId(vid) {
    const raw = text(vid);
    const sep = raw.indexOf(':');
    if (sep > 0 && YT_AGG.LABELS[raw.slice(0, sep)] && raw.slice(sep + 1)) {
      return [raw.slice(0, sep), raw.slice(sep + 1)];
    }
    return ['yt', raw];
  }

  encode(tag, name, raw) {
    const payload = `${cleanName(name)}${US}${raw}`;
    const blob = b64urlEncode(payload);
    return blob ? `${tag}|${blob}` : '';
  }

  decode(pid, flag = '') {
    const raw = text(pid);
    const sep = raw.indexOf('|');
    if (sep > 0 && YT_AGG.LABELS[raw.slice(0, sep)] && raw.slice(sep + 1)) {
      const tag = raw.slice(0, sep);
      const plain = b64urlDecode(raw.slice(sep + 1)).toString('utf8');
      const cut = plain.indexOf(US);
      if (cut >= 0) return [tag, plain.slice(cut + 1), plain.slice(0, cut) || text(flag)];
    }
    return ['yt', raw, text(flag)];
  }

  render(tag, vod, baseLines, extra) {
    const lines = [...baseLines];
    for (const other of this.order.filter((t) => t !== tag)) lines.push(...asList(extra[other]));
    const froms = [];
    const urls = [];
    const used = {};
    for (const line of lines) {
      let label = cleanName(`${YT_AGG.LABELS[line.tag] || line.tag}·${cleanName(line.name) || '线路'}`);
      if (used[label]) { used[label] += 1; label = `${label}·${used[label]}`; } else { used[label] = 1; }
      const segs = [];
      for (const [epName, raw] of line.eps) {
        const code = this.encode(line.tag, line.name, raw);
        if (code) segs.push(`${cleanName(epName) || '正片'}$${code}`);
      }
      if (segs.length) { froms.push(label); urls.push(segs.join('#')); }
    }
    const result = { ...vod, vod_play_from: froms.join('$$$'), vod_play_url: urls.join('$$$') };
    if (!froms.length) {
      result.vod_content = `${text(vod.vod_content)}${NL}${NL}[聚合提示] 四个源都没有匹配到可用线路，可稍后重试或换个片名搜索。`.trim();
    }
    return { list: [result] };
  }

  async detail(vid) {
    const id = text(vid);
    if (!id) return { list: [] };
    const cacheKey = `merged:${id}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;

    const [tag, real] = this.splitId(id);
    const baseGot = await this.base(tag, real);
    if (!baseGot) return { list: [] };

    const others = this.order.filter((t) => t !== tag);
    const found = {};
    const jobs = others.map(async (other) => {
      try { found[other] = await this.collect(other, baseGot.title); } catch { found[other] = []; }
    });
    await Promise.race([Promise.all(jobs), sleep(this.detailBudget)]);
    for (const other of others) if (found[other] && found[other].length) cachePut(`pre:${other}:${id}`, found[other], 1800);

    const result = this.render(tag, { ...baseGot.vod }, baseGot.lines, found);
    cachePut(cacheKey, result, YT_AGG.CACHE_TTL);
    return result;
  }

  async play(pid, flag = '') {
    const [tag, real, name] = this.decode(pid, flag);
    if (!real) return { parse: 0, url: '', header: { 'User-Agent': UA_WEB } };
    try {
      if (tag === 'yt') {
        const got = await ytPlay(real);
        return { parse: 0, url: text(got.url), header: got.header || { 'User-Agent': 'okhttp/4.12.0' } };
      }
      if (tag === 'gg' || tag === 'jz') {
        const cut = real.indexOf(US);
        const parserId = cut > 0 ? real.slice(0, cut) : '0';
        const playId = cut > 0 ? real.slice(cut + 1) : real;
        const url = await this.src(tag).play(parserId, playId, name);
        return { parse: 0, url: url || '', header: { 'User-Agent': T3_PROFILES[tag].ua } };
      }
      if (tag === 'zj') {
        const got = await this.src(tag).play(real);
        return { parse: Number(got.parse) || 0, url: text(got.url), header: got.header || { 'User-Agent': UA_WEB } };
      }
    } catch { /* ignore */ }
    return { parse: 0, url: '', header: { 'User-Agent': UA_WEB } };
  }
}

const youtubeList = (data) => asList(asDict(data).list).length > 0;

function splitEps(block) {
  const segs = Array.isArray(block) ? block.map(text) : text(block).split('#');
  const eps = [];
  for (const seg of segs) {
    const sep = seg.indexOf('$');
    if (sep > 0 && seg.slice(sep + 1)) eps.push([seg.slice(0, sep), seg.slice(sep + 1)]);
  }
  return eps;
}

// ============================================================
// 第二组：稀饭聚合（稀饭动漫 · GiriGiri爱 · 次元城 · OmoFun）
// ============================================================
const XF_UA = UA_WEB;
const VIDEO_EXT_RE = /\.(?:m3u8|mp4|mkv|flv|avi|ts|mov|m4v|webm|wmv|rmvb|mpd)$/i;
const XF_EXT_HOSTS = ['v.qq.com', 'qq.com', 'youku.com', 'iqiyi.com', 'bilibili.com', 'mgtv.com', 'sohu.com', 'pptv.com', 'le.com', 'wasu.cn', '1905.com'];

const isVideoUrl = (url) => isUrl(url) && VIDEO_EXT_RE.test(pathOf(url));
const isExtLink = (url) => {
  try {
    const host = new URL(text(url)).hostname.toLowerCase();
    return XF_EXT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch { return false; }
};
const playHeaderOf = (host, ref) => ({
  'User-Agent': XF_UA, Referer: ref || `${host}/`, Origin: host,
  Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9',
});

function epLabelOf(raw, idx) {
  const label = text(raw);
  if (!label) return `第${String(idx + 1).padStart(2, '0')}集`;
  if (/^[0-9]{1,4}$/.test(label)) return `第${String(Number(label)).padStart(2, '0')}集`;
  return label;
}

async function jsonPost(url, body, headers = {}, timeout = 9000) {
  const res = await httpText(url, 'POST',
    { 'Content-Type': 'application/json', ...headers },
    Buffer.from(JSON.stringify(body), 'utf8'), timeout, 1);
  if (!res.status || res.status >= 400 || !res.text) return {};
  return loads(res.text);
}

class XifanSource {
  constructor(cfg = {}) {
    this.tag = 'xf';
    this.host = text(cfg.host) || 'https://next.xifanacg.com';
    this.api = text(cfg.api) || 'https://api.xifanacg.com';
    this.key = text(cfg.key) || 'sb_publishable_OBIVAWACIX6lPXrO98_z24_HcsmalkA';
    this.timeout = Number(cfg.timeout) > 0 ? Number(cfg.timeout) * 1000 : 9000;
    this.pageSize = 24;
    this.maxLines = 4;
    this.fails = 0;
    this.coolUntil = 0;
    this.alive = true;
  }

  mark(ok) {
    if (ok) { this.fails = 0; this.alive = true; return; }
    this.fails += 1;
    this.alive = false;
    this.coolUntil = Date.now() + 120000;
  }

  health() {
    if (!this.alive && Date.now() > this.coolUntil) { this.alive = true; this.fails = 0; }
    return this.alive;
  }

  hdr(ref) {
    return {
      'User-Agent': XF_UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: ref || `${this.host}/`,
      Origin: this.host,
      'x-platform': 'web',
      'x-requested-with': 'XMLHttpRequest',
      apikey: this.key,
      authorization: `Bearer ${this.key}`,
      'x-client-info': 'supabase-ssr/0.10.3 createBrowserClient',
      'content-profile': 'public',
    };
  }

  async get(path, params = null, ttl = 0) {
    const query = params ? `?${new URLSearchParams(params.map(([k, v]) => [k, String(v ?? '')]))}` : '';
    const url = this.api + path + query;
    if (ttl) { const hit = cacheGet(`xf:${url}`); if (hit !== undefined) return hit; }
    const res = await httpText(url, 'GET', this.hdr(), null, this.timeout, 1);
    this.mark(Boolean(res.status && res.status < 400));
    if (!res.status || res.status >= 400 || !res.text) return {};
    const parsed = loads(res.text);
    if (ttl && parsed && Object.keys(parsed).length) cachePut(`xf:${url}`, parsed, ttl);
    return parsed;
  }

  async post(path, body, ttl = 0) {
    if (ttl) { const hit = cacheGet(`xf:${path}:${JSON.stringify(body)}`); if (hit !== undefined) return hit; }
    const res = await httpText(this.api + path, 'POST', { 'Content-Type': 'application/json', ...this.hdr() },
      Buffer.from(JSON.stringify(body), 'utf8'), this.timeout, 1);
    this.mark(Boolean(res.status && res.status < 400));
    if (!res.status || res.status >= 400 || !res.text) return {};
    const parsed = loads(res.text);
    if (ttl && parsed && Object.keys(parsed).length) cachePut(`xf:${path}:${JSON.stringify(body)}`, parsed, ttl);
    return parsed;
  }

  cat(tid) {
    const key = text(tid) || '1';
    const alias = XIFAN_TID_ALIAS[key.toLowerCase()];
    const target = alias || key;
    return XIFAN_CATS.find((c) => c.tid === target) || { tid: target };
  }

  query(tid, pg, ext = {}, kw = '') {
    const cat = this.cat(tid);
    const page = Number.parseInt(String(pg || ''), 10);
    const params = {
      page_number: Number.isFinite(page) && page > 0 ? page : 1,
      items_per_page: this.pageSize,
      sort_by: cat.sort || 'updated_at',
      sort_order: 'desc',
      filter_only_published: true,
    };
    if (kw) params.search_term = text(kw);
    if (cat.type_id) params.filter_type_id = cat.type_id;
    if (cat.fmt) params.filter_format = cat.fmt;
    if (cat.finished !== undefined) params.filter_is_finished = cat.finished;
    if (cat.year) params.filter_release_year = cat.year;
    const extMap = {
      sort_by: 'sort_by', sort_order: 'sort_order', year: 'filter_release_year',
      type_id: 'filter_type_id', format: 'filter_format',
    };
    for (const [from, to] of Object.entries(extMap)) {
      const value = asDict(ext)[from];
      if (value !== undefined && value !== null && value !== '') params[to] = value;
    }
    return params;
  }

  async rpc(tid, pg, ext = {}, kw = '', ttl = 0) {
    const arr = await this.post('/rest/v1/rpc/search_animes', this.query(tid, pg, ext, kw), ttl);
    if (!Array.isArray(arr)) return { items: [], total: 0 };
    const total = arr.length ? Number(arr[0].total_count || 0) : 0;
    return { items: arr, total: Number.isFinite(total) ? total : 0 };
  }

  vod(item) {
    if (!item || typeof item !== 'object') return null;
    const aid = item.id;
    if (aid === undefined || aid === null || aid === '') return null;
    const pic = text(item.cover_url).replace('img2.xfmanga.top', 'img.xfmanga.top');
    const cur = Number(item.current_episodes || 0);
    const total = Number(item.total_episodes || 0);
    let remark = '';
    if (item.is_finished) remark = total ? `全${total}集` : '已完结';
    else if (cur) remark = `更新至${cur}集${total && total > cur ? `/${total}` : ''}`;
    let desc = text(item.description);
    const tags = asList(item.meta_tags);
    if (tags.length) desc = `${desc}${NL}标签：${tags.slice(0, 8).map((t) => text(t)).join(' / ')}`.trim();
    const actors = asList(item.actors);
    return {
      vod_id: String(aid),
      vod_name: text(item.title || item.title_original),
      vod_pic: pic,
      vod_remarks: remark,
      vod_year: text(item.release_year),
      vod_area: text(item.region),
      vod_lang: '日语',
      vod_actor: actors.slice(0, 6).map((a) => text(a)).join('、'),
      vod_director: text(item.director),
      vod_score: text(item.bangumi_score),
      vod_content: desc,
    };
  }

  vodList(items) {
    const out = [];
    for (const item of asList(items)) {
      const got = this.vod(item);
      if (got) out.push(got);
    }
    return out;
  }

  filters() {
    const years = [{ n: '全部', v: '' }];
    for (let y = 2026; y >= 2019; y -= 1) years.push({ n: String(y), v: String(y) });
    const sorts = [
      { n: '最近更新', v: '' }, { n: '最多播放', v: 'view_count' },
      { n: '高分好评', v: 'bangumi_score' }, { n: '最近上新', v: 'created_at' },
    ];
    const out = {};
    for (const cat of XIFAN_CATS) {
      out[cat.tid] = [
        { key: 'sort_by', name: '排序', value: sorts },
        { key: 'year', name: '年份', value: years },
      ];
    }
    return out;
  }

  async home(withFilter = true) {
    const classes = XIFAN_CATS.map((c) => ({ type_id: c.tid, type_name: c.name }));
    let list = [];
    try {
      const first = await this.rpc('1', 1, {}, '', 90);
      list = this.vodList(first.items).slice(0, 18);
      if (list.length < 8) {
        const more = await this.rpc('3', 1, {}, '', 90);
        list = list.concat(this.vodList(more.items).slice(0, 10));
      }
    } catch { list = []; }
    return { class: classes, filters: withFilter ? this.filters() : {}, list };
  }

  async homeVod() {
    try {
      let { items } = await this.rpc('new', 1, {}, '', 90);
      let list = this.vodList(items);
      if (!list.length) { items = (await this.rpc('1', 1, {}, '', 90)).items; list = this.vodList(items); }
      return { list };
    } catch { return { list: [] }; }
  }

  async category(tid, pg, ext = {}) {
    const page = pageOf(pg);
    try {
      const { items, total } = await this.rpc(tid, page, ext, '', 60);
      const list = this.vodList(items);
      const pagecount = total ? Math.ceil(total / this.pageSize) : (list.length ? 9999 : 1);
      return { list, page, pagecount: Math.max(pagecount, page), limit: this.pageSize, total: total || list.length };
    } catch {
      return { list: [], page: 1, pagecount: 1, limit: this.pageSize, total: 0 };
    }
  }

  async search(kw, pg = 1) {
    const word = text(kw);
    if (!word) return { list: [] };
    try {
      const { items } = await this.rpc('', pageOf(pg), {}, word, 30);
      return { list: this.vodList(items) };
    } catch { return { list: [] }; }
  }

  // 详情 + 剧集一次取回；嵌套 select 失败时回退成两次单独请求
  async animeEps(aid) {
    const id = text(aid);
    try {
      const arr = await this.get('/rest/v1/animes', [
        ['id', `eq.${id}`],
        ['select', '*,episodes(id,episode_number,title,kind,release_date,duration_seconds)'],
        ['limit', 1],
      ], 120);
      if (Array.isArray(arr) && arr.length && arr[0] && typeof arr[0] === 'object') {
        const item = { ...arr[0] };
        const eps = asList(item.episodes);
        delete item.episodes;
        if (eps.length) {
          eps.sort((a, b) => Number(a.episode_number || 0) - Number(b.episode_number || 0));
          return { info: item, eps: eps.filter((e) => e && e.id) };
        }
      }
    } catch { /* fall through */ }
    const plain = await this.get('/rest/v1/animes', [['id', `eq.${id}`], ['select', '*'], ['limit', 1]], 120);
    const info = Array.isArray(plain) && plain[0] && typeof plain[0] === 'object' ? plain[0] : {};
    const arr = await this.get('/rest/v1/episodes', [
      ['anime_id', `eq.${id}`],
      ['select', 'id,episode_number,title,kind,release_date,duration_seconds'],
      ['order', 'episode_number.asc'],
      ['limit', 2000],
    ], 300);
    return { info, eps: Array.isArray(arr) ? arr.filter((e) => e && e.id) : [] };
  }

  epName(ep, idx) {
    const num = Number.parseInt(String(ep.episode_number || idx + 1), 10) || idx + 1;
    const title = text(ep.title);
    return cleanName(title ? `第${num}集 ${title}` : `第${num}集`);
  }

  // 用第一集取流响应的 candidates 枚举真实线路
  async sourceLines(aid, eps) {
    const out = [];
    const eids = eps.filter((e) => e.id).map((e) => e.id);
    if (!eids.length) return out;
    const firstEid = Number.parseInt(String(eids[0]), 10);
    if (!Number.isFinite(firstEid)) return out;
    const data = await this.post('/functions/v1/issue-web-playback', { action: 'fallback', episode_id: firstEid }, 180);
    let cands = Array.isArray(data.candidates) ? data.candidates : [];
    if (!cands.length) cands = [{ source_id: 0, source_name: '稀饭线路' }];
    const used = {};
    for (const cand of cands.slice(0, this.maxLines)) {
      if (!cand || typeof cand !== 'object') continue;
      const sid = Number.parseInt(String(cand.source_id || 0), 10) || 0;
      const base = cleanName(cand.source_name || cand.source_code || '稀饭线路') || '稀饭线路';
      let name = base;
      if (used[name]) { used[name] += 1; name = `${base}·${used[name]}`; } else used[name] = 1;
      const items = [];
      eps.forEach((ep, idx) => {
        if (!ep.id) return;
        items.push([this.epName(ep, idx), 'xfline', `${aid}|${ep.id}|${sid}`]);
      });
      if (items.length) out.push({ name, eps: items });
    }
    return out;
  }

  async detail(aid) {
    const id = text(aid);
    const { info, eps } = await this.animeEps(id);
    const vod = this.vod(info) || { vod_id: id };
    vod.vod_id = id;
    if (!vod.vod_name) vod.vod_name = `稀饭动漫 ${id}`;
    vod.vod_pubdate = text(info.release_date);
    const lines = await this.sourceLines(id, eps);
    if (eps.length) {
      const page = `${this.host}/anime/${id}/play/${eps[0].id}`;
      lines.push({ name: '网页解析', eps: [['正片', 'xfpage', `playpage:${page}`]] });
    }
    return { vod, lines };
  }

  async fetchPlayable(eid, sid) {
    const idNum = Number.parseInt(String(eid), 10);
    if (!Number.isFinite(idNum)) return '';
    const body = { action: 'fallback', episode_id: idNum };
    const sidNum = Number.parseInt(String(sid || 0), 10);
    if (Number.isFinite(sidNum) && sidNum) body.source_id = sidNum;
    const data = await this.post('/functions/v1/issue-web-playback', body);
    let url = data && typeof data === 'object' ? text(data.url) : '';
    if (!url && body.source_id) {
      const retry = await this.post('/functions/v1/issue-web-playback', { action: 'fallback', episode_id: idNum });
      url = retry && typeof retry === 'object' ? text(retry.url) : '';
    }
    return url;
  }

  async play(flag, pid) {
    const base = { parse: 0, url: '', header: playHeaderOf(this.host) };
    const raw = text(pid);
    if (!raw) return base;
    if (raw.startsWith('playpage:')) {
      const page = raw.slice('playpage:'.length);
      return { parse: 1, url: page, header: playHeaderOf(this.host, page) };
    }
    if (raw.startsWith('http') || raw.startsWith('//')) {
      const url = raw.startsWith('//') ? `https:${raw}` : raw;
      return { ...base, url };
    }
    const match = /^([0-9]+)\|([0-9]+)\|([0-9]+)$/.exec(raw);
    if (match) {
      const url = await this.fetchPlayable(match[2], match[3]);
      if (url) return { ...base, url };
      const page = `${this.host}/anime/${match[1]}/play/${match[2]}`;
      return { parse: 1, url: page, header: playHeaderOf(this.host, page) };
    }
    if (/^[0-9]+$/.test(raw)) {
      const url = await this.fetchPlayable(raw, 0);
      if (url) return { ...base, url };
    }
    return base;
  }
}

const XIFAN_CATS = [
  { tid: '1', name: '连载新番', type_id: 1, sort: 'updated_at' },
  { tid: '2', name: '完结旧番', type_id: 2, sort: 'updated_at' },
  { tid: '3', name: '剧场版', type_id: 3, sort: 'updated_at' },
  { tid: '4', name: '美漫', type_id: 4, sort: 'updated_at' },
  { tid: 'hot', name: '热门播放', sort: 'view_count' },
  { tid: 'score', name: '高分好评', sort: 'bangumi_score' },
  { tid: 'new', name: '最近上新', sort: 'created_at' },
  { tid: 'tv', name: 'TV动画', fmt: 'tv', sort: 'updated_at' },
  { tid: 'movie', name: '剧场动画', fmt: 'movie', sort: 'updated_at' },
  { tid: 'ova', name: 'OVA', fmt: 'ova', sort: 'updated_at' },
  { tid: 'web', name: 'WEB动画', fmt: 'web', sort: 'updated_at' },
  { tid: 'fin', name: '已完结', finished: true, sort: 'updated_at' },
  { tid: 'ing', name: '连载中', finished: false, sort: 'updated_at' },
  { tid: 'y2026', name: '2026年', year: 2026, sort: 'updated_at' },
  { tid: 'y2025', name: '2025年', year: 2025, sort: 'updated_at' },
  { tid: 'y2024', name: '2024年', year: 2024, sort: 'updated_at' },
  { tid: 'y2023', name: '2023年', year: 2023, sort: 'updated_at' },
];

const XIFAN_TID_ALIAS = {
  '0': '1', all: '1', ongoing: '1', anime: '1',
  finished: '2', theater: '3', western: '4', drama: 'tv',
};

// ------------------------------------------------------------
// GiriGiri爱（maccms 接口，直链）
// ------------------------------------------------------------
class GirigiriSource {
  constructor(cfg = {}) {
    this.tag = 'gg';
    this.host = text(cfg.giri_host) || 'https://ani.girigirilove.com';
    this.api = text(cfg.giri_api) || 'https://m3u8.girigirilove.com/api.php';
    this.img = 'https://jpg.girigirilove.com';
    this.timeout = 12000;
    this.pageSize = 24;
    this.maxLines = 4;
  }

  hdr(ref) {
    return {
      'User-Agent': XF_UA, Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9', Referer: ref || `${this.host}/`, Origin: this.host,
      'x-platform': 'web', 'x-requested-with': 'XMLHttpRequest',
    };
  }

  async call(path, params = null, ttl = 0) {
    const url = this.api + path + (params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v ?? '')]))}` : '');
    if (ttl) { const hit = cacheGet(`gg:${url}`); if (hit !== undefined) return hit; }
    const res = await httpText(url, 'GET', this.hdr(), null, this.timeout, 1);
    if (!res.status || res.status >= 400 || !res.text) return {};
    const parsed = loads(res.text);
    if (ttl && parsed && Object.keys(parsed).length) cachePut(`gg:${url}`, parsed, ttl);
    return parsed;
  }

  pic(value) {
    const str = text(value);
    if (!str) return '';
    if (str.startsWith('//')) return `https:${str}`;
    if (str.startsWith('http')) return str;
    return `${this.img}/${str.replace(/^\/+/, '')}`;
  }

  vod(item) {
    if (!item || typeof item !== 'object') return null;
    const vid = item.vod_id;
    if (vid === undefined || vid === null || vid === '') return null;
    let desc = text(item.vod_blurb || item.vod_content);
    const cls = text(item.vod_class);
    if (cls) desc = `${desc}${NL}类型：${cls.split(',').join(' / ')}`.trim();
    return {
      vod_id: String(vid),
      vod_name: text(item.vod_name),
      vod_pic: this.pic(item.vod_pic),
      vod_remarks: text(item.vod_remarks),
      vod_year: text(item.vod_year),
      vod_area: text(item.vod_area),
      vod_lang: text(item.vod_lang),
      vod_content: desc,
    };
  }

  vodList(items) {
    const out = [];
    for (const item of asList(items)) {
      const got = this.vod(item);
      if (got) out.push(got);
    }
    return out;
  }

  static CATS = [
    { type_id: 'gg_new', type_name: '日漫·最新' },
    { type_id: 'gg_hot', type_name: '日漫·热门' },
    { type_id: 'gg_score', type_name: '日漫·高分' },
    { type_id: 'gg_us', type_name: '欧美动漫' },
  ];

  static CAT_RULE = { gg_new: [2, ''], gg_hot: [2, 'hits'], gg_score: [2, 'score'], gg_us: [3, ''] };

  queryOf(tid, pg) {
    const [typeId, orderby] = GirigiriSource.CAT_RULE[text(tid) || 'gg_new'] || [2, ''];
    const page = pageOf(pg);
    return {
      type_id: typeId, offset: (page - 1) * this.pageSize, limit: this.pageSize,
      vod_name: '', vod_area: '', vod_year: '', orderby, vod_class: '',
      vod_lang: '', vod_version: '', vod_state: '', vod_weekday: '',
      vod_letter: '', vod_tag: '', user_id: '',
    };
  }

  async rows(query, ttl = 0) {
    const data = await this.call('/Vod/get_list', query, ttl);
    const info = asDict(data.info);
    const rows = asList(info.rows);
    const total = Number.parseInt(String(info.total || 0), 10) || 0;
    return { rows, total };
  }

  async home() {
    const classes = GirigiriSource.CATS.map((c) => ({ type_id: c.type_id, type_name: c.type_name }));
    const filters = {};
    for (const cat of GirigiriSource.CATS) {
      filters[cat.type_id] = [{
        key: 'orderby', name: '排序',
        value: [{ n: '默认', v: '' }, { n: '最热', v: 'hits' }, { n: '评分', v: 'score' }],
      }];
    }
    return { class: classes, filters };
  }

  async homeVod() {
    const { rows } = await this.rows(this.queryOf('gg_new', 1), 120);
    return { list: this.vodList(rows).slice(0, 30) };
  }

  async category(tid, pg, ext = {}) {
    const page = pageOf(pg);
    const query = this.queryOf(tid, page);
    const orderby = asDict(ext).orderby;
    if (orderby) query.orderby = text(orderby);
    const { rows, total } = await this.rows(query);
    const list = this.vodList(rows);
    const pagecount = total ? Math.max(1, Math.ceil(total / this.pageSize)) : page;
    return { list, total: total || list.length, page, pagecount };
  }

  async search(kw, pg = 1) {
    const page = pageOf(pg);
    const query = { ...this.queryOf('gg_new', page) };
    delete query.type_id;
    query.vod_name = text(kw);
    const data = await this.call('/Vod/get_list', query, 30);
    const info = asDict(data.info);
    return this.vodList(asList(info.rows));
  }

  async lines(vid) {
    const data = await this.call('/Vod/get_detail', { vod_id: vid }, 180);
    const info = asDict(data.info);
    const froms = text(info.vod_play_from).split('$$$');
    const segs = text(info.vod_play_url).split('$$$');
    const out = [];
    const used = {};
    segs.forEach((seg, i) => {
      const code = text(froms[i] || '').toLowerCase();
      const base = GIRI_LINE_NAME[code] || cleanName(froms[i]) || '线路';
      let name = base;
      if (used[name]) { used[name] += 1; name = `${base}·${used[name]}`; } else used[name] = 1;
      const items = [];
      seg.split('#').forEach((part, j) => {
        const piece = part.trim();
        if (!piece) return;
        let title = '';
        let url = piece;
        if (piece.includes('$')) {
          const cut = piece.indexOf('$');
          title = piece.slice(0, cut);
          url = piece.slice(cut + 1).trim();
        }
        if (!url || !isVideoUrl(url)) return;
        items.push([epLabelOf(title, j), '', url]);
      });
      if (items.length && out.length < this.maxLines) out.push({ name, eps: items });
    });
    return out;
  }

  async detail(vid) {
    const data = await this.call('/Vod/get_detail', { vod_id: vid }, 180);
    const info = asDict(data.info);
    const vod = this.vod(info) || { vod_id: text(vid), vod_name: text(vid) };
    return { vod, lines: await this.lines(vid) };
  }

  async play(flag, pid) {
    const base = { parse: 0, url: '', header: playHeaderOf(this.host) };
    const raw = text(pid);
    if (!raw) return base;
    if (raw.startsWith('page:')) {
      const page = raw.slice(5);
      return { parse: 1, url: page, header: playHeaderOf(this.host, page) };
    }
    if (raw.startsWith('http') || raw.startsWith('//')) {
      const url = raw.startsWith('//') ? `https:${raw}` : raw;
      if (isVideoUrl(url)) return { ...base, url };
      if (isExtLink(url)) return { parse: 1, url, header: playHeaderOf(this.host, url) };
      return { ...base, url };
    }
    if (/^[0-9]+$/.test(raw)) {
      const data = await this.call('/Vod/get_detail', { vod_id: raw }, 180);
      const info = asDict(data.info);
      for (const seg of text(info.vod_play_url).split('$$$')) {
        for (const part of seg.split('#')) {
          if (!part.includes('$')) continue;
          const url = part.slice(part.indexOf('$') + 1).trim();
          if (isVideoUrl(url)) return { ...base, url };
        }
      }
    }
    return base;
  }
}

const GIRI_LINE_NAME = { cht: '繁中字幕', chs: '简中字幕', 'cht,chs': '繁简双字' };

// ------------------------------------------------------------
// 次元城动画（REST API，播放需登录）
// ------------------------------------------------------------
class CycaniSource {
  constructor(cfg = {}) {
    this.tag = 'cy';
    this.host = text(cfg.cyc_host) || 'https://www.cycani.org';
    this.api = text(cfg.cyc_api) || `${this.host}/api`;
    this.timeout = 8000;
    this.pageSize = 18;
    this.maxLines = 3;
    this.username = text(cfg.cyc_username);
    this.password = text(cfg.cyc_password);
    this.token = this.norm(cfg.cyc_token);
  }

  norm(value) {
    let str = text(value);
    if (str.toLowerCase().startsWith('bearer ')) str = str.slice(7).trim();
    return str;
  }

  jwtExp(token) {
    try {
      const part = text(token).split('.')[1];
      const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      return Number(asDict(loads(json)).exp || 0);
    } catch { return 0; }
  }

  tokenOk() {
    if (!this.token) return false;
    const exp = this.jwtExp(this.token);
    return !(exp && exp < Date.now() / 1000 + 60);
  }

  loggedIn() { return this.tokenOk(); }

  hdr(auth = false, ref) {
    const base = {
      'User-Agent': XF_UA, Accept: 'application/json',
      'X-App-Name': 'cyc_web', 'X-App-Version': 'cycweb', 'X-Time-Zone': 'Asia/Shanghai',
      Referer: ref || `${this.host}/`, Origin: this.host,
    };
    if (auth && this.token) base.Authorization = `Bearer ${this.token}`;
    return base;
  }

  async login() {
    if (!this.username || !this.password) return false;
    const data = await jsonPost(`${this.api}/auth/login`, { username: this.username, password: this.password }, this.hdr(), this.timeout);
    const token = this.norm(asDict(data.data).token || data.token);
    if (token) { this.token = token; return true; }
    return false;
  }

  async ensureToken() {
    if (this.tokenOk()) return true;
    return this.login();
  }

  async call(path, params = null, auth = false, ttl = 0) {
    const url = this.api + path + (params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v ?? '')]))}` : '');
    if (ttl) { const hit = cacheGet(`cy:${url}:${auth}`); if (hit !== undefined) return hit; }
    let res = await httpText(url, 'GET', this.hdr(auth), null, this.timeout, 1);
    if (auth && res.status === 401 && await this.ensureToken()) {
      res = await httpText(url, 'GET', this.hdr(auth), null, this.timeout, 1);
    }
    if (!res.status || res.status >= 400 || !res.text) return {};
    const parsed = loads(res.text);
    const data = asDict(parsed).data;
    const out = data && typeof data === 'object' ? data : (parsed && typeof parsed === 'object' ? parsed : {});
    if (ttl && Object.keys(out).length) cachePut(`cy:${url}:${auth}`, out, ttl);
    return out;
  }

  card(item) {
    if (!item || typeof item !== 'object') return null;
    const vid = item.video_id || item.id;
    if (vid === undefined || vid === null || vid === '') return null;
    let remark = text(item.remarks);
    if (!remark) {
      const total = Number(item.total || 0);
      if (total > 1) remark = item.completed ? `全${total}集` : `更新至${total}集`;
    }
    return { vod_id: String(vid), vod_name: text(item.title), vod_pic: text(item.cover_url), vod_remarks: remark };
  }

  async search(kw, pg = 1) {
    const data = await this.call('/videos/search', { q: text(kw), page: pageOf(pg), page_size: this.pageSize }, false, 30);
    return asList(data.list).map((item) => this.card(item)).filter(Boolean);
  }

  async sections(vid, code) {
    const out = [];
    const seen = new Set();
    const base = `/videos/${encodeURIComponent(text(vid))}/sections`;
    for (let page = 1; page <= 5; page += 1) {
      const data = await this.call(base, { player_code: code, page, page_size: 100 }, false, 180);
      const arr = asList(data.list);
      if (!arr.length) break;
      let added = 0;
      for (const sec of arr) {
        const sid = text(sec.id);
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        out.push({ id: sid, title: text(sec.title) });
        added += 1;
      }
      if (!added || arr.length < 100) break;
    }
    return out;
  }

  async lines(vid) {
    const data = await this.call(`/videos/${encodeURIComponent(text(vid))}`, null, false, 120);
    let srcs = asList(data.play_from);
    if (!srcs.length) srcs = [{ code: 'cychub', title: '默认线路' }];
    const out = [];
    for (const src of srcs.slice(0, this.maxLines)) {
      const code = text(src.code);
      if (!code) continue;
      const name = cleanName(src.title || code) || code;
      const items = [];
      (await this.sections(vid, code)).forEach((sec, idx) => {
        items.push([cleanName(sec.title) || `第${idx + 1}集`, '', sec.id]);
      });
      if (items.length) out.push({ name, eps: items });
    }
    return out;
  }

  async detail(vid) {
    const data = await this.call(`/videos/${encodeURIComponent(text(vid))}`, null, false, 120);
    const vod = {
      vod_id: text(vid),
      vod_name: text(data.title) || text(vid),
      vod_pic: text(data.cover_url),
      vod_remarks: text(data.remarks),
      vod_content: text(data.description || data.intro),
    };
    return { vod, lines: await this.lines(vid) };
  }

  async play(flag, pid) {
    const base = { parse: 0, url: '', header: playHeaderOf(this.host) };
    const raw = text(pid);
    if (!raw) return base;
    if (raw.startsWith('http') || raw.startsWith('//')) {
      const url = raw.startsWith('//') ? `https:${raw}` : raw;
      return { ...base, url };
    }
    const data = await this.call(`/v2/sections/${encodeURIComponent(raw)}/play-url`, null, true);
    let url = text(data.url);
    if (!url) return base;
    if (url.startsWith('//')) url = `https:${url}`;
    if (isExtLink(url)) return { parse: 1, url, header: playHeaderOf(this.host, url) };
    return { ...base, url };
  }
}

// ------------------------------------------------------------
// OmoFun（HTML + 聚合取流接口）
// ------------------------------------------------------------
class OmoFunSource {
  constructor(cfg = {}) {
    this.tag = 'om';
    this.host = text(cfg.omo_host) || 'https://omofun.in';
    this.hosts = ['https://omofun.in', 'https://omofun2.com'];
    this.timeout = 14000;
    this.maxLines = 4;
    this.dead = {};
  }

  hdr(ref) {
    return {
      'User-Agent': XF_UA,
      Accept: 'text/html,application/xhtml+xml,application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9', Referer: ref || `${this.host}/`,
      'x-platform': 'web', 'x-requested-with': 'XMLHttpRequest',
    };
  }

  async get(path, ttl = 0, valid = '') {
    const key = `omo:${path}`;
    if (ttl) { const hit = cacheGet(key); if (hit !== undefined) return hit; }
    const hosts = [this.host, ...this.hosts.filter((h) => h !== this.host)];
    for (const host of hosts) {
      if ((this.dead[host] || 0) > Date.now()) continue;
      const res = await httpText(host + path, 'GET', this.hdr(`${host}/`), null, this.timeout, 1);
      if (res.status >= 200 && res.status < 300 && res.text && (!valid || res.text.includes(valid))) {
        delete this.dead[host];
        if (ttl) cachePut(key, res.text, ttl);
        return res.text;
      }
      this.dead[host] = Date.now() + 60000;
    }
    return '';
  }

  abs(url) {
    const str = text(url);
    if (!str) return '';
    if (str.startsWith('http')) return str;
    return this.host + str;
  }

  parseItems(html) {
    const out = [];
    try {
      const re1 = /<a href="(\/vod\/detail\/([0-9]+)\.html)"[^>]*title="([^"]*)"[^>]*class="[^"]*module-poster-item[^"]*"[^>]*>(.*?)(?=<a href="\/vod\/detail\/|<\/div>\s*<div class="module-main|<div class="module-foot|$)/g;
      for (const m of html.matchAll(re1)) {
        let title = m[3];
        if (!title) {
          const t = /module-poster-item-title">\s*([^<]+)/.exec(m[4]);
          title = t ? t[1].trim() : '';
        }
        const note = /module-item-note">\s*([^<]*)/.exec(m[4]);
        const pic = /data-original="([^"]+)"/.exec(m[4]);
        out.push({
          vod_id: m[2], vod_name: text(title),
          vod_pic: this.abs(pic ? pic[1] : ''), vod_remarks: note ? text(note[1]) : '',
        });
      }
    } catch { /* ignore */ }
    if (!out.length) {
      try {
        for (const block of html.split('<div class="module-card-item module-item">').slice(1)) {
          const id = /href="\/vod\/detail\/([0-9]+)\.html"/.exec(block);
          if (!id) continue;
          const title = /module-card-item-title">\s*<a[^>]*>\s*<strong>([^<]+)</.exec(block);
          const pic = /data-original="([^"]+)"/.exec(block);
          const note = /module-item-note">\s*([^<]*)/.exec(block);
          out.push({
            vod_id: id[1], vod_name: title ? text(title[1]) : '',
            vod_pic: this.abs(pic ? pic[1] : ''), vod_remarks: note ? text(note[1]) : '',
          });
        }
      } catch { /* ignore */ }
    }
    return out;
  }

  async dyn(vid, ep) {
    let code = text(ep);
    if (!code.startsWith('ep')) code = `ep${code}`;
    return asDict(loads(await this.get(`/_dyn_plays/${vid}/${code}`, 180)));
  }

  async search(kw, pg = 1) {
    const path = `/vod/search.html?wd=${encodeURIComponent(text(kw))}&page=${pageOf(pg)}`;
    return this.parseItems(await this.get(path, 30, '/vod/'));
  }

  async lines(vid) {
    const html = await this.get(`/vod/detail/${vid}.html`, 180, '/vod/');
    if (!html) return [];
    let eps = [...html.matchAll(/<a class="module-play-list-link" href="\/vod\/play\/([0-9]+)\/ep([0-9]+)\.html"[^>]*>\s*<span>([^<]+)</g)]
      .map((m) => [m[1], m[2], m[3]]);
    if (!eps.length) {
      eps = [...html.matchAll(/href="\/vod\/play\/([0-9]+)\/ep([0-9]+)\.html"[^>]*>\s*(?:<span>)?([^<]+)/g)]
        .map((m) => [m[1], m[2], m[3]]);
    }
    if (!eps.length) eps = [[text(vid), '1', 'HD']];
    const seen = new Set();
    const epList = [];
    for (const [v, e, t] of eps) {
      const key = `${v}|${e}`;
      if (seen.has(key)) continue;
      seen.add(key);
      epList.push([v, e, cleanName(t) || '正片']);
    }
    const plays = asList((await this.dyn(vid, epList[0][1])).video_plays);
    const sites = [];
    for (const p of plays) {
      const url = text(asDict(p).play_data);
      if (url && isVideoUrl(url)) {
        const site = cleanName(asDict(p).src_site || '线路');
        if (site && !sites.includes(site)) sites.push(site);
      }
    }
    const chosen = sites.sort().slice(0, this.maxLines);
    if (!chosen.length) chosen.push('OmoFun解析');
    return chosen.map((site) => ({
      name: site,
      eps: epList.map(([v, e, t]) => [t, '', `${v}/ep${e}`]),
    }));
  }

  async detail(vid) {
    const vod = { vod_id: text(vid), vod_name: text(vid) };
    return { vod, lines: await this.lines(vid) };
  }

  async play(flag, pid) {
    const base = { parse: 0, url: '', header: playHeaderOf(this.host) };
    const raw = text(pid).replace('!parse', '');
    if (!raw) return base;
    const parts = raw.split('/');
    let vid;
    let ep;
    if (parts.length === 2) [vid, ep] = parts;
    else if (parts.length >= 3) { vid = parts[parts.length - 2]; ep = parts[parts.length - 1]; }
    else return base;
    const plays = asList((await this.dyn(vid, ep)).video_plays);
    const cands = plays.map((p) => [cleanName(asDict(p).src_site || ''), text(asDict(p).play_data)]).filter(([, u]) => u);
    let pick = '';
    for (const [site, url] of cands) if (site === text(flag) && isVideoUrl(url)) { pick = url; break; }
    if (!pick) for (const [, url] of cands) if (isVideoUrl(url)) { pick = url; break; }
    if (!pick && cands.length) pick = cands[0][1];
    if (pick && isVideoUrl(pick)) return { ...base, url: pick };
    return { parse: 1, url: pick || `${this.host}/vod/play/${raw}.html`, header: playHeaderOf(this.host) };
  }
}

// ------------------------------------------------------------
// 稀饭聚合门面：首页/分类/搜索 = 稀饭（挂了自动切 GiriGiri），详情四源合并
// ------------------------------------------------------------
class XifanGroup {
  constructor(cfg = {}) {
    this.tag = 'xf';
    this.label = '稀饭';
    this.order = ['xf', 'gg', 'cy', 'om'];
    this.labels = { xf: '稀饭', gg: 'GiriGiri', cy: '次元城', om: 'OmoFun' };
    this.maxLinesPerSrc = 4;
    this.detailBudget = 7000;
    this.cfg = cfg;
    this.sources = {};
    this.xf = this.build('xf', () => new XifanSource(cfg));
    this.build('gg', () => new GirigiriSource(cfg));
    this.cy = this.build('cy', () => new CycaniSource(cfg));
    this.build('om', () => new OmoFunSource(cfg));
  }

  build(tag, maker) {
    if (!this.sources[tag]) this.sources[tag] = maker();
    return this.sources[tag];
  }

  async main() {
    if (this.xf && this.xf.health()) return ['xf', this.xf];
    return ['gg', this.sources.gg];
  }

  tagged(tag, res) {
    if (tag !== 'gg' || !res || typeof res !== 'object') return res;
    for (const item of asList(res.list)) {
      const vid = text(item.vod_id);
      if (vid && !vid.startsWith('g:')) item.vod_id = `g:${vid}`;
    }
    return res;
  }

  async home(withFilter = true) {
    const [tag, src] = await this.main();
    try {
      const data = tag === 'xf' ? await src.home(withFilter) : await src.home();
      if (tag === 'gg' && data && data.list && data.list.length === 0) {
        const extra = await src.homeVod();
        data.list = asList(extra.list).slice(0, 18);
      }
      return data;
    } catch { return { class: [], filters: {} }; }
  }

  async homeVod() {
    const [tag, src] = await this.main();
    try { return this.tagged(tag, await src.homeVod()); } catch { return { list: [] }; }
  }

  async category(tid, pg, ext = {}) {
    const [tag, src] = await this.main();
    try {
      const got = await (tag === 'xf' ? src.category(tid, pg, ext) : src.category(tid, pg, ext));
      return this.tagged(tag, got);
    } catch { return { list: [], page: 1, pagecount: 0, limit: 24, total: 0 }; }
  }

  async search(kw, pg = 1) {
    const [tag, src] = await this.main();
    try {
      const got = tag === 'xf' ? await src.search(kw, pg) : { list: await src.search(kw, pg) };
      return this.tagged(tag, got);
    } catch { return { list: [] }; }
  }

  async matchLines(tag, title) {
    const src = this.sources[tag];
    if (!src) return [];
    const items = await src.search(title, 1);
    const picked = strictMatch(title, items) || bestMatch(title, items, 0.8);
    if (!picked) return [];
    const got = await src.detail(text(picked.vod_id));
    return asList(got.lines).slice(0, this.maxLinesPerSrc);
  }

  async detail(vid) {
    const raw = text(vid);
    const byGiri = raw.startsWith('g:');
    const aid = raw.replace(/[^0-9]/g, '');
    if (!aid) return { vod: {}, lines: [] };
    const cacheKey = `xagg:${byGiri ? 'g' : 'x'}:${aid}:${this.order.join(',')}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
    const mainTag = byGiri ? 'gg' : 'xf';
    if (!byGiri && this.xf && !this.xf.health()) return { vod: {}, lines: [] };
    let base;
    try { base = await this.sources[mainTag].detail(aid); }
    catch { return { vod: {}, lines: [] }; }
    if (!base || !base.lines || !base.lines.length) {
      if (!byGiri) {
        await sleep(200);
        try { base = await this.xf.detail(aid); } catch { /* ignore */ }
      }
    }
    if (!base) return { vod: {}, lines: [] };
    const title = text(asDict(base.vod).vod_name);
    const boxes = {};
    const jobs = this.order.filter((tag) => tag !== mainTag).map(async (tag) => {
      try { boxes[tag] = await this.matchLines(tag, title); } catch { boxes[tag] = []; }
    });
    await Promise.race([Promise.all(jobs), sleep(this.detailBudget)]);

    const cyNeedLogin = this.cy && !this.cy.loggedIn();
    const lines = [];
    const used = {};
    for (const tag of this.order) {
      const got = tag === mainTag ? asList(base.lines) : asList(boxes[tag]);
      for (const line of got.slice(0, this.maxLinesPerSrc)) {
        const rawName = cleanName(line.name) || '线路';
        const prefix = this.labels[tag] || tag;
        let label = rawName.startsWith(prefix) ? rawName : `${prefix}·${rawName}`;
        if (tag === 'cy' && cyNeedLogin) label += '(需登录)';
        if (used[label]) { used[label] += 1; label = `${label}·${used[label]}`; } else used[label] = 1;
        lines.push({ name: label, tag, eps: asList(line.eps) });
      }
    }
    const vod = { ...asDict(base.vod) };
    if (cyNeedLogin && this.order.includes('cy')) {
      const tip = this.cy.username && this.cy.password
        ? '[次元城] 已配置账号，播放时将自动登录。'
        : '[次元城线路需登录] 请在源配置里填 cyc_username / cyc_password，或填浏览器复制的 cyc_token。';
      vod.vod_content = `${text(vod.vod_content)}${NL}${NL}${tip}`.trim();
    }
    const result = { vod, lines };
    cachePut(cacheKey, result, 300);
    return result;
  }

  async play(subtag, flag, pid) {
    const key = ['xf', 'gg', 'cy', 'om'].includes(text(subtag)) ? text(subtag) : 'xf';
    const target = this.sources[key];
    if (!target) return { parse: 0, url: '', header: playHeaderOf('', null) };
    try { return await target.play(text(flag), text(pid)); }
    catch { return { parse: 0, url: '', header: playHeaderOf('', null) }; }
  }
}

// ============================================================
// 第三组：小鸡看看（App 接口，五头签名 + 播放令牌换链）
// ============================================================
const XJ_APP_ID = 'com.kankan.tv';
const XJ_APP_VER = '105';
const XJ_SK = 'SK-sk_13oXDZ7u9j2Tk1c0cawWVFfO';
const XJ_FINGER = 'SF-F5F11CB15897115AE6BCFE063C288F730CA865588F572C780A3E8477D0DD3776';
const XJ_UA = 'okhttp/4.12.0';
const XJ_PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const XJ_HOST = 'https://xjggg.top';

const XJ_CATS = [
  ['c_movie', '🎬电影', '电影'],
  ['c_tv', '📺剧集', '剧集'],
  ['c_anime', '🌸动漫', '动漫'],
  ['c_show', '🎤综艺', '综艺'],
  ['c_rank', '🔥排行榜', '排行榜'],
];

const XJ_YEARS = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018',
  '2017', '2016', '2015', '2010', '2005', '2000'];

const XJ_FILTER_DEF = {
  电影: {
    class: ['动作', '喜剧', '爱情', '科幻', '恐怖', '悬疑', '剧情', '战争', '犯罪', '动画',
      '奇幻', '冒险', '灾难', '纪录片', '历史', '武侠', '青春', '家庭', '古装', '运动'],
    area: ['中国大陆', '美国', '韩国', '日本', '英国', '法国', '中国香港', '中国台湾',
      '泰国', '印度', '俄罗斯', '加拿大', '澳大利亚', '德国', '西班牙', '意大利'],
    year: XJ_YEARS.concat(['1995', '1990']),
  },
  剧集: {
    class: ['国产剧', '欧美剧', '美剧', '英剧', '日韩剧', '韩剧', '日剧', '港台剧', '香港剧',
      '台湾剧', '电视剧', '古装', '悬疑', '都市', '爱情', '犯罪', '战争', '奇幻', '喜剧'],
    area: ['中国大陆', '美国', '韩国', '日本', '英国', '中国香港', '中国台湾', '泰国', '法国', '加拿大'],
    year: XJ_YEARS,
  },
  动漫: {
    class: ['日本动漫', '国产动漫', '欧美动漫', '国创（B站）', '动画', '热血', '奇幻', '冒险',
      '恋爱', '搞笑', '科幻', '儿童', '亲子', '魔幻', '悬疑', '武侠', '古装', '真人'],
    area: ['日本', '中国大陆', '美国', '英国', '韩国', '加拿大', '法国'],
    year: XJ_YEARS,
  },
  综艺: {
    class: ['大陆综艺', '日韩综艺', '欧美综艺', '港台综艺', '真人秀', '脱口秀', '选秀', '音乐',
      '竞技', '晚会', '明星', '情感', '搞笑', '文化', '戏曲'],
    area: ['中国大陆', '韩国', '日本', '美国', '英国', '中国香港', '中国台湾', '泰国'],
    year: XJ_YEARS.slice(0, 13),
  },
};

const XJ_SORTS = [['hot', '最热'], ['score', '评分'], ['time', '最新']];
const XJ_FRM_ALIAS = {
  ZJ4K: 'zijianm3u8', BB蓝光: 'BBA', QS蓝光: 'qsvip', ZY蓝光: 'zy1080_01',
  JD4K: 'JD4K', TM蓝光: 'tmdb', NBY: 'NBY',
};
const XJ_TOK_FRM = {
  zijian: 'zijianm3u8', qqqq: 'BBA', qsvip: 'qsvip', JD: 'JD4K', tmdb: 'tmdb', NBY: 'NBY',
};

class XiaojiSource {
  constructor(cfg = {}) {
    this.tag = 'xj';
    this.host = text(cfg.xj_host) || XJ_HOST;
    this.timeout = 15000;
    this.pageSize = 30;
    this.maxLines = 7;
    this.devices = [];
    this.badDev = {};
    this.devIdx = 0;
    this.epsCache = {};
  }

  device() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.badDay !== day) { this.badDay = day; this.badDev = {}; }
    while (this.devices.length < 12) this.devices.push(`uuid-${randomUUID()}`);
    const pool = this.devices.filter((d) => !this.badDev[d]);
    if (!pool.length) { this.devices = []; return this.device(); }
    this.devIdx = (this.devIdx + 1) % pool.length;
    return pool[this.devIdx];
  }

  dropDevice(dev) {
    this.badDev[dev] = true;
    this.devices = this.devices.filter((d) => d !== dev);
  }

  sigHeaders(dev) {
    const ts = Date.now();
    const nonce = createHash('sha256').update(dev, 'utf8').digest('hex').slice(0, 8)
      + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const raw = `finger=${XJ_FINGER}&id=${XJ_APP_ID}&nonce=${nonce}&sk=${XJ_SK}&time=${ts}&v=${XJ_APP_VER}`;
    const sign = createHash('sha256').update(raw, 'utf8').digest('hex').toUpperCase();
    return {
      'x-aid': XJ_APP_ID, 'x-ave': XJ_APP_VER, 'x-time': String(ts), 'x-nonc': nonce,
      'x-sign': sign, 'x-device-id': dev, 'x-device-brand': 'Xiaomi',
      'x-device-model': 'M2012K11AC', 'x-client-type': 'tv', 'x-update-id': 'embedded',
      Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': XJ_UA,
    };
  }

  async api(path, params = null, okCodes = [200]) {
    const query = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v ?? '')]))}` : '';
    const url = this.host + path + query;
    let lastError = '';
    for (let round = 0; round < 2; round += 1) {
      for (let rotate = 0; rotate < 12; rotate += 1) {
        const dev = this.device();
        const res = await httpText(url, 'GET', this.sigHeaders(dev), null, this.timeout, 1);
        if (!res.status || res.status !== 200 || !res.text) { lastError = `http ${res.status}`; break; }
        const obj = loads(res.text);
        if (!obj || typeof obj !== 'object') { lastError = 'bad body'; break; }
        const code = Number(obj.code);
        if (okCodes.includes(code)) return obj.data === undefined ? obj : obj.data;
        lastError = text(obj.msg);
        if (code === 401) break;
        if (code === 429 || Number(obj.error_code) === 42901) { this.dropDevice(dev); continue; }
        break;
      }
      if (!lastError) break;
      await sleep(300);
    }
    return null;
  }

  vod(item) {
    if (!item || typeof item !== 'object') return null;
    const vid = item.vod_id;
    if (vid === undefined || vid === null || vid === '') return null;
    return {
      vod_id: String(vid),
      vod_name: text(item.vod_name),
      vod_pic: text(item.vod_pic || item.vod_douban_pic),
      vod_remarks: text(item.vod_remarks),
      vod_year: text(item.vod_year),
      vod_area: text(item.vod_area),
      vod_class: text(item.vod_class),
      vod_actor: text(item.vod_actor),
      vod_director: text(item.vod_director),
      vod_score: text(item.vod_douban_score),
      vod_content: text(item.vod_content),
      type_name: text(item.type_name),
    };
  }

  vodList(items) {
    const out = [];
    for (const item of asList(items)) {
      const got = this.vod(item);
      if (got && got.vod_name) out.push(got);
    }
    return out;
  }

  filters() {
    const out = {};
    for (const [tid, , tname] of XJ_CATS) {
      if (tid === 'c_rank') { out[tid] = []; continue; }
      const dims = XJ_FILTER_DEF[tname] || {};
      const arr = [];
      for (const [key, label] of [['class', '类型'], ['area', '地区'], ['year', '年份']]) {
        const vals = dims[key] || [];
        if (!vals.length) continue;
        arr.push({
          key, name: label,
          value: [{ n: '全部', v: '' }, ...vals.map((v) => ({ n: v, v }))],
        });
      }
      arr.push({
        key: 'sort', name: '排序',
        value: [{ n: '默认', v: '' }, ...XJ_SORTS.map(([v, n]) => ({ n, v }))],
      });
      out[tid] = arr;
    }
    return out;
  }

  async home() {
    const classes = XJ_CATS.map(([tid, name]) => ({ type_id: tid, type_name: name }));
    const data = await this.api('/api.php/app/index/home');
    const list = [];
    const seen = new Set();
    for (const item of asList(asDict(data).recommend)) {
      const vid = text(item.vod_id);
      if (!vid || seen.has(vid)) continue;
      seen.add(vid);
      const got = this.vod(item);
      if (got && got.vod_name) list.push(got);
    }
    for (const cat of asList(asDict(data).categories)) {
      for (const item of asList(asDict(cat).videos)) {
        const vid = text(item.vod_id);
        if (!vid || seen.has(vid)) continue;
        seen.add(vid);
        const got = this.vod(item);
        if (got && got.vod_name) list.push(got);
      }
    }
    return { class: classes, filters: this.filters(), list: list.slice(0, 40) };
  }

  async homeVod() {
    const data = await this.api('/api.php/app/index/home');
    const list = [];
    const seen = new Set();
    for (const item of asList(asDict(data).recommend)) {
      const vid = text(item.vod_id);
      if (!vid || seen.has(vid)) continue;
      seen.add(vid);
      const got = this.vod(item);
      if (got && got.vod_name) list.push(got);
    }
    for (const cat of asList(asDict(data).categories)) {
      for (const item of asList(asDict(cat).videos)) {
        const vid = text(item.vod_id);
        if (!vid || seen.has(vid)) continue;
        seen.add(vid);
        const got = this.vod(item);
        if (got && got.vod_name) list.push(got);
      }
    }
    return { list: list.slice(0, 40) };
  }

  async rankList() {
    const data = await this.api('/api.php/app/ranking/list');
    const list = [];
    for (const rk of asList(asDict(data).rankings)) {
      const tname = text(asDict(rk).type_name);
      for (const item of asList(asDict(rk).videos)) {
        const got = this.vod(item);
        if (!got || !got.vod_name) continue;
        if (tname && !got.vod_remarks) got.vod_remarks = tname;
        list.push(got);
      }
    }
    return list;
  }

  async category(tid, pg, ext = {}) {
    const page = pageOf(pg);
    const key = text(tid);
    if (key === 'c_rank' || key.startsWith('c_rank')) {
      const list = page === 1 ? await this.rankList() : [];
      return { list, page, pagecount: 1, limit: 30, total: list.length };
    }
    let tname = '';
    for (const [cid, , name] of XJ_CATS) if (cid === key) { tname = name; break; }
    if (!tname) tname = key;
    const params = { type_name: tname, page, limit: this.pageSize };
    for (const k of ['class', 'area', 'year', 'sort']) {
      const value = text(asDict(ext)[k]);
      if (value) params[k] = value;
    }
    const data = await this.api('/api.php/app/filter/vod', params);
    const list = Array.isArray(data) ? this.vodList(data) : [];
    let pagecount = Math.max(1, Math.ceil(1000 / this.pageSize));
    if (list.length < this.pageSize) pagecount = page;
    return { list, page, pagecount, limit: this.pageSize, total: list.length };
  }

  async search(kw, pg = 1) {
    const word = text(kw);
    if (!word) return { list: [] };
    const data = await this.api('/api.php/app/search/index', { wd: word, page: pageOf(pg), limit: this.pageSize });
    return { list: Array.isArray(data) ? this.vodList(data) : [] };
  }

  async detail(vid) {
    const id = text(vid);
    const data = asDict(await this.api('/api.php/app/vod/detail_v2', { vod_id: id }));
    if (!Object.keys(data).length) return { vod: {}, lines: [] };
    const det = asDict(data.detail);
    const vod = this.vod(det) || { vod_id: id, vod_name: id };
    vod.vod_id = id;
    const pb = asDict(data.playback);
    const srcs = asList(pb.sources);
    const sel = asDict(pb.selected_source);
    const selFrom = text(sel.from);
    const order = [];
    if (selFrom) order.push(selFrom);
    for (const s of srcs) {
      const f = text(asDict(s).from);
      if (!f || order.includes(f)) continue;
      if (Number(asDict(s).episode_count || 0) <= 0 && !asList(asDict(s).episodes).length) continue;
      order.push(f);
    }
    const names = {};
    for (const s of srcs) names[text(asDict(s).from)] = text(asDict(s).display_name);
    let all = {};
    try { all = asDict(await this.api('/api.php/app/vod/playback_v2', { vod_id: id })); } catch { all = {}; }
    const got = {};
    for (const s of asList(all.sources || all.sources)) {
      const f = text(asDict(s).from);
      const eps = asList(asDict(s).episodes);
      if (f && eps.length) got[f] = eps;
    }
    const lines = [];
    for (const f of order) {
      let eps = asList(got[f]);
      if (!eps.length && f === selFrom) eps = asList(sel.episodes);
      if (!eps.length) continue;
      const name = cleanName(names[f] || f) || f;
      const cells = [];
      eps.forEach((e, i) => {
        const title = text(asDict(e).title) || `第${i + 1}集`;
        const tok = text(asDict(e).url);
        if (!tok) return;
        cells.push([title, f, tok]);
      });
      if (cells.length) lines.push({ name, tag: 'xj', kind: f, eps: cells });
    }
    lines.sort((a, b) => (a.kind === 'qsvip' ? 1 : 0) - (b.kind === 'qsvip' ? 1 : 0));
    for (const line of lines) if (line.kind === 'qsvip') line.name = `${line.name}(可能失效)`;
    const cache = {};
    for (const line of lines) {
      line.eps.forEach(([title, f, tok], i) => {
        if (!cache[i]) cache[i] = [];
        cache[i].push([f, tok]);
      });
    }
    this.epsCache[id] = cache;
    const keys = Object.keys(this.epsCache);
    while (keys.length > 8) { delete this.epsCache[keys.shift()]; }
    return { vod, lines: lines.map((l) => ({ name: l.name, tag: 'xj', eps: l.eps })) };
  }

  frmFromTok(tok) {
    const lower = text(tok).toLowerCase();
    for (const [prefix, frm] of Object.entries(XJ_TOK_FRM)) {
      if (lower.startsWith(prefix.toLowerCase())) return frm;
    }
    return '';
  }

  async decode(tok, frm, retry = 0) {
    const data = await this.api('/api.php/app/decode/url/', {
      url: tok, vodFrom: frm, _t: Date.now(),
    }, [1, 200]);
    const url = text(data);
    if (url && /^https?:|^\/\//i.test(url) && url !== tok) return url;
    if (retry < 2) { await sleep(400 * (retry + 1)); return this.decode(tok, frm, retry + 1); }
    return '';
  }

  altEpisode(tok) {
    for (const rec of Object.values(this.epsCache)) {
      for (const toks of Object.values(rec)) {
        for (const [f, t] of toks) {
          if (t !== tok) continue;
          for (const [f2, t2] of toks) if (f2 !== f) return t2;
        }
      }
    }
    return '';
  }

  async play(subtag, flag, pid) {
    let tok = text(pid);
    let frm = text(flag);
    if (tok.includes('@@')) {
      const cut = tok.lastIndexOf('@@');
      frm = tok.slice(cut + 2);
      tok = tok.slice(0, cut);
    }
    const cands = [];
    if (frm) cands.push(XJ_FRM_ALIAS[frm] || frm);
    const inferred = this.frmFromTok(tok);
    if (inferred) cands.push(inferred);
    if (flag) cands.push(XJ_FRM_ALIAS[text(flag)] || text(flag));
    cands.push('');
    let url = '';
    const seen = new Set();
    for (const f of cands) {
      if (seen.has(f)) continue;
      seen.add(f);
      url = await this.decode(tok, f);
      if (url) break;
    }
    if (!url) {
      const altTok = this.altEpisode(tok);
      if (altTok) {
        for (const f of [this.frmFromTok(altTok), '']) {
          const alt = await this.decode(altTok, f);
          if (alt) { url = alt; break; }
        }
      }
    }
    const header = { 'User-Agent': XJ_PLAY_UA };
    if (url.includes('shenhua7.vip')) header.Referer = 'https://www.shenhua7.vip/';
    if (url) return { parse: 0, url, header };
    return { parse: 1, url: tok, header };
  }
}

// ============================================================
// 第四组：枫奇4K（至臻4K / 蓝光2K 两条线路）
// ============================================================
const FQ_SITE = 'https://maihaolian.com';
const FQ_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile';
const FQ_PARSE = { JD: 'https://fgsrg.hzqingshan.com', co: 'https://zzrs.mfdyvip.com' };
const FQ_LINES = [['至臻4k', '至臻4K'], ['蓝光2k', '蓝光2K']];

class FengqiSource {
  constructor(cfg = {}) {
    this.tag = 'fq';
    this.site = text(cfg.fq_site) || FQ_SITE;
    this.cookies = {};
    this.lineSid = {};
  }

  hdr(ref) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const out = {
      'User-Agent': FQ_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      Referer: ref || `${this.site}/`,
    };
    if (cookie) out.Cookie = cookie;
    return out;
  }

  storeCookies(setCookie) {
    for (const line of String(setCookie || '').split(/,(?=[^;]+=[^;]+)/)) {
      const m = /^([^=]+)=([^;]*)/.exec(line.trim());
      if (m) this.cookies[m[1].trim()] = m[2];
    }
  }

  async raw(url, { data = null, referer = '', ctype = '', timeout = 12000 } = {}) {
    const headers = this.hdr(referer);
    if (data) headers['Content-Type'] = ctype || 'application/x-www-form-urlencoded';
    const res = await rawRequest(url, {
      method: data ? 'POST' : 'GET', headers,
      body: data ? Buffer.from(data, 'utf8') : null, timeout, retries: 1,
    });
    if (res.headers && typeof res.headers.get === 'function') {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) this.storeCookies(setCookie);
    }
    return res.body ? res.body.toString('utf8') : '';
  }

  abs(url) {
    const u = text(url).trim();
    if (!u) return '';
    if (u.startsWith('http')) return u;
    return this.site + (u.startsWith('/') ? u : `/${u}`);
  }

  // 详情页/首页卡片解析：结构变了也尽量兜住
  parseCards(html) {
    const out = [];
    const seen = new Set();
    const re = /<a[^>]+href="\/detail\/(\d+)\.html"[^>]*>/g;
    for (const m of html.matchAll(re)) {
      const vid = m[1];
      if (seen.has(vid)) continue;
      const tail = html.slice(m.index, m.index + 900);
      let name = '';
      const t1 = /title="([^"]+)"/.exec(m[0]);
      if (t1 && t1[1] && !/^\d+$/.test(t1[1])) name = t1[1];
      if (!name) {
        const t2 = /class="slide-info-types"[^>]*>\s*<span[^>]*>([^<]+)/.exec(tail)
          || /<span[^>]*class="[^"]*this-tag[^"]*"[^>]*>([^<]+)/.exec(tail);
        if (t2) name = t2[1];
      }
      if (!name) {
        const t3 = /<img[^>]*\balt="([^"]*)"/.exec(tail);
        if (t3) name = t3[1];
      }
      name = cleanName(name);
      if (!name) continue;
      seen.add(vid);
      const pic = /(?:data-src|data-original|src)="([^"]+)"/.exec(tail);
      const note = /class="[^"]*(?:public-prt-g|this-desc-score|public-list-prb)[^"]*"[^>]*>\s*([^<]+)/.exec(tail);
      out.push({
        vod_id: `/detail/${vid}.html`,
        vod_name: name,
        vod_pic: pic ? pic[1] : '',
        vod_remarks: note ? cleanName(note[1]) : '',
      });
    }
    return out;
  }

  pageCount(html) {
    const m = /\d+\/(\d+)页/.exec(html);
    return m ? Number(m[1]) : 1;
  }

  async home() {
    const classes = [
      { type_id: '1', type_name: '枫奇·电影' },
      { type_id: '2', type_name: '枫奇·电视剧' },
      { type_id: '3', type_name: '枫奇·综艺' },
      { type_id: '4', type_name: '枫奇·动漫' },
      { type_id: '5', type_name: '枫奇·短剧' },
    ];
    const list = this.parseCards(await this.raw(`${this.site}/`));
    return { class: classes, filters: {}, list: list.slice(0, 30) };
  }

  async homeVod() {
    return { list: this.parseCards(await this.raw(`${this.site}/`)).slice(0, 30) };
  }

  async category(tid, pg, ext = {}) {
    const page = pageOf(pg);
    const t = text(tid);
    const url = t && /^[0-9]+$/.test(t)
      ? `${this.site}/cupfox-list/${t}----------${page}---.html`
      : `${this.site}/`;
    let html = await this.raw(url);
    let list = this.parseCards(html);
    // 列表页被验证码拦住时，首页卡片仍可解析，退回首页给一屏内容
    if (!list.length && page === 1) {
      html = await this.raw(`${this.site}/`);
      list = this.parseCards(html);
    }
    return { list, page, pagecount: this.pageCount(html) || 1, limit: 30, total: list.length };
  }

  async search(kw, pg = 1) {
    const word = text(kw);
    if (!word || pageOf(pg) >= 2) return { list: [] };
    const key = `fq:s:${word}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    const html = await this.raw(`${this.site}/cupfox-search/-------------.html?wd=${encodeURIComponent(word)}`);
    const res = { list: this.parseCards(html) };
    if (res.list.length) cachePut(key, res, 300);
    return res;
  }

  async detail(vid) {
    const html = await this.raw(this.abs(vid));
    if (!html || html.includes('系统安全验证')) return { vod: {}, lines: [] };
    const names = [];
    for (const m of html.matchAll(/<a\s+class="swiper-slide"[^>]*>(.*?)<\/a>/gs)) {
      const plain = m[1]
        .replace(/<i[^>]*>.*?<\/i>/gs, '')
        .replace(/<span[^>]*>.*?<\/span>/gs, '')
        .replace(/<[^>]+>/g, '');
      names.push(cleanName(plain.replace(/&nbsp;/g, ' ')));
    }
    const panels = [];
    const segs = html.split('<div class="anthology-list-box').slice(1);
    for (const seg of segs) {
      const eps = [];
      for (const m of seg.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)</g)) {
        if (!m[1].includes('/play/')) continue;
        eps.push([cleanName(m[2]), m[1]]);
      }
      panels.push(eps.reverse().slice(0, 300));
    }
    const lines = [];
    names.forEach((name, i) => {
      const key = name.toLowerCase().replace(/ /g, '');
      for (const [raw, disp] of FQ_LINES) {
        if (key === raw && i < panels.length && panels[i].length) {
          lines.push({ name: disp, eps: panels[i].map(([ep, href]) => [ep, '', href]) });
          break;
        }
      }
    });
    lines.sort((a, b) => FQ_LINES.findIndex(([, d]) => d === a.name) - FQ_LINES.findIndex(([, d]) => d === b.name));
    if (!lines.length) return { vod: {}, lines: [] };
    const num = /(\d+)\.html/.exec(text(vid));
    if (num) {
      for (const line of lines) {
        for (const [, , href] of line.eps.slice(0, 3)) {
          const m = /\/play\/\d+-(\d+)-\d+\.html/.exec(href);
          if (m) {
            this.lineSid[num[1]] = this.lineSid[num[1]] || {};
            this.lineSid[num[1]][line.name] = m[1];
            break;
          }
        }
      }
    }
    const title = /class="slide-info-title[^"]*"[^>]*>([^<]+)/.exec(html);
    const pic = /class="detail-pic"[\s\S]{0,600}?<img[^>]*?data-src="([^"]+)"/.exec(html);
    const intro = /id="height_limit"[^>]*>([\s\S]{0,1200}?)<\/div>/.exec(html);
    let actor = '';
    for (const block of html.matchAll(/class="slide-info"[^>]*>([\s\S]{0,400}?)<\/div>/g)) {
      if (block[1] && block[1].includes('演员')) { actor = cleanName(block[1].replace(/<[^>]+>/g, ' ')); break; }
    }
    const vod = {
      vod_id: text(vid),
      vod_name: title ? cleanName(title[1]) : '',
      vod_pic: pic ? pic[1] : '',
      vod_content: intro ? cleanName(intro[1].replace(/<[^>]+>/g, ' ')) : '',
      vod_actor: actor,
      vod_remarks: `${lines[0].name} / ${lines[lines.length - 1].name}`,
    };
    return { vod, lines };
  }

  async parsePlay(key) {
    const kind = text(key).split(/[-_]/)[0];
    const base = FQ_PARSE[kind];
    if (!base) return '';
    const target = `${base}/player/?url=${key}`;
    const html = await this.raw(target, { referer: `${this.site}/` });
    const tok = /data-te="([^"]+)"/.exec(html);
    if (!tok) return '';
    const body = new URLSearchParams({ url: key, token: tok[1] }).toString();
    const res = await this.raw(`${base}/player/mplayer.php`, {
      data: body, referer: target,
      ctype: 'application/x-www-form-urlencoded; charset=UTF-8', timeout: 15000,
    });
    const obj = loads(res);
    const url = text(obj.url);
    if (!url) return '';
    return url.startsWith('/playproxy.php') ? base + url : url;
  }

  fallbackPage(pid) {
    const m = /\/play\/(\d+)-(\d+)-(\d+)\.html/.exec(text(pid));
    if (!m) return '';
    const [, vid, sid, ep] = m;
    const sids = this.lineSid[vid] || {};
    for (const name of ['蓝光2K', '至臻4K']) {
      if (sids[name] && sids[name] !== sid) return `/play/${vid}-${sids[name]}-${ep}.html`;
    }
    return '';
  }

  async play(subtag, flag, pid) {
    const header = { 'User-Agent': FQ_UA, Referer: `${this.site}/` };
    const pageUrl = this.abs(pid);
    const html = await this.raw(pageUrl);
    if (!html) return { parse: 0, url: '', header };
    let u = '';
    const m1 = /var\s+player_aaaa[\s\S]*?"url"\s*:\s*"([^"]+)"/.exec(html);
    if (m1) u = m1[1].replace(/\\\//g, '/');
    if (!u) {
      const m2 = /url\s*[:=]\s*["'](http[^"']+)["']/.exec(html);
      if (m2) u = m2[1];
    }
    if (!u) u = pageUrl;
    if (/^http/.test(u) && (u.includes('m3u') || u.includes('.mp4'))) return { parse: 0, url: u, header };
    let real = await this.parsePlay(u);
    if (!real) real = u;
    if (!/^http/.test(real)) {
      const alt = this.fallbackPage(pid);
      if (alt) {
        const altUrl = this.abs(alt);
        const altHtml = await this.raw(altUrl);
        let au = '';
        const am = /var\s+player_aaaa[\s\S]*?"url"\s*:\s*"([^"]+)"/.exec(altHtml);
        if (am) au = am[1].replace(/\\\//g, '/');
        if (au) {
          const altReal = (await this.parsePlay(au)) || au;
          if (/^http/.test(altReal)) return { parse: 0, url: altReal, header };
        }
      }
    }
    return { parse: /^http/.test(real) && (real.includes('m3u') || real.includes('.mp4')) ? 0 : 1, url: real, header };
  }
}

// ============================================================
// 第五组：橘汁新网关（protobuf + RSA 密钥交换 + AES 双层加密）
//   状态：代码完整，但服务端握手返回 100001，默认不加载（配置 {"jn": true} 才启用）
// ============================================================
const JN_HOST = 'http://juziapp.hzhcbkj.cn';
const JN_UA = 'okhttp/3.12.1';
const JN_NATIVE_K = 'ed5fdsgucxumegqa';
const JN_PUB = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCr8SzZhjYy+rsya1K09t8d2K50pWFoBkgUqMpKOiW+3IEVKd4eTdvg9RSOjQ82kypL6R9BnsmrS1V8s4PVDwjQbUtYhTPPC9Hz16qY7rpD6m0d2vr09/UpWQ5uOy9PR0QTrsioveZ+DIe9jc3C+zBCu/kZSY/R8stwJoiitki3gwIDAQAB';
const JN_DATA_KEY = 'ZU1DSFFWNENKMDYXVUQRN0ZJDUC4PQ==';
const JN_DATA_IV = 'OC1A06E197EF10CF3F6058CA7A803B5E';
const JN_PKG = 'com.asjdhjhd.mgd.p3';
const JN_APP = '橘汁';
const JN_VER = '3.0.7.0';
const JN_VIDEO_RE = /\.(mp4|m3u8|flv|mkv|avi|ts|mov|mpd|m4a|wmv)(\?.*)?$/i;

const JN_CATS = [
  ['20', '电影', '喜剧,爱情,恐怖,动作,科幻,剧情,战争,警匪,犯罪,动画,奇幻,武侠,冒险,悬疑,惊悚,经典,青春,文艺,微电影,古装,历史,运动,农村,儿童,网络电影',
    '大陆,香港,台湾,美国,法国,英国,日本,韩国,德国,泰国,印度,意大利,西班牙,加拿大,其他'],
  ['21', '剧集', '古装,战争,青春,偶像,喜剧,家庭,犯罪,动作,奇幻,剧情,历史,经典,乡村,情景,商战,网剧,其他',
    '内地,韩国,香港,台湾,日本,美国,泰国,英国,新加坡,其他'],
  ['22', '综艺', '选秀,情感,访谈,播报,旅游,音乐,美食,纪实,曲艺,生活,游戏互动,财经,求职',
    '内地,港台,日韩,欧美'],
  ['23', '动漫', '', ''],
  ['24', '短剧', '重生民国,穿越年代,现代言情,反转爽文,女恋总裁,闪婚离婚,都市脑洞,古装仙侠,其它', ''],
  ['26', '漫剧', '', ''],
];

// ---------- protobuf ----------
function jnVarint(n) {
  let v = Number(n) >>> 0;
  const out = [];
  while (v > 127) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
}

function jnField(num, wire, payload) {
  const tag = jnVarint((num << 3) | wire);
  if (wire === 2) return Buffer.concat([tag, jnVarint(payload.length), payload]);
  return Buffer.concat([tag, payload]);
}

function jnPbDecode(buf) {
  const out = [];
  let i = 0;
  const n = buf.length;
  const readVar = () => {
    let result = 0;
    let shift = 0;
    while (i < n) {
      const b = buf[i];
      i += 1;
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return result;
  };
  while (i < n) {
    const key = readVar();
    const fn = Math.floor(key / 8);
    const wt = key % 8;
    if (wt === 0) out.push([fn, wt, readVar()]);
    else if (wt === 1) { out.push([fn, wt, buf.slice(i, i + 8)]); i += 8; }
    else if (wt === 2) {
      const len = readVar();
      out.push([fn, wt, buf.slice(i, i + len)]);
      i += len;
    } else if (wt === 5) { out.push([fn, wt, buf.slice(i, i + 4)]); i += 4; }
    else break;
  }
  return out;
}

function jnPbData(buf) {
  for (const [fn, wt, v] of jnPbDecode(buf)) if (fn === 3 && wt === 2) return v;
  return Buffer.alloc(0);
}

function jnPbCode(buf) {
  for (const [fn, wt, v] of jnPbDecode(buf)) if (fn === 1 && wt === 0) return Number(v);
  return -1;
}

// ---------- crypto ----------
function jnRand(size) {
  return randomBytes(size).toString('hex').slice(0, size);
}

function jnRsa(data, pubB64) {
  const key = createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
  return publicEncrypt({ key, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(data, 'utf8')).toString('base64');
}

function jnAesName(len) {
  if (len === 32) return 'aes-256-ecb';
  if (len === 24) return 'aes-192-ecb';
  return 'aes-128-ecb';
}

function jnEcbEnc(str, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const cipher = createCipheriv(jnAesName(key.length), key, null);
  return cipher.update(str, 'utf8', 'base64') + cipher.final('base64');
}

function jnEcbDec(str, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const decipher = createDecipheriv(jnAesName(key.length), key, null);
  return decipher.update(Buffer.from(str, 'base64'), null, 'utf8') + decipher.final('utf8');
}

function jnCbcEnc(str, key, iv) {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv || key, 'utf8'));
  return cipher.update(str, 'utf8', 'hex') + cipher.final('hex');
}

class JnSource {
  constructor(cfg = {}) {
    this.tag = 'jn';
    this.host = text(cfg.jn_host) || JN_HOST;
    this.timeout = 15000;
    this.sec = '';
    this.ready = false;
    this.udid = text(cfg.jn_udid) || '9f3c1d2e7a5b4c68';
    this.detailCache = {};
  }

  dObj() {
    const ver = JN_VER;
    return {
      country: 'CN', vName: ver, cpuId: 'MT6893Z/CZA', young: 0, facturer: 'OnePlus',
      pkg: JN_PKG, uuid: this.udid, resolution: '1080x2272', mac: '02:00:00:00:00:00',
      abid: '397', model: 'PJX110', plat: 'android', udid: this.udid, dpi: '440',
      net: '1', lang: 'zh', brand: 'OnePlus', density: '2.75', appName: JN_APP,
      cpu: 'arm64-v8a', chid: '10000', carrier: '联通', _vOsCode: '36', vOs: '16',
      v: 1, tenantId: '', vApp: ver.replace(/\./g, ''), device: 0, androidID: this.udid,
    };
  }

  cHead(sec) {
    const d = this.dObj();
    const ts = Date.now();
    const f = jnRand(16);
    d.sig = jnRsa(`${ts}${f}${d.vApp}`, sec);
    const b = jnEcbEnc(`${ts}${f}`, JN_DATA_IV);
    d.random_str = f;
    d.timestamp = ts;
    d.sig2 = b.slice(0, 8);
    d.sig3 = b.slice(8);
    return {
      'User-Agent': JN_UA,
      Accept: 'application/x-protobuf',
      'Content-Type': 'application/x-protobuf',
      'Cache-Control': 'no-cache',
      publicParams: JSON.stringify({ paramsData: jnCbcEnc(JSON.stringify(d), JN_NATIVE_K) }),
    };
  }

  eHead() {
    return {
      'User-Agent': JN_UA,
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      publicParams: JSON.stringify({ paramsData: jnCbcEnc(JSON.stringify(this.dObj()), JN_NATIVE_K) }),
    };
  }

  gBody(mp) {
    const ts = Date.now();
    const f8 = jnRand(8);
    const f20 = jnRand(20);
    const sb = Object.entries(mp)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${v}`).join('&');
    const s3 = f8 + jnEcbEnc(sb + ts, JN_DATA_KEY);
    return Buffer.concat([
      jnField(1, 2, Buffer.from(s3.slice(0, 20), 'utf8')),
      jnField(2, 2, Buffer.from(s3.slice(20), 'utf8')),
      jnField(3, 2, Buffer.from(f20, 'utf8')),
      jnField(4, 0, jnVarint(ts)),
      jnField(5, 2, Buffer.from(f8, 'utf8')),
    ]);
  }

  async zone() {
    const ts = Date.now();
    const r = jnRand(16);
    const body = Buffer.concat([
      jnField(1, 0, jnVarint(ts)),
      jnField(2, 2, Buffer.from(jnRsa(`${ts}${r}`, JN_PUB), 'utf8')),
      jnField(3, 2, Buffer.from(r, 'utf8')),
      jnField(4, 2, Buffer.from(r, 'utf8')),
      jnField(5, 2, Buffer.from(jnRand(16), 'utf8')),
    ]);
    const res = await rawRequest(`${this.host}/api/v5/find/app/zone`, {
      method: 'POST', headers: this.cHead(JN_PUB), body, timeout: this.timeout, retries: 1,
    });
    if (!res.status || res.status >= 400) return '';
    const data = jnPbData(res.body);
    if (!data.length) return '';
    const strs = {};
    for (const [fn, wt, v] of jnPbDecode(data)) if (wt === 2 && Buffer.isBuffer(v)) strs[fn] = v.toString('utf8');
    return `${strs[2] || ''}${strs[3] || ''}${strs[4] || ''}${strs[5] || ''}`;
  }

  async ensure() {
    if (this.ready && this.sec) return true;
    try {
      const sec = await this.zone();
      if (sec) { this.sec = sec; this.ready = true; return true; }
    } catch { /* ignore */ }
    return false;
  }

  async post(path, mp) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!(await this.ensure())) return Buffer.alloc(0);
      const res = await rawRequest(`${this.host}${path}`, {
        method: 'POST', headers: this.cHead(this.sec || JN_PUB), body: this.gBody(mp),
        timeout: this.timeout, retries: 1,
      });
      if (!res.status || res.status >= 400) return Buffer.alloc(0);
      const code = jnPbCode(res.body);
      if (code === 200) return jnPbData(res.body);
      if ([100001, 100002, 100003].includes(code) && attempt === 0) {
        this.ready = false; this.sec = '';
        continue;
      }
      return Buffer.alloc(0);
    }
    return Buffer.alloc(0);
  }

  pic(value) {
    const m = /https?:\/\/[^\x00-\x20"\\]+/.exec(text(value));
    return m ? m[0] : '';
  }

  parseList(data) {
    const out = [];
    for (const [fn, wt, v] of jnPbDecode(data)) {
      if (fn !== 1 || wt !== 2 || !Buffer.isBuffer(v) || v.length < 8) continue;
      const d = {};
      for (const [f2, w2, x] of jnPbDecode(v)) {
        if (w2 === 2 && Buffer.isBuffer(x)) d[f2] = x.toString('utf8');
        else if (w2 === 0) d[f2] = Number(x);
      }
      if (typeof d[3] !== 'number' || !d[5]) continue;
      out.push({
        vod_id: String(d[3]), vod_name: text(d[5]), vod_pic: this.pic(d[2]),
        vod_remarks: text(d[13]) || '',
      });
    }
    return out;
  }

  filters() {
    const out = {};
    for (const [tid, , cls, area] of JN_CATS) {
      const arr = [];
      if (cls) arr.push({ key: 'class', name: '类型', value: [{ n: '全部', v: '' }, ...cls.split(',')].filter(Boolean).map((x) => (typeof x === 'string' ? { n: x, v: x } : x)) });
      if (area) arr.push({ key: 'area', name: '地区', value: [{ n: '全部', v: '' }, ...area.split(',').map((x) => ({ n: x, v: x }))] });
      arr.push({ key: 'extend_sort', name: '排序', value: [{ n: '最新', v: '最新' }, { n: '最热', v: '最热' }, { n: '好评', v: '好评' }] });
      out[tid] = arr;
    }
    return out;
  }

  async home() {
    const classes = JN_CATS.map(([tid, name]) => ({ type_id: tid, type_name: `橘汁新·${name}` }));
    return { class: classes, filters: this.filters() };
  }

  async homeVod() {
    const res = await rawRequest(`${this.host}/api/ex/v3/security/tag/list`, {
      method: 'GET', headers: this.eHead(), timeout: this.timeout, retries: 1,
    });
    if (!res.status || res.status >= 400) return { list: [] };
    let obj = loads(res.body.toString('utf8'));
    let ds = asDict(obj).data;
    if (!ds) return { list: [] };
    try {
      ds = jnEcbDec(jnEcbDec(ds, JN_DATA_KEY), JN_DATA_IV);
    } catch {
      try { ds = jnEcbDec(ds, JN_DATA_IV); } catch { return { list: [] }; }
    }
    let arr = loads(ds);
    if (!Array.isArray(arr)) return { list: [] };
    const seen = new Set();
    const out = [];
    for (const block of arr) {
      for (const sec of asList(asDict(block).sections)) {
        for (const v of asList(asDict(sec).vodList)) {
          const vid = text(asDict(v).id);
          if (!vid || seen.has(vid)) continue;
          seen.add(vid);
          out.push({
            vod_id: vid, vod_name: text(asDict(v).name),
            vod_pic: this.pic(asDict(asDict(v).coverImage).path),
            vod_remarks: text(asDict(v).remark),
          });
        }
      }
    }
    return { list: out.slice(0, 40) };
  }

  async category(tid, pg, ext = {}) {
    const page = pageOf(pg);
    const mp = { pagesize: '21', typeId1: text(tid), page: String(page), vodOrderBy: '最新' };
    const mapping = { extend_sort: 'vodOrderBy', area: 'vodArea', lang: 'vodLang', class: 'vodClass', year: 'vodYear' };
    for (const [from, to] of Object.entries(mapping)) {
      const v = text(asDict(ext)[from]);
      if (v) mp[to] = v;
    }
    const list = this.parseList(await this.post('/api/proto/v5/drama/category', mp));
    return { list, page, pagecount: list.length >= 21 ? page + 1 : page, limit: 21, total: list.length };
  }

  async search(kw, pg = 1) {
    const word = text(kw);
    if (!word) return { list: [] };
    const data = await this.post('/api/proto/v5/drama/search', {
      searchKeys: word, page: String(pageOf(pg)), pagesize: '21',
    });
    return { list: this.parseList(data) };
  }

  async detail(vid) {
    const id = text(vid).replace(/^\/+|\/+$/g, '');
    if (this.detailCache[id]) return this.detailCache[id];
    const data = await this.post('/api/proto/v5/drama/getDetail', { id });
    if (!data.length) return { vod: {}, lines: [] };
    const meta = {};
    const groups = {};
    for (const [fn, wt, v] of jnPbDecode(data)) {
      if (wt === 2 && Buffer.isBuffer(v)) {
        if (fn === 29) {
          const e = {};
          for (const [f2, w2, x] of jnPbDecode(v)) {
            if (w2 === 2 && Buffer.isBuffer(x)) e[f2] = x.toString('utf8');
            else if (w2 === 0) e[f2] = Number(x);
          }
          const cn = text(e[10] || e[9]) || '橘汁';
          const src = text(e[9]);
          let path = text(e[4]);
          const title = text(e[3] || e[2]) || '正片';
          if (!path) continue;
          if (!JN_VIDEO_RE.test(path)) {
            path = Buffer.from(JSON.stringify({ vodPlayFrom: src, playUrl: path })).toString('base64');
          }
          if (!groups[cn]) groups[cn] = [];
          groups[cn].push([title, '', path]);
        } else {
          meta[fn] = v.toString('utf8');
        }
      } else if (wt === 0) {
        meta[fn] = Number(v);
      }
    }
    const lines = Object.entries(groups).map(([name, eps]) => ({ name, tag: 'jn', eps }));
    const vod = {
      vod_id: id,
      vod_name: text(meta[9]) || id,
      vod_pic: this.pic(meta[2]),
      vod_remarks: text(meta[26]),
      vod_year: text(meta[18]),
      vod_area: text(meta[1]),
      vod_actor: text(meta[25]),
      vod_director: text(meta[12]),
      vod_content: text(meta[6] || meta[7]).replace(/<[^>]+>/g, '').trim(),
    };
    const result = { vod, lines };
    if (lines.length) this.detailCache[id] = result;
    return result;
  }

  async play(subtag, flag, pid) {
    const raw = text(pid);
    if (JN_VIDEO_RE.test(raw)) return { parse: 0, url: raw, header: { 'User-Agent': UA_WEB } };
    let obj = {};
    try { obj = loads(Buffer.from(raw, 'base64').toString('utf8')); } catch { return { parse: 0, url: '', header: {} }; }
    const data = await this.post('/api/proto/v5/videoUsableUrl', {
      vodPlayFrom: text(asDict(obj).vodPlayFrom), playUrl: text(asDict(obj).playUrl),
    });
    let url = '';
    for (const [fn, wt, v] of jnPbDecode(data)) {
      if (fn === 1 && wt === 2 && Buffer.isBuffer(v)) { url = v.toString('utf8'); break; }
    }
    if (!url.startsWith('http')) return { parse: 0, url: '', header: {} };
    return { parse: 0, url, header: { 'User-Agent': UA_WEB } };
  }
}

// ============================================================
// 多组门面：k1/k2 编解码 + 跨组按标题补线路
// ============================================================
const AGG = new YtAggregator();

const GROUPS = {
  yt: { label: '影探', src: AGG },
  xf: { label: '稀饭', src: null },
  xj: { label: '小鸡', src: null },
  fq: { label: '枫奇', src: null },
  jn: { label: '橘汁新', src: null },
};
const GROUP_ORDER = ['yt', 'xf', 'xj', 'fq', 'jn'];

function encVid(tag, vid) { return `k1${b64urlEncode(`${tag}${US}${vid}`)}`; }

function decVid(code) {
  const raw = text(code);
  if (raw.startsWith('k1')) {
    const plain = b64urlDecode(raw.slice(2)).toString('utf8');
    const cut = plain.indexOf(US);
    if (cut > 0) {
      const tag = plain.slice(0, cut);
      if (GROUPS[tag]) return [tag, plain.slice(cut + 1)];
    }
  }
  return ['yt', raw];
}

function encPlay(tag, subtag, flag, pid, cid = '', ep = '') {
  return `k2${b64urlEncode([tag, subtag, flag, pid, cid, ep].join(US))}`;
}

function decPlay(code) {
  const raw = text(code);
  if (raw.startsWith('k2')) {
    const parts = b64urlDecode(raw.slice(2)).toString('utf8').split(US);
    if (parts.length >= 4 && GROUPS[parts[0]]) {
      while (parts.length < 6) parts.push('');
      return parts;
    }
  }
  return ['yt', '', '', raw, '', ''];
}

function linesOf(vod, subtag = 'yt') {
  const froms = text(vod.vod_play_from).split('$$$');
  const urls = text(vod.vod_play_url).split('$$$');
  const lines = [];
  froms.forEach((name, i) => {
    const eps = splitEps(urls[i]).map(([ep, code]) => [ep, '', code]);
    if (eps.length) lines.push({ name: cleanName(name) || '线路', tag: subtag, eps });
  });
  return lines;
}

class Kishuto {
  constructor() {
    this.cfg = {};
    this.homeCache = null;
    this.homeAt = 0;
    this.configure({});
  }

  configure(config) {
    this.cfg = asDict(config);
    AGG.configure(this.cfg);
    const xcfg = asDict(this.cfg.xifan);
    if (this.cfg.xf !== false) {
      GROUPS.xf.src = new XifanGroup({ ...xcfg, ...this.cfg });
      if (!GROUP_ORDER.includes('xf')) GROUP_ORDER.push('xf');
    }
    if (this.cfg.xj !== false) {
      GROUPS.xj.src = new XiaojiSource(this.cfg);
      if (!GROUP_ORDER.includes('xj')) GROUP_ORDER.push('xj');
    }
    if (this.cfg.fq !== false) {
      GROUPS.fq.src = new FengqiSource(this.cfg);
      if (!GROUP_ORDER.includes('fq')) GROUP_ORDER.push('fq');
    }
    // 橘汁新网关：握手被服务端判签失败，默认关闭，配 {"jn": true} 可自行调试
    if (this.cfg.jn === true) {
      GROUPS.jn.src = new JnSource(this.cfg);
      if (!GROUP_ORDER.includes('jn')) GROUP_ORDER.push('jn');
    } else {
      GROUPS.jn.src = null;
      const idx = GROUP_ORDER.indexOf('jn');
      if (idx >= 0) GROUP_ORDER.splice(idx, 1);
    }
  }

  static labelOf(tag) { return GROUPS[tag] ? GROUPS[tag].label : tag; }

  async home(withFilter = true) {
    const now = Date.now();
    if (this.homeCache && now - this.homeAt < 90000) return this.homeCache;
    let tag = 'yt';
    let data = null;
    try { data = await GROUPS.yt.src.home(); } catch { data = null; }
    if (!data || !asList(data.class).length) {
      tag = 'xf';
      try { data = GROUPS.xf.src ? await GROUPS.xf.src.home(withFilter) : null; } catch { data = null; }
    }
    if (!data) return { class: [], filters: [] };
    const label = Kishuto.labelOf(tag);
    const classes = [];
    const filters = {};
    for (const item of asList(data.class).slice(0, 12)) {
      const tid = text(item.type_id);
      if (!tid) continue;
      classes.push({ type_id: `${tag}|${tid}`, type_name: `${label}·${text(item.type_name) || tid}` });
    }
    for (const [tid, value] of Object.entries(asDict(data.filters))) {
      filters[`${tag}|${tid}`] = value;
    }
    const list = asList(data.list).map((item) => ({ ...item, vod_id: encVid(tag, item.vod_id) }));
    const result = { class: classes, filters };
    this.homeCache = result;
    this.homeAt = now;
    if (list.length) this.lastList = { tag, list };
    return result;
  }

  async homeVod() {
    for (const tag of ['yt', 'xf']) {
      const src = GROUPS[tag] && GROUPS[tag].src;
      if (!src) continue;
      try {
        const got = await src.homeVod();
        const list = asList(got.list).slice(0, 30).map((item) => ({ ...item, vod_id: encVid(tag, item.vod_id) }));
        if (list.length) return { list };
      } catch { /* next */ }
    }
    return { list: [] };
  }

  async category(tid, pg, ext = {}) {
    const raw = text(tid);
    const cut = raw.indexOf('|');
    const tag = cut > 0 && GROUPS[raw.slice(0, cut)] ? raw.slice(0, cut) : 'yt';
    const id = cut > 0 ? raw.slice(cut + 1) : raw;
    const src = GROUPS[tag] && GROUPS[tag].src;
    if (!src) return { list: [], page: 1, pagecount: 0, limit: 18, total: 0 };
    let got;
    try { got = await src.category(id, pg, ext); } catch { got = { list: [] }; }
    return { ...got, list: asList(got.list).map((item) => ({ ...item, vod_id: encVid(tag, item.vod_id) })) };
  }

  async search(kw, pg = 1) {
    const word = text(kw);
    if (!word) return { list: [] };
    const out = [];
    const seen = new Set();
    const boxes = {};
    const jobs = GROUP_ORDER.map(async (tag) => {
      const src = GROUPS[tag] && GROUPS[tag].src;
      if (!src) return;
      try { boxes[tag] = await src.search(word, pg); } catch { boxes[tag] = null; }
    });
    await Promise.race([Promise.all(jobs), sleep(2800)]);
    for (const tag of GROUP_ORDER) {
      const got = boxes[tag];
      if (!got) continue;
      for (const card of asList(got.list)) {
        const name = text(card.vod_name);
        if (!name) continue;
        const key = normTitle(name);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...card, vod_id: encVid(tag, card.vod_id) });
      }
    }
    return { list: out };
  }

  async detail(vid) {
    const [tag, real] = decVid(vid);
    const src = GROUPS[tag] && GROUPS[tag].src;
    if (!src) return { list: [] };
    let base;
    try { base = await src.detail(real); } catch { base = null; }
    if (!base) return { list: [] };

    let vod;
    let baseLines;
    if (tag === 'yt') {
      vod = asList(base.list)[0] || {};
      baseLines = linesOf(vod);
    } else {
      vod = asDict(base.vod);
      baseLines = asList(base.lines);
    }
    if (!vod || !Object.keys(vod).length) return { list: [] };
    const title = text(vod.vod_name);

    const boxes = {};
    const others = GROUP_ORDER.filter((t) => t !== tag && GROUPS[t] && GROUPS[t].src);
    const jobs = others.map(async (other) => {
      try {
        const got = await GROUPS[other].src.search(title, 1);
        const pick = strictMatch(title, asList(got.list)) || bestMatch(title, asList(got.list), 0.8);
        if (!pick) { boxes[other] = []; return; }
        const d = await GROUPS[other].src.detail(pick.vod_id);
        const lines = other === 'yt' ? linesOf(asList(d.list)[0] || {}) : asList(d.lines);
        boxes[other] = lines.slice(0, 4);
      } catch { boxes[other] = []; }
    });
    await Promise.race([Promise.all(jobs), sleep(2200)]);

    const froms = [];
    const urls = [];
    const used = {};
    const push = (name, eps, subtag) => {
      let label = name;
      if (used[label]) { used[label] += 1; label = `${name}·${used[label]}`; } else used[label] = 1;
      const segs = eps.map(([ep, flag, pid]) => {
        const code = encPlay(tag, subtag || '', flag, pid, vid, ep);
        return `${cleanName(ep) || '正片'}${code ? `$${code}` : ''}`;
      }).filter((seg) => seg.includes('$'));
      if (segs.length) { froms.push(label); urls.push(segs.join('#')); }
    };

    const label = Kishuto.labelOf(tag);
    for (const line of baseLines) {
      const base = cleanName(line.name) || '线路';
      const hasPrefix = base.startsWith(`${label}·`) || base.startsWith(label);
      push(hasPrefix ? base : `${label}·${base}`, asList(line.eps), line.tag);
    }
    for (const other of others) {
      const otherLabel = Kishuto.labelOf(other);
      for (const line of asList(boxes[other])) {
        const base = cleanName(line.name) || '线路';
        const hasPrefix = base.startsWith(`${otherLabel}·`) || base.startsWith(otherLabel);
        push(hasPrefix ? base : `${otherLabel}·${base}`, asList(line.eps), line.tag);
      }
    }

    const result = { ...vod, vod_play_from: froms.join('$$$'), vod_play_url: urls.join('$$$'), vod_id: vid };
    if (!froms.length) {
      result.vod_content = `${text(vod.vod_content)}${NL}${NL}[聚合提示] 没有匹配到可用线路，可稍后重试或换个片名搜索。`.trim();
    }
    return { list: [result] };
  }

  async play(pid, flag = '') {
    const [tag, subtag, flagIn, code] = decPlay(pid);
    const src = GROUPS[tag] && GROUPS[tag].src;
    if (!src) return { parse: 0, url: '', header: { 'User-Agent': UA_WEB } };
    try {
      let got;
      if (tag === 'yt') got = await src.play(code, flagIn || flag);
      else got = await src.play(subtag, flagIn, code);
      return { parse: Number(got.parse) || 0, url: text(got.url), header: got.header || { 'User-Agent': UA_WEB } };
    } catch {
      return { parse: 0, url: '', header: { 'User-Agent': UA_WEB } };
    }
  }
}

// ============================================================
// 插件入口
// ============================================================
const KISH = new Kishuto();

function bodyOf(inReq) {
  return asDict(inReq?.body);
}

export default {
  meta: { key: KEY, name: '🎬 影探聚合(10源)', type: 3 },
  api: async (fastify) => {
    await resolveReqUtil();
    fastify.post('/init', async (inReq) => { KISH.configure(bodyOf(inReq)); return {}; });
    fastify.post('/home', async (inReq) => KISH.home(bodyOf(inReq).filter !== false));
    fastify.post('/homeVod', async () => KISH.homeVod());
    fastify.post('/category', async (inReq) => {
      const body = bodyOf(inReq);
      const ext = body.filters ?? body.extend ?? {};
      return KISH.category(text(body.id ?? body.tid), body.page ?? body.pg, ext);
    });
    fastify.post('/search', async (inReq) => {
      const body = bodyOf(inReq);
      return KISH.search(body.wd ?? body.key, body.page ?? body.pg);
    });
    fastify.post('/detail', async (inReq) => {
      const input = bodyOf(inReq).id;
      const ids = (Array.isArray(input) ? input : [input]).map(text).filter(Boolean);
      const list = [];
      for (const id of ids) {
        const got = await KISH.detail(id);
        list.push(...asList(got.list));
      }
      return { list };
    });
    fastify.post('/play', async (inReq) => {
      const body = bodyOf(inReq);
      const playId = body.id ?? body.play ?? body.url;
      return KISH.play(playId, body.flag ?? body.from ?? '');
    });
  },
};
