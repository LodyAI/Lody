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
