# 影探聚合（Kishuto）· JS 插件源

由 `影探聚合.py` 移植，插件契约对齐 `影探4k.js`。单文件、无第三方依赖（只用 Node 内置 `crypto` / `zlib` / `fetch`）。

## 文件

| 路径 | 说明 |
|---|---|
| `kishuto.js` | 主文件，4220 行，10 个源 |

## 在线地址

```
原始（GitHub Raw）
https://raw.githubusercontent.com/l64142139/kishuto-source/main/kishuto.js

加速（jsDelivr CDN，国内更快）
https://cdn.jsdelivr.net/gh/l64142139/kishuto-source@main/kishuto.js
```

## 契约

```js
export default {
  meta: { key: 'kishuto', name: '🎬 影探聚合(10源)', type: 3 },
  api: async (fastify) => { /* POST /init /home /homeVod /category /detail /play /search */ }
};
```

宿主需提供 `../../util/req.js` 与 `../../util/home-cache.js`（与 `影探4k.js` 相同的目录结构），例如放在 `src/sources/` 下。

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

## 已知限制

- 枫奇列表/搜索页有图形验证码，只有详情+播放可用；分类第 1 页回退读首页卡片（84 条）。
- 次元城播放需登录，未配置账号时线路名带「(需登录)」。
- 橘汁新网关握手返回 `100001`，默认不加载，需 `{"jn": true}` 才启用。
- 小山影视 / 四源4K专线 / FoFo影院上游已下线，未接入。

## 注意

这是 **Node + fastify 插件**，不是 TVBox/CatVod 内置 JS 引擎（QuickJS）的规则源。猫影视/TVBox 直接填本地址无法运行，需要配套的 Node 宿主；若要 TVBox 原生可用，需另转 `var rule = {…}` 规则格式。
