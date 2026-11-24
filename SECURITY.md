# Security policy

## Report a vulnerability privately

Email [contact@lody.ai](mailto:contact@lody.ai?subject=Lody%20Security) to report a vulnerability privately to the Lody team. Use a subject beginning with “Lody Security”. For sensitive details, first ask the team to arrange an appropriate secure transfer channel.

You may also use [GitHub Private Vulnerability Reporting](https://github.com/LodyAI/Lody/security/advisories/new) when **Report a vulnerability** is available in this repository's **Security → Advisories** tab. If it is unavailable, use the email contact above.

Do not disclose vulnerabilities, exploit details, credentials, private repository content, or personal data in public issues, pull requests, or chat channels. Revoke any credential that may already have been exposed.

## Scope

Reports are welcome for the code and protocol specifications in this repository, including:

- E2EE clients, cryptographic protocols, device pairing, key custody, recovery, and authorization.
- CLI, desktop and mobile clients, local control interfaces, and synchronization.
- Installation, managed runtime integrity, and public/cloud/local boundaries.

Include the affected version or commit, platform, expected security boundary, observed impact, and minimal reproduction steps using synthetic data. Never include real keys, tokens, recovery material, or user content. Tell us privately if you believe the same issue affects a hosted service.

## Coordinated disclosure

Test only systems and accounts you own or have explicit permission to assess. Avoid accessing other users' data, disrupting service, or destructive testing. Stop and report if you encounter private data.

Please give maintainers time to investigate and prepare a fix before public disclosure. Coordinate the disclosure date and any advisory through the private report. We will use that report to discuss impact, mitigation, and release status; no fixed response or remediation deadline is promised.

## Review status

The E2EE protocol specifications and client code have undergone internal security review and automated verification. A paid third-party external cryptographic audit has not yet been completed and is planned for a future milestone. See the [security whitepaper](specs/e2ee/whitepaper.md) for the threat model and limitations.
