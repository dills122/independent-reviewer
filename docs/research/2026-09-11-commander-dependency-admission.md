# Commander 15 dependency admission

Status: accepted for Slice 1 CLI grammar; verified locally. Owner: project maintainer.
Baseline: `19e7c6d`. Evaluated package: `commander@15.0.0`.

## Decision question

Does Commander 15 reduce custom CLI parsing failure modes without widening the
runtime, compatibility, or supply-chain boundary of Independent Reviewer?

Scope covers package ownership, maintenance, adoption, license, advisories,
package cost, Node.js/ESM/TypeScript compatibility, and current CLI parity.
Credential handling, interactive prompts, and broader UX changes are outside
this dependency decision.

## Conclusion

Adopt exact-pinned `commander@15.0.0` for command-option grammar. Retain product
validation for mutually exclusive modes, repeated-option rejection, required
product inputs, numeric policy, and dash-leading path guidance. Commander does
not receive credentials or repository content.

## Primary sources

- [Commander repository and releases](https://github.com/tj/commander.js/releases)
- [Commander npm package](https://www.npmjs.com/package/commander)
- Installed package declarations: `node_modules/commander/typings/index.d.ts`
- Installed package license: `node_modules/commander/LICENSE`

## Evidence

Documented facts:

- Commander 15.0.0 is current, ESM-only, requires Node.js 22.12 or newer, and
  moved Commander 14 into a documented maintenance window.
- npm identifies `tj/commander.js` as the repository, MIT as the license, and
  reports very high weekly use and ecosystem adoption.
- Exact package metadata reports 12 files, 207,368 unpacked bytes, and no runtime
  dependencies. Package declarations expose `Command`, `Option`,
  `CommanderError`, output controls, and parse/exit overrides through the public
  root export.

Local observations on Node.js 24 / TypeScript 6:

- `npm ls commander --all` resolves exactly one direct `commander@15.0.0`.
- Installed directory occupies 232 KiB locally.
- `npm audit --omit=dev --json` reports zero known vulnerabilities.
- Existing CLI compatibility tests cover unknown commands/options, repeated
  options, required values, dash-leading values, help/version output, exit
  codes, stdout/stderr separation, dry-run credential isolation, and legacy
  JSON configuration.
- New tests cover simple initialization, Git-local persistence, effective-policy
  display, advanced/simple exclusivity, unsupported models before credential
  access, and provider-free dry-run.

Inference: package replaces commodity option parsing with materially less local
grammar code while its zero-dependency ESM surface fits the existing runtime.
Product-specific prechecks remain necessary because last-value-wins repetition
and generic parser errors do not satisfy the digest-bound CLI contract.

## Rejected alternatives

- Keep `node:util.parseArgs`: zero dependency cost, but retains more custom
  grammar/help plumbing and does not support planned nested and interactive CLI
  growth as directly.
- Add a decorator or CLI framework wrapper: larger abstraction and dependency
  surface without a demonstrated benefit for this local command set.
- Add Commander extra typings: unnecessary; installed root package already ships
  declarations sufficient for current integration.

## Limits and next gate

This admission does not approve Inquirer or any steering parser/matcher package.
Each receives its own evidence before installation. Full CLI help migration and
interactive input remain in Slice 5. Any Commander major upgrade requires a new
compatibility and advisory check because version 15 changed module format and
minimum Node.js version.
