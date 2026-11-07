package app.lody.android

/** Build-owned configuration; never accept endpoint changes from intents or server data. */
internal object BackendEnvironment {
    const val convex = BuildConfig.CONVEX_URL
    const val site = BuildConfig.CONVEX_SITE_URL
    const val worker = BuildConfig.CF_WORKER_URL
    const val storageSuffix = BuildConfig.BACKEND_STORAGE_SUFFIX
}
