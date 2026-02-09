/**
 * Attractor - DOT-based pipeline orchestration engine for multi-stage AI workflows
 *
 * Three-layer architecture:
 * 1. Unified LLM Client - Multi-provider LLM client (OpenAI, Anthropic, Gemini)
 * 2. Coding Agent Loop - Autonomous coding agent with provider-aligned toolsets
 * 3. Attractor Pipeline Engine - DOT-based workflow orchestrator
 */

export * as llm from './unified-llm/index.js';
export * as agent from './agent-loop/index.js';
export * as attractor from './attractor/index.js';
