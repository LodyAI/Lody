package app.lody.android.catalog

import app.lody.android.auth.AccountContextStore
import app.lody.android.runtime.*

data class SavedCatalog(val snapshot: CatalogSnapshot, val syncedAt: Long)
interface CatalogStore : AccountContextStore {
    suspend fun select(scope: RuntimeScope)
    suspend fun read(scope: RuntimeScope): SavedCatalog?
    suspend fun write(scope: RuntimeScope, catalog: SavedCatalog)
}
