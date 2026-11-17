package app.lody.android.home

/** Keep the compact bar stable until the list actually reaches its top. */
internal class HomeBarScrollState {
    var collapsed = false
        private set

    fun update(offset: Float, scrolling: Boolean, threshold: Float) {
        if (offset <= 1f) collapsed = false
        else if (scrolling && offset > threshold) collapsed = true
    }

    /** Tapping the compact bar restores it; the next downward scroll may collapse it again. */
    fun expand() {
        collapsed = false
    }
}
