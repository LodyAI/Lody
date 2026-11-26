use lody_app::{
    AppCommand, AppQuery, EntitlementStatus, MachineId, PortErrorKind, ProfileId, SessionId,
    TurnId, UserId, VerifiedPrincipal, WorkspaceId, enforce_command_policy, enforce_query_policy,
};
use serde_json::json;
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
        custom_acp: None,
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

    let restore_id = AppCommand::RestoreMachineId {
        target_machine_id: "m_hijack".to_string(),
        active_host_pid: None,
    };
    let restore_err = enforce_command_policy(&remote_caller, &restore_id, None).unwrap_err();
    assert_eq!(restore_err.kind, PortErrorKind::Forbidden);

    let mcp_caller = VerifiedPrincipal::AgentSession {
        workspace_id: WorkspaceId("ws_1".to_string()),
        session_id: SessionId("sess_caller".to_string()),
        machine_id: MachineId("m_local".to_string()),
        account_id: None,
    };
    assert_eq!(
        enforce_command_policy(&mcp_caller, &register, None)
            .unwrap_err()
            .kind,
        PortErrorKind::Forbidden
    );
    assert_eq!(
        enforce_command_policy(
            &mcp_caller,
            &AppCommand::ProposeSchedule {
                workspace_id: WorkspaceId("ws_other".to_string()),
                invoking_session_id: SessionId("sess_caller".to_string()),
                request_id: "req_1".to_string(),
                title: "Daily".to_string(),
                prompt_text: "run".to_string(),
                rule: json!({ "kind": "daily", "hour": 9, "minute": 0 }),
            },
            None
        )
        .unwrap_err()
        .kind,
        PortErrorKind::Forbidden
    );
    assert_eq!(
        enforce_command_policy(
            &mcp_caller,
            &AppCommand::ProposeSchedule {
                workspace_id: WorkspaceId("ws_1".to_string()),
                invoking_session_id: SessionId("sess_spoofed".to_string()),
                request_id: "req_1".to_string(),
                title: "Daily".to_string(),
                prompt_text: "run".to_string(),
                rule: json!({ "kind": "daily", "hour": 9, "minute": 0 }),
            },
            None
        )
        .unwrap_err()
        .kind,
        PortErrorKind::Forbidden
    );
    assert_eq!(
        enforce_query_policy(
            &mcp_caller,
            &AppQuery::ListSchedules {
                workspace_id: WorkspaceId("ws_1".to_string()),
                invoking_session_id: None,
                filter_query: None,
                limit: 10,
                offset: 0,
            }
        )
        .unwrap_err()
        .kind,
        PortErrorKind::Forbidden
    );
}
