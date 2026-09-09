# Reporting bugs and unexpected behavior

A useful report lets a maintainer reproduce the same behavior against the same
Independent Reviewer version and target changeset without guessing. Use the
[bug or unexpected behavior form](https://github.com/dills122/independent-reviewer/issues/new?template=01-bug-report.yml)
for defects, crashes, incorrect reports, confusing behavior, and other oddities.

Do not open a public issue for a suspected vulnerability. Follow
[the security policy](../SECURITY.md) instead. Do not post API keys, proprietary
source, credentials, private author packets, raw provider request bodies, or
unredacted review artifacts.

## Before filing

1. Search open and closed issues for the symptom and error text.
2. Re-run from a clean checkout when practical and note whether the problem is
   repeatable.
3. Reduce the example to the smallest repository and changeset that still fails.
4. Remove secrets and private data from inputs and diagnostics. Redaction must
   preserve the structure relevant to the problem.
5. Record the exact Independent Reviewer commit or release and environment.

Do not spend money repeating a live provider failure solely to improve a bug
report. Preserve the first sanitized failure evidence and say which retry or
cost limits stopped further attempts.

## Required report content

The issue form requires:

- concise summary, observed result, expected result, and impact;
- exact reproduction steps, commands, inputs, and exit code;
- Independent Reviewer release or full commit SHA;
- target-repository availability and a replayable changeset, or a clear reason
  it cannot be shared;
- sanitized request and review configuration when the path uses them; and
- OS/architecture plus Node.js, npm, Git, shell, and relevant provider/model
  details.

Logs, stack traces, frequency, the last known-good commit, screenshots, and a
minimal reproduction are optional but often shorten triage.

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

Useful local facts include:

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

GitHub issue forms are used because they collect structured, required fields;
GitHub documents their behavior in [About issue and pull request templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates).
The replay guidance follows Git's documented patch workflow and
[`git bundle`](https://git-scm.com/docs/git-bundle), which transports refs and
Git objects when an ordinary remote is unavailable.
