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
