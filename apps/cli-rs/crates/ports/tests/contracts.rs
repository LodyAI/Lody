use lody_ports::{
    BackendNetworkPolicy, BackendProfile, CANONICAL_LODY_CLOUD_ORIGIN, CapabilitySet,
    EntitlementStatus, MAX_MACHINE_ID_LENGTH, PlatformCapability, PortErrorKind, ProfileId,
    WellKnownDiscoveryDocument, WorkspaceSecurityMode, parse_machine_id,
};
use std::path::Path;

#[test]
fn workspace_security_mode_forbids_unknown_egress_and_encrypted_downgrade() {
    assert!(!WorkspaceSecurityMode::Unknown.allows_plaintext_network_egress());
    assert!(WorkspaceSecurityMode::Plaintext.allows_plaintext_network_egress());

    let local_caps = CapabilitySet::local_only();
    assert!(!local_caps.has(PlatformCapability::Telemetry));
    assert!(!local_caps.has(PlatformCapability::UsageAnalytics));

    let encrypted = WorkspaceSecurityMode::Encrypted {
        genesis_hash: "genesis_a".to_string(),
    };
    assert!(!encrypted.allows_plaintext_network_egress());
    assert!(
        encrypted
            .validate_transition(&WorkspaceSecurityMode::Plaintext)
            .is_err()
    );
    assert!(
        encrypted
            .validate_transition(&WorkspaceSecurityMode::Unknown)
            .is_err()
    );
    assert!(
        encrypted
            .validate_transition(&WorkspaceSecurityMode::Encrypted {
                genesis_hash: "genesis_b".to_string(),
            })
            .is_err()
    );
}

#[test]
fn self_hosted_profiles_isolate_state_bind_canonical_recovery_locator_and_enforce_machine_id_bounds()
 {
    let make_profile = |id: &str, origin: &str, site_origin: Option<&str>| BackendProfile {
        profile_id: ProfileId(id.to_string()),
        server_origin: origin.to_string(),
        discovery: WellKnownDiscoveryDocument {
            schema_version: 1,
            instance_id: id.to_string(),
            control_api_url: format!("{origin}/api"),
            auth_issuer_url: format!("{origin}/auth"),
            site_origin: site_origin.map(ToOwned::to_owned),
            auth_methods: Vec::new(),
            streams_sync_url: None,
            blob_service_url: None,
            artifact_mirror_url: None,
            preview_tunnel_url: None,
            iroh_relays: None,
            capabilities: CapabilitySet::local_only(),
        },
        network: BackendNetworkPolicy::default(),
    };

    let root = Path::new("/tmp/lody-root");
    let p_cloud = make_profile("cloud", "https://app.lody.ai/v1/", None);
    let p_self = make_profile(
        "corp",
        "https://api.corp.internal",
        Some("https://lody.corp.internal/app"),
    );
    assert_ne!(
        p_cloud.isolated_data_dir(root),
        p_self.isolated_data_dir(root)
    );
    assert_eq!(
        p_cloud.recovery_service_locator(),
        CANONICAL_LODY_CLOUD_ORIGIN
    );
    assert_eq!(
        p_self.recovery_service_locator(),
        "https://lody.corp.internal"
    );
    assert!(
        p_cloud
            .verify_recovery_vault_locator("https://lody.ai")
            .is_ok()
    );
    assert_eq!(
        p_cloud
            .verify_recovery_vault_locator("https://lody.corp.internal")
            .unwrap_err()
            .kind,
        PortErrorKind::Forbidden
    );

    assert!(parse_machine_id("").is_err());
    assert!(parse_machine_id(&"a".repeat(MAX_MACHINE_ID_LENGTH + 1)).is_err());
    assert!(parse_machine_id("bad/path").is_err());
    assert!(parse_machine_id("valid-machine_01:host.local").is_ok());

    let expired = EntitlementStatus::ExpiredReadOnly {
        reason: "expired".to_string(),
    };
    assert!(!expired.allows_remote_collaboration_dispatch());
    assert!(expired.allows_local_read_and_export());
}
