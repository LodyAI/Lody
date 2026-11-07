package app.lody.android.catalog

import androidx.test.platform.app.InstrumentationRegistry
import app.lody.android.auth.*
import app.lody.android.runtime.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class CatalogStoreTest {
 private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
 private val account = Account("account", "Fixture", listOf(Workspace("w", "Work"), Workspace("other", "Other")))
 private val scope = RuntimeScope("account", "w")
 private val saved = SavedCatalog(CatalogSnapshot(99, listOf(CatalogProject("p", "m", "项目 🌙", "/fixture")), listOf(CatalogSession("s", "m", "p", "hello", "idle", false, true, "2026")), listOf("m")), 1234)
 @Test fun membersPersistAcrossRestartAndArePrunedOnLostAccessOrLogout() = runBlocking {
  val store = AtomicCatalogStore(context, "members-test")
  val members = listOf(WorkspaceMember("other", "Alice", "https://example.com/avatar.png"))
  try {
   store.clear(); store.saveAccount(account); store.writeMembers(scope, members)
   val reopened = AtomicCatalogStore(context, "members-test")
   assertEquals(members, reopened.readMembers(scope))
   assertNull(reopened.readMembers(RuntimeScope("another", "w")))
   assertNull(reopened.readMembers(RuntimeScope("account", "other")))
   reopened.saveAccount(account.copy(workspaces = emptyList()))
   reopened.saveAccount(account)
   assertNull(reopened.readMembers(scope))
   reopened.writeMembers(scope, members); reopened.clear()
   assertNull(store.readMembers(scope))
  } finally { store.clear() }
 }
 @Test fun branchesRestoreSelectionAcrossInstancesWithoutCrossingWorkspace() = runBlocking {
  val store = AtomicCatalogStore(context, "branches-test")
  val page = app.lody.android.create.BranchPage(listOf("main", "feature"), "main")
  try {
   store.clear(); store.saveAccount(account)
   store.selectBranch(scope, "Owner/Repo", "feature") // A tap can race the first disk write.
   store.writeBranches(scope, "Owner/Repo", page)
   val reopened = AtomicCatalogStore(context, "branches-test")
   assertEquals("feature", reopened.readBranches(scope, "Owner/Repo")!!.selected)
   assertEquals(page, reopened.readBranches(scope, "Owner/Repo")!!.page)
   assertNull(reopened.readBranches(RuntimeScope("account", "other"), "Owner/Repo"))
   assertNull(reopened.readBranches(scope, "Other/Repo"))
   reopened.saveAccount(account.copy(workspaces = listOf(Workspace("other", "Other"))))
   reopened.saveAccount(account)
   assertNull(reopened.readBranches(scope, "Owner/Repo"))
   reopened.writeBranches(scope, "Owner/Repo", page); reopened.clear()
   assertNull(store.readBranches(scope, "Owner/Repo"))
  } finally { store.clear() }
 }
 @Test fun creationOptionsPersistAcrossInstancesAndRespectScopeAndLogout() = runBlocking {
  val store = AtomicCatalogStore(context, "options-test")
  val agent = CreationAgent("provider", "Assistant", "m", "acp", "codex")
  val capability = CreationCapability("m", "acp", "codex", listOf(CreationChoice("model", "Model")), listOf(CreationChoice("auto", "Auto")), mapOf("model" to listOf("high")), "provider")
  val options = CreationOptions(listOf(agent), listOf(capability))
  try {
   store.clear(); store.saveAccount(account); store.writeOptions(scope, null, options)
   val reopened = AtomicCatalogStore(context, "options-test")
   assertEquals(options, reopened.readOptions(scope, null))
   assertNull(reopened.readOptions(scope, "project"))
   assertNull(reopened.readOptions(RuntimeScope("account", "other"), null))
   assertNull(reopened.readOptions(RuntimeScope("other-account", "w"), null))
   reopened.saveAccount(account.copy(workspaces = listOf(Workspace("other", "Other"))))
   reopened.saveAccount(account)
   assertNull(reopened.readOptions(scope, null))
   reopened.writeOptions(scope, null, options)
   reopened.clear()
   assertNull(store.readOptions(scope, null))
  } finally { store.clear() }
 }
 @Test fun atomicSnapshotRestoresContextAndIsolatesScopeAcrossInstances() = runBlocking {
  val store = AtomicCatalogStore(context, "cache-test")
  try {
   store.clear(); store.saveAccount(account); store.select(scope); store.write(scope, saved)
   val reopened = AtomicCatalogStore(context, "cache-test")
   assertEquals(AccountContext(account, "w"), reopened.readContext())
   assertEquals(saved, reopened.read(scope))
   assertNull(reopened.read(RuntimeScope("other-account", "w")))
   assertNull(reopened.read(RuntimeScope("account", "other")))
   // Revisions belong to a runtime generation: a new bootstrap may restart at 1.
   reopened.write(scope, saved.copy(snapshot = saved.snapshot.copy(revision = 1)))
   assertEquals(1L, reopened.read(scope)!!.snapshot.revision)
   reopened.saveAccount(account.copy(workspaces = listOf(Workspace("other", "Other"))))
   assertNull(reopened.read(scope)); assertNull(reopened.readContext()!!.workspaceId)
   reopened.clear(); assertNull(store.readContext()); assertNull(store.read(scope))
  } finally { store.clear() }
 }
 @Test fun corruptOrOversizedCacheIsDiscardedWithoutLosingAccount() = runBlocking {
  val store = AtomicCatalogStore(context, "cache-corrupt")
  try {
   store.clear();store.saveAccount(account);store.write(scope,saved)
   val files = File(context.noBackupFilesDir,"cache-corrupt").listFiles()!!.filter {it.name != "account.json"}
   assertEquals(1,files.size)
   files.single().writeText("not valid json")
   assertNull(store.read(scope));assertEquals(account,store.readContext()!!.account)
   store.write(scope,saved)
   files.single().outputStream().use {out -> repeat(9) {out.write(ByteArray(1024*1024))}}
   assertNull(store.read(scope)); assertEquals(account,store.readContext()!!.account)
  } finally {store.clear()}
 }
}
