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
    // Vue ribbon / tool palette replace the built-in simple-ui chrome.
    // Without this the merged-in AcApSimpleUiChrome auto-loads: it draws a
    // second docked toolbar, forces isShowRibbon=false (hiding the Vue
    // ribbon), and re-registers layer/find/markuppanel/measurementpanel
    // which registerCmds() already owns.
    simpleUi: false,
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
