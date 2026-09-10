# JavaScript and TypeScript profile resolution

This project-owned overlay resolves placeholders in the machine-local shared
`javascript-typescript-steering.md` profile. The shared profile applies to all
JavaScript and TypeScript under the repository root. Repository-specific
steering and `AGENTS.md` remain authoritative when guidance conflicts.

## Verification commands

- Format: `npm run format:check`
- Lint: `npm run lint`
- Type check: `npm run typecheck`
- Test: `npm test`
- Build: `npm run build`
- Dependency audit: `npm audit` when dependency or release work requires a
  current registry-backed audit; weekly Dependabot checks provide the committed
  continuous dependency gate.

`npm run check` composes the normal offline application gate. Run repository
context checks separately as required by `AGENTS.md`.
