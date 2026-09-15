# Correctness and comprehensive engineering review

## Executive assessment

Build a reproducible quality baseline and complete claim adjudication first.
Then improve evidence selectively, qualify semantic adapters, add isolated
observed checks, and expand engineering dimensions. More context, more agents,
and more reflection are hypotheses to test, not reliable substitutes for an
applicable obligation and evidence of a failure.

This sequence preserves Independent Reviewer's existing investment: immutable
packets, explicit author separation, bounded provider calls, versioned artifacts,
and runner-owned outcome projection. The missing layer is measured semantic
quality: whether claims are true, necessary unknowns remain visible, and relevant
defects are found. Broader engineering feedback also needs its own report classes
so useful design advice is not mislabeled as a demonstrated runtime defect.

Three refinements to the initial sequence matter:

1. Start with a small evaluator over existing artifacts rather than a new
   evaluation platform or broad model leaderboard.
2. Separate frozen evidence access from semantic indexing. Index generation that
   executes repository tooling depends on isolation, even if semantic context
   appears earlier in the product roadmap.
3. Treat missed-defect discovery as a measured option. A verifier only examining
   existing claims cannot measure completeness; a pass pressured to find more
   defects can increase noise.

The [delivery plan](../plans/2026-09-14-correctness-engineering-review-plan.md)
and [evaluation protocol](../plans/2026-09-14-review-quality-evaluation-protocol.md)
translate these conclusions into issues [#159–#165](https://github.com/dills122/independent-reviewer/issues/159).
They remain proposed implementation designs. No new backend, dependency, runtime
contract, or paid experiment is adopted by this report.

## Evidence boundaries

Repository baseline is `6073c2f`. Local analysis found a fixed-payload reviewer,
syntax-enriched deterministic units, direct relative JS/TS supporting imports,
and fresh verification of preliminary adverse claims. ADR-016 explicitly defers
final-only finding verification and deterministic inconclusive-finding
projection. The [assessment](2026-09-14-correctness-and-engineering-review-assessment.md)
records observed checks and latest historical provider evidence.

External evidence combines primary research and official project documentation.
Research on older models and other tasks informs experimental design; it does
not establish performance of current configured reviewer. Current documentation
identifies candidate capabilities, not compatibility with this repository's
exact dependency set. Any package adoption still needs a pinned, local spike.

## A. Evaluation before expansion

### Benchmarks distinguish different kinds of success

SWE-PRBench is a March 2026 preprint with 350 PRs, but its reported model
evaluation uses a 100-PR sample, with a Python-heavy corpus. It reports worse
results as context expands across its tested configurations. Its primary judge
was checked against 30 human rubric classifications; cross-judge checks were
smaller still. These limitations make it a useful warning about context
representation, not a universal instruction to remove supporting code.[^1]

CR-Bench studies defect-oriented review using 174 verified cases from a larger
584-case corpus. Its reflection variant increases recall but reduces useful
signal relative to noise. Its appendix also explicitly biases that variant
toward retaining uncertain issues, so the result does not isolate extra passes
from prompting policy. Its gold defects are not exhaustive, and its reported
precision divides known bug hits by all comments, including valid suggestions.
That metric differs from precision of demonstrated defect claims.[^2]

**Implication:** do not import either leaderboard's scalar score or thresholds.
Evaluate unique defect roots, invalid claims, useful recommendations, uncertainty,
duplicates, and delivery independently. Otherwise a reviewer can appear better
by emitting many suggestions, declining difficult reviews, or delivering only
easy cases.

### Build a bounded, reproducible corpus

Start with roughly 30 changes: 12 defect/clean pairs and six uncertainty or
author-adversarial controls. Choose cases whose obligations and expected results
can be explained independently of model output. Several should represent real
regressions; maintain synthetic controls for precise failure-channel coverage.

BugsJS offers 453 curated JavaScript bugs with separated bug, test, and fix
revisions. It provides useful provenance patterns and candidate cases, but its
historical Mocha/Node environments and project concentration require fresh
reproduction. It should not be adopted wholesale as a Node.js 24 review-quality
oracle.[^3]

SWE-bench's evaluation infrastructure builds instance environments and executes
tests in containers. It offers a concrete execution-harness reference, but
patch-repair success is a different target from whether a reviewer identifies
the correct defect without false claims. Reuse suitable reproducible cases or
environment ideas; retain review-specific scoring.[^4]

Keep defect/clean pairs and related repository families together in one split.
Do not transmit gold bug descriptions, future fixing patches, or evaluator-only
tests. A reviewer can legitimately inspect tests already in the change; a hidden
oracle test is different evidence. If supplied later, it defines a different
experiment variant.

Label completeness must be explicit. An unmatched finding can be a novel true
defect rather than a false positive. Require adjudication of new claims before
scoring them, version any gold correction, and rescore both compared variants.
Conversely, matching a filename or quoting a gold phrase must not earn credit
when the scenario is causally wrong.

### Metrics and uncertainty

Report completed-run recall and all-start recall together. First isolates
semantic behavior; second exposes lost product utility from provider failures.
Keep false abstention distinct from justified missing-evidence outcomes. Measure
true findings lost during verification, not only false findings removed.

Use a case-level score ledger with numerators and denominators. Record unavailable
ratios rather than giving perfect scores to empty output. Deduplicate root-cause
credit while retaining duplicate-comment burden. Separate model-reported usage,
unknown-cost attempts, and conservative reservations.

Small perfect samples give weak population assurances. Under independent
binomial assumptions, observing zero false-positive reviews among 12 clean
cases still permits an exact one-sided 95% upper rate near 22.1%. Repeating each
case three times estimates response variance; it does not create 36 independent
software scenarios. Use interval assumptions consistent with case/family
clustering, following established binomial interval guidance.[^5]

### Tooling decision

| Option | Useful capability | Fit for first increment |
| --- | --- | --- |
| Existing runner plus evaluator-only scorer | Preserves actual stage, admission, retry, privacy, and artifact behavior | Recommended starting point; custom work limited to product-specific cases and scoring |
| Promptfoo custom provider adapter | JavaScript/TypeScript interface can wrap an existing system and return usage/cost metadata | Candidate later UI/comparison wrapper; must invoke whole runner, not bypass policies |
| Inspect | General evaluation tasks, solvers, scorers, logging, and tool/sandbox support | Candidate research integration; adopting another framework/runtime is not required for first corpus |
| SWE-bench harness | Reproducible repair-task environments | Reference or selected case source; not a drop-in review scorer |

Promptfoo documents a custom provider interface and exposes full test context to
that provider. Any adapter must explicitly exclude oracle variables from review
inputs.[^6] Inspect offers a mature evaluation abstraction, but framework
convenience alone does not resolve this product's semantic label policy.[^7]

**Recommendation:** defer framework adoption until repeated experiment management
becomes a measured maintenance problem. Keep evaluator artifact formats simple
enough for later adapters. Do not implement another provider client, scheduler,
credential path, or retry system merely to run evaluations.

## B. Claim adjudication and external feedback

### Evidence is mixed on self-correction

An ICLR 2024 study found intrinsic self-correction unreliable on its reasoning
tasks and sometimes harmful.[^8] A separate ACL study distinguished inability
to locate a reasoning error from ability to correct an error once its location
is supplied.[^9] These findings support separate discovery and verification
measurements, but neither study directly evaluates this repository's review
protocol or current model configuration.

Counterevidence matters: ProCo improved correction by constructing targeted
verification questions around masked key conditions on its evaluated QA and
reasoning tasks.[^10] CRITIC reported gains using tool-interactive feedback
across several tasks.[^11] Together, these studies argue for well-formed
verification questions and independent evidence rather than assuming that any
fresh prompt is a truth oracle.

**Inference:** retain a fresh verifier, but score it as a fallible classifier.
Track both rejection of false claims and erroneous withdrawal of real defects.
A different model family may add diversity; qualify the effect rather than
making family difference a correctness guarantee.

### Complete the semantic boundary

Current runner enforces some useful deterministic consequences of model
judgments. The remaining problem is which claims have been judged. A final-only
finding, a changed premise under an existing ID, or an unassessed standards
status can affect outcome. Summary prose can also contradict formal disposition
even when it does not control the exit code.

Make claim identity cover obligation, domain assumptions, scenario, asserted
effect, and exact evidence. Distinguish a paraphrase from a materially new
premise through explicit bounded claim fields and a continuity decision.
Do not attempt universal semantic equivalence with regexes or hashes of titles.

Projection should be a pure, testable runner function. Demonstrated violations
remain eligible; rejected claims withdraw; inconclusive findings become
uncertainty whose blocking effect depends on necessity for an in-scope
obligation. This last condition avoids both extremes: treating every unanswered
question as a blocker and treating every inconclusive result as clean.

Selective post-author verification receives relevant newly available evidence
with author claims labeled. It cannot retroactively alter the persisted blind
assessment. Preserve source provenance for each decision and constrain factual
status prose so rejected claims do not remain as residual warnings.

### Resource and recovery consequences

An extra logical stage affects input/output reservations, maximum calls, retry
allowance, durable stage state, and final resume. Decide these together before
adding a function to the existing orchestrator. A failed final verifier needs a
visible incomplete result or an explicit eligible resume, not an unchecked final
report or a restart that leaks author context into blind stages.

Use focused modules for claim validation, eligibility, and projection. Existing
issues #49, #17, and #123 already own relevant architectural debt. Touched
responsibilities can move behind narrow boundaries; a large refactor need not
block the first correctness improvement.

## C. Evidence access and semantic context

### Larger payloads can dilute useful evidence

Lost in the Middle found performance sensitivity to relevant information's
position in long-context question answering and retrieval tasks.[^12] That is
not direct code-review evidence, but it motivates position and distractor
controls alongside code-specific context experiments.

**Recommendation:** compare current windows, enclosing declarations, and targeted
evidence access under fixed review policies. Measure missing-evidence resolution,
newly detected roots, false findings, bytes, latency, and calls. Keep changed
regions visually and structurally distinct from supporting source. Do not turn
every available file into prompt content.

The first useful expansion does not need semantic indexing: current context map
already knows declaration ranges. Materialize exact relevant declarations under
budgets and retain fallback windows when declarations are oversized or parser
output is unavailable. This offers a small, testable improvement before a tool
loop or build integration.

### Freeze a source inventory before interactive access

Evidence service must answer from admitted frozen bytes. For dirty worktrees,
an immutable commit alone is insufficient: uncommitted content needs capture at
preparation. For unchanged sources, a frozen inventory can identify permitted
objects, but every returned blob still needs path, content, size, and secret
admission under declared policy.

Separate required changed scope from optional search enrichment. Ranked results
may help discover context but cannot certify that every obligation was checked.
Search responses must report omitted results, continuation, limits, and source
identity. Persist what was actually transmitted so a valid snapshot location
does not become citable before reviewer has seen it.

Introduce supporting citation roles. A finding against a changed call site can
then cite the unchanged contract that demonstrates its error. This preserves
defect ownership without forcing every causal explanation into a changed-line
anchor. Define roles before loosening current validators.

### Semantic indexing is a separate capability

SCIP standardizes language-neutral documents, symbols, occurrences, and
relationships; separate indexers produce that information.[^13] Its schema
allows explicit position encodings and relationship roles. Importers must
handle those encodings and cannot treat every reference as a runtime call or
every omitted edge as proof of absence.[^14]

The TypeScript indexer's documented workflow expects a project configuration
and installed dependencies. It also documents memory tradeoffs. These are
operational constraints, not merely a library API over a supplied string.[^15]

| Evidence producer | Relation strength | Main constraint | Proposed treatment |
| --- | --- | --- | --- |
| Existing declaration parser | Syntactic enclosure | Cannot resolve caller semantics | Keep; materialize useful ranges |
| Reverse import/reference scan | Syntactic or heuristic candidate | Aliases, dynamic dispatch, names, and resolution ambiguity | Establish cheap baseline with honest uncertainty |
| Qualified language resolver | Semantic within documented project assumptions | Needs complete relevant configuration and declarations | Spike one adapter; bind assumptions and inputs |
| SCIP importer | Semantic facts emitted by external producer | Must verify source/producer provenance and completeness | Optional boundary; isolate executing producers |
| Embedding or text ranking | Relevance estimate | No coverage guarantee | Optional discovery enrichment only |

**Decision gate:** first demonstrate changed-helper/unchanged-caller recall gain
on clean-paired cases. Then test aliases, re-exports, unresolved dependencies,
Unicode ranges, and BASE/HEAD divergence. Reject stale indexes, unknown
resolution assumptions, and unqualified completeness claims.

Build-dependent index generation belongs behind execution isolation. A pure
frozen-input resolver can precede it. This dependency is the main reason to
split C into evidence access and semantic qualification rather than promise one
large context subsystem.

## D. Observed verification and isolation

### Process management does not establish isolation

Docker documents namespaces, cgroups, daemon exposure, capabilities, and mount
configuration as separate security considerations. Control of its daemon can
grant extensive host access.[^16] Its seccomp profile restricts system calls,
but one profile is only one boundary in the execution design.[^17]

gVisor intercepts application interactions with the host system API through a
user-space kernel boundary. Its own security model warns that sandboxing does
not replace secure architecture; compatibility remains a qualification
consideration.[^18][^19]

**Recommendation:** define the backend contract and threat boundary before
selecting a runtime. Qualify one opt-in platform first. A temporary directory,
non-shell command array, or container label cannot by itself justify executing
untrusted repository tooling in a developer environment.

### Minimum execution contract

Runner supplies exact snapshot, permitted command/arguments, environment image
and dependency identity, writable scratch locations, network policy, resource
limits, and cancellation deadline. Backend returns executor identity, actual
start/finish, exit or termination reason, output digests, and scope limitations.

Keep provider credentials, host sockets, and unrelated worktree data outside
worker. Package installation and lifecycle scripts need an explicit policy
separate from test execution. A snapshot may contain executable setup code;
calling it a named check does not make it safe or deterministic.

Backend probes should include host-write attempts, secret reads, unauthorized
egress, process descendants, memory/output exhaustion, symlink boundaries, and
cleanup after forced termination. These are acceptance tests for a chosen
backend, not a new generic sandbox product.

### An observed failure still needs an oracle

For a regression, a strong reproduction compares identical check and environment
on BASE and HEAD, showing the relevant behavior change. Both failing can indicate
an existing defect or environment problem. A new feature may not execute on BASE;
record non-comparability rather than manufacture a control.

Generated tests can encode an invented requirement. Evaluate the assertion and
valid input domain independently of the model proposing the defect. A failing
test supports only what it actually checks. Separate assertion failure from
setup error, timeout, unsupported environment, and cancellation.

Property-based tools can generate inputs and shrink counterexamples; fast-check
provides these capabilities for JS/TS.[^20] Mutation testing probes whether
tests detect selected code changes. Stryker distinguishes killed, survived,
uncovered, timeout, and invalid mutants; its scoring treatment is not the same
as proving a review finding.[^21]

**Recommendation:** begin with focused supplied checks and known reproductions.
Add property tests or mutation selectively when they address a demonstrated gap.
Preserve seeds, shrunk inputs, equivalent/invalid mutations, and environmental
failures. Avoid making a global mutation score a substitute for behavioral
coverage or adding a property-testing package to product runtime prematurely.

## E. Comprehensive engineering judgment

Google's review guidance includes design, functionality, complexity, tests,
naming, comments, style, and documentation. It also asks reviewers to consider
surrounding context and clarifies that testing does not replace code
inspection.[^22] This supports a broader review scope, but does not make every
preference a mandatory project requirement.

Define dimension-specific questions and evidence needs. Behavior review needs
requirements and contracts; compatibility needs consumers and schema history;
state/concurrency needs lifecycle paths; architecture needs existing boundaries
and constraints; performance needs workload assumptions or measurements.
Security and operations need applicable trust and deployment context.

Treat dimensions as explicit scope, not a long unqualified checklist in every
prompt. A documentation-only change should not claim concurrency assessment.
An API change may require compatibility context even when only one file changed.
An unsupported adapter or absent environment must remain visible.

Represent defects, standards violations, design recommendations, and uncertainty
separately. A simpler architecture can be worth suggesting without proving a bug.
A code change can satisfy selected standards while lacking evidence for broader
system correctness. Preserve those distinctions in labels and outcome rules.

### Missed-defect discovery

After A–C provide baseline and useful evidence, evaluate a fresh obligation-driven
pass. Withhold first review's conclusions and author rationale. Ask it to assess
specific responsibilities and permit an empty finding set; do not assert that
the first reviewer must have missed something.

Synthesis must examine interactions between units and reconcile duplicate or
contradictory roots. Additional passes increase potential findings and triage
cost. Promotion therefore needs incremental unique defects, added invalid
claims, abstention, delivery, latency, and cost. Majority vote is not proof when
reviewers share missing evidence or assumptions.

Different dimensions can mature independently. Static architecture advice need
not wait for every execution backend. A dimension promising observed runtime
behavior must wait for D. A compatibility claim depending on complete symbol
resolution needs C2 qualification or an explicit limitation.

## Decision register

| Decision | Recommendation | Confidence | Revisit trigger |
| --- | --- | --- | --- |
| First work | Small reproducible corpus and complete claim adjudication | High | Existing scorer/corpus is discovered and qualifies equivalently |
| Evaluation platform | Reuse product runner; evaluator-only artifacts | High for initial slice | Experiment management becomes substantial repeated work |
| Context strategy | Declarations and targeted frozen access before broad payload expansion | Medium | Paired corpus shows no gain or distractor regression |
| Semantic foundation | Language-neutral adapter; SCIP optional | Medium | Qualified alternative offers better frozen provenance and cost |
| Execution | Opt-in qualified isolation backend; no default host execution | High on boundary, open on backend | Platform/resource requirements and backend probes settle choice |
| Extra model passes | Selective and measured after adjudication | Medium | Repeated local evidence establishes consistent net benefit |
| Broader review | Explicit dimensions with separate recommendation/uncertainty classes | High | User-facing outcome design reveals incompatible expectations |

## Remaining experiments

1. Reconstruct original 14-case fixtures and identify reusable definitions,
   licensing, and clean controls. Historical run summaries alone cannot become
   a reproducible corpus.
2. Freeze finding-matching rubric and manually adjudicate a small disagreement
   set before selecting an automated judge.
3. Measure B's true-positive retention across all output categories.
4. Compare declarations versus current windows with constant reviewer policy.
5. Compare reverse syntax candidates and a qualified semantic adapter on identical
   cross-file cases; measure false edges and unsupported scope.
6. Spike execution backend on actual target platform and package ecosystems.
7. Evaluate optional fresh discovery with predeclared criteria and full delivery
   accounting. Do not infer benefit solely from total findings emitted.

These experiments resolve local design uncertainty. Published results motivate
them but cannot supply project-specific precision, cost, or portability claims.
Hosting, broad model comparison, and a universal environment builder remain
outside the first delivery batch.

## Sources

Primary research and official documentation; living pages accessed September 14,
2026. Preprints are identified as such. Documentation on moving branches must
be pinned again when qualifying an implementation dependency.

[^1]: Deepak Kumar. [SWE-PRBench: Benchmarking AI Code Review Quality Against Pull Request Feedback](https://arxiv.org/html/2603.26130v1), March 27, 2026, arXiv preprint v1. Sections 5–8; context ablation, judge validation, sample limitations.
[^2]: Kristen Pereira, Neelabh Sinha, Rajat Ghosh, Debojyoti Dutta. [CR-Bench: Evaluating the Real-World Utility of AI Code Review Agents](https://arxiv.org/html/2603.11078v1), March 10, 2026, arXiv preprint v1. Sections 4–7 and Appendix B; gold completeness, metrics, reflection prompt confound.
[^3]: BugsJS authors. [BugsJS: A Benchmark of JavaScript Bugs](https://bugsjs.github.io/), ICST 2019 project and dataset documentation. Reproducibility and separated bug/test/fix revisions.
[^4]: SWE-bench maintainers. [Evaluation guide](https://www.swebench.com/SWE-bench/guides/evaluation/), living documentation. Containerized repair evaluation reference.
[^5]: NIST/SEMATECH. [Confidence intervals for a binomial proportion](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm), e-Handbook of Statistical Methods, undated living reference. Small-sample interval interpretation.
[^6]: Promptfoo maintainers. [JavaScript Provider](https://www.promptfoo.dev/docs/providers/custom-api/), living documentation. Custom-provider interface, result metadata, and test-context access.
[^7]: Inspect maintainers. [Inspect](https://inspect.aisi.org.uk/), living project documentation. Evaluation-framework alternative.
[^8]: Jie Huang et al. [Large Language Models Cannot Self-Correct Reasoning Yet](https://proceedings.iclr.cc/paper_files/paper/2024/hash/8b4add8b0aa8749d80a34ca5d941c355-Abstract-Conference.html), ICLR 2024. Intrinsic correction limitations on studied reasoning tasks.
[^9]: Gladys Tyen, Hassan Mansoor, Victor Carbune, Peter Chen, Tony Mak. [LLMs cannot find reasoning errors, but can correct them given the error location](https://aclanthology.org/2024.findings-acl.826/), Findings of ACL 2024. Detection/correction distinction.
[^10]: Zhenyu Wu et al. [Large Language Models Can Self-Correct with Key Condition Verification](https://aclanthology.org/2024.emnlp-main.714/), EMNLP 2024. Targeted verification counterevidence.
[^11]: Zhibin Gou et al. [CRITIC: Large Language Models Can Self-Correct with Tool-Interactive Critiquing](https://proceedings.iclr.cc/paper_files/paper/2024/hash/fef126561bbf9d4467dbb8d27334b8fe-Abstract-Conference.html), ICLR 2024. External tool feedback.
[^12]: Nelson F. Liu et al. [Lost in the Middle: How Language Models Use Long Contexts](https://aclanthology.org/2024.tacl-1.9/), TACL 12, 2024, pages 157–173. Position sensitivity in QA/retrieval, not a code-review benchmark.
[^13]: SCIP maintainers. [SCIP Code Intelligence Protocol](https://github.com/scip-code/scip), living repository documentation. Language-neutral semantic interchange and separate indexers.
[^14]: SCIP maintainers. [SCIP Protobuf schema](https://raw.githubusercontent.com/scip-code/scip/main/scip.proto), moving `main` source. Position encodings, occurrences, and relationship semantics.
[^15]: Sourcegraph. [scip-typescript](https://github.com/sourcegraph/scip-typescript), living repository documentation. Configuration/dependency requirements and memory tradeoffs.
[^16]: Docker. [Docker Engine security](https://docs.docker.com/engine/security/), living documentation. Isolation components and daemon/mount exposure.
[^17]: Docker. [Seccomp security profiles](https://docs.docker.com/engine/security/seccomp/), living documentation. System-call restriction boundary.
[^18]: gVisor authors. [Security Model](https://gvisor.dev/docs/architecture_guide/security/), living documentation. System API isolation and limits of sandbox claims.
[^19]: gVisor authors. [Application compatibility](https://gvisor.dev/docs/user_guide/compatibility/), living documentation. Workload qualification requirement.
[^20]: Nicolas Dubien and fast-check maintainers. [Introduction](https://fast-check.dev/docs/introduction/), updated August 18, 2026. Generated inputs and shrinking.
[^21]: Stryker maintainers. [Mutant states and metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/), living documentation. Mutation outcomes and score semantics.
[^22]: Google Engineering Practices. [What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html), living guidance. Broader engineering review dimensions.
