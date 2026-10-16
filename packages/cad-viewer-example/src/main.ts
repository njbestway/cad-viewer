import 'element-plus/dist/index.css'

import { ACADRUST_PARSER_WORKER_FILE } from '@mlightcad/cad-simple-viewer'
import { LIBREDWG_PARSER_WORKER_FILE } from '@mlightcad/cad-simple-viewer'
import { i18n } from '@mlightcad/cad-viewer'
import ElementPlus from 'element-plus'
import { createApp } from 'vue'

import App from './App.vue'
import { registerAcadRustConverter } from './registerAcadRust'
import { isAcadTsEnabled, registerAcadTsConverter } from './registerAcadTs'
import { registerLibreDwgConverter } from './registerLibreDwg'

const initApp = () => {
  // Opt into GPL DWG support before the viewer mounts.
  registerLibreDwgConverter(`./assets/${LIBREDWG_PARSER_WORKER_FILE}`)
  // Local fork: re-register the DWG slot with the copyleft-free acadrust
  // converter (MPL-2.0). `register` replaces the slot, so acad-rust wins.
  registerAcadRustConverter(`./assets/${ACADRUST_PARSER_WORKER_FILE}`)
  // Verification opt-in: `?acadts=1` re-registers the DWG slot with the
  // experimental acad-ts parser (MIT, pure TS, main-thread) so its real parse
  // output can be eyeballed against acad-rust / LibreDWG on this app too.
  if (isAcadTsEnabled()) {
    registerAcadTsConverter()
  }

  const app = createApp(App)
  // Required when Vite aliases `@mlightcad/ui-components` to source: those SFCs
  // use `<el-*>` tags without local imports (their own build auto-imports them).
  app.use(ElementPlus)
  app.use(i18n)
  app.mount('#app')
  // Hide the loading spinner
  const loader = document.getElementById('loader')
  if (loader) {
    loader.style.display = 'none'
  }
}

initApp()
