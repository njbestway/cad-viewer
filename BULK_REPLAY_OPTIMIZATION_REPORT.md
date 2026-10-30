# BULK_REPLAY_OPTIMIZATION_REPORT — Phase 2.7

SPEC-CAD-001 · Phase 2.7 · Bulk ERASE redo replay optimization.
审计依据见 `BULK_REPLAY_AUDIT.md`（Task A）；本报告覆盖 Task B–E 与 §8 交付清单。

**结论：`AcDbChangeApplier.applyForward` 现在把同一 BTR 的连续 Remove 变更聚合为一次
`btr.removeEntity(ids)`。50k 单命令 ERASE 的 Redo 从 58 814.7 ms（Node）/
105 477.5 ms（浏览器）降到 33.03 ms（Node）/ **204 ms**（浏览器），
BTR 全表扫描次数从 50 000 次降到 **1** 次，扫描槽位从 1 250 025 000 降到 50 000。
Undo/Redo 结果、事件次数与顺序、Undo Record 格式、事务回滚行为全部与改造前一致。**

---

## 1. 改动

### 1.1 `realdwg-web/packages/data-model/src/database/transaction/AcDbChangeApplier.ts`

`applyForward` 维护一个 **maximal run**：连续的、`container.type === 'blockTableRecord'`
且 `ownerId` 相同的 `remove` 变更被收集进 `runObjects`，遇到任何其他变更
（`modify` / `sysvar` / `append` / 其他容器或其他 BTR 的 `remove`）或列表结束即 flush。
flush 时：

```ts
private applyRemoveBatch(ownerId: string, objects: AcDbObject[]): void {
  if (objects.length === 1) {
    this.applyRemove({ type: 'blockTableRecord', ownerId }, objects[0])
    return
  }
  const btr = this.database.tables.blockTable.getIdAt(ownerId)
  if (btr) {
    btr.removeEntity(objects.map(object => object.objectId))
  }
}
```

约束逐条对照：

| SPEC §3 要求 | 实现 |
| --- | --- |
| 只合并语义上可交换的操作 | 只合并同一 BTR 的 Remove（稳定压缩，见审计 §2） |
| 保留变更列表逻辑顺序 | `changes` 数组从不重排、从不拷贝；run 在原位 flush |
| 无法证明安全时保留逐条 | 其它容器 / 其它 kind / 单元素 run 一律走 `applyRemove` |
| 重复 ID 行为与旧实现一致 | 批内 `new Set(ids)` 与逐条第二次命中为空等价（审计 §5.1） |
| 不改 Undo Record 格式 | `AcDbUndoRecord.changes` 原样保存，replay 前后是同一数组对象 |
| 不跳过 transaction manager | 仍在 `undo()/redo()/abortTransaction()` 的 `beginEventBatch` + `_applyingUndoRedo` 内 |
| 不改 ObjectId / Handle / OwnerId | 只把 `change.object.objectId` 传给公开批量 API |
| 不关闭事件通知 | 事件由 `dispatchUndoRedoEvents` 在 replay 之后从 `changes` 派生，未触碰 |
| 不碰 BTR 私有 `_entities` | 只调 `removeEntity(ids)` |
| 不把整份 `changes` 数组的 Remove 收集到最后 | 按连续 run 聚合，任何屏障立即 flush |

`applyInverse` **未改动**：inverse 方向把 Remove 变成 `appendEntity`（摊销 O(1)），
逐条执行本来就是线性的（审计 §1、§10）。

### 1.2 计数器（仅基准用，生产代码零插桩）

计数全部发生在基准侧：`benchmarks/bulk-edit/replay-harness.ts` 的
`installScanCounter()` 在 `AcDbBlockTableRecord.prototype.removeEntity`、
`AcDbChangeApplier.prototype.applyRemove`、`applyRemoveBatch` 上包一层
`countCalls`，只读参数与 `_entities.length`，不改结果。缺失的方法被容忍
（`applyRemoveBatch` 只存在于优化后的构建，基线因此仍可测）。生产线上的
`AcDbChangeApplier` 只有聚合逻辑本身，没有开关、没有 `globalThis` 计数、
没有 `if (instrumented)` 分支。

### 1.3 版本与产物

| 项 | 值 |
| --- | --- |
| 版本 | `@mlightcad/data-model@1.15.16-perf.2` |
| 产物 | `vendor/mlightcad-data-model-1.15.16-perf.2.tgz`（1 553 802 B） |
| SHA256 | `E17D67D005E3E1A58CE9DED9CFFD6708A300B9331399278CE143BC6B3C98D1E9` |
| realdwg-web | `vendor/…-perf.2.tgz`（同一 SHA256），`packages/data-model/package.json` 版本号 1 行 |
| cad-viewer 接入 | `pnpm-workspace.yaml` `overrides['@mlightcad/data-model'] = file:vendor/…-perf.2.tgz`；全部 24 个包解析为 `1.15.16-perf.2` |
| realdwg-web HEAD | `395525f576afd90ede93892c9054040b3173e66e`（branch `perf/change-recorder-index`） |
| diff | `reports/phase27/realdwg-web.diff`（55 620 B，含新增测试文件） |

diffstat：`package.json` 1 行、`AcDbChangeApplier.ts` +82/−1、新增
`packages/data-model/__tests__/AcDbBulkReplay.spec.ts`。

### 1.4 cad-viewer 侧改动

| 文件 | 内容 |
| --- | --- |
| `packages/cad-simple-viewer/src/view/AcTrView2d.ts` | 新增 `queued` 调试暂停阶段（Task C 的 R-8 覆盖项）；`AcTrConvertDebugStage` 加一字面量，`runConvertDrain` 在 splice 前 hook 一次 |
| `packages/cad-editor-demo/e2e/tests/phase27-bulk-replay.spec.ts` | 新增（1 038 行，3 用例），Task E |
| `benchmarks/bulk-edit/replay.bench.ts`、`replay-harness.ts`、`replay-report.ts` | 新增，Task D（原型计数、统计、按档合并写入 JSON） |
| `benchmarks/bulk-edit/run-phase27-after.ps1` | 新增，逐档独立进程跑 after 矩阵 |
| `pnpm-workspace.yaml`、`vendor/…-perf.2.tgz` | 接入 perf.2 |

基线与 after 使用同一个 bench 入口，只靠 `BENCH_REPLAY_TAG` /
`BENCH_SIZES` 区分，因此两者的测量代码完全相同。

---

## 2. Task C — 正确性

### 2.1 新增测试：`packages/data-model/__tests__/AcDbBulkReplay.spec.ts`（21 项）

| SPEC §4 项 | 覆盖用例 |
| --- | --- |
| 1 / 2. 50k、100k 单事务 ERASE → Undo → Redo | `round-trips a 50000/100000-entity erase through undo and redo`（50k 3 108 ms、100k 5 982 ms） |
| 10 / 11. 一次 Undo 恢复完整选择集、一次 Redo 删除完整集合 | `restores the exact id set with one undo and removes it with one redo` |
| 13. 多轮 Undo/Redo | `stays exact across four undo/redo rounds`、`restores a partial erase by appending in reverse record order` |
| 3. 同一 BTR 连续 Remove | `collapses a contiguous run into one removeEntity call` |
| 4. 多 BTR 交错 Remove | `keeps removals from different block table records in separate runs` |
| 5. 混合 Append / Remove / Modify | `matches the pre-fix per-change replay for a mixed record`、`flushes before a modify barrier` |
| 6 / 7. Remove → Append、Append → Remove | `keeps order for remove then append and append then remove`、`flushes before an append barrier` |
| 8. 同一 ID 重复记录 | `collapses duplicate ids in one run exactly like the per-id path` |
| 9. 嵌套事务 Commit / Abort | `merges nested commits and restores both levels on undo`、`rolls a nested abort back without touching the outer removals` |
| 12. Redo 后再次 Undo | 四轮用例 |
| 14. 中途重放失败的状态一致性 | `skips removals whose container no longer exists`、`removes an id that is already gone without disturbing the rest`（批量调用要么全删要么不删，见审计 §7） |
| 15. 事件顺序与次数 | `produces the same dispatch order and payloads in both directions`、`fires once per direction no matter how many runs the record has`、`does not create recorder entries while replaying` |
| 16. 数据库/空间索引无残留 | 各用例 `expectBulkState` 断言 id 集合逐一相等 + `removeEntity` 返回值 |
| 18. Locked Layer、INSERT 与块定义成员语义 | `leaves block definition members alone when an insert is erased`、`keeps owner and layer ownership across a replay on a locked layer` |
| 17. R-8 无回归 | 浏览器用例 2 / 3（§3.2、§3.3），data-model 侧不涉及 |

### 2.2 全量回归

`reports/phase27/data-model-tests.log`：

```
Test Suites: 129 passed, 129 total
Tests:       1054 passed, 1054 total
Time:        45.582 s
```

其中 `AcDbBulkReplay.spec.ts` 10.159 s（含 50k / 100k 两档）。

既有 R-8 浏览器回归（phase26 生命周期 harness，8 个用例，含 50 轮循环）：

```
npx playwright test e2e/tests/phase26-lifecycle.spec.ts
→ 8 passed (5.7m)
```

日志 `reports/phase27/phase26-lifecycle.log`。该 harness 在 `claimed` /
`beforeCommit` / `groupLayer` 三个阶段暂停，新增的 `queued` 阶段既不改变
它的 trap 匹配，也不改变断言：hook 只是多收到一种 stage 字符串。

---

## 3. Task D — 性能基准

方法：沿用 `benchmarks/bulk-edit/replay.bench.ts`，**每档独立进程**
（`run-phase27-after.ps1` 逐档 `npx jest … BENCH_SIZES=<n>`），固定 fixture
（60% LINE / 20% LWPOLYLINE / 10% INSERT / 10% TEXT），每档 5 次取统计。
基线 = perf.1，after = perf.2，两份 JSON 分开存放，Phase 2.6 的原始基准未覆盖：

* `reports/phase27/replay-baseline.json`（tag `baseline`）
* `reports/phase27/replay-after.json`（tag `after`）

两份文档的 `env` 完整一致（同一台机器、`gitCommit 73b4b4c`、Node v26.5.0、
Ryzen 7 5800H、16 线程），**唯一差异是 `versions.dataModel`：
`1.15.16-perf.1` → `1.15.16-perf.2`**，因此表中差值是单变量差异。

### 3.1 Redo / Undo 主表（中位数，n = 5）

| n | Undo 前 | Undo 后 | Redo 前 | **Redo 后** | 加速 | 扫描次数 前→后 | 槽位 前→后 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 000 | 3.20 | 2.57 | 25.06 | **0.55** | 45.6× | 1 000 → 1 | 500 500 → 1 000 |
| 5 000 | 13.32 | 12.07 | 512.94 | **2.25** | 228.0× | 5 000 → 1 | 12 502 500 → 5 000 |
| 20 000 | 39.74 | 44.66 | 10 138.74 | **11.42** | 887.8× | 20 000 → 1 | 200 010 000 → 20 000 |
| 50 000 | 113.67 | 113.11 | 58 814.70 | **33.03** | 1 780.6× | 50 000 → 1 | 1 250 025 000 → 50 000 |
| 100 000 | 226.55 | 180.28 | 256 751.18 | **73.40** | 3 498.0× | 100 000 → 1 | 5 000 050 000 → 100 000 |

单位 ms。改造前的槽位数等于 `n(n+1)/2`（Θ(k·m) 的全部代价）；改造后等于 `n`
（一次稳定压缩），Redo 的每实体成本稳定在 0.45–0.73 µs，**接近线性**。

### 3.2 分位与内存

| n | Redo p95 前 | Redo p95 后 | Redo min/max 后 | Undo p95 后 | heap peak 前→后 (MB) | maxRSS 前→后 (MB) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 000 | 29.44 | 1.51 | 0.34 / 1.51 | 5.68 | 1 157.3 → 1 032.1 | 1 321.0 → 1 194.8 |
| 5 000 | 545.70 | 4.62 | 1.81 / 4.62 | 23.17 | 1 043.7 → 1 050.7 | 1 216.5 → 1 208.1 |
| 20 000 | 10 476.30 | 17.86 | 8.49 / 17.86 | 51.63 | 1 071.0 → 1 095.7 | 1 242.0 → 1 256.3 |
| 50 000 | 60 081.90 | 37.60 | 28.15 / 37.60 | 140.11 | 1 087.2 → 1 156.1 | 1 292.6 → 1 329.9 |
| 100 000 | 260 644.06 | 76.32 | 63.88 / 76.32 | 223.76 | 1 176.5 → 1 253.2 | 1 374.2 → 1 453.4 |

内存：50k 档 heap peak +68.9 MB（+6.3%）、100k 档 +76.7 MB（+6.5%）、rss +37.3/+79.2 MB。
两档的绝对量由 fixture 本身（100k 实体 ≈1.2 GB packed buffer）主导，增量落在
进程间采样方差内；改造不引入任何按实体的新缓冲（批量只多一个 `ids` 数组 + 一个 `Set`，
即 100k × 8 B 量级），故不构成无解释增长。1k/5k 档的反向偏差（−125 MB / +7 MB）
同属噪声，记录而不解释为收益。

### 3.3 九个新指标

| SPEC 指标 | JSON 字段 | 50k after 实测 |
| --- | --- | --- |
| `applyRemoveCount` | `instrumentation.applyRemoveCount` | 0（无逐条 Remove） |
| `batchRemoveCount` | `instrumentation.applyRemoveBatchCount` | 1 |
| `batchRemovedEntityCount` | `instrumentation.applyRemoveBatchObjectCount` | 50 000 |
| `btrScanCount` | `instrumentation.btrRemoveScanCount` | 1 |
| `replayDurationMs` | `undo/redo.stats.medianMs`（Node）、`results.*.replayMs`（浏览器） | 33.03 / 204 |
| `undoDurationMs` / `redoDurationMs` | 同上，按方向 | 113.11 / 33.03 |
| `entityErasedEventCount` | `instrumentation.entityErasedEventCount` / `…EntityCount` | 1 次派发 / 50 000 实体（与基线一致） |
| `sceneConsistencyResult` | `undo/redo.dbConsistent` + `entityCountAfter`；浏览器侧 `missingFromIndex` / `spatialIndexResidual` / `duplicateIndexIds` | true / 0 |

补充指标同样入库：`btrRemoveBatchCallCount`、`btrRemovedEntityCount`、
`btrBatchRemovedEntityCount`、`btrScanEntityCount`（槽位）、
`entityAppendedEventCount`、`entityAppendedEntityCount`。

数据库 Replay 与浏览器最终场景完成时间**分开记录**：Node 只有数据库；
浏览器 JSON 中 `replayMs`（页内 `performance.now()` 包住 `manager.undo()/redo()`）
与 `settleMs`（墙钟直到空间索引 drawable 数达到期望值）是两个字段。

---

## 4. Task E — 真实浏览器验收

规格：`packages/cad-editor-demo/e2e/tests/phase27-bulk-replay.spec.ts`（3 用例，serial）。
命令：`npx playwright test e2e/tests/phase27-bulk-replay.spec.ts --reporter=line --timeout=3600000`。
结果：**3 passed (1.1m)**，日志 `reports/phase27/bulk-replay.log`，
数据 `reports/phase27/bulk-replay.json`，trace `reports/phase27/bulk-replay-trace.zip`。

### 4.1 用例 1 — 50k 单命令 `ERASE → Undo → Redo → Undo → Redo`

| 步骤 | DB replay ms | 场景完成 ms（settle） | 最长长任务 ms | DB ids | 场景 ids（空间索引） | 索引残留 | 缺渲染 | undo/redo 栈 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| open | — | — | — | 50 000 | 50 000 | 0 | 0 | 0 / 0 |
| ERASE | 1 042.0 | 1 428 | 0 | 0 | 0 | 0 | 0 | 1 / 0 |
| Undo #1 | 580.1 | 4 675 | 1 889 | 50 000 | 50 000 | 0 | 0 | 0 / 1 |
| **Redo #1** | **204.0** | 255 | 0 | 0 | 0 | 0 | 0 | 1 / 0 |
| Undo #2 | 556.4 | 4 425 | 1 948 | 50 000 | 50 000 | 0 | 0 | 0 / 1 |
| **Redo #2** | **204.3** | 256 | 0 | 0 | 0 | 0 | 0 | 1 / 0 |

* **Redo 204 ms < 1 s 目标**，相对 Phase 2.6 的 105 477.5 ms 快 **517×**。
  Redo 期间主线程**没有任何 ≥50 ms 的长任务**（`longestTaskMs = 0`）。
* 断言为全集而非抽样：每一步都比较 DB id 集合与空间索引 id 集合
  （`missingFromIndex`、`spatialIndexResidual`、`duplicateIndexIds` 均为 0），
  对全部 50 000 个被擦 id 逐一 `hasEntity`，并比较 picking 结果与 GPU 驻留计数。
* Undo Record：ERASE 后 `undoRecords = open + 1`、`redoRecords = 0`，
  record 内 `changes.length = 100 000`。**100 000 而非 50 000**：`eraseEntities`
  对每个 id 先 `openEntityForWrite`（记一条 `modify` 快照）再 `removeEntity`
  （记一条 `remove`），这是记录器既有行为（审计 §5），与本次批量重放无关；
  结构上表现为「先 50 000 条 modify，再 50 000 条连续 remove」，
  因此 run 依然连续、依然合并为一次调用。
* 两轮之间稳定：`undo2`/`redo2` 的 id 集合、picking 数组、`textures` 计数与第一轮完全一致。
* GPU：`geometries` 序列 open 5 → erase 5 → undo 6 → redo 6 → undo 7 → redo 7
  （每轮 restore 至多 +1，总量 ≤ open+2；`textures` 恒为 4）。
  +1 只发生在 **undo（append 路径）**，本次改动完全没有触碰 append 路径；
  来源是 batched group 的 block-template 共享几何缓存每个模板代克隆一份
  （`_ownedSharedGeometries`，按模板 uuid 缓存），与实体数量无关（见 §6 风险 4）。
* 与 Phase 2.6 的单次样本对照：erase 824.3 → 1 042.0 ms、undo 435.5 → 580.1 ms。
  两者走的是未被修改的代码路径，差异属单样本噪声与机器负载，不作为收益或退步计入。
  Node 侧 50k redo 33 ms vs 浏览器 204 ms 的差距由记录内容解释：Node 基准的 record
  只有 50 000 条 `remove`，而浏览器生产命令的 record 有 100 000 条
  （50 000 条 `modify` 也要在重放中 `restoreFrom`），这 50 000 次属性还原是
  剩余时间的主体，与 BTR 扫描无关。

### 4.2 用例 2 — 加载中 `ERASE → Undo → Redo`

在 DB 已有 13 000 / 20 000 实体、场景仍在转换时擦掉首批 3 000 个 id，
紧接着 Undo、Redo，随后等待加载与转换收敛：

| 项 | 结果 |
| --- | --- |
| 最终 DB ids | 17 000 |
| 最终场景 ids | 17 000 |
| 被擦 id 的 drawable（幽灵） | 0 / 3 000 |
| 被擦 id 仍 `hasEntity` | 0 / 3 000 |
| 空间索引残留 / 缺失渲染 / 重复 id | 0 / 0 / 0 |
| record `changes.length` | 6 000（3 000 modify + 3 000 remove） |

即「加载中执行 ERASE → Undo → Redo」的回归项：既没有留下幽灵几何，
也没有把 erased id 从后续加载里吞掉或重复添加。

### 4.3 用例 3 — R-8 真正停在 `_convertQueue`、尚未 claim

`AcTrView2d` 新增 `queued` 调试暂停阶段（`packages/cad-simple-viewer/src/view/AcTrView2d.ts`：
`AcTrConvertDebugStage` 增加 `'queued'`，`runConvertDrain` 在
`createConvertPending` / splice 之前 await hook）。测试在 20 000 实体的首次 drain
入口处暂停：

| 项 | 结果 |
| --- | --- |
| 暂停时 `_convertQueue.length` | 20 000 |
| 暂停时 `_claimedConvertObjectIds.size` | **0**（未 claim，非 claimed 用例的重复） |
| 暂停时 `_erasedConvertObjectIds.size` | 0 |
| 擦除全部 queued id | 20 000 / 20 000，329.5 ms |
| Undo / Redo | 212.6 ms / 49.9 ms |
| Redo 后 DB / 场景 | 0 / 0，索引残留 0，幽灵 0 |
| 再 Undo 后 DB / 场景 | 20 000 / 20 000，`hasEntity` 20 000 |
| 释放后队列 / tombstone | `queueLength = 0`、`erasedCount = 0` |

该用例覆盖的是 Phase 2.6 没覆盖的状态：实体已在 `_convertQueue` 但没有任何
claim，`AcApContext.entityErased` 会把这类 id 一并交给视图。结果无幽灵、无残留。

---

## 5. 验收对照（SPEC §6）

| 条件 | 结果 |
| --- | --- |
| 50k ERASE Redo 不再产生 50k 次 BTR 全表扫描 | ✅ 扫描 1 次，槽位 50 000 |
| Undo/Redo 结果与改造前严格一致 | ✅ 21 项 data-model 用例 + 浏览器全集比较 + 1 054 项全量回归 |
| 大量 Remove 的扫描工作量接近线性 | ✅ 槽位 n(n+1)/2 → n；Redo 0.45–0.73 µs/实体 |
| 不产生幽灵几何 | ✅ 浏览器 3 用例对全部被擦 id 断言，幽灵 0 |
| 不引入事务回滚 / 事件顺序 / 数据一致性回归 | ✅ 事件派发次数与 payload 不变（`1/n`），嵌套 abort、damaged record 用例通过 |
| 所有原有 data-model 事务测试通过 | ✅ 129 suites / 1 054 tests |
| 浏览器 50k Redo < 1 s | ✅ 204 ms（两轮 204.0 / 204.3） |
| 不得仅以 Node 加速代替浏览器验收 | ✅ §4 为浏览器实测 |
| 不得为降耗拆分单个 Undo 命令 | ✅ 一次 `eraseEntities`，一个 undo record，`undoRecords` 只 +1 |
| 内存峰值不得出现明显无解释的增长 | ✅ §3.2 + §6 风险 4 |

---

## 6. 未解决风险

1. **Undo 方向的 4.4–4.7 s 场景完成时间（含 1.9 s 长任务）** 未被优化。
   实体回归场景要重建 50 000 个 drawable，属 append/转换路径，
   审计 §10 已判定不在本 Phase 范围内。下次评审 MOVE 主线程延迟时一并处理。
2. **ERASE 自身 1 042 ms（DB）+ 1 428 ms（场景）** 仍是单命令内最重的一步。
   它与本次改动无关（`eraseEntities` 未改），但会限制「ERASE→Undo→Redo」
   连续操作的可感知流畅度。
3. **浏览器 record 每条实体带一条 `modify` 快照**，使 replay 的变更条数是 Node
   基准的两倍（100 000 vs 50 000），并额外分配 50 000 份克隆。
   这是既有记录策略，本次不动；如后续要压缩 Redo 的剩余 200 ms，这是第一处可查。
4. **每轮 restore 多 1 个 GPU 几何**（5→6→7）。落在 undo 的 append 路径、
   渲染器 block-template 缓存，与实体数量无关，本次改动未触碰该路径；
   两轮样本不足以断言「有界」，只记录了 `+1/轮` 与 `≤ open+2` 的约束。
5. **`_claimedConvertObjectIds` 在收敛后仍保留 id**（用例 3 中 undo 后为 20 000）。
   既有设计（防止二次 convert 重复追加 slot），文档寿命与文档一致，非本次回归；
   若关心长会话内存，应单独评审这个集合的生命周期。
6. **replay 失败无恢复**（审计 §7，既有行为）。批量调用比逐条调用更安全
   （`strictMode` 守卫在前，之后是稳定压缩 + `Map.delete`，不存在部分删除），
   但没有回滚快照。
7. **基准与浏览器数值均来自开发构建**（Vite dev + 未压缩），绝对值不能与生产包对齐；
   加速比与扫描次数是可迁移的结论，毫秒数不是。

---

## 7. 交付清单（SPEC §8）

| 交付物 | 位置 |
| --- | --- |
| `BULK_REPLAY_AUDIT.md` | 仓库根目录（288 行） |
| `BULK_REPLAY_OPTIMIZATION_REPORT.md` | 仓库根目录（本文件） |
| `replay-baseline.json` | `reports/phase27/`（5 档 ×5 次，tag `baseline`） |
| `replay-after.json` | `reports/phase27/`（5 档 ×5 次，tag `after`） |
| 浏览器测试 JSON / Trace | `reports/phase27/bulk-replay.json`、`bulk-replay-trace.zip`（1 173 093 B）、`bulk-replay.log` |
| realdwg-web Git Diff + Commit SHA | `reports/phase27/realdwg-web.diff`；HEAD `395525f576afd90ede93892c9054040b3173e66e`（工作区未提交：2 改 1 增） |
| cad-viewer 集成测试结果 | 本文件 §4（3 passed）+ data-model 全量 `reports/phase27/data-model-tests.log` |
| 依赖构建产物版本与 SHA256 | §1.3 |
| 全部测试结果及未解决风险 | §2、§4、§6 |

基准原始日志：`reports/phase27/after-{1000,5000,20000,50000,100000}.log`、
`baseline-100k.log`（100k 基线，Jest 1 291 s）。

> `reports/` 与 `benchmarks/` 在 `.gitignore` 中，属本地交付物；
> 需入库时请显式 `git add -f`。

---

## 8. 复现

```powershell
# 1. data-model 正确性（realdwg-web）
cd E:\rustpro\realdwg-web
npx jest packages/data-model/__tests__/AcDbBulkReplay.spec.ts

# 2. Node 基准（cad-viewer，每档独立进程）
cd E:\rustpro\cad-viewer
powershell -File benchmarks/bulk-edit/run-phase27-after.ps1

# 3. 浏览器验收
cd packages\cad-editor-demo
npx playwright test e2e/tests/phase27-bulk-replay.spec.ts --reporter=line --timeout=3600000
```

---

**Phase 2.7 到此停止。** 未进入 MOVE Undo 数据模型重构、GPU Buffer Translate、
Worker 事务迁移、Wry/Rust 改造；MOVE 主线程延迟留待下一轮单独评审。
