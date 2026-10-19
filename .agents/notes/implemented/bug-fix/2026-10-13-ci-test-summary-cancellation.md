# Preserve cancellation in the CI test summary

Status: implemented
Translation: current

[中文](2026-10-13-ci-test-summary-cancellation.zh.md)

## Abstract

A superseded PR run could leave a failed `Tests` check even after the same head completed a successful run. The summary used `always()`, so workflow cancellation still ran its success-only assertion with `RESULT=cancelled`. Use `!cancelled()` for the summary job while retaining the strict requirement that every test group succeeds. Real failures and unexpected skipped dependencies still fail; this does not convert cancellation into test success or rewrite historical checks.

## Evidence and boundary

The cancelled Lab run38363006126 logged `Test groups: cancelled` and exit1 in summary job115181431735; the same head008ef773 completed CI38363006130 successfully. The same shape affected current checks for1474,1485,1491,1493,1496 and1526. Their source/test green runs remain separate evidence; no obsolete E2EE matrix is rerun to hide a cancelled summary.

[GitHub status documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions) recommends `!cancelled()` to run regardless of success/failure while excluding cancelled workflows. Keep the existing `needs.test-groups.result == success` shell check, read-only permissions, concurrency cancellation and required-check name. No token, checkout, cache, deployment or branch-protection changes. The job predicate is evaluated by GitHub, not the local shell; local guard cases and successful CI cannot by themselves certify an observed live cancellation. Existing failed/cancelled records remain historical until future workflow executions supersede them. No automatic merge or historical-check mutation is authorized.
