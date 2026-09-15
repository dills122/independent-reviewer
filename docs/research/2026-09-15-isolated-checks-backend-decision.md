# Isolated named-check backend decision

Date: 2026-09-15. Status: decision-ready research; no execution backend is
implemented or qualified. Decision owner: project maintainer. Parent issue:
[#164](https://github.com/dills122/independent-reviewer/issues/164).

## Executive conclusion

Qualify one Linux backend first: an exact-pinned gVisor `runsc` release under a
rootless Docker Engine whose cgroup v2 controllers are proven to enforce every
declared resource limit. Use gVisor's default `systrap` platform initially. The
backend is `UNSUPPORTED` until the complete probe matrix in this report passes
on each exact host/backend version. Ordinary Docker, a rootful Docker daemon,
native child processes, disposable worktrees, and temporary directories do not
satisfy this boundary.

macOS remains `UNSUPPORTED` for the first backend. Docker Desktop and Podman
Machine add a Linux VM, but their exact VM, daemon, mount, egress, limit, and
cleanup boundaries have not been qualified here. Apple `container` is the most
direct later macOS candidate because it runs Linux containers as lightweight
virtual machines on Apple silicon, but its project is still under active
development and no repository probe has run against it.

Keep the current Node `spawn`-based controller. It starts and supervises the
backend CLI; it is not the isolation boundary. This supersedes the earlier
recommendation to adopt `execa` without a demonstrated product gap. Revisit only
when a retained failing lifecycle test, supported-platform defect, or measured
maintenance cost shows the current wrapper cannot meet the controller contract.

Dependency acquisition is a separate, operator-controlled phase. A check run
uses a locally present, digest-pinned image with implicit pulls disabled and
network denied. It never runs a package installer. Issue
[#113](https://github.com/dills122/independent-reviewer/issues/113) provides
promising macOS evidence that Tree-sitter WASM assets survive
`npm ci --ignore-scripts`, but it does not establish Linux support, packaging
parity, or a project-wide install-policy change.

## Research packet

### Question and reason

Which isolation boundary, platform contract, result semantics, and acquisition
policy can support runner-observed named checks without turning repository or
provider text into host execution authority?

Answer matters before build-dependent semantic indexers or runtime checks are
added. A subprocess timeout or temporary worktree can improve cleanup without
protecting host files, secrets, sockets, network, or the host kernel.

### Authorized scope and stop condition

Authorized: repository and issue evidence, current primary documentation,
read-only local tool/version inventory, proposed contracts, backend comparison,
and an acceptance-probe design. Prohibited: product runtime, provider calls,
paid evaluation, GitHub mutation, package installation, VM/container creation,
daemon configuration, and changing dependency policy.

Stop condition: select one candidate to qualify, define fail-closed platform
states and versioned contract shapes, reconcile process-wrapper guidance, and
retain the probes required before implementation can call the backend
`SUPPORTED`.

### Source hierarchy and method

Repository architecture, protocol, ADRs, and issues own product invariants.
Official backend and package-manager documentation supplies capability and
platform facts. Local commands only inventoried installed clients; they did not
exercise a daemon or isolation boundary.

Evidence labels in this report mean:

- **Documented fact:** supported directly by a linked primary source.
- **Observation:** reproduced on the named local host.
- **Inference:** design conclusion from documented facts and repository rules.
- **Unknown:** evidence still required for qualification.

## Threat boundary

Named checks execute repository-controlled code. Treat snapshot files,
dependencies, test runners, compilers, fixtures, and all descendants as
untrusted. Provider output may select only an enabled `checkId`; it cannot
provide a command, argument, environment value, image, mount, network rule, or
limit.

Protected host assets include:

- filesystem outside the exact captured source and backend-owned scratch;
- environment variables, credential files, keychains, SSH agents, cloud
  metadata, API keys, Git credential helpers, and package-registry credentials;
- Docker/Podman/containerd sockets, host control sockets, devices, and the host
  PID namespace;
- loopback and external network unless an operator-owned future policy names a
  narrowly scoped destination;
- other runs, user processes, host resources, and artifacts after cancellation
  or completion.

Initial policy assumes arbitrary native code and hostile lifecycle scripts. It
does not claim protection from hardware side channels, host/kernel/backend
vulnerabilities, denial of service outside proven limits, or a malicious host
administrator. Backend and host patching remain operator responsibilities.

## Proposed versioned contracts

These are product contract proposals, not exported runtime schemas. Runtime
implementation must use shared canonical JSON, digest, identifier, UTF-16
ordering, snapshot-path, and JSON-document primitives rather than re-declaring
them. Every artifact has `schemaVersion: 1`, a discriminating `type`, and a
JCS/SHA-256 document digest.

### `NamedCheckSpecV1`

Operator-owned catalog entry:

| Field | Required meaning |
| --- | --- |
| `checkId` | Stable prefixed identifier; reviewer may request only this value. |
| `revision` | Positive catalog revision; prevents silent command replacement. |
| `purpose` | Bounded operator text describing the assertion, not proof it is correct. |
| `argv` | Non-empty exact argument array; no shell string, interpolation, response-file expansion, or repository-derived arguments. |
| `workingDirectory` | Normalized path inside reconstructed snapshot; cannot escape or be a symlink. |
| `exitProtocol` | Disjoint pass, assertion-failure, and setup/tool-failure code sets; signals never count as assertion failures. |
| `baseHeadMode` | `REQUIRED_IDENTICAL`, `HEAD_ONLY_NEW_FEATURE`, or `SINGLE_TARGET`. |
| `environmentRequirements` | Capability names, runtime family/version range, architecture, and non-secret variable names; no values. |
| `oracle` | `SUPPLIED` or `GENERATED`, assertion digest, obligation refs, valid input domain, and required validation record. |
| `enabledForExternalRequest` | Explicit operator decision; default false. |

Catalog resolution occurs before reviewer interaction and produces a digest of
the exact entry. Unknown, disabled, changed, or ambiguous IDs return `NOT_RUN`;
they never fall back to a command string.

### `CheckExecutionPolicyV1`

Operator-owned authority and limits:

| Field | Required meaning |
| --- | --- |
| `policyId` / `policyDigest` | Exact policy identity bound into request and result. |
| `backend` | Exact backend kind, release digest/version, runtime handler, platform, architecture, and required feature set. |
| `image` | Registry/name plus immutable OCI digest; tags alone forbidden. |
| `sourceMode` | Controller-generated reconstruction of one admitted snapshot; no mutable worktree mount. |
| `network` | V1 must be `DENY_ALL`; DNS, loopback peers, host networking, and implicit image pulls denied. |
| `filesystem` | Read-only image, private reconstructed source, bounded writable scratch, no host bind mounts or devices. |
| `environment` | Start empty; add only fixed runner values and resolved operator-owned non-secret values. Ambient inheritance forbidden. Bind the canonical name/value document by digest. |
| `limits` | Hard wall time, CPU quota, memory, PIDs, disk/scratch bytes and inodes, stdout bytes, stderr bytes, and combined retained bytes. |
| `termination` | Monotonic deadline, graceful interval, forced kill, descendant accounting, removal deadline, and orphan scan. |
| `acquisition` | `PREBUILT_LOCAL_ONLY`; implicit pull and in-run install forbidden. |
| `outputDisclosure` | Secret/disclosure detector policy, fail-closed handling, model-safe byte cap, and cumulative evidence/tool/conversation admission limits. |

Admission fails when backend introspection cannot prove every requested feature
and limit is active. Docker documents that rootless cgroup flags can be ignored
without cgroup v2 and systemd; V1 therefore treats missing controllers as
`UNSUPPORTED_ENVIRONMENT`, not a best-effort downgrade.

### `CheckEnvironmentProfileV1`

Stable comparable environment identity. It contains no attempt ID, timestamp,
container/process ID, counters, or other volatile observation:

| Field | Required meaning |
| --- | --- |
| `environmentId` | Digest of all remaining fields, not an operator label. |
| `backend` | Client, daemon/engine, OCI runtime, gVisor release, platform, kernel, architecture, rootless status, and security-profile identities. |
| `image` | Manifest digest, config digest, and required local-only acquisition policy. |
| `dependencies` | Lockfile/content digest and acquisition provenance; `NONE` when image contains all requirements. |
| `capabilities` | Effective network, mount, user, PID, cgroup/controller, seccomp, capability, privilege, scratch, and output-limit states. |
| `environment` | Sorted names plus digest of exact fixed values; secret values are forbidden rather than hidden behind a digest. |
| `qualification` | Probe-suite version, exact qualifying result digest, and expiry/recheck policy. |

### `CheckEnvironmentObservationV1`

One attempt's preflight and runtime observation:

| Field | Required meaning |
| --- | --- |
| `observationId` / `attemptId` | Unique observation identity bound to one result; never used as comparable environment identity. |
| `environmentId` | Expected `CheckEnvironmentProfileV1`; stable-field drift fails admission. |
| `observedAt` | Controller wall-clock and monotonic start data. |
| `actualBackend` | Actual client/daemon/runtime/kernel/security configuration and private backend resource identity. |
| `actualImage` | Locally present image/config digests and pull-never preflight receipt. |
| `actualCapabilities` | Applied network, mount, user, cgroup/controller, seccomp, capability, privilege, and limit readings. |
| `actualEnvironment` | Sorted names and digest of exact values passed after empty-environment construction. |
| `qualificationState` | Qualification freshness and exact probe result used at admission. |
| `drift` | Empty on admission; any difference from stable profile produces `UNSUPPORTED_ENVIRONMENT` before assertion. |

BASE and HEAD attempts carry distinct observation IDs and timestamps while
binding same stable `environmentId`. They are comparable only when both
observations validate every stable field with empty drift. V1 never reuses a
prior check result as current runner evidence. An exact old result may be shown
only as historical evidence; current execution creates a new observation and
result. Any future cache reuse needs a new decision and contract version, so a
source, profile, policy, oracle, or engine near-match cannot be mistaken for
current observation.

### `CheckResultV1`

One immutable attempt result:

| Field | Required meaning |
| --- | --- |
| Identity | Result/run/request IDs plus exact check, policy, environment, oracle, snapshot, BASE/HEAD side, and source digests. |
| Lifecycle | Requested, admitted, setup-started, assertion-started, terminal-triggered, exited, cleanup-started, and cleanup-finished timestamps/events with valid transition rules. |
| Assertion outcome | `PASSED`, `FAILED`, or `NOT_OBSERVED`; semantic assertion result stays separate from process lifecycle. |
| Execution outcome | Exactly one execution taxonomy value below plus a bounded runner reason code. |
| Cleanup outcome | `SUCCEEDED`, `FAILED`, or `NOT_REQUIRED`, independently retained after execution outcome. |
| Process | Executor identity, PID/container identity where safe, exit code or signal, OOM/resource events, and cleanup receipt. |
| Output | Local-only raw-output reference and optional separately admitted model-safe-output reference. |
| Limits | Declared and observed wall time, CPU, peak memory, PID peak, scratch bytes/inodes, and unavailable measurements. |
| Provenance | `RUNNER_OBSERVED`; author logs live in separate evidence and can never populate these fields. |

Execution-outcome taxonomy:

- `COMPLETED`: assertion process reached clean EOF and exited with a configured
  pass or assertion-failure code. `assertionOutcome` carries which one.
- `SETUP_FAILURE`: after a supported profile was admitted, reconstruction,
  entrypoint, dependency, or configured setup/tool exit prevented a trustworthy
  assertion result. An unavailable or unprovable required capability is
  `UNSUPPORTED_ENVIRONMENT` instead.
- `PROCESS_CRASHED`: unclassified signal, abnormal exit, or lost process made
  configured assertion semantics unavailable.
- `OOM_KILLED`: backend gives authoritative evidence that memory limit caused
  termination.
- `OUTPUT_LIMIT_EXCEEDED`: stdout, stderr, or combined observed-byte limit was
  first terminal cause.
- `RESOURCE_LIMIT_EXCEEDED`: a proven CPU, PID, scratch byte/inode, or other
  contracted resource limit was first terminal cause.
- `TIMED_OUT`: monotonic deadline expired, regardless of later exit.
- `CANCELLED`: authorized caller cancelled before timeout.
- `UNSUPPORTED_ENVIRONMENT`: backend or required capability/limit could not be
  proven before execution.
- `NOT_RUN`: disabled, not requested, execution-admission budget rejected, or
  another explicit pre-setup reason. A later model-delivery budget failure does
  not rewrite an execution that already happened.

`assertionOutcome` may be `PASSED` or `FAILED` only when execution is
`COMPLETED` and exact exit-code mapping applies; every other execution outcome
requires `NOT_OBSERVED`. First durable causal terminal event wins. An
authoritative backend OOM/resource event is recorded as its specific outcome;
otherwise output limit, timeout, or cancellation uses whichever controller event
was durably recorded first. A later cleanup kill or exit signal never rewrites
that cause. Unknown abnormal termination is `PROCESS_CRASHED`.

Cleanup is independent. Once backend resources exist it must be `SUCCEEDED` or
`FAILED`, even after a completed assertion. Cleanup failure never rewrites
assertion or execution history, but makes claim projection `INCONCLUSIVE`, blocks
result reuse/transmission of repository output, and marks backend unhealthy until
operator reconciliation proves no survivor. `NOT_REQUIRED` is valid only before
any backend resource was created.

A separate claim-evidence projection may say `SUPPORTS_CLAIM`,
`CONTRADICTS_CLAIM`, `INCONCLUSIVE`, or `NOT_APPLICABLE`. Support or contradiction
requires `COMPLETED`, `PASSED`/`FAILED`, `cleanupOutcome: SUCCEEDED`, validated
oracle, comparable environment where required, and admitted model-safe evidence.
Every other combination, inconsistent pair, or flaky observation projects to
`INCONCLUSIVE`; none becomes a code defect.

### Raw-local and model-safe output

`CheckRawOutputV1` is private runner evidence and is never placed in a model
message. It binds result/stream IDs, bytes observed before termination, streaming
digest over those observed bytes, clean-EOF status, retained-prefix byte count
and digest, truncation/limit cause, private artifact reference, and capture
errors. stdout and stderr remain separate. A digest over a retained prefix is
never labeled as digest of complete output.

`CheckTransmittedOutputV1` is a separately derived artifact. It binds raw-output
digests, disclosure-policy and scanner versions, scan decision, any
non-sensitive rule IDs and transformation ranges, exact final UTF-8 bytes and digest,
byte/token counts, truncation markers, and the tool/conversation admission
receipt. Exact bytes include runner-owned provenance/delimiter text. Provider
request ledger additionally binds the complete containing message and wire body.

V1 disclosure policy is fail closed:

1. Scan raw retained bytes and decoded text for configured secret patterns,
   exact ambient/fixture canaries, prohibited host paths or control-socket
   identities, invalid UTF-8, terminal/control escapes, and output-policy size.
2. Any secret, prohibited disclosure, ambiguous encoding, incomplete scan, or
   cleanup failure selects `REJECT_TRANSMISSION`. The model receives only a fixed
   runner-generated status and digests, never matching output bytes.
3. Deterministic escaping may neutralize non-secret control characters before a
   second scan. Secret redaction is not supported in V1 because partial,
   transformed, or encoded values can evade span replacement. Adding
   `DETERMINISTIC_REDACT` requires a new qualified policy version; unknown policy
   values reject.
4. Before any provider call containing a check result, admit exact transmitted
   bytes against per-result and cumulative evidence/tool bytes and tokens,
   conversation bytes, call/time limits, and conservative reservation for all
   still-mandatory model calls. Failure withholds bytes or stops before provider
   delivery; it cannot clip silently or borrow budget from mandatory stages.
5. Serialize admitted output only inside fixed runner-owned untrusted-evidence
   framing. Repository output cannot define tool calls, commands, permissions,
   messages, or policy, and never bypasses normal request/schema admission.

### `OracleValidationV1`

Generated checks require a companion evaluator-owned record before admission:

- exact generated test/source and assertion digest;
- canonical obligation refs and independently stated expected behavior;
- valid and excluded input domains;
- validator identity/type and evidence digest;
- `ACCEPTED`, `REJECTED`, or `INCONCLUSIVE` decision with bounded rationale;
- generator identity, which must differ from validator identity;
- no access by validator to generator's defect conclusion beyond assertion and
  declared obligation; and
- immutable linkage to `NamedCheckSpecV1` revision.

V1 accepts generated oracle evidence only after human approval or a separately
qualified independent-review process with mandatory human review of severe or
disputed outcomes. A model-generated test that fails is not self-validating.

## BASE/HEAD differential rules

When `baseHeadMode` is `REQUIRED_IDENTICAL`, run exact same check-spec digest and
stable environment ID against independently reconstructed BASE and HEAD
snapshots. Each attempt has its own environment observation. Only source
identity, designated side, timestamps, and private resource IDs may differ;
stable-field drift makes pair inconclusive. Preserve both attempt records even
when one fails.

| BASE | HEAD | Allowed interpretation |
| --- | --- | --- |
| completed/pass | completed/fail | Regression evidence for validated oracle; still requires claim/source adjudication. |
| completed/fail | completed/pass | Fix evidence. |
| completed/fail | completed/fail | Pre-existing behavior, wrong oracle, or shared environment problem; inconclusive for regression. |
| completed/pass | completed/pass | Proposed regression not reproduced. |
| any non-completed or cleanup-failed result | any | Inconclusive; no automatic retry or favorable-result selection. |

`HEAD_ONLY_NEW_FEATURE` requires a retained non-comparability reason and oracle
validation. Do not synthesize a BASE command or treat BASE setup failure as a
regression. Repetitions, if predeclared, retain every outcome and seed; evidence
cannot discard a flaky run or repeat until the desired result appears.

## Backend comparison

| Option | Current primary-source facts | Product disposition |
| --- | --- | --- |
| Linux rootless Docker + gVisor `runsc` | gVisor requires Linux 5.6+ on x86_64/ARM64, interposes a user-space kernel, documents rootless Docker/Podman integration, and relies on host cgroups/network policy for resource and egress enforcement. Compatibility gaps remain. | **First qualification candidate.** `UNSUPPORTED` until exact release, rootless chain, cgroup v2 controllers, language fixtures, and full probes pass. |
| Linux rootless Docker with default OCI runtime | Docker rootless makes daemon/runtime unprivileged, but containers still share host kernel; daemon configuration and socket remain powerful. | `UNSUPPORTED` for hostile checks in V1; useful control arm only. |
| Linux Firecracker | Hardware-backed microVM boundary, minimal device model, Linux/KVM requirement, separate guest kernel/rootfs and production host setup. | Strong future hosted/managed candidate; defer because image, agent, networking, cleanup, and KVM operations exceed local V1 scope. |
| Linux bubblewrap | Can construct user/mount/PID/network namespaces and seccomp policy, but maintainers state it is not a complete ready-made sandbox and security depends on caller arguments. | Reject as V1 backend; too much security policy becomes product-owned. |
| macOS Docker Desktop / Podman Machine | Linux containers run inside a VM; Podman documents rootless machine management and macOS VM providers. | `UNSUPPORTED` until exact VM/engine mount, socket, egress, cgroup, descendant, and cleanup probes pass. No inference from Linux qualification. |
| macOS Apple `container` | Official project supports Apple silicon on macOS 26 and runs Linux containers as lightweight VMs; project describes active development and non-semver releases. | Later candidate; `UNSUPPORTED` now. Revisit after CLI stability and full repository probe. |
| Native Node child process, temporary directory, or disposable Git worktree | Process wrapper controls argv/lifecycle and a worktree separates file placement only. | Permanently insufficient as an isolation backend. |

## Selected Linux qualification profile

Candidate profile, not a runnable command contract:

- exact Linux host/kernel and architecture inventory;
- true rootless daemon/runtime chain, never rootful daemon plus Docker-group
  access or only `userns-remap`;
- exact-pinned gVisor release and `runsc` runtime using `systrap` initially;
- image referenced by digest and already local; pull policy `never`;
- no host bind mounts, Docker socket, devices, privilege, added capabilities,
  host namespaces, or inherited environment;
- network namespace with no connectivity;
- read-only image; private reconstructed source and bounded scratch only;
- non-root check UID, no-new-privileges, default-or-stricter seccomp, all
  capabilities dropped;
- cgroup v2/systemd-backed CPU, memory, and PIDs plus bounded scratch/output and
  monotonic controller deadline; and
- controller-enforced kill/remove/orphan audit even after client interruption.

Exact flags are implementation-owned and must be produced from validated policy,
not copied from repository files. Backend introspection and negative probes must
verify effects rather than treating CLI success as proof.

## Required qualification probes

Every probe records source fixture digest, policy/environment identities,
command, expected boundary, actual events, output digests, and cleanup receipt.
Qualification fails closed if a measurement is unavailable.

### Filesystem and source

- mutate a sentinel outside sandbox; expect no visibility and unchanged host
  digest;
- read unrelated worktree, home, `/etc` secret fixture, and adjacent run; expect
  denial or absence;
- attempt absolute, `..`, hard-link, symlink, procfs-fd, mount, and archive-path
  escapes during reconstruction and execution;
- fill scratch bytes and inodes; expect bounded failure without host spill;
- prove source reconstruction digest before start and no host mutation after.

### Secrets and control surfaces

- seed canary values in ambient environment, credential files, agent sockets,
  Docker socket, cloud-metadata emulator, Git/package config, and keychain-facing
  paths; expect none in environment, filesystem, output, or result artifacts;
- attempt device, Docker/Podman/containerd socket, host PID, ptrace, keyring, and
  privileged-syscall access; expect denial;
- recursively scan bounded outputs/artifacts for every canary.
- emit secrets and prohibited paths split across stream chunks, common encoded
  forms, invalid UTF-8, terminal escapes, and prompt/tool-like text; prove raw
  artifacts stay local, ambiguous scans reject, harmless control escaping is
  deterministic, and exact admitted bytes/digests match provider ledger input;
- exceed per-result and cumulative evidence/tool/conversation admission after a
  successful check; prove no hostile output bytes reach another provider call
  and execution outcome remains unchanged.

### Network

- attempt DNS, public IPv4/IPv6, loopback host service, link-local metadata, Unix
  abstract sockets, and a cooperating adjacent container; expect no connection;
- verify image pull and package acquisition cannot occur after check admission;
- prove policy remains denied across descendants and alternate protocols.

### Descendants, deadlines, and cleanup

- silent child, stalled stdin/stdout/stderr, output flood on either stream,
  ignored termination, double-fork/session escape, daemonized child, fork bomb,
  and child retaining pipe descriptors;
- start deadline before reconstruction/backend setup that can block; require
  bounded create, attach, copy, wait, kill, remove, and orphan-scan phases;
- interrupt controller at each lifecycle transition; reconciliation must locate
  and remove named backend resources or return visible cleanup failure;
- after forced termination, prove no container, process, mount, namespace,
  network endpoint, volume, or scratch artifact survives.

### Resource and result semantics

- exceed CPU, memory, PIDs, scratch bytes/inodes, stdout, stderr, and combined
  output independently; verify exact terminal classification and retained caps;
- distinguish configured assertion exit from tool crash, missing executable,
  invalid working directory, OOM, signal, timeout, and cancellation;
- run known regression BASE/HEAD, clean counterpart, both-fail control,
  non-comparable new feature, flaky seeded check, and stale-result identity;
- verify author logs never acquire `RUNNER_OBSERVED` provenance and no
  non-assertion outcome projects to demonstrated defect.

### Platform matrix

Minimum Linux qualification covers x86_64 and ARM64 separately only if both are
claimed, Node.js 24 plus the project's JavaScript/TypeScript/TSX, Python, Go, and
Java smoke fixtures, gVisor compatibility failures, and exact cgroup controller
availability. macOS needs its own full matrix; a Linux pass does not transfer.

## Process-wrapper reconciliation (#116)

The 2026-09-10 Git/context report recommended adopting `execa`; the later
agent-tool-loop experiment found both Execa and Node can provide no-shell argv,
timeouts, cancellation, and output limits, while product-specific environment,
classification, persistence, and cleanup remain local. Runtime currently uses
Node primitives successfully.

Decision: retain Node `spawn` behind one bounded backend-controller adapter.
Required controller tests cover spawn error, both stream floods, silent/stalled
I/O, timeout from before any blocking phase, cancellation, process-tree/backend
resource removal, non-throwing exit capture, and exactly-once settlement. These
tests prove controller lifecycle, not sandbox strength.

Revisit only when:

1. a retained supported-platform failure cannot be fixed inside the narrow
   adapter without reimplementing commodity lifecycle machinery;
2. a measured code/maintenance comparison shows exact-pinned Execa deletes
   material complexity while preserving byte streams, empty environment,
   backend reconciliation, and result taxonomy; or
3. a new supported platform requires semantics Node cannot supply and parity
   tests demonstrate Execa can.

Dependency release novelty or ergonomic preference is not a trigger.

## Dependency acquisition and #113

npm documents that `ignore-scripts=true` prevents scripts declared in package
manifests while explicit commands such as `npm test` and `npm run` still execute
their target script without pre/post hooks. Issue #113 records one offline macOS
clean-install observation: required Tree-sitter WASM files remained after
`npm ci --ignore-scripts`. It also explicitly leaves supported macOS/Linux,
runtime grammar, packaging, and complete lifecycle inventory unverified.

Consequences for named checks:

- no `npm install`, `npm ci`, registry access, lifecycle script, build of a
  dependency image, or image pull occurs in a check run;
- an operator-controlled acquisition pipeline may build a digest-pinned image
  separately, with its own network, credentials, logs, SBOM/provenance, and
  policy evidence;
- `npm ci --ignore-scripts` is the preferred Node acquisition experiment, not
  yet a universal requirement;
- a package requiring lifecycle execution needs an explicit reviewed exception
  in acquisition policy and does not gain execution permission from repository
  content; and
- this research does not change repository `.npmrc`, install commands, lockfile,
  or support claims. #113 remains open until its full platform/package gate runs.

## Evidence and limitations

### Documented facts

- Docker rootless mode runs daemon and containers without root; rootless cgroup
  limits require cgroup v2 and systemd, and otherwise relevant flags can be
  ignored. [Rootless mode](https://docs.docker.com/engine/security/rootless/),
  [rootless limits](https://docs.docker.com/engine/security/rootless/tips/).
- Docker supports digest-pinned images, pull-never, no-network, read-only
  rootfs, PID/memory/CPU limits, no-new-privileges, and tmpfs bounds, but defaults
  are not the proposed policy. Its daemon API is a high-authority control
  surface. [Run reference](https://docs.docker.com/reference/cli/docker/container/run),
  [image digests](https://docs.docker.com/reference/cli/docker/image/pull/),
  [engine security](https://docs.docker.com/engine/security/),
  [tmpfs](https://docs.docker.com/engine/storage/tmpfs/).
- gVisor requires Linux 5.6+ and supports x86_64/ARM64. It interposes a user-space
  kernel, supports Docker integration and rootless modes, depends on host
  cgroups/network policy for resource/egress enforcement, and documents syscall
  compatibility gaps. [Installation](https://gvisor.dev/docs/user_guide/install/),
  [security model](https://gvisor.dev/docs/architecture_guide/security/),
  [rootless](https://gvisor.dev/docs/user_guide/rootless/),
  [compatibility](https://gvisor.dev/docs/user_guide/compatibility/).
- Podman on macOS requires a Linux VM; machine management is rootless. Apple
  `container` requires Apple silicon/macOS 26 and runs Linux containers as
  lightweight VMs. [Podman Machine](https://docs.podman.io/en/stable/markdown/podman-machine.1.html),
  [Apple container](https://github.com/apple/container).
- Firecracker supports Linux hosts/guests and hardware virtualization; its
  production guidance requires KVM, host/guest patching, seccomp, jailer/cgroup,
  and network controls. [FAQ](https://github.com/firecracker-microvm/firecracker/blob/main/FAQ.md),
  [production host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md).
- npm's `ignore-scripts` behavior does not prohibit explicit script commands.
  [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/).

### Local observations

Host: macOS 26.6.2, Darwin 25.6.0, ARM64. Installed clients reported Docker
29.7.2, Podman 5.8.3, and Apple `container` 1.0.0. `runsc` and Firecracker were
not found on `PATH`. A sandboxed Docker version query could not access the user
Docker socket; Podman reported no running machine/socket. No backend, image,
network, filesystem, resource, descendant, or cleanup probe ran. Node on default
`PATH` was v22.22.1, not the required Node.js 24 test runtime.

### Inferences

- gVisor plus a proven rootless/cgroup profile reduces host-kernel and daemon
  exposure enough to justify the first bounded qualification; documentation
  alone does not make it supported.
- macOS VM-backed engines may ultimately provide a useful boundary, but sharing
  an OCI interface with Linux does not establish identical enforcement.
- disabling dependency lifecycle scripts reduces acquisition risk but cannot
  replace runtime isolation or validate a generated oracle.

### Unknowns and evidence gaps

- No Linux host was available; rootless Docker/gVisor interoperability and
  cgroup enforcement are unobserved.
- No macOS backend was started; Apple `container`, Podman Machine, and Docker
  Desktop behavior is unobserved.
- No language fixture, hostile escape probe, image build, package install,
  lifecycle-script audit, or BASE/HEAD differential ran.
- Exact backend/image versions, maintenance cadence, qualification expiry, and
  acceptable performance ceilings remain owner decisions before implementation.

## Recommendation and next gate

Project maintainer should accept or reject
[ADR-019](../decisions/019-use-gvisor-backed-linux-check-workers.md). Acceptance
authorizes contract/runtime planning, not execution of repository code. Next
implementation gate must first land strict contracts and mock lifecycle tests,
then run the exact Linux probe suite in a disposable qualification environment.
Until that evidence is retained, ordinary review reports
`UNSUPPORTED_ENVIRONMENT` or `NOT_RUN` and remains fully usable without checks.
