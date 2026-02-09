# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
npm run build          # TypeScript compilation (tsc) → dist/
npm run lint           # Type-check only, no emit (tsc --noEmit)
npm test               # Run all tests (vitest run)
npm run test:watch     # Vitest watch mode

# Single test file
npx vitest run src/attractor/conditions.test.ts

# Tests matching a name pattern
npx vitest run -t "evaluateCondition"

# Coverage report
npx vitest run --coverage

# Mutation testing (targets 5 critical modules, takes ~60s)
npx stryker run
```

## Architecture

Three-layer stack, each layer depends only on the one below it:

```
┌─────────────────────────────────────────┐
│  Attractor Pipeline Engine              │  DOT-based workflow orchestrator
│  src/attractor/                         │  9 node handler types, condition DSL
├─────────────────────────────────────────┤
│  Coding Agent Loop                      │  Autonomous agent: LLM → tools → loop
│  src/agent-loop/                        │  Provider profiles, tool registry
├─────────────────────────────────────────┤
│  Unified LLM Client                     │  OpenAI / Anthropic / Gemini
│  src/unified-llm/                       │  Native HTTP adapters (no SDKs)
└─────────────────────────────────────────┘
```

**Unified LLM** (`src/unified-llm/`): Multi-provider client using each provider's native API via `fetch()`. `Client.from_env()` auto-detects providers from API key env vars. Two API levels: `Client.complete()` (low-level, used by agent loop) and `generate()`/`stream()` (high-level convenience). Adapters in `src/unified-llm/adapters/` implement `ProviderAdapter` interface. Middleware chain wraps requests (logging, retry).

**Agent Loop** (`src/agent-loop/`): `processInput()` drives the LLM→tool→loop cycle. Session state machine (IDLE→PROCESSING→AWAITING_INPUT→CLOSED). Turn-based history with truncation. Provider-specific tool profiles in `src/agent-loop/tools/`. `LocalExecutionEnvironment` sandboxes file/command execution.

**Attractor Engine** (`src/attractor/`): DOT source → `parseDot()` (recursive-descent lexer+parser) → Graph AST → `PipelineEngine` execution. Pipeline lifecycle: PARSE→VALIDATE→INITIALIZE→EXECUTE→FINALIZE. Node handlers registered by shape→HandlerType mapping. Condition DSL for edge routing (`outcome=success && context.x=1`). CSS-like model stylesheet for per-node model config. Checkpoint save/resume.

## Key Conventions

- **Pure ESM** — `"type": "module"`, all imports use `.js` extensions
- **No external LLM SDKs** — every provider adapter uses native `fetch()`
- **Node >=20** — relies on global `fetch()`, no polyfills
- **Strict TypeScript** — ES2022 target, Node16 module resolution
- **Relative imports only** — no path aliases
- **Barrel exports** — each layer re-exports its public API through `index.ts`
- **Test files co-located** with source (`foo.ts` → `foo.test.ts`), except E2E (`src/e2e/`) and fuzz (`src/fuzz/`)

## Specs

Behavioral specifications live in the repo root. These are NLSpecs (Natural Language Specs) intended for coding agents to implement/validate behavior:

- `attractor-spec.md` — Pipeline engine, handlers, DOT format, conditions, stylesheets
- `coding-agent-loop-spec.md` — Agent loop, tools, steering, truncation
- `unified-llm-spec.md` — Client, adapters, streaming, middleware, retry

## Error Hierarchy

All errors extend `LLMError`. Key subclasses: `AuthenticationError`, `RateLimitError`, `ProviderError`, `TimeoutError`, `ContentFilterError`. Provider adapters map HTTP status codes to the appropriate error class via `errorFromStatusCode()`.
