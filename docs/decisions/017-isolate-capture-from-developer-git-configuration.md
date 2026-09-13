# ADR-017: Isolate capture from developer Git configuration

## Status

Accepted

## Date

2026-09-13

## Context

A snapshot is meant to be frozen: every artifact identity is a digest over
captured content, capture proves the tree was stable by reading it twice, and
`path-classification.ts` states that classification is deterministic by
construction because a classifier that answered differently on two runs would
break the freeze, the race check, and final-stage resume.

The tree was frozen. The inputs to classification were not.

`runGit` inherits `HOME` and never pinned Git's configuration files, so capture
read whatever the developer had configured. Two surfaces were measured:

- **`core.attributesFile`** changes what `git check-attr` reports, and therefore
  whether a changed file is reviewed as SOURCE or excluded as generated,
  vendored, or documentation.
- **`core.excludesFile`** changes what `git ls-files --others --exclude-standard`
  returns, and therefore whether an untracked file is captured *at all*.

The second is the more serious, and was not part of the original report. A
developer with a broad personal ignore rule could have files silently dropped
from the snapshot while the run reported success. Membership, not merely
classification.

Two further surfaces are per-clone rather than per-machine, and survive any
configuration isolation:

- **`.git/info/exclude`**, also consulted by `--exclude-standard`.
- **`.git/info/attributes`**, always consulted by `check-attr`.

So the same commit could produce different snapshots on two machines, and even in
two clones on one machine. None of it was recorded anywhere.

The environment filter in `runGit` carried a comment claiming `GIT_CONFIG_*` was
dropped so configuration could not redirect capture. Dropping those variables
never stopped Git from reading the configuration files themselves.

## Decision

Isolate capture from everything outside the repository, use a narrower flag
where one exists, and record the single surface that has neither.

**Pin global and system configuration.** `gitEnvironment` sets
`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` to the null device. Only
repository-owned configuration and in-tree files participate in capture.

**Forward `safe.directory`, and nothing else.** That setting governs whether Git
will operate at all rather than what it reports, and it is honoured only in
protected scopes, so isolating global configuration removes it — breaking capture
wherever the checkout is owned by another user, which is ordinary in containers
and on shared mounts. The entries the user already configured are read once per
process against their real configuration and forwarded back through
`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`. This re-admits
their existing trust decisions and invents none: forwarding the target repository
unconditionally would bypass a protection that still matters, because
repository-local clean and smudge filters can execute during a working-tree read.

This is the one place the runner sets `GIT_CONFIG_*` deliberately. The difference
from the variables that are dropped is that these values are constructed here
rather than inherited.

**Ask for in-tree ignore rules specifically.** Untracked discovery uses
`--exclude-per-directory=.gitignore` instead of `--exclude-standard`. The two are
equivalent for committed `.gitignore` files; only the former declines the global
file and `.git/info/exclude`.

**Record `.git/info/attributes` when present.** `check-attr` always reads it and
offers no flag to decline it, and rewriting attribute resolution by hand would
lose the precedence and pattern semantics that make `check-attr` the correct
reader in the first place. Its presence is recorded as a manifest omission scoped
`repository:per-clone-attributes`, which converts a silent non-determinism into a
stated one.

## Alternatives considered

### Record the configuration instead of isolating it

Rejected, and it is the option that sounds safer while being weaker.

Recording requires enumerating every configuration surface that affects capture.
The original report named one; measurement found a second within minutes, and the
list stays open — `core.autocrlf`, clean and smudge filters, `diff.*.textconv`
and others all reach capture by the same route. Isolation closes every one of
them at once, including those nobody has thought of yet.

It also does not address the harm. The failure is a personal rule silently
excluding a change from review while the tool reports success. A digest recorded
in a manifest does not prevent that; it only makes it explicable afterwards, and
only for the surfaces someone remembered to enumerate.

### Refuse to capture when `.git/info/attributes` exists

Rejected. The file is rare and usually benign, and refusing turns a reproducibility
caveat into a hard failure for a working setup. Recording it states the limitation
without taking the decision away from the operator.

### Let isolation break environments that need `safe.directory`

Rejected. It would fail exactly where the tool is most likely to run unattended,
for no gain: forwarding the user's own entries changes nothing about what capture
reports.

### Parse `.gitattributes` from the frozen BASE directly

Rejected for now. It would close the last surface and remove the dependency on
ambient state entirely, but reimplementing Git's attribute precedence, pattern
syntax, and macro expansion is a large surface to get subtly wrong, and being
subtly wrong here silently misclassifies files. Worth revisiting only with a
differential test against `check-attr`.

## Consequences

- The same commit now produces the same snapshot on any machine, except where
  `.git/info/attributes` is present, where the difference is recorded.
- Developers relying on personal global attribute or ignore rules will see their
  snapshots change. Files a personal ignore rule previously hid are now captured
  and reviewed. This is the intended correction, and it is a behaviour change.
- In-tree `.gitignore` and `.gitattributes` continue to work unchanged. They are
  repository-owned and part of the frozen tree.
- `isPathIgnoredV1` deliberately keeps using `check-ignore` with full
  configuration. It asks whether a path would be committed in the user's actual
  environment, which is a question about that environment rather than about the
  frozen snapshot.
- One extra `git config` invocation per process, cached.
