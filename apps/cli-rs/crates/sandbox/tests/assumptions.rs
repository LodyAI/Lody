use lody_ports::{
    AutomationHostOps, AutomationMatchResult, AutomationProgramContext, AutomationSandboxPort,
    PortError, PortErrorKind, PortResult, SessionId, WorkspaceId,
};
use lody_sandbox::{QuickJsAutomationSandbox, resolve_contained_cwd};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

struct TestHostOps {
    workdir: Option<PathBuf>,
    reads: BTreeMap<String, Value>,
    fetch_reply: Option<Value>,
}

impl AutomationHostOps for TestHostOps {
    fn read_resource(&self, resource: &str, _query: &Value) -> PortResult<Value> {
        self.reads.get(resource).cloned().ok_or_else(|| {
            PortError::new(
                PortErrorKind::InvalidInput,
                format!("AUTOMATION_UNKNOWN_READ_RESOURCE:{resource}"),
            )
        })
    }

    fn session_workdir(&self) -> Option<PathBuf> {
        self.workdir.clone()
    }

    fn command_env(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert(
            "PATH".to_string(),
            "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
        );
        env
    }

    fn override_fetch(&self, request: &Value) -> Option<PortResult<Value>> {
        let url = request.get("url").and_then(Value::as_str).unwrap_or("");
        if url.contains("user:pass@") || url.starts_with("file:") {
            return None;
        }
        self.fetch_reply.clone().map(Ok)
    }
}

fn sample_ctx() -> AutomationProgramContext {
    AutomationProgramContext {
        session_id: SessionId("00000000-0000-4000-8000-000000000001".to_string()),
        workspace_id: WorkspaceId("ws_test".to_string()),
        now_ms: 1_700_000_000_000,
    }
}

#[test]
fn sandbox_validates_function_shape_evaluates_async_reads_and_enforces_call_timeout_and_cwd_bounds()
{
    let dir = tempfile::tempdir().unwrap();
    let subdir = dir.path().join("nested");
    fs::create_dir_all(&subdir).unwrap();
    fs::write(subdir.join("marker.txt"), "ready-now\n").unwrap();

    let outside = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape_link")).unwrap();
        assert!(resolve_contained_cwd(dir.path(), Some("escape_link")).is_err());
    }
    assert!(resolve_contained_cwd(dir.path(), Some("../outside")).is_err());
    assert!(resolve_contained_cwd(dir.path(), Some("/etc")).is_err());
    assert!(resolve_contained_cwd(dir.path(), Some("nested")).is_ok());

    let sandbox = QuickJsAutomationSandbox::with_limits(
        8 * 1024 * 1024,
        Duration::from_millis(400),
        Duration::from_millis(200),
    );
    let ctx = sample_ctx();

    assert!(sandbox.validate_program("42", &ctx).is_err());
    assert!(
        sandbox
            .validate_program("({ notAFunction: true })", &ctx)
            .is_err()
    );
    sandbox
        .validate_program(
            "async ({ ctx }) => { const s = await ctx.read('session'); return false; }",
            &ctx,
        )
        .expect("validation must not invoke function body or require reads");

    let mut reads = BTreeMap::new();
    reads.insert(
        "github.pullRequests".to_string(),
        json!([{ "number": 42, "checks": "success" }]),
    );
    let ops: std::sync::Arc<dyn AutomationHostOps> = std::sync::Arc::new(TestHostOps {
        workdir: Some(dir.path().to_path_buf()),
        reads,
        fetch_reply: Some(json!({ "ok": true, "status": 200, "body": "pong" })),
    });

    let not_ready = sandbox
        .evaluate_program(
            "async ({ ctx }) => { const prs = await ctx.read('github.pullRequests'); return prs.length === 99 ? { resumeText: 'go' } : false; }",
            &ctx,
            std::sync::Arc::clone(&ops),
        )
        .unwrap();
    assert_eq!(not_ready.matched, None);
    assert_eq!(not_ready.reads, vec!["github.pullRequests".to_string()]);
    assert_eq!(not_ready.evidence.len(), 1);

    let matched = sandbox
        .evaluate_program(
            r#"
            async ({ ctx }) => {
              const [prs, http, cmd] = await Promise.all([
                ctx.read("github.pullRequests"),
                ctx.fetch("https://example.com/status"),
                ctx.exec("/bin/cat", ["marker.txt"], { cwd: "nested" }),
              ]);
              if (prs[0].checks === "success" && http.ok && cmd.stdout.trim() === "ready-now") {
                return {
                  resumeText: "  PR #42 green and marker ready  ",
                  payload: { pr: prs[0].number, marker: cmd.stdout.trim() }
                };
              }
              return false;
            }
            "#,
            &ctx,
            std::sync::Arc::clone(&ops),
        )
        .unwrap();
    assert_eq!(
        matched.matched,
        Some(AutomationMatchResult {
            resume_text: "PR #42 green and marker ready".to_string(),
            payload: Some(json!({ "pr": 42, "marker": "ready-now" })),
        })
    );

    let too_many_calls = sandbox.evaluate_program(
        r#"
        async ({ ctx }) => {
          for (let i = 0; i < 40; i++) {
            await ctx.read("github.pullRequests");
          }
          return false;
        }
        "#,
        &ctx,
        std::sync::Arc::clone(&ops),
    );
    assert!(
        too_many_calls
            .unwrap_err()
            .message
            .contains("AUTOMATION_TOOL_CALL_LIMIT_EXCEEDED")
    );

    let credential_url = sandbox.evaluate_program(
        r#"async ({ ctx }) => { await ctx.fetch("https://user:pass@example.com"); return false; }"#,
        &ctx,
        std::sync::Arc::clone(&ops),
    );
    assert!(
        credential_url
            .unwrap_err()
            .message
            .contains("AUTOMATION_FETCH_INVALID_URL")
    );

    let infinite_loop = sandbox.evaluate_program(
        "() => { while (true) {} }",
        &ctx,
        std::sync::Arc::clone(&ops),
    );
    assert!(
        infinite_loop
            .unwrap_err()
            .message
            .contains("AUTOMATION_PROGRAM_TIMEOUT")
    );
}
