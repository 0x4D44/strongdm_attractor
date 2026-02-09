# Test Infrastructure

This document describes the test infrastructure, tooling, and conventions for the Attractor project.

## Overview

| Metric | Value |
|--------|-------|
| Total tests | 887 |
| Test files | 43 |
| Statement coverage | 90% |
| Branch coverage | 84% |
| Function coverage | 98% |
| Mutation score | 86% (on targeted modules) |
| Test runtime | ~4s |

## Test Categories

### Unit Tests (804 tests, 38 files)

Co-located with source files (`foo.ts` → `foo.test.ts`). Each test file covers a single module.

**Unified LLM layer** (292 tests):

| File | Tests | What's tested |
|------|-------|---------------|
| `unified-llm/types.test.ts` | 82 | Type constructors, enums, error hierarchy, message helpers |
| `unified-llm/utils/http.test.ts` | 41 | fetch() wrapper, timeout/abort, error classification, headers |
| `unified-llm/api.test.ts` | 26 | generate(), stream(), generate_object(), tool rounds, stop_when |
| `unified-llm/client.test.ts` | 25 | Client routing, from_env(), middleware, provider registration |
| `unified-llm/adapters/anthropic.test.ts` | 24 | Request/response mapping, streaming, tool use |
| `unified-llm/adapters/gemini.test.ts` | 23 | Request/response mapping, streaming, JSON schema |
| `unified-llm/model-catalog.test.ts` | 23 | Model lookup, listing, latest model resolution |
| `unified-llm/adapters/openai.test.ts` | 20 | Request/response mapping, streaming, Responses API |
| `unified-llm/utils/retry.test.ts` | 20 | Exponential backoff, jitter, error classification, max attempts |
| `unified-llm/utils/sse.test.ts` | 19 | SSE parsing, chunked input, multi-line data, edge cases |
| `unified-llm/middleware.test.ts` | 14 | Middleware chain composition, logging middleware, elapsed time |

**Agent Loop layer** (184 tests):

| File | Tests | What's tested |
|------|-------|---------------|
| `agent-loop/execution/local.test.ts` | 35 | Command execution, timeouts, env filtering, file ops, grep/glob |
| `agent-loop/tools/shared.test.ts` | 21 | Shared tool definitions (read, write, edit, shell, grep, glob) |
| `agent-loop/tools/gemini-profile.test.ts` | 20 | Gemini-specific tools, batch reads, web operations |
| `agent-loop/truncation.test.ts` | 18 | Char/line truncation, tool output limits |
| `agent-loop/tools/openai-profile.test.ts` | 17 | OpenAI tools, patch parsing, v4a format, hunk matching |
| `agent-loop/tools/anthropic-profile.test.ts` | 17 | Anthropic tools, shell timeout, system prompt |
| `agent-loop/loop.test.ts` | 17 | processInput loop, history conversion, loop detection |
| `agent-loop/events.test.ts` | 16 | Event emission, listener management, event kinds |
| `agent-loop/tools/registry.test.ts` | 16 | Tool registration, lookup, executor dispatch |
| `agent-loop/subagent.test.ts` | 12 | SubAgent spawn, depth limits, send_input, wait/close |
| `agent-loop/session.test.ts` | 12 | Session lifecycle, state machine, steering, abort |

**Attractor layer** (276 tests):

| File | Tests | What's tested |
|------|-------|---------------|
| `attractor/parser/dot-lexer.test.ts` | 54 | Tokenization, comments, strings, numbers, identifiers, edge cases |
| `attractor/engine/edge-selection.test.ts` | 39 | Edge routing, condition evaluation, weight/priority, fallback |
| `attractor/conditions.test.ts` | 34 | Condition DSL parsing, evaluation, context resolution, && operator |
| `attractor/events.test.ts` | 22 | Pipeline event emission, lifecycle events, listener management |
| `attractor/handlers/handlers.test.ts` | 22 | All 9 handler types, registry, default handler |
| `attractor/interviewer.test.ts` | 20 | All 5 interviewer implementations (auto, console, callback, queue, recording) |
| `attractor/parser/dot-parser.test.ts` | 15 | DOT parsing, subgraphs, attributes, edge chains, defaults |
| `attractor/parser/validator.test.ts` | 13 | Graph validation, required attributes, shape mapping, lint rules |
| `attractor/stylesheet.test.ts` | 13 | CSS-like stylesheet parsing, selectors, application to graph |
| `attractor/engine/context.test.ts` | 12 | Pipeline context, variable get/set, nested access |
| `attractor/engine/pipeline.test.ts` | 10 | PipelineEngine lifecycle, retry, checkpoint, edge selection |
| `attractor/utils.test.ts` | 10 | Utility functions |
| `attractor/engine/checkpoint.test.ts` | 8 | Save/load/restore checkpoints, serialization |
| `attractor/handlers/stack-manager.test.ts` | 8 | Stack manager loop, polling, stop conditions |
| `attractor/transforms.test.ts` | 6 | Variable expansion, stylesheet transforms |

### E2E Integration Tests (31 tests, 1 file)

Located in `src/e2e/pipeline.e2e.test.ts`. Exercise the full pipeline stack (DOT parser → validator → pipeline engine → handlers → edge selection) with mock LLM responses.

**Strategy:** Mock at the HTTP boundary by intercepting `fetch()` globally, so the full Unified LLM → Agent Loop → Attractor stack is exercised.

**Scenarios tested:**

1. **Simple linear pipeline** — START → codergen → EXIT with mock LLM response
2. **Conditional branching** — codergen produces outcome, conditional routes to correct branch
3. **Parallel fan-out/fan-in** — parallel node splits work, fan-in collects results
4. **Human-in-the-loop** — wait-human node with QueueInterviewer, approvals and rejections
5. **Error + retry** — codergen fails, retries with exponential backoff, eventually succeeds
6. **Checkpoint save/resume** — run halfway, save checkpoint, restore and resume
7. **Model stylesheet** — CSS-like rules correctly select model/provider per node

### Property-Based Fuzz Tests (52 tests, 5 files)

Located in `src/fuzz/`. Use [fast-check](https://github.com/dubzzz/fast-check) for property-based testing — generate thousands of random inputs and verify invariants hold.

| File | Tests | Target | Properties verified |
|------|-------|--------|-------------------|
| `fuzz/dot-lexer.fuzz.test.ts` | 12 | `DotLexer.tokenize()` | Never crashes on arbitrary input; valid tokens for valid DOT; token count bounded by input length |
| `fuzz/conditions.fuzz.test.ts` | 10 | `evaluateCondition()` | Returns boolean for well-formed conditions; never crashes; handles all operators |
| `fuzz/stylesheet.fuzz.test.ts` | 12 | `parseStylesheet()` | Never crashes; valid stylesheets produce rules; selectors match expected types |
| `fuzz/dot-parser.fuzz.test.ts` | 9 | `DotParser.parse()` | Valid DOT always produces Graph with >= 1 node; edges reference existing nodes; round-trip properties |
| `fuzz/sse.fuzz.test.ts` | 9 | SSE parser | Handles arbitrary chunking of valid streams; never hangs on random input |

Each test runs 100-500 iterations by default (configurable via `numRuns`).

### Mutation Testing (StrykerJS)

Configuration in `stryker.config.json`. Targets 5 critical modules where correctness of decision logic is paramount:

| Module | Mutation Score | Mutants Killed | Survived |
|--------|---------------|----------------|----------|
| `unified-llm/middleware.ts` | 95% | 17 | 1 |
| `attractor/engine/edge-selection.ts` | 90% | 72 | 8 |
| `attractor/parser/dot-lexer.ts` | 86% | 269 | 52 |
| `attractor/conditions.ts` | 81% | 100 | 22 |
| `unified-llm/utils/retry.ts` | 80% | 19 | 7 |
| **Overall** | **86%** | **477** | **90** |

Mutation testing verifies that tests actually detect code changes. A surviving mutant means the test suite doesn't catch that specific modification — potential blind spots.

## Running Tests

### All Tests

```bash
npm test                     # All 887 tests (~4s)
npm run test:watch           # Watch mode for development
```

### Single File

```bash
npx vitest run src/attractor/conditions.test.ts
```

### By Name Pattern

```bash
npx vitest run -t "evaluateCondition"
npx vitest run -t "never crashes"
```

### By Category

```bash
npx vitest run src/e2e/              # E2E integration tests only
npx vitest run src/fuzz/             # Fuzz tests only
npx vitest run src/unified-llm/      # All unified-llm tests
npx vitest run src/agent-loop/       # All agent-loop tests
npx vitest run src/attractor/        # All attractor tests
```

### Coverage Report

```bash
npx vitest run --coverage
```

Produces a text summary in the terminal and an lcov report in `coverage/`. Coverage thresholds are configured in `vitest.config.ts`.

### Mutation Testing

```bash
npx stryker run                      # Full run (~60s)
```

Produces a text summary and an HTML report in `reports/mutation/mutation.html`.

### Full Test Suite (All Categories)

```bash
npm run test:full                    # Cross-platform (Windows, macOS, Linux)
./full-test.sh                       # Bash only (WSL/Linux/macOS) — colored summary
```

`test:full` runs type-check → all tests with coverage → mutation testing. Works on Windows CMD, PowerShell, and Unix. `full-test.sh` runs the same steps with colored pass/fail output per stage.

## Test Conventions

**Framework:** Vitest with `vi.fn()` / `vi.spyOn()` for mocking.

**File naming:** `*.test.ts` co-located with source. Exception: `src/e2e/` and `src/fuzz/` directories for integration and fuzz tests.

**Structure:**
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('functionName', () => {
  it('describes expected behavior', () => {
    // Arrange → Act → Assert
  });
});
```

**Mocking patterns:**
- HTTP: mock `fetch()` globally with `vi.fn()` to intercept all provider calls
- Filesystem: mock `fs` module for checkpoint tests
- Readline: mock `readline/promises` for console interviewer tests
- Time: `vi.useFakeTimers()` for retry/timeout tests

**Timeout:** 10 seconds per test (configured in `vitest.config.ts`).

## Configuration Files

| File | Purpose |
|------|---------|
| `vitest.config.ts` | Test runner config: includes, coverage provider (v8), timeout |
| `stryker.config.json` | Mutation testing: target modules, vitest runner, TypeScript checker |
| `tsconfig.json` | Excludes `*.test.ts` from compilation output |

## Dependencies

All test dependencies are devDependencies:

| Package | Purpose |
|---------|---------|
| `vitest` | Test runner and assertion library |
| `@vitest/coverage-v8` | V8-based code coverage |
| `fast-check` | Property-based testing / fuzzing |
| `@fast-check/vitest` | Vitest integration for fast-check |
| `@stryker-mutator/core` | Mutation testing framework |
| `@stryker-mutator/vitest-runner` | Stryker vitest integration |
| `@stryker-mutator/typescript-checker` | TypeScript-aware mutation |
