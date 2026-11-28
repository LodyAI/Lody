pub mod ipc;
pub mod sandbox;
pub mod scenarios;
pub mod summary;

pub use ipc::{DaemonRunFile, LocalIpcClient};
pub use sandbox::{CliOutput, ConformanceSandbox, TargetBinary};
pub use scenarios::{
    run_all_business_scenarios, run_differential_suite, run_shared_data_dir_handoff,
};
pub use summary::{
    BusinessOutcome, ProjectBusinessSummary, SessionBusinessSummary, TurnBusinessSummary,
    assert_business_equivalent, normalize_history_payload,
};
