# Reporting bugs and unexpected behavior

A short report is better than an abandoned report. Start with what happened and
what you were doing; maintainers can ask for missing detail. Use the
[bug or unexpected behavior form](https://github.com/dills122/independent-reviewer/issues/new?template=01-bug-report.yml)
for defects, crashes, incorrect reports, confusing behavior, and other oddities.

Do not open a public issue for a suspected vulnerability. Follow
[the security policy](../SECURITY.md) instead. Do not post API keys, proprietary
source, credentials, private author packets, raw provider request bodies, or
unredacted review artifacts.

## Quick path

1. Describe what happened and what you expected.
2. List what you were doing when it happened. It is fine to say the problem is
   intermittent or that you cannot reproduce it yet.
3. Submit the report. Everything else in the form is optional.
4. For a repository-dependent problem, optionally run the capture helper below,
   review its output, and paste it into the Git capture field.

Do not spend money repeating a live provider failure solely to improve a bug
report. Preserve the first sanitized failure evidence and say which retry or
cost limits stopped further attempts.

## Minimum report

The public form requires only:

- what happened and what was expected;
- the best-known reproduction steps or the context in which it happened; and
- confirmation that the public report contains no vulnerability or sensitive
  material.

Version, environment, logs, target Git identity, frequency, last known-good
commit, screenshots, and a minimal reproduction all help, but none should stop
someone from filing.

## Optional Git capture helper

The repository includes a small POSIX shell helper for people who do not know
which Git details matter. From an Independent Reviewer checkout, run:

```sh
support/collect-bug-report-info.sh --repo /path/to/target-repository
```

The helper is plain shell and can be read before running. `--repo` is the only
option commonly needed. `--base` identifies the start of the target
changeset; without it, the helper tries the merge base with `origin/HEAD` and
otherwise falls back to `HEAD`. Add `--public-url` only when that clone URL is
already safe to publish.

For a clean public branch, the more complete form is:

```sh
support/collect-bug-report-info.sh \
  --repo /path/to/target-repository \
  --base origin/main \
  --public-url https://github.com/owner/repository
```

The helper prints Markdown to standard output for the reporter to review and
paste. It makes no network requests and changes no repository state. It does
not output source, diff bodies, changed paths, local repository paths, or
untracked contents. It reports commit IDs, clean/dirty state, staged/unstaged/
untracked counts, a tracked-change summary and SHA-256 fingerprint, and basic
tool versions. Repository URLs and commit IDs can still be sensitive, so review
every line before posting.

This metadata is enough to replay a clean changeset only when its public URL and
commits are reachable. A dirty changeset still needs a safe reproduction commit
or a separately reviewed sanitized patch if maintainers need its exact content.

## Make a public changeset replayable

For a public repository or fork, provide all of the following:

- clone URL;
- full base commit SHA;
- full head commit SHA;
- whether the working tree was clean;
- exact checkout and Independent Reviewer commands; and
- submodule or Git LFS setup, if relevant.

Prefer immutable commit SHAs over branch names or pull-request URLs alone.
Maintainers should be able to run, for example:

```sh
git clone https://github.com/owner/repository.git
cd repository
git checkout <full-head-sha>
git diff --stat <full-base-sha>..<full-head-sha>
```

If uncommitted changes are essential, first try to publish them on a temporary
public fork or minimal reproduction repository. Otherwise create a sanitized
binary-safe patch from the stated base:

```sh
git status --short
git diff --binary --full-index <full-base-sha> > reproducer.patch
```

Verify the patch in a disposable clone before attaching it:

```sh
git checkout <full-base-sha>
git apply --check /path/to/reproducer.patch
git apply /path/to/reproducer.patch
```

Include untracked files deliberately; `git diff` does not include them. Add
sanitized untracked files to the temporary reproduction commit, or package them
separately and list where they belong.

A Git bundle can carry commits when no public remote exists, but it may also
contain history and object metadata. Use one only after checking that every
included commit and object is safe to disclose. State the prerequisite base and
verify the bundle before attaching it:

```sh
git bundle create reproducer.bundle <head-branch> ^<full-base-sha>
git bundle verify reproducer.bundle
```

Compress attachments only when GitHub does not accept their extension. State
the archive contents and SHA-256 digest in the issue.

## Private repositories and sensitive inputs

Never make private source public for a bug report. Prefer, in order:

1. a small synthetic public repository that triggers the same behavior;
2. a sanitized patch against a public or synthetic base;
3. a textual reproduction using harmless placeholder content; or
4. an explanation of what cannot be shared and which observable facts remain.

Maintainers may ask focused follow-up questions, but a public issue is not a
secure upload channel. If a defect also creates a confidentiality, integrity,
availability, authorization, credential, or billing risk, use private security
reporting.

## Diagnostics for this project

If the helper cannot be used, useful local facts include:

```sh
node --version
npm --version
git --version
git status --short
git rev-parse HEAD
```

Include the exact CLI invocation with secrets replaced by descriptive markers.
For `prepare` or capture problems, include sanitized request input, resolved base
and head, changed paths, exclusions, and packet inspection output. For `review`
or `resume-final` problems, include the exit code, stage, requested model and
provider policy, and sanitized run-attempt metadata.

Do not attach an entire `.review-runs` directory without inspecting every file.
It can contain captured source, canonical inputs, author explanations, and raw
provider responses. Never include `OPENROUTER_API_KEY` or any provider
authorization header. Missing provider usage is unknown, not zero; report it as
unknown.

## What happens after filing

Maintainers first check safety, duplication, scope, and replayability. They then
attempt the reproduction against the supplied Independent Reviewer and target
commits, record whether the behavior was observed, and request only the missing
evidence needed to proceed. A report may remain unconfirmed when its target or
inputs cannot be shared. Confirmation does not imply an immediate fix or a
particular release date.

## Maintainer setup

Repository settings complete this file-based workflow:

1. Keep GitHub Issues enabled and retain the `bug` label used by the form.
2. Enable **Settings → Security and quality → Advanced Security → Private
   vulnerability reporting**. The security contact link is not a private
   channel until this setting is enabled.
3. Subscribe maintainers to repository security-alert notifications.
4. Merge the form into the default branch, then test the issue chooser and the
   private vulnerability form while signed in as a non-maintainer.

Blank issues remain enabled because this repository currently defines only a
bug form; disabling them now would leave outside contributors without a path
for feature proposals and other legitimate topics. Add dedicated forms before
making the chooser stricter.

GitHub issue forms are used because they collect structured information while
letting this project keep the required core small;
GitHub documents their behavior in [About issue and pull request templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates).
The replay guidance follows Git's documented patch workflow and
[`git bundle`](https://git-scm.com/docs/git-bundle), which transports refs and
Git objects when an ordinary remote is unavailable.
