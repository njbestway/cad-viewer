<template>
  <div class="app-shell">
    <MlCadViewer
      :base-url="cadDataBaseUrl"
      @create="onViewerCreate"
    />
  </div>
</template>

<script setup lang="ts">
import { AcApDocManager } from '@mlightcad/cad-simple-viewer'

import { MlCadViewer } from '../src'

/**
 * Repo-root `caddata/` checkout served by vite.config.ts at `/cad-data/`.
 * The relative form is fine: `MlCadViewer` normalizes `baseUrl` to an absolute
 * URL before handing it to `AcApDocManager` (required by `newDocument()`).
 *
 * `progressiveRendering` is deliberately left at its default (`false`): the
 * progressive open path does not wait for deferred text, which shows glyphs as
 * stacked mid-open slices instead of final shapes.
 */
const cadDataBaseUrl = '/cad-data/'

/**
 * The viewer mounts without a drawing so that the editor opens empty by
 * default. Create the blank ISO template here to give the ribbon, palettes and
 * commands an active document; real drawings are opened from the toolbar
 * (`Open`) or in a later step from the backend drawing list.
 */
const onViewerCreate = async () => {
  try {
    await AcApDocManager.instance.newDocument()
  } catch (error) {
    // Missing `caddata/` checkout or an unreachable template must not crash
    // the editor shell - the Open command still works once a file is chosen.
    console.warn(
      '[cad-editor-ol] Could not create the blank drawing:',
      error
    )
  }
}
</script>

<style scoped>
.app-shell {
  width: 100%;
  height: 100%;
}
</style>
