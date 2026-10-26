import 'element-plus/dist/index.css'

import { ACADRUST_PARSER_WORKER_FILE } from '@mlightcad/cad-simple-viewer'
import ElementPlus from 'element-plus'
import { createApp } from 'vue'

import { i18n } from '../src'
import App from './App.vue'
import { registerAcadRustConverter } from './registerAcadRust'

// acad-rust (MPL-2.0) is the only DWG parser in this fork. The GPL libredwg
// converter is intentionally never imported here.
registerAcadRustConverter(`/assets/${ACADRUST_PARSER_WORKER_FILE}`)

const app = createApp(App)
// Required when Vite aliases `@mlightcad/ui-components` to source: those SFCs
// use `<el-*>` tags without local imports.
app.use(ElementPlus)
app.use(i18n)
app.mount('#app')
