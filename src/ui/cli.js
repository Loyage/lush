/**
 * CLI adapter inside the UI boundary.
 *
 * The mature CLI implementation remains in `src/cli/` for import compatibility;
 * all executable entry points go through `src/ui/` so Web UI and a future TUI
 * have one composition namespace.
 */
export * from '../cli/main.js';
