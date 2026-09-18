import { createApp } from 'vue'
import App from './App.vue'
import { applyKioskBehaviour } from '../shared/kiosk'

// The Edge is a touch panel, not a browser window: no context menu on a long press, no drag, no
// text selection. The helper's WKWebView turns the same things off natively; this covers the
// Chrome kiosk path (scripts/kiosk.sh) and is defence in depth under the helper.
applyKioskBehaviour(document)

createApp(App).mount('#app')
