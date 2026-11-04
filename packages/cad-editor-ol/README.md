# CAD Editor OL (`@mlightcad/cad-editor-ol`)

私有 fork，基于 [`packages/cad-editor`](../cad-editor)（上游包名仍为
`@mlightcad/cad-viewer`），为 GIS 业务裁剪并改造：

- **默认不打开图纸**：`dev` 入口挂载一个空的 ISO 模板图，通过工具条 `Open`
  打开本地文件（后续接后端图纸列表）。
- **移除**：CAD Agent、HTML 导出、PDF 导出、SVG 导出、PNG 导出、OneDrive、
  Google Drive，以及对应的工具条/菜单/对话框/命令。
- **保留**：CAD Script 面板（`@mlightcad/cad-script-plugin`）、DXF 导出
  （File → Export → Convert）、图层/属性/测量/查找等核心编辑能力。
- **DWG 解析只有 acad-rust**（MPL-2.0），不加载 GPL 的 libredwg converter。
- **后端落点**：`dev/api/client.ts`（`cadApiRequest` / `cadApiBaseUrl`）。

## 开发

```bash
# 仅启动本包（需要仓库根目录存在 caddata/ 资源检出）
pnpm --filter @mlightcad/cad-editor-ol dev

# 构建库产物（dist/cad-editor-ol.js + dist/cad-editor-ol.d.ts）
pnpm --filter @mlightcad/cad-editor-ol build
```

`vite.config.ts` 同时服务两种模式：

| 模式 | 入口 | 产物 |
| --- | --- | --- |
| `vite`（dev） | `index.html` → `dev/main.ts` | 内存中的 dev server |
| `vite build`（lib） | `build.lib.entry = src/index.ts` | `dist/cad-editor-ol.js` |

`caddata/` 由 vite 中间件映射到 `/cad-data/`，用于字体、模板与示例图纸；
worker（acad-rust 解析器、mtext 渲染器）由 `vite-plugin-static-copy` 复制到
`assets/`。

## 本地 data-model / mtext 覆盖

本包直接对接兄弟目录里维护的三个 checkout：`realdwg-web` 的
`@mlightcad/data-model`，以及 `mtext-renderer` / `mtext-parser` 仓库。
`node_modules` 里装的是 `pnpm` 按上游声明固定的版本（根
`pnpm-workspace.yaml` 的 override 指向 vendored data-model tarball）。覆盖只
发生在**本包的 vite 配置**里，因此根配置、`pnpm-lock.yaml` 与其他包保持与
上游一致，合并上游时不会冲突。

```bash
# 默认：data-model 用 ../realdwg-web/packages/data-model/lib/，
# mtext 用 ../mtext-renderer/... 与 ../mtext-parser 的 dist 产物
pnpm --filter @mlightcad/cad-editor-ol dev

# 直连 data-model 源码（免 build，改完 src 直接生效）
CAD_LOCAL_REALDWG_SRC=1 pnpm --filter @mlightcad/cad-editor-ol dev

# 关闭某一族覆盖（回到 node_modules 里的固定版本，用于验证固定版本）
CAD_LOCAL_REALDWG=0 pnpm --filter @mlightcad/cad-editor-ol dev
CAD_LOCAL_MTEXT=0 pnpm --filter @mlightcad/cad-editor-ol dev

# 用本地 data-model 的类型做类型检查 + 构建
pnpm --filter @mlightcad/cad-editor-ol build:local
```

| 环境变量 | 作用 |
| --- | --- |
| `CAD_LOCAL_REALDWG` | checkout 根目录，默认 `../../../realdwg-web`；`0`/`false`/`off` 关闭 |
| `CAD_LOCAL_REALDWG_SRC` | `1` 时别名到 `src/index.ts`（需 vite 现编），默认用 `lib/index.js` |
| `CAD_LOCAL_MTEXT` | `0`/`false`/`off` 关闭 mtext 覆盖，默认探测到 checkout 即启用 |

实现见 `localMlightcad.ts`，每个包名只重写一次说明符：

- `@mlightcad/data-model` 的内部依赖（`common` / `geometry-engine` /
  `graphic-interface` / `emf-converter`）沿 checkout 自己的 `node_modules`
  解析，家族版本保持一致、全图只有一个实例。
- `@mlightcad/mtext-renderer` / `@mlightcad/mtext-parser` 必须成对重写：
  renderer 的产物会从自己的 `node_modules` 找 parser，只改其一会得到两个
  parser 实例。
- `three` 一并指到本包解析到的那份：checkout 自带 `three`，否则跨边界的
  `instanceof THREE.*` 会失效。
- mtext worker 是独立 bundle，alias 管不到，因此直接复制 checkout 自己的
  `dist/mtext-renderer-worker.js`，保证主线程与 worker 同源。

checkout 不存在时自动回退到 `node_modules`，因此 CI 与没有这些目录的机器照常
构建。类型侧由 `tsconfig.local.json`（`build:local` / `typecheck:local`）对齐。

> `vite build` 的产物中 data-model / mtext-renderer 仍是外部依赖
> （`peerDepsExternal`），所以覆盖只作用于本包的 dev/preview；由别的应用
> 消费 `dist` 时，需在其构建配置中复用 `localMlightcad()` 的 alias。

## 使用

```vue
<script setup lang="ts">
import { MlCadViewer } from '@mlightcad/cad-editor-ol'
</script>

<template>
  <MlCadViewer base-url="/cad-data/" />
</template>
```

打开文件：工具条 `Open`（`AcApOpenCmd`），或给组件传 `url` / `local-file`。

## 上游同步

本包是 `packages/cad-editor` 的裁剪副本，不参与上游发布。同步步骤：

1. 对比 `packages/cad-editor` 与上游最新版本；
2. 重新应用本文档「移除」清单中的裁剪；
3. 重点检查 `src/app/register.ts`（插件注册）、
   `src/component/ribbon/MlRibbonCommands.vue`（File 菜单）、
   `src/component/palette/MlPaletteManager.vue`（面板页签）。
