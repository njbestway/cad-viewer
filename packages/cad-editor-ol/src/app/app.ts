import 'element-plus/dist/index.css'
import '../style/style.css'
import '../style/index.scss'

import {
  AcApDocManager,
  AcApDocManagerOptions
} from '@mlightcad/cad-simple-viewer'

import { registerCadViewerNotificationCenter } from './cadViewerNotificationCenter'
import {
  registerCmds,
  registerDialogs,
  registerLazyPlugins,
  registerMTextColorPicker
} from './register'

/** Options for {@link initializeCadViewer}. */
export type InitializeCadViewerOptions = AcApDocManagerOptions

export const initializeCadViewer = (
  options: InitializeCadViewerOptions = {}
) => {
  AcApDocManager.createInstance({
    ...options,
    // Keep the shared event bridge; Vue panel replaces the built-in DOM UI.
    notificationCenter: {
      showDefaultUi: false,
      host: options.busyIndicatorHost ?? options.container
    }
  })
  registerCadViewerNotificationCenter()
  registerCmds()
  registerDialogs()
  registerMTextColorPicker()
  registerLazyPlugins()
}
