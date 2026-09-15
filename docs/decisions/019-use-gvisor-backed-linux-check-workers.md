# ADR-019: Qualify gVisor-backed Linux workers for named checks

## Status

Proposed

## Date

2026-09-15

## Context

Issue [#164](https://github.com/dills122/independent-reviewer/issues/164)
requests runner-observed named checks and BASE/HEAD reproductions. Repository or
provider text is untrusted. Running an argument array through a bounded child
process protects command parsing and controller lifecycle; it does not protect
host files, secrets, sockets, network, kernel, or other processes.

The [isolation backend research](../research/2026-09-15-isolated-checks-backend-decision.md)
compares realistic Linux and macOS choices, proposes V1 contracts, and defines
the qualification probes. No backend passed those probes in this decision
slice, so runtime support remains absent.

Existing research also conflicts on process machinery. The Git/context report
recommended adopting Execa, while the later agent-loop experiment recommended
retaining Node's current child-process wrapper because both offer the needed
primitives and product policy remains local. Issue
[#116](https://github.com/dills122/independent-reviewer/issues/116) asks for one
decision. Issue [#113](https://github.com/dills122/independent-reviewer/issues/113)
records partial evidence for disabling npm lifecycle scripts but not full
supported-platform qualification.

## Decision

### Qualify one Linux backend first

First candidate is an exact-pinned gVisor `runsc` release under true rootless
Docker Engine on Linux. Initial platform is `systrap`. Admission requires proven
Linux/kernel/architecture support, complete rootless daemon/runtime chain,
cgroup v2/systemd enforcement for every declared controller, exact digest-pinned
local image, sandbox-private loopback with no host or external connectivity,
private source/scratch, empty ambient environment, no host
sockets/devices/mounts, and bounded output/lifecycle cleanup.

This is a qualification target, not a shipped support claim. Backend state is
`UNSUPPORTED` until the exact host/backend/image profile passes every required
filesystem, secret, network, descendant, cleanup, limit, taxonomy, oracle, and
BASE/HEAD probe. A missing or unprovable control returns
`UNSUPPORTED_ENVIRONMENT`; implementation cannot weaken policy to make a check
run.

macOS is unsupported for V1. Apple `container` is the preferred later macOS
spike; Docker Desktop and Podman Machine remain alternatives. Each needs a full
native qualification. No Linux result transfers to a VM-backed macOS engine.

### Version contracts before consumers

Define strict V1 contracts before backend orchestration:

- `NamedCheckSpecV1`: operator-owned check ID/revision, exact argv, fixed working
  directory, exit-code protocol, BASE/HEAD mode, environment capabilities,
  oracle identity, and explicit enablement;
- `CheckExecutionPolicyV1`: backend/image/acquisition identity,
  sandbox-private loopback with host/external connectivity denied,
  filesystem/environment rules, hard limits, and termination/cleanup policy;
- `CheckEnvironmentProfileV1`: stable digest-derived backend, image,
  dependency, host capability, environment, and qualification identity without
  timestamps or attempt IDs;
- `CheckEnvironmentObservationV1`: per-attempt timestamps, actual preflight,
  backend resource IDs, applied controls, and stable-profile drift decision;
- `CheckResultV1`: exact source/check/policy/environment/oracle bindings,
  separate assertion/execution/cleanup outcomes, lifecycle, process termination,
  resource observations, and cleanup receipt;
- private `CheckRawOutputV1` plus runner-generated, budget-admitted
  `CheckProviderStatusV1` containing no repository output or raw-derived digest;
- `CheckResourceLeaseV1`: crash-durable creation intent/receipt, unpredictable
  ownership identity, expiry, reconciliation, cleanup, and recovery audit;
- private `CheckComparisonV1`: complete ordered BASE/HEAD result-digest graph,
  shared identities, repetition/seed set, comparability, and atomic projection;
  and
- evaluator-owned `OracleValidationV1` for independently validating generated
  assertions and input domains before execution.

Use shared contract primitives and JCS/SHA-256 artifact identity. Historical
evidence is comparable only under exact source, check, policy, environment,
oracle, and engine identities; V1 never reuses it as current runner evidence.

Assertion outcome is `PASSED`, `FAILED`, or `NOT_OBSERVED`. Execution outcome is
`COMPLETED`, `SETUP_FAILURE`, `PROCESS_CRASHED`, `EXECUTOR_FAILURE`, `OOM_KILLED`,
`OUTPUT_LIMIT_EXCEEDED`, `RESOURCE_LIMIT_EXCEEDED`, `TIMED_OUT`, `CANCELLED`,
`UNSUPPORTED_ENVIRONMENT`, or `NOT_RUN`. Cleanup is independently `SUCCEEDED`,
`FAILED`, or `NOT_REQUIRED`. A non-completed execution requires
`NOT_OBSERVED`; cleanup failure preserves earlier history but makes evidence
inconclusive and backend unhealthy. No operational failure or inconsistent pair
can automatically become a demonstrated defect.

Controller capture, stream, persistence, backend-protocol, or reconciliation
failure is `EXECUTOR_FAILURE`: it takes trust precedence over an event from the
same incomplete observation chain, produces no provider status or claim
projection, and cannot be rehabilitated by a later backend receipt. A later
identity-bound authoritative OOM/resource receipt may refine an otherwise valid
earlier controller trigger only when it proves the resource event occurred first.

Stable environment profile excludes timestamps and attempt/resource IDs.
BASE/HEAD attempts bind the same profile through distinct observations that must
show no stable-field drift. V1 performs no automatic cross-attempt result reuse;
old results remain historical evidence only.

### Keep execution authority outside reviewed content

Provider may request an enabled `checkId` only. Operator configuration resolves
it to exact argv and policy. No shell string, repository command, author log,
model-supplied argument, environment value, image, mount, dependency, network
rule, or limit can grant authority.

Checks run only against disposable reconstruction of the exact frozen snapshot.
They never run in the user's mutable checkout. Author-provided logs retain
author provenance and cannot populate `RUNNER_OBSERVED` result fields.

Raw stdout/stderr, metadata about its content or size, artifact references, and
raw-derived digests remain private local evidence. V1 provider delivery contains
only a closed `CheckProviderStatusV1` schema of runner-generated
status/exit/resource facts. Exact serialized status bytes must pass per-artifact
and cumulative evidence, token, conversation, call, time, and mandatory-reserve
admission before delivery; request ledger binds exact status-message bytes and
wire-body digest. `EXECUTOR_FAILURE`, cleanup failure, incomplete durable state,
or admission failure suppresses check-status delivery. Hostile repository output
cannot enter or bypass provider request admission.

Richer output is deferred. A future version may expose only exact worker-visible
frozen bytes admitted for remote disclosure and budget before execution;
generated stdout/stderr and post-execution redaction remain ineligible without a
new decision, contract version, leak corpus, and provider-admission review.

Backend ownership is crash durable. Persist and sync unpredictable exact
resource identity and creation intent before create, then an identity-bound
receipt before use. Startup reconciliation and an independently supervised
janitor enforce leases/deadlines and block new admission on any uncertain,
expired, unowned, cleanup-failed, or ledger-divergent resource. Manual recovery
is exact-ID, confirmed, bounded, and audited; wildcard prune is forbidden. Node
spawn/process groups and `finally` remain controller mechanics, not a cleanup
guarantee.

### Separate acquisition from execution

V1 check execution uses `PREBUILT_LOCAL_ONLY`: immutable image digest already
present, implicit pulls disabled, no registry or package credentials,
host/external connectivity denied, and no installer or lifecycle script in the
run.

Operator-controlled image acquisition is a separate trust domain with its own
network, credentials, provenance, and audit. `npm ci --ignore-scripts` is the
preferred Node acquisition experiment where qualified, but #113's current
single-platform evidence does not authorize a repository-wide install-policy
change or a cross-platform support claim.

### Retain Node child-process primitives

Keep Node `spawn` behind one backend-controller adapter. Its responsibility is
exact argv, empty/allowlisted environment, concurrent byte-stream drainage,
monotonic deadlines, cancellation, bounded output, exit capture, backend
reconciliation, and exactly-once settlement. Isolation is supplied by qualified
backend policy, never by process-wrapper brand.

This supersedes only the unimplemented Execa adoption recommendation in the
2026-09-10 Git/context research. Revisit Execa when a retained lifecycle failure
cannot be fixed narrowly, measured maintenance evidence shows material code
removal with parity, or a supported platform requires semantics Node lacks and
Execa demonstrably provides. Dependency freshness or API ergonomics alone is
not a trigger.

### Preserve strict BASE/HEAD comparison

Regression evidence uses same check-spec digest and stable environment ID
against independently reconstructed BASE and HEAD, with distinct per-attempt
observations proving no stable drift. Completed BASE-pass/HEAD-fail may support
a validated regression. Both-fail, cleanup failure, any non-completed execution,
or flaky evidence is inconclusive. New features may use an explicit
`HEAD_ONLY_NEW_FEATURE` mode and retained non-comparability reason; they cannot
manufacture a BASE control.

For `REQUIRED_IDENTICAL`, one private `CheckComparisonV1` binds ordered
BASE/HEAD result digests, all shared identities, and the complete predeclared
repetition/seed set. Validation and provider projection are atomic: model
receives one runner-generated comparison status, never one side or a favorable
repetition. Missing, duplicate, unexpected, executor-failed, cleanup-failed, or
identity-drifted input is inconclusive and suppresses stronger projection.
`HEAD_ONLY_NEW_FEATURE` and `SINGLE_TARGET` create no comparison artifact and
make no regression/fix or differential claim; `SINGLE_TARGET` names one exact
arbitrary snapshot rather than implying HEAD.

## Alternatives considered

### Ordinary rootless Docker

Rejected as first hostile-code boundary. Rootless operation reduces daemon
privilege, but the default runtime still shares the host Linux kernel. Keep it
as a qualification control, not a supported backend.

### Rootful Docker plus gVisor

Rejected for local V1. gVisor reduces workload/host-kernel exposure, but a
rootful daemon and its control socket remain high-authority host surfaces.

### Firecracker

Deferred. Hardware microVM isolation is attractive for a managed worker, but
Linux/KVM, guest kernel/rootfs, agent, image, network, jailer/cgroup, and cleanup
operations create a larger platform than this first local backend.

### Bubblewrap or direct namespaces/seccomp

Rejected. Bubblewrap deliberately supplies mechanisms rather than a complete
security policy. Product would own too much low-level sandbox configuration and
qualification.

### macOS VM-backed engines first

Deferred. Apple `container`, Docker Desktop, and Podman Machine are realistic,
but none has repository-specific negative-probe evidence. Initial support may
be one platform; unsupported is safer than claiming equivalent enforcement.

### Native process, temporary directory, or disposable worktree

Rejected as an isolation backend. Retain these only as controller or source
materialization mechanics behind a qualified boundary.

### Adopt Execa before backend work

Rejected. It can improve lifecycle ergonomics but cannot establish sandbox
strength, and no measured current-wrapper gap justifies another dependency.

## Consequences

- Ordinary static review remains available when backend is absent or
  unsupported; check status stays visible.
- Initial runtime and CI work can target strict contracts and mock lifecycle
  behavior without executing hostile repositories.
- Linux qualification needs exact external platform evidence before promotion.
- macOS users receive explicit unsupported results until a separately qualified
  backend exists.
- Dependency/image acquisition becomes a separate operator workflow rather than
  an implicit side effect of a review.
- Generated tests cannot become evidence until their assertion and input domain
  have independent oracle validation.
- Controller dependency discussion is closed unless objective revisit evidence
  appears.
- Build-dependent C2 indexers remain blocked on a supported D backend; pure
  frozen-input adapters do not.

## Acceptance gate

Accepting this ADR does not mark backend supported. Runtime work may begin only
with versioned contracts, schemas, semantic validators, mock lifecycle tests,
and ordinary-review fallback. Promotion requires retained exact-platform results
for all probes named in the research report plus Node.js 24 application and
repository gates. Any failed or unmeasurable boundary remains unsupported.
