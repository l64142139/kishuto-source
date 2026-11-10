// 影探聚合 · TVBox / 猫影视 兼容宿主
//   1) 直接挂载 kishuto.js 的 7 个 fastify 路由（/init /home /homeVod /category /detail /play /search）
//   2) 再补一层苹果CMS v10 兼容接口，让 TVBox / 猫影视 用「type:1 JSON 源」接入：
//        GET /api.php/provide/vod/?ac=list&t=<分类>&pg=<页>
//        GET /api.php/provide/vod/?ac=detail&ids=<id>
//        GET /api.php/provide/vod/?ac=detail&wd=<关键词>
//        GET /api.php/provide/vod/?ac=detail&t=<分类>&pg=<页>
//   3) 播放走 GET /p?t=<k2令牌> → 302 跳真实直链（TVBox 播放器会跟随跳转）
//   启动：node server.mjs        端口：PORT，默认 18081；部署时把 PUBLIC_BASE 设成公网地址
import Fastify from 'fastify';

// 源码文件名可能是 kishuto.js（仓库用）或 影探聚合.js（本地用）
let plugin;
for (const path of ['./kishuto.js', './影探聚合.js']) {
  try { plugin = (await import(path)).default; break; } catch { /* next */ }
}
if (!plugin) throw new Error('找不到 kishuto.js / 影探聚合.js');

const PORT = Number(process.env.PORT || 18081);
const HOST = process.env.HOST || '0.0.0.0';
const BASE = process.env.PUBLIC_BASE || `http://127.0.0.1:${PORT}`;

const app = Fastify({
  logger: false,
  bodyLimit: 8 * 1024 * 1024,
  keepAliveTimeout: 65_000,
  disableRequestLogging: true,
});

// 影探4k.js 的插件是 { meta, api }，api 才是 fastify 插件函数
await app.register(async (f) => plugin.api(f));

const call = (url, body) => app.inject({ method: 'POST', url, payload: body || {} }).then((res) => {
  try { return JSON.parse(res.body || '{}'); } catch { return {}; }
});

// ---------- 分类表：把组内分类 id（yt|1 / xf|1 …）编成纯数字 t ----------
const TID = new Map();   // t -> 组内分类 id
const TNAME = new Map(); // t -> 名称
let classReady = false;

async function ensureClass() {
  if (classReady) return;
  const home = await call('/home', { filter: true });
  let n = 0;
  for (const cls of home.class || []) {
    n += 1;
    TID.set(String(n), cls.type_id);
    TNAME.set(String(n), cls.type_name);
  }
  classReady = n > 0;
}

function cmsClass() {
  return [...TNAME.entries()].map(([type_id, type_name]) => ({ type_id: Number(type_id), type_name }));
}

function cardOf(item, typeId) {
  return {
    vod_id: item.vod_id,
    vod_name: item.vod_name || '',
    vod_pic: item.vod_pic || '',
    vod_remarks: item.vod_remarks || '',
    vod_year: item.vod_year || '',
    vod_area: item.vod_area || '',
    vod_lang: item.vod_lang || '',
    vod_score: item.vod_score || '',
    vod_time: item.vod_time || '',
    type_id: typeId || '',
    type_name: TNAME.get(String(typeId)) || '',
  };
}

// 把 vod_play_url 里的 k2 令牌换成 /p?t=<token>，TVBox 点开即 302 到真直链
function rewritePlay(vod) {
  const self = BASE.replace(/\/$/, '');
  const from = String(vod.vod_play_from || '');
  const urls = String(vod.vod_play_url || '');
  if (!urls) return vod;
  const blocks = urls.split('$$$').map((line) => line.split('#').map((ep) => {
    const idx = ep.indexOf('$');
    if (idx < 0) return ep;
    const name = ep.slice(0, idx);
    const code = ep.slice(idx + 1);
    return `${name}$${self}/p?t=${encodeURIComponent(code)}`;
  }).join('#'));
  return { ...vod, vod_play_from: from, vod_play_url: blocks.join('$$$') };
}

// ---------- 最简单的内存缓存，挡掉 TVBox 的重复请求 ----------
const MEM = new Map();
async function memo(key, ttlMs, fn) {
  const hit = MEM.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = await fn();
  MEM.set(key, { value, exp: Date.now() + ttlMs });
  if (MEM.size > 400) {
    const first = MEM.keys().next().value;
    MEM.delete(first);
  }
  return value;
}

async function detailOf(id) {
  return memo(`d:${id}`, 120_000, async () => {
    const got = await call('/detail', { id });
    return (got.list || [])[0] || null;
  });
}

async function detailMany(ids, limit = 4) {
  const want = ids.slice(0, limit);
  const got = await Promise.all(want.map((id) => detailOf(id).catch(() => null)));
  return got.filter(Boolean);
}

// ---------- 苹果CMS 兼容路由 ----------
async function cms(req, reply) {
  const q = req.query || {};
  const ac = String(q.ac || 'list').toLowerCase();
  const pg = Math.max(1, Number(q.pg || q.page || 1) || 1);
  const t = String(q.t || q.type_id || '0');
  const wd = String(q.wd || q.key || '').trim();
  const ids = String(q.ids || q.id || '').split(',').map((x) => x.trim()).filter(Boolean);

  await ensureClass();
  reply.header('access-control-allow-origin', '*');

  // 详情 / 搜索
  if (ac === 'detail') {
    if (wd) {
      return memo(`s:${wd}:${pg}`, 90_000, async () => {
        const found = await call('/search', { wd, page: pg });
        const list = (found.list || []).slice(0, 14);
        const full = await detailMany(list.slice(0, 4).map((x) => x.vod_id));
        const cards = full.map(rewritePlay);
        const rest = list.slice(4).map((x) => cardOf(x, ''));
        return { code: 1, msg: '数据列表', page: pg, pagecount: 1, limit: 20, total: cards.length + rest.length, list: [...cards, ...rest], class: cmsClass() };
      });
    }
    // ac=detail 不带 ids/wd 时，TVBox 有时当分类列表用
    if (!ids.length) {
      if (t && t !== '0' && TID.has(t)) {
        const cid = TID.get(t);
        const got2 = await call('/category', { id: cid, page: String(pg) });
        const list2 = (got2.list || []).map((x) => cardOf(x, t));
        return { code: 1, msg: '数据列表', page: pg, pagecount: Number(got2.pagecount || 1) || 1, limit: Number(got2.limit || 20) || 20, total: Number(got2.total || list2.length) || list2.length, list: list2, class: cmsClass() };
      }
      const home2 = await call('/homeVod', {});
      const list3 = (home2.list || []).map((x) => cardOf(x, ''));
      return { code: 1, msg: '数据列表', page: pg, pagecount: 1, limit: 30, total: list3.length, list: list3, class: cmsClass() };
    }
    const got = await detailMany(ids, 6);
    return { code: 1, msg: '数据列表', page: pg, pagecount: 1, limit: got.length, total: got.length, list: got.map(rewritePlay), class: cmsClass() };
  }

  // 列表：带分类就翻分类，不带就回首页
  const pageIn = String(pg);
  if (t && t !== '0' && TID.has(t)) {
    const cid = TID.get(t);
    return memo(`c:${cid}:${pageIn}`, 60_000, async () => {
      const got = await call('/category', { id: cid, page: pageIn });
      const list = (got.list || []).map((x) => cardOf(x, t));
      return {
        code: 1, msg: '数据列表', page: pg,
        pagecount: Number(got.pagecount || 1) || 1,
        limit: Number(got.limit || 20) || 20,
        total: Number(got.total || list.length) || list.length,
        list, class: cmsClass(),
      };
    });
  }

  return memo(`h:${pg}`, 60_000, async () => {
    const home = await call('/homeVod', {});
    const list = (home.list || []).map((x) => cardOf(x, ''));
    return { code: 1, msg: '数据列表', page: pg, pagecount: 1, limit: 30, total: list.length, list, class: cmsClass() };
  });
}

app.get('/api.php/provide/vod/', cms);
app.get('/api.php/provide/vod', cms);
app.get('/api.php/provide/vod/at/json', cms);
app.get('/api.php/provide/vod/at/xml', cms);

// 播放：302 到真实直链
async function playTo(req, reply) {
  const token = String((req.query && (req.query.t || req.query.token)) || '');
  if (!token) return reply.code(400).send({ code: 0, msg: 'missing token' });
  const free = MEM.get(`p:${token}`);
  if (free && free.exp > Date.now()) {
    return reply.redirect(free.value, 302);
  }
  const got = await call('/play', { id: token });
  const url = String(got.url || '');
  if (!/^https?:\/\//i.test(url)) {
    return reply.code(404).send({ code: 0, msg: got.msg || '解析失败', detail: got });
  }
  MEM.set(`p:${token}`, { value: url, exp: Date.now() + 600_000 });
  return reply.redirect(url, 302);
}

// 播放令牌走查询串：k2 有 500+ 字符，路径参数放不下（且和插件的 POST /play 同路径易撞车）
app.get('/p', playTo);
app.head('/p', async (req, reply) => reply.code(200).send());

app.get('/', async () => ({
  ok: true,
  name: '影探聚合 · TVBox 兼容宿主',
  cms: `${BASE}/api.php/provide/vod/`,
  config: {
    'type:1 源地址': `${BASE}/api.php/provide/vod/`,
    '接口说明': 'ac=list 取分类与列表，ac=detail&wd= 搜索，ac=detail&ids= 详情，播放走 /p?t=<token>',
  },
}));

app.get('/health', async () => ({ ok: true }));

await app.listen({ port: PORT, host: HOST });
console.log(`[kishuto] http://${HOST}:${PORT}  cms=${BASE}/api.php/provide/vod/`);
