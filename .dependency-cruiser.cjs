/**
 * Package boundaries from docs/plan/01-architecture.md §1.
 *
 * These are not style rules. The engine's purity (spec §1.3) and the hard rule
 * that the LLM never computes a statement value (spec §1.1) are both claims
 * about what code can reach what. "We'll be careful" is not an enforcement
 * mechanism; this file is.
 */
module.exports = {
  forbidden: [
    {
      name: 'engine-purity',
      severity: 'error',
      comment:
        'packages/engine may depend only on money, schemas and seeds. Anything else ' +
        'breaks the determinism guarantee that replay and the property tests rest on.',
      from: { path: '^packages/engine/src' },
      to: {
        // Both forms appear: relative paths for intra-package imports, and the
        // bare workspace specifier for cross-package ones (pnpm symlinks them).
        pathNot: [
          '^packages/engine/src',
          '^packages/(money|schemas|seeds)/src',
          '^@bizsim/(money|schemas|seeds)$',
          'node_modules/(zod|typescript)',
        ],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'llm-never-sees-the-ledger',
      severity: 'error',
      comment:
        'Spec §1.1: the LLM never computes a value that appears in a financial ' +
        'statement. packages/llm importing the engine is how that rule gets broken.',
      from: { path: '^packages/llm/src' },
      to: { path: ['^packages/engine/src', '^@bizsim/engine$'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: { path: '\\.test\\.ts$' },
  },
};
