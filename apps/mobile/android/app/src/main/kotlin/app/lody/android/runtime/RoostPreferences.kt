package app.lody.android.runtime

import android.content.Context

/** Local beta switches match the web client's developer-mode and Roost opt-in gates. */
internal object RoostPreferences {
    private fun preferences(context: Context) = context.getSharedPreferences("lody.beta", Context.MODE_PRIVATE)
    fun developer(context: Context) = preferences(context).getBoolean("developerMode", false)
    fun experiment(context: Context) = preferences(context).getBoolean("roostHistory", false)
    fun enabled(context: Context) = developer(context) && experiment(context)
    fun setDeveloper(context: Context, value: Boolean) { preferences(context).edit().putBoolean("developerMode", value).apply() }
    fun setExperiment(context: Context, value: Boolean) { preferences(context).edit().putBoolean("roostHistory", value).apply() }
}
