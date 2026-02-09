// ============================================================================
// Model Catalog
// ============================================================================

import type { ModelInfo } from "./types.js";

export const MODELS: ModelInfo[] = [
  // ==========================================================
  // Anthropic — prefer Claude Opus 4.6 for top quality
  // ==========================================================
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    display_name: "Claude Opus 4.6",
    context_window: 200_000,
    max_output: 32_768,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    input_cost_per_million: 15,
    output_cost_per_million: 75,
    aliases: ["opus", "claude-opus"],
  },
  {
    id: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    display_name: "Claude Sonnet 4.5",
    context_window: 200_000,
    max_output: 16_384,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    input_cost_per_million: 3,
    output_cost_per_million: 15,
    aliases: ["sonnet", "claude-sonnet", "claude-sonnet-4-5"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    display_name: "Claude Haiku 4.5",
    context_window: 200_000,
    max_output: 8_192,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: false,
    input_cost_per_million: 0.8,
    output_cost_per_million: 4,
    aliases: ["haiku", "claude-haiku", "claude-haiku-4-5"],
  },

  // ==========================================================
  // OpenAI — prefer GPT-5.2 series for top quality
  // ==========================================================
  {
    id: "gpt-5.2",
    provider: "openai",
    display_name: "GPT-5.2",
    context_window: 1_047_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gpt5"],
  },
  {
    id: "gpt-5.2-mini",
    provider: "openai",
    display_name: "GPT-5.2 Mini",
    context_window: 1_047_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gpt5-mini"],
  },
  {
    id: "gpt-5.2-codex",
    provider: "openai",
    display_name: "GPT-5.2 Codex",
    context_window: 1_047_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["codex"],
  },
  {
    id: "gpt-4.1",
    provider: "openai",
    display_name: "GPT-4.1",
    context_window: 1_047_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: false,
    aliases: ["gpt4.1"],
  },
  {
    id: "gpt-4.1-mini",
    provider: "openai",
    display_name: "GPT-4.1 Mini",
    context_window: 1_047_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: false,
    aliases: ["gpt4.1-mini"],
  },
  {
    id: "gpt-4.1-nano",
    provider: "openai",
    display_name: "GPT-4.1 Nano",
    context_window: 1_047_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: false,
    aliases: ["gpt4.1-nano"],
  },

  // ==========================================================
  // Gemini — prefer Gemini 3 Flash Preview for latest
  // ==========================================================
  {
    id: "gemini-3-pro-preview",
    provider: "gemini",
    display_name: "Gemini 3 Pro (Preview)",
    context_window: 1_048_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gemini-3-pro", "gemini-pro"],
  },
  {
    id: "gemini-3-flash-preview",
    provider: "gemini",
    display_name: "Gemini 3 Flash (Preview)",
    context_window: 1_048_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gemini-3-flash", "gemini-flash"],
  },
  {
    id: "gemini-2.5-pro-preview-06-05",
    provider: "gemini",
    display_name: "Gemini 2.5 Pro (Preview)",
    context_window: 1_048_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gemini-2.5-pro"],
  },
  {
    id: "gemini-2.5-flash-preview-05-20",
    provider: "gemini",
    display_name: "Gemini 2.5 Flash (Preview)",
    context_window: 1_048_576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gemini-2.5-flash"],
  },
];

// Build lookup indices
const byId = new Map<string, ModelInfo>();
const byAlias = new Map<string, ModelInfo>();
for (const model of MODELS) {
  byId.set(model.id, model);
  if (model.aliases) {
    for (const alias of model.aliases) {
      byAlias.set(alias, model);
    }
  }
}

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return byId.get(modelId) ?? byAlias.get(modelId);
}

export function listModels(provider?: string): ModelInfo[] {
  if (!provider) return [...MODELS];
  return MODELS.filter((m) => m.provider === provider);
}

export function getLatestModel(
  provider: string,
  capability?: string,
): ModelInfo | undefined {
  let candidates = MODELS.filter((m) => m.provider === provider);

  if (capability) {
    switch (capability) {
      case "reasoning":
        candidates = candidates.filter((m) => m.supports_reasoning);
        break;
      case "vision":
        candidates = candidates.filter((m) => m.supports_vision);
        break;
      case "tools":
        candidates = candidates.filter((m) => m.supports_tools);
        break;
    }
  }

  // Return first match (models are ordered newest/best first per provider)
  return candidates[0];
}
