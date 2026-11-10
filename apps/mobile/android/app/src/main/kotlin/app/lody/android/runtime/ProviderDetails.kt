package app.lody.android.runtime

/** Native provider metadata. Stored credentials are deliberately absent. */
data class ProviderChoice(val id: String, val name: String)
data class ProviderOption(val id: String, val name: String, val type: String, val value: String?, val booleanValue: Boolean?, val choices: List<ProviderChoice>)
data class ProviderCapabilities(val models: List<ProviderChoice> = emptyList(), val modes: List<ProviderChoice> = emptyList(), val sessionTitle: Boolean = false, val options: List<ProviderOption> = emptyList(), val authMethods: List<ProviderChoice> = emptyList())
data class ProviderPresetMode(val id: String, val name: String, val endpoint: String?, val tokenPrefix: String?, val customEndpoint: Boolean, val endpoints: List<ProviderEndpoint>)
data class ProviderEndpoint(val id: String, val name: String, val url: String)
data class ProviderPreset(val id: String, val name: String, val cliType: String, val agentType: String, val tokenEnvKey: String, val protectedEnvKeys: List<String>, val modes: List<ProviderPresetMode>)
data class ProviderCodexAuth(val mode: String, val profileId: String, val baseUrl: String? = null)
data class ProviderDetail(val id: String, val machineId: String, val revision: String, val description: String, val envKeys: List<String>, val endpoints: Map<String, String>, val runtimePaths: Map<String, String>, val piExtensions: List<String>, val titleValues: Map<String, Any>, val codexAuth: ProviderCodexAuth?, val presetId: String?, val capabilities: ProviderCapabilities, val supportsAuthentication: Boolean, val supportsMethodSelection: Boolean, val supportsCodexProfiles: Boolean, val supportsPiExtensions: Boolean = false, val unavailableActions: Map<String, String> = emptyMap(), val supportsRateLimitsRefresh: Boolean = false)
data class ProviderProbe(val success: Boolean, val authRequired: Boolean, val capabilities: ProviderCapabilities)
data class ProviderAuthField(val id: String, val label: String, val type: String, val required: Boolean, val options: List<ProviderChoice>)
data class ProviderAuthState(val flowId: String, val status: String, val methods: List<ProviderChoice>, val fields: List<ProviderAuthField>, val interactionId: String?, val authorizationUrl: String?, val userCode: String?, val acceptsAuthorizationCode: Boolean, val errorCode: String?, val requiresAuthorizationConsent: Boolean = false)
class ProviderAuthRequest(val machineId: String, val id: String, val action: String, val flowId: String, val methodId: String? = null, val interactionId: String? = null, val values: Map<String, String>? = null, val authorizationCode: String? = null, val responseAction: String? = null)
/** Write-only patches are not persisted or returned in list/detail responses. */
class ProviderAdvanced(val detailRevision: String? = null, val description: String? = null,
    val envPatch: Map<String, String?>? = null, val runtimePaths: Map<String, String?>? = null,
    val piExtensions: List<String>? = null, val titleValues: Map<String, Any>? = null,
    val codexAuth: ProviderCodexAuth? = null, val presetId: String? = null, val presetModeId: String? = null, val presetEndpoint: String? = null)

data class ProviderOperation(val action: String, val success: Boolean, val status: String?, val extensions: List<ProviderChoice>, val version: String?, val current: String?, val required: String?, val errorCode: String?)
