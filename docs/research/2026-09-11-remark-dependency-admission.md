# Unified and remark dependency admission

Status: accepted for Slice 2 Markdown source parsing. Decision owner: project
maintainer.

## Decision

Pin `unified@11.0.5` and `remark-parse@11.0.0`. Use their public ESM API behind
the reviewer-guidance adapter to parse CommonMark and verify complete UTF-16
source-position coverage. Keep source selection, BASE trust, secret admission,
resource limits, semantic priority, graph identity, and prompt rendering in
product code.

## Why now

Slice 2 admits one Markdown guidance source into a paid model path. The accepted
plan requires a qualified Markdown library instead of a hand-written parser.
Automatic harness frontmatter, imports, style lint, and semantic interpretation
remain out of scope.

## Evidence

### Documented facts

- [`remark-parse`](https://www.npmjs.com/package/remark-parse) is the unified
  collective's CommonMark-to-mdast parser. Version 11.0.0 is ESM, includes
  TypeScript declarations, supports Node.js 16+, uses the MIT license, and has
  thousands of direct dependents.
- [`unified`](https://www.npmjs.com/package/unified) supplies the typed processor
  API. Version 11.0.5 is ESM, supports Node.js 16+, uses the MIT license, and is
  used broadly across the ecosystem.
- The official public integration is `unified().use(remarkParse).parse(text)`;
  returned mdast nodes carry unist source positions.

### Repository observations

- Package API inspection resolved `unified` to `index.js` / `index.d.ts` with
  named export `unified`, and `remark-parse` to `index.js` / `index.d.ts` with a
  default plugin export. No private subpath is used.
- Exact installation added 42 transitive packages. Registry metadata reports
  unpacked direct sizes of 145,932 bytes for `unified` and 19,481 bytes for
  `remark-parse`; the parser delegates to `mdast-util-from-markdown` and
  micromark packages.
- `npm audit --omit=dev` reported zero known vulnerabilities after installation.
- Install emitted only the repository's existing npm allow-scripts notices for
  five Tree-sitter packages; unified/remark added no install-script request.
- Focused adversarial tests prove BASE-only reads, exact 64 KiB source admission,
  invalid UTF-8 rejection, complete-content preservation, and secret rejection.

### Inference

Dependency count is material but justified: Markdown grammar and positional AST
behavior are commodity responsibilities explicitly assigned to remark by the
accepted architecture. The adapter exposes none of unified's plugin or file
execution surfaces to repository content.

## Alternatives

| Option | Result |
| --- | --- |
| Hand-written heading/block parser | Rejected; duplicates Markdown grammar and violates accepted library boundary |
| Direct micromark/mdast internals | Rejected; lower-level API without meaningful dependency reduction |
| Full `remark` processor package | Rejected for now; serialization is unnecessary in Slice 2 |
| `unified` plus `remark-parse` | Accepted; smallest documented typed processor surface matching planned later lint plugins |

## Limits and next gate

CommonMark is permissive, so successful parsing does not mean guidance is
correct or well structured. Slice 2 uses AST positions only and keeps prose
opaque. Slices 3–4 must separately admit frontmatter and lint packages, preserve
the current caps, and add malformed/adversarial fixtures before using those
grammars.
