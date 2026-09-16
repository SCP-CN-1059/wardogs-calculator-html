# 离线使用（断网运行全部地图）

> 如果连本地服务都不想要，可以直接用**单文件版**：`npm run build:single` 会生成
> `炮兵计算器-单文件版.html`，样式、脚本、地图配置和地图影像全部内嵌，双击即用，
> 不需要服务器也不需要网络。详见 [单文件版](single-file.md)。
> 本文档描述的是功能完整、影像最清晰的离线版（启动后走 `127.0.0.1` 本地服务）。

这个检出已经把三张地图 **Bakurani / Ozeti / Zestafona** 的全部瓦片（黑白 + 彩色两套样式）、
标记图标、地图配置、等高线以及 Terrain3D 高程块都镜像到了本地，
**完全断网也能正常打开、缩放、搜索坐标、画标记测距**。

## 快速开始

双击项目根目录的 `离线启动.cmd`（等价于在项目目录执行 `npm run offline`），
然后浏览器会自动打开：

```text
http://127.0.0.1:8000/
http://127.0.0.1:8000/mobile/     (手机界面)
```

关掉那个命令行窗口（或按 Ctrl+C）就停止服务。整个过程只监听 `127.0.0.1`，
不对外网开放，也不需要管理员权限。

> ⚠️ 不要用“双击 html 文件”的方式打开。浏览器的 `fetch()` 不允许读 `file://`，
> 应用启动时会报 “Interactive tools failed to load”。必须通过上面的本地服务访问。

## 为什么还需要一个小服务

应用启动时要 `fetch()` 地图注册表、语言包、地形 manifest 这些 JSON，
瓦片则是逐个 `<img>` 请求。浏览器出于安全策略禁止 `file://` 页面发起这类请求，
所以离线版用一个几十行的、只读本地文件的 Node 服务把它们发出去
（`scripts/offline-server.mjs`，无第三方依赖，不监听公网，不做文件写入）。

## 数据放在哪里

| 内容 | 本地路径 | 说明 |
| --- | --- | --- |
| 地图注册表与配置 | `maps/index.json`、`maps/*.json` | 仓库自带 |
| 标记图标注册表 / 图标 | `maps/assets.json`、`assets/map-markers/*.webp` | 仓库自带 |
| 黑白瓦片 | `maps/tiles/<map>/zoom_<z>/<x>_<y>.webp` | 镜像下载 |
| 彩色瓦片 | `maps/tiles-color/<map>/zoom_<z>/<x>_<y>.webp` | 镜像下载 |
| 地形 manifest | `data/terrain/<map>/manifest.json` | 仓库自带 |
| 地形高程块 | `data/terrain/<map>/chunks/*.bin` | 镜像下载 |
| 等高线图层 | `data/terrain/<map>/contours.json` | 仓库自带（默认关闭，打开才加载） |
| 弹道/弹道修正表 | `data/weapons.json`、`data/ballistics/**` | 仓库自带 |

镜像的目录结构故意与 CDN 发布目录保持一致：
发布 URL `.../releases/<release>/` **之后**的那段路径，就是仓库里的相对路径。

```text
https://assets.wardogs-artillery.com/releases/assets-v1/maps/tiles/bakurani/zoom_3/2_1.webp
   ->  maps/tiles/bakurani/zoom_3/2_1.webp

https://assets.wardogs-artillery.com/releases/assets-v1/maps/tiles-color/bakurani/zoom_3/2_1.webp
   ->  maps/tiles-color/bakurani/zoom_3/2_1.webp

https://assets.wardogs-artillery.com/releases/assets-v1/data/terrain/bakurani/manifest.json
   ->  data/terrain/bakurani/manifest.json
```

`maps/tiles/`、`maps/tiles-color/`、`data/terrain/**/*.bin` 都在 `.gitignore` 里，
不会污染版本库，也不会进入 `npm run build` 的产物。

## 离线开关是怎么工作的

只有一个开关：`config/app.json` 里的

```json
"offline": { "enabled": true }
```

打开后：

1. `js/core/resources.js` 的 `offlineResourcePath()` 把任何 `https://…/releases/<release>/…`
   形式的发布 URL 重写成仓库内相对路径，其它相对路径（语言包、弹道表、图标）原样通过。
2. 两个调用点因此自动改走本地文件：
   - `js/map/tiles.js` → 瓦片 URL（黑白 / 彩色样式都会改写）
   - `js/features/terrain-ballistics.js` → 高程 manifest（其 chunk 相对 manifest 解析，于是也变成本地）
3. `js/core/config.js` 的 `applyOfflineOverrides()` 在离线下关闭**联机大厅**与**反馈**：
   它们的后端在公网，离线必然失败，关掉可以避免启动时白等几秒。
4. `scripts/offline-server.mjs` 会去掉页面里的 Umami 统计脚本并注入
   `window.__WARDOGS_ANALYTICS_DISABLED__ = true`，和 `npm run dev` 的行为一致。

想恢复“走 CDN / 线上站点”的行为，把 `offline.enabled` 改成 `false` 即可，
地图配置和脚本都不用动。

## 校验与维护

```bash
npm run mirror:verify     # 只检查，不联网：逐张地图报 已镜像/应有、缺失数
npm run mirror            # 补下载瓦片（已存在的文件会跳过，可随时中断重跑）
npm run mirror -- --terrain   # 连 Terrain3D 高程块一起补
npm run mirror -- --force     # 强制重下
npm run mirror -- --maps bakurani --styles color   # 只处理某张图/某个样式
npm run offline -- --check     # 打印镜像状态后退出（不启动服务）
```

镜像脚本对高程块会校验 manifest 里记录的 `sha256` 与字节数；
对发布方本来就没有的瓦片（HTTP 404）记为 “not published”，不算失败。
每次运行都会写一份 `offline-mirror-report.json`（已 gitignore）。

## 体积（实测）

镜像完成后的实际占用（`npm run mirror:verify` 输出）：

| 项目 | 文件数 | 占用 |
| --- | --- | --- |
| Bakurani 黑白瓦片 / 彩色瓦片 | 21,845 / 21,845 | 637 MB / 1.46 GB |
| Ozeti 黑白瓦片 / 彩色瓦片 | 21,845 / 21,845 | 619 MB / 1.38 GB |
| Zestafona 黑白瓦片 / 彩色瓦片 | 21,845 / 21,845 | 536 MB / 1.33 GB |
| Terrain3D 高程块（3 图 × 256 块） | 768 | 3 × 127.5 MB |
| **合计** | **131,838** | **≈ 6.3 GB** |

每张图每个样式都是完整的 z0–z7 金字塔（21,845 张），发布方缺图 0 张、下载失败 0 张、
校验不一致 0 个。留出 7 GB 以上磁盘空间即可。

## 验证记录

本检出在**屏蔽全部外部域名**（Chrome `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`，
即除本机以外的域名一律解析失败）的条件下实测通过：

- Bakurani / Ozeti / Zestafona 三张地图，黑白与彩色两种样式，桌面与手机界面均正常渲染；
- 页面请求的资源全部来自 `127.0.0.1:8000`，外部请求数为 **0**；
- 选择 SPH-2 并给出射击解后，`data/terrain/<map>/manifest.json` 与
  `data/terrain/<map>/chunks/*.bin` 都从本地加载，地形高程（ΔZ）照常工作；
- 等高线图层在本地 `contours.json` 上工作。

## 已知限制

- **联机大厅、反馈**需要公网后端，离线模式已禁用；本地标注、导出/导入、
  保存目标、坐标搜索、测距、Terrain3D 高程修正都照常可用。
- **SEO 落地页**（`/maps/bakurani/` 这种）是构建时生成的，离线不生成；
  本地服务会把该路径 302 到 `/?map=bakurani`，直接进计算器并选好地图。
- 镜像不完整时，缺的那一块瓦片渲染成深色占位（不会白屏）。
- 把整个文件夹拷到另一台电脑也能用，前提是那台机器装了 **Node.js 18+**。

## 常见问题

- **端口 8000 被占用**：`离线启动.cmd --port 8100`，或
  `node scripts/offline-server.mjs --port 8100`。
- **Windows 防火墙弹窗**：只绑定了 `127.0.0.1`，可以直接拒绝公网访问。
- **地图是空白方块**：先 `npm run mirror:verify`；再按 F12 看 Network，
  如果请求打到了 `assets.wardogs-artillery.com`，说明 `offline.enabled` 没生效
  （确认是通过本地服务打开、并且 `config/app.json` 是最新内容）。
- **想自己验证“真断网也能用”**：用 Chrome 带上
  `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"` 打开
  `http://127.0.0.1:8000/`，除本机以外的域名全部解析失败，仍能正常显示地图即通过。
- **发布方更新了地图（例如 `assets-v2`）**：改 `maps/*.json` 里的 `tiles.path`
  （或 `data/ballistics/terrain-context.json` 里的 manifest 地址）后重新跑
  `npm run mirror -- --terrain`，脚本会按 JSON 里的新 URL 下载到对应本地路径。

## 本次新增/改动的文件

新增：

- `scripts/fetch-map-tiles.mjs` — 镜像下载器（可续传、可校验，含 `--verify` / `--terrain` / `--terrain-only`）
- `scripts/offline-server.mjs` — 离线静态服务 + 镜像自检
- `scripts/lib/offline-paths.test.mjs` — 用真实运行时代码校验「发布路径 ↔ 本地镜像路径」契约
- `离线启动.cmd` — 一键启动
- `docs/offline.md` — 本文档

改动：

- `config/app.json` — 新增 `offline` 开关
- `js/core/resources.js` — 新增 `offlineResourcePath()` / `isOfflineMode()`
- `js/map/tiles.js` — 瓦片 URL 走离线改写
- `js/features/terrain-ballistics.js` — 高程 manifest 走离线改写
- `js/core/config.js` — 离线时关闭联机大厅与反馈
- `scripts/build-pages.mjs` — 构建产物排除 `maps/tiles-color/`（与 `maps/tiles/` 同理）
- `package.json` — 新增 `offline` / `mirror` / `mirror:verify` 脚本
- `.gitignore` — 忽略 `maps/tiles-color/` 与镜像报告
- `README.md` — 新增 Offline Use 小节
