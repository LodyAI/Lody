use lody_ports::{
    BackendNetworkPolicy, BackendProfile, CapabilitySet, EntitlementStatus, ProfileId,
    WellKnownDiscoveryDocument, WorkspaceSecurityMode,
};
use std::path::Path;

#[test]
fn workspace_security_mode_forbids_unknown_egress_and_encrypted_downgrade() {
    assert!(!WorkspaceSecurityMode::Unknown.allows_plaintext_network_egress());
    assert!(WorkspaceSecurityMode::Plaintext.allows_plaintext_network_egress());

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
fn self_hosted_profiles_never_share_local_state_dirs_and_expired_license_preserves_local_reads() {
    let make_profile = |id: &str, origin: &str| BackendProfile {
        profile_id: ProfileId(id.to_string()),
        server_origin: origin.to_string(),
        discovery: WellKnownDiscoveryDocument {
            schema_version: 1,
            instance_id: id.to_string(),
            control_api_url: format!("{origin}/api"),
            auth_issuer_url: format!("{origin}/auth"),
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
    let p1 = make_profile("cloud", "https://app.lody.ai");
    let p2 = make_profile("corp", "https://lody.corp.internal");
    assert_ne!(p1.isolated_data_dir(root), p2.isolated_data_dir(root));

    let expired = EntitlementStatus::ExpiredReadOnly {
        reason: "expired".to_string(),
    };
    assert!(!expired.allows_remote_collaboration_dispatch());
    assert!(expired.allows_local_read_and_export());
}
