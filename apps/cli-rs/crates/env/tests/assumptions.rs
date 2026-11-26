use lody_env::{HostEnv, keys};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[test]
fn explicit_data_dir_disables_default_anchor_gate_and_unknown_platform_fails_closed() {
    let invalid = HashMap::from([(keys::LODY_PLATFORM, "staging-preset")]);
    assert!(HostEnv::from_lookup(|k| invalid.get(k).map(|v| (*v).to_string())).is_err());

    let oss_vars = HashMap::from([(keys::HOME, "/Users/alice")]);
    let oss = HostEnv::from_lookup(|k| oss_vars.get(k).map(|v| (*v).to_string())).unwrap();
    assert_eq!(oss.data_dir, PathBuf::from("/Users/alice/.lody-oss"));
    assert!(oss.is_default_data_dir);

    let cloud_vars = HashMap::from([(keys::HOME, "/Users/alice"), (keys::LODY_PLATFORM, "cloud")]);
    let cloud = HostEnv::from_lookup(|k| cloud_vars.get(k).map(|v| (*v).to_string())).unwrap();
    assert_ne!(oss.data_dir, cloud.data_dir);
    assert!(cloud.is_default_data_dir);

    let override_vars = HashMap::from([
        (keys::HOME, "/Users/alice"),
        (keys::LODY_PLATFORM, "local"),
        (keys::LODY_DATA_DIR, "/Users/alice/.lody-oss"),
    ]);
    let overridden =
        HostEnv::from_lookup(|k| override_vars.get(k).map(|v| (*v).to_string())).unwrap();
    assert_eq!(overridden.data_dir, PathBuf::from("/Users/alice/.lody-oss"));
    assert!(!overridden.is_default_data_dir);
}

#[test]
fn electron_run_as_node_is_stripped_for_external_agents_kept_only_for_current_exe_and_proxies_preserve_loopback()
 {
    let merged = lody_env::merge_loopback_no_proxy(Some(""), Some("corp.internal"));
    assert_eq!(merged, "corp.internal,localhost,127.0.0.1,::1");
    assert_eq!(
        lody_env::merge_loopback_no_proxy(Some("*"), Some("a.local")),
        "*"
    );

    let vars = HashMap::from([
        (keys::HOME, "/Users/alice"),
        (keys::ELECTRON_RUN_AS_NODE, "1"),
        (keys::ALL_PROXY, "socks5://127.0.0.1:1080"),
        (keys::NO_PROXY, ""),
        (keys::NO_PROXY_LOWER, "intranet.local"),
    ]);
    let env = HostEnv::from_lookup(|k| vars.get(k).map(|v| (*v).to_string())).unwrap();
    assert_eq!(env.https_proxy.as_deref(), Some("socks5://127.0.0.1:1080"));

    let helper_exe = Path::new("/Applications/Lody.app/Contents/MacOS/Lody Helper");
    let external_agent = Path::new("/usr/local/bin/claude");

    let external_env = env.agent_spawn_env(external_agent, Some(helper_exe));
    assert!(!external_env.contains_key(keys::ELECTRON_RUN_AS_NODE));
    assert_eq!(
        external_env.get(keys::ALL_PROXY).map(String::as_str),
        Some("socks5://127.0.0.1:1080")
    );
    assert_eq!(
        external_env.get(keys::NO_PROXY),
        external_env.get(keys::NO_PROXY_LOWER)
    );
    assert!(
        external_env
            .get(keys::NO_PROXY)
            .is_some_and(|v| v.contains("127.0.0.1"))
    );

    let builtin_adapter_env = env.agent_spawn_env(helper_exe, Some(helper_exe));
    assert_eq!(
        builtin_adapter_env
            .get(keys::ELECTRON_RUN_AS_NODE)
            .map(String::as_str),
        Some("1")
    );

    let auto_env = env.automation_command_env();
    assert!(!auto_env.contains_key(keys::ELECTRON_RUN_AS_NODE));
    assert_eq!(
        auto_env.get(keys::ALL_PROXY).map(String::as_str),
        Some("socks5://127.0.0.1:1080")
    );

    let term_env = env.sanitized_terminal_env("sess-42");
    assert_eq!(
        term_env.get(keys::LODY_SESSION_ID).map(String::as_str),
        Some("sess-42")
    );
    assert!(!term_env.contains_key("LODY_CLI_TOKEN"));
    assert!(!term_env.contains_key(keys::ELECTRON_RUN_AS_NODE));
}
