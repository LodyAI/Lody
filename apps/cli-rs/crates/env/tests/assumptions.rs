use lody_env::{HostEnv, keys};
use std::collections::HashMap;
use std::path::PathBuf;

#[test]
fn explicit_data_dir_overrides_platform_namespace_and_unknown_platform_fails_closed() {
    let invalid = HashMap::from([(keys::LODY_PLATFORM, "staging-preset")]);
    assert!(HostEnv::from_lookup(|k| invalid.get(k).map(|v| (*v).to_string())).is_err());

    let oss_vars = HashMap::from([(keys::HOME, "/Users/alice")]);
    let oss = HostEnv::from_lookup(|k| oss_vars.get(k).map(|v| (*v).to_string())).unwrap();
    assert_eq!(oss.data_dir, PathBuf::from("/Users/alice/.lody-oss"));

    let cloud_vars = HashMap::from([(keys::HOME, "/Users/alice"), (keys::LODY_PLATFORM, "cloud")]);
    let cloud = HostEnv::from_lookup(|k| cloud_vars.get(k).map(|v| (*v).to_string())).unwrap();
    assert_ne!(oss.data_dir, cloud.data_dir);

    let override_vars = HashMap::from([
        (keys::HOME, "/Users/alice"),
        (keys::LODY_PLATFORM, "local"),
        (keys::LODY_DATA_DIR, "/var/lib/lody-custom"),
    ]);
    let overridden =
        HostEnv::from_lookup(|k| override_vars.get(k).map(|v| (*v).to_string())).unwrap();
    assert_eq!(overridden.data_dir, PathBuf::from("/var/lib/lody-custom"));
}

#[test]
fn empty_uppercase_no_proxy_never_suppresses_loopback_bypass_and_terminal_env_strips_tokens() {
    let merged = lody_env::merge_loopback_no_proxy(Some(""), Some("corp.internal"));
    assert_eq!(merged, "corp.internal,localhost,127.0.0.1,::1");
    assert_eq!(
        lody_env::merge_loopback_no_proxy(Some("*"), Some("a.local")),
        "*"
    );

    let vars = HashMap::from([
        (keys::HOME, "/Users/alice"),
        (keys::NO_PROXY, ""),
        (keys::NO_PROXY_LOWER, "intranet.local"),
    ]);
    let env = HostEnv::from_lookup(|k| vars.get(k).map(|v| (*v).to_string())).unwrap();
    let agent_env = env.agent_spawn_env();
    assert_eq!(
        agent_env.get(keys::NO_PROXY),
        agent_env.get(keys::NO_PROXY_LOWER)
    );
    assert!(
        agent_env
            .get(keys::NO_PROXY)
            .is_some_and(|v| v.contains("127.0.0.1"))
    );

    let term_env = env.sanitized_terminal_env("sess-42");
    assert_eq!(
        term_env.get(keys::LODY_SESSION_ID).map(String::as_str),
        Some("sess-42")
    );
    assert!(!term_env.contains_key("LODY_CLI_TOKEN"));
    assert!(!term_env.contains_key("ELECTRON_RUN_AS_NODE"));
}
