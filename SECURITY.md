# Security policy

## Supported versions

Independent Reviewer has not published a stable release. Security fixes target
the current `main` branch; older commits and development branches are not
supported.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/dills122/independent-reviewer/security/advisories/new).
Do not open a public issue, discussion, or pull request for a suspected
vulnerability.

Include, when safe and available:

- affected version or full commit SHA;
- vulnerability class and realistic impact;
- minimal reproduction or proof of concept;
- required preconditions and trust boundary crossed;
- affected files, functions, and source locations;
- suggested mitigation or workaround; and
- whether any disclosure deadline or active exploitation is known.

Do not include live credentials or unnecessary proprietary data. Use placeholder
secrets and the smallest synthetic reproduction possible. If reproduction
requires sensitive target source or review artifacts, describe that constraint
before transmitting them.

Maintainers will acknowledge the report through the private advisory, assess
scope and severity, coordinate a fix and validation when warranted, and discuss
disclosure timing there. No fixed response or remediation deadline is promised.

Security-sensitive areas include repository-boundary escapes, unintended source
or author-packet disclosure, credential leakage, prompt-driven permission
changes, snapshot or artifact-integrity failures, authorization bypasses,
unsafe command execution, and provider-routing or billing-control bypasses.
Ordinary incorrect output without a security consequence belongs in the public
[bug-reporting workflow](docs/bug-reporting.md).
