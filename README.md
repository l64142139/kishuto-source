# 影探聚合（Kishuto）· 10 源聚合源

移植自 `影探聚合.py`，与 `影探4k.js` 同一套 `{ meta, api }` 插件契约。单文件、无第三方依赖（只用 Node 内置 `crypto` / `zlib` / `fetch`）。

## 两种用法

### A. 当插件用（Node 宿主，`src/sources/`）
把 `kishuto.js` 放进宿主的 `src/sources/`，宿主提供 `../../util/req.js` 与 `../../util/home-cache.js`（缺失时自动退回全局 `fetch`）。路由：`POST /init /home /homeVod /category /detail /play /search`。

### B. 当 TVBox / 猫影视源用（本项目自带宿主）
`server.mjs` 挂载上面的插件，并补一层苹果CMS v10 兼容接口。

```bash
npm install
PUBLIC_BASE=http://你的公网地址:18081 node server.mjs
# 或 docker build -t kishuto . && docker run -d -p 18081:18081 -e PUBLIC_BASE=http://你的公网地址:18081 kishuto
```

`PUBLIC_BASE` 必须填**客户端能访问到的地址**，播放链接靠它拼出来。

#### TVBox / 猫影视 配置（type:1 JSON 源）

```json
{
  "sites": [
    {
      "key": "kishuto",
      "name": "影探聚合",
      "type": 1,
      "api": "http://你的公网地址:18081/api.php/provide/vod/",
      "searchable": 1,
      "quickSearch": 1,
      "filter": 0
    }
  ]
}
```

接口：

| 请求 | 作用 |
|---|---|
| `/api.php/provide/vod/?ac=list` | 分类表 + 首页 30 条 |
| `/api.php/provide/vod/?ac=list&t=1&pg=1` | 按分类翻页（t 见返回的 class） |
| `/api.php/provide/vod/?ac=detail&wd=关键词` | 搜索（前 4 条带完整线路） |
| `/api.php/provide/vod/?ac=detail&ids=<vod_id>` | 详情 |
| `/p?t=<k2令牌>` | 播放：m3u8 走 `/s` 代理，其他直接 302 |
| `/s?u=<b64url>&r=<b64url referer>` | 取流代理，m3u8 内切片/密钥地址自动改写 |

#### 直链接口（给非 TVBox 客户端）

```
POST /home      POST /homeVod   POST /category   POST /detail   POST /play   POST /search
```

## 源清单（10 个）

- 第一组：影探4K、咕噜咕噜、橘汁4K、找剧AI
- 第二组：稀饭动漫、GiriGiri、次元城、OmoFun
- 第三组：小鸡看看
- 第四组：枫奇4K
- 第五组：橘汁新网关（默认关闭）

## 配置（`/init` 的 body，均可省略）

```json
{ "xj": false, "fq": false, "jn": true,
  "xifan": { "host": "...", "api": "..." },
  "cyc_username": "...", "cyc_password": "...", "cyc_token": "..." }
```

## 线路与播放

- 详情返回的线路会按可播性排序：直链类（鲸宝/菲乐/咖啡/酷萌/豪华/红牛/新浪/zyk/4K/蓝光）在前，网盘类（联通云/天翼云/优酷）排到最后并标注 `(网盘)`——这些是下载地址，不是视频流。
- m3u8 不直接 302，而是跳到 `/s` 代理：由服务端带 UA/Referer 取流并改写切片地址，安卓端不需要任何额外请求头，避免 `403 the source ip is forbidden` 和 Referer 校验。
- 播放失败会返回 502 和原因（如「该线路是网盘下载地址」），不会让播放器干等。

## 已知限制

- 枫奇列表/搜索页有图形验证码，只有详情+播放可用；分类第 1 页回退读首页卡片（84 条）。
- 次元城播放需登录，未配置账号时线路名带「(需登录)」。
- 橘汁新网关握手返回 `100001`，默认不加载，需 `{"jn": true}` 才启用。
- 小山影视 / 四源4K专线 / FoFo影院上游已下线，未接入。
- 详情解析偏慢（多源并发补线路，冷缓存约 7–8 秒），宿主已加 60–120 秒内存缓存。

## 文件

| 文件 | 说明 |
|---|---|
| `kishuto.js` | 插件本体，10 源 |
| `server.mjs` | TVBox 兼容宿主（fastify + 苹果CMS 路由） |
| `Dockerfile` | 一键部署 |
