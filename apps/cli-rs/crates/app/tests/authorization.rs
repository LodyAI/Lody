use lody_app::{
    AppCommand, EntitlementStatus, PortErrorKind, ProfileId, SessionId, TurnId, UserId,
    VerifiedPrincipal, WorkspaceId, enforce_command_policy,
};
use std::path::PathBuf;

#[test]
fn expired_entitlement_blocks_remote_dispatch_but_keeps_local_operations_usable() {
    let expired = EntitlementStatus::ExpiredReadOnly {
        reason: "enterprise license expired".to_string(),
    };
    let remote_caller = VerifiedPrincipal::ConnectedMember {
        profile_id: ProfileId("corp".to_string()),
        user_id: UserId("u_alice".to_string()),
    };
    let local_caller = VerifiedPrincipal::LocalHost {
        caller_pid: Some(1234),
        account_id: Some(UserId("u_alice".to_string())),
    };

    let send_chat = AppCommand::SendChat {
        workspace_id: WorkspaceId("ws_1".to_string()),
        session_id: SessionId("s_1".to_string()),
        turn_id: TurnId("t_1".to_string()),
        prompt: "hello".to_string(),
    };

    let remote_err =
        enforce_command_policy(&remote_caller, &send_chat, Some(&expired)).unwrap_err();
    assert_eq!(remote_err.kind, PortErrorKind::EntitlementReadOnly);

    assert!(enforce_command_policy(&local_caller, &send_chat, Some(&expired)).is_ok());

    let archive = AppCommand::ArchiveSession {
        workspace_id: WorkspaceId("ws_1".to_string()),
        session_id: SessionId("s_1".to_string()),
    };
    assert!(enforce_command_policy(&remote_caller, &archive, Some(&expired)).is_ok());
}

#[test]
fn remote_principal_cannot_register_local_projects_or_mutate_backend_profile() {
    let remote_caller = VerifiedPrincipal::ConnectedMember {
        profile_id: ProfileId("corp".to_string()),
        user_id: UserId("u_bob".to_string()),
    };
    let register = AppCommand::RegisterProject {
        name: "demo".to_string(),
        root_path: PathBuf::from("/srv/repo"),
    };
    let err = enforce_command_policy(&remote_caller, &register, None).unwrap_err();
    assert_eq!(err.kind, PortErrorKind::Forbidden);
}
