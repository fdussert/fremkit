package app.fremkit.android

import android.view.Window
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Full screen, the system bars hidden: the dashboard covers the whole display, and the region the
 * app measures for pairing is the one the page will have (spike result 11). A swipe from an edge
 * shows the bars for a moment, over the page and without resizing it. Applied to the activity's
 * window at creation and whenever it regains focus (a dialog or the bars' own swipe takes it).
 *
 * The display cutout keeps its default: content stays out of a notch, as the iPad stays in its
 * safe area.
 */
object Immersive {
    fun apply(window: Window) {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
        }
        WindowInsetsControllerCompat(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }
}
