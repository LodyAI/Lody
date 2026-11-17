package app.lody.android.runtime

/** Native display/edit projection of agentProviders. Environment values never enter native UI. */
data class ProviderMachine(val id: String, val name: String, val os: String, val readOnly: Boolean, val online: Boolean, val supportsSetup: Boolean, val supportsCodexProfiles: Boolean = false, val supportsAuthentication: Boolean = false, val supportsPiExtensions: Boolean = false) {
    val canManage: Boolean get() = !readOnly && online
}
data class AgentProvider(val id: String, val machineId: String, val name: String, val prompt: String, val cliType: String, val agentType: String, val command: String, val args: List<String>, val readOnly: Boolean)
data class ProviderSetup(val id: String, val machineId: String, val name: String, val agentType: String, val status: String, val attempt: Int, val canRetry: Boolean, val canDelete: Boolean, val failureCode: String?)
data class ProviderCatalogEntry(val id: String, val name: String, val cliType: String, val agentType: String)
data class AgentProviders(val machines: List<ProviderMachine>, val providers: List<AgentProvider>, val setups: List<ProviderSetup>, val catalog: List<ProviderCatalogEntry>, val authRequired: Boolean = false, val presets: List<ProviderPreset> = emptyList())
data class ProviderFields(val name: String, val prompt: String, val cliType: String, val agentType: String, val command: String, val args: List<String>, val advanced: ProviderAdvanced? = null) {
    val valid: Boolean get() = name.trim().isNotEmpty() && name.length <= 200 && prompt.length <= 32000 &&
        command.length <= 4096 && args.size <= 128 && args.all { it.length <= 4096 } &&
        listOf(name, prompt, command).none { '\u0000' in it } && args.none { '\u0000' in it } &&
        (cliType != "custom" || command.isNotBlank()) && cliType.isNotBlank() && agentType.isNotBlank()
}
sealed interface ProviderAction {
    data class ListMachine(val machineId: String) : ProviderAction
    data object List : ProviderAction
    data class Save(val machineId: String, val id: String, val base: AgentProvider?, val fields: ProviderFields) : ProviderAction
    data class Delete(val base: AgentProvider) : ProviderAction
    data class Refresh(val base: AgentProvider) : ProviderAction
    data class RetrySetup(val setup: ProviderSetup) : ProviderAction
    data class DeleteSetup(val setup: ProviderSetup) : ProviderAction
}
