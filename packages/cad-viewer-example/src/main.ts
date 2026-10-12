import 'element-plus/dist/index.css'

import { ACADRUST_PARSER_WORKER_FILE } from '@mlightcad/cad-simple-viewer'
import { i18n } from '@mlightcad/cad-viewer'
import ElementPlus from 'element-plus'
import { createApp } from 'vue'

import App from './App.vue'
import { registerAcadRustConverter } from './registerAcadRust'

const initApp = () => {
  // Opt into copyleft-free DWG support (acadrust / MPL-2.0) before the viewer mounts.
  registerAcadRustConverter(`./assets/${ACADRUST_PARSER_WORKER_FILE}`)

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
