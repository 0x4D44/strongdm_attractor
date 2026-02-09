// ============================================================================
// Core Client — Provider Routing, Middleware, from_env()
// ============================================================================

import {
  ConfigurationError,
} from "./types.js";
import type {
  ProviderAdapter,
  Request,
  Response,
  StreamEvent,
  Middleware,
  StreamMiddleware,
} from "./types.js";
import { buildMiddlewareChain, buildStreamMiddlewareChain, wrapMiddlewareForStream } from "./middleware.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { GeminiAdapter } from "./adapters/gemini.js";

export interface ClientOptions {
  providers?: Record<string, ProviderAdapter>;
  default_provider?: string;
  middleware?: Middleware[];
  stream_middleware?: StreamMiddleware[];
}

export class Client {
  private providers: Map<string, ProviderAdapter>;
  private default_provider: string | undefined;
  private middlewareList: Middleware[];
  private streamMiddlewareList: StreamMiddleware[];

  constructor(opts: ClientOptions = {}) {
    this.providers = new Map(Object.entries(opts.providers ?? {}));
    this.default_provider = opts.default_provider;
    this.middlewareList = opts.middleware ?? [];
    this.streamMiddlewareList = opts.stream_middleware ?? [];

    // Auto-detect default provider if not set
    if (!this.default_provider && this.providers.size > 0) {
      this.default_provider = this.providers.keys().next().value;
    }
  }

  /**
   * Create a Client from standard environment variables.
   * Only providers whose API keys are present are registered.
   */
  static from_env(): Client {
    const providers: Record<string, ProviderAdapter> = {};

    // OpenAI
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      providers.openai = new OpenAIAdapter({
        api_key: openaiKey,
        base_url: process.env.OPENAI_BASE_URL,
        organization: process.env.OPENAI_ORG_ID,
        project: process.env.OPENAI_PROJECT_ID,
      });
    }

    // Anthropic
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      providers.anthropic = new AnthropicAdapter({
        api_key: anthropicKey,
        base_url: process.env.ANTHROPIC_BASE_URL,
      });
    }

    // Gemini
    const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (geminiKey) {
      providers.gemini = new GeminiAdapter({
        api_key: geminiKey,
        base_url: process.env.GEMINI_BASE_URL,
      });
    }

    return new Client({ providers });
  }

  /**
   * Register a provider adapter.
   */
  registerProvider(name: string, adapter: ProviderAdapter): void {
    this.providers.set(name, adapter);
    if (!this.default_provider) {
      this.default_provider = name;
    }
  }

  /**
   * Resolve which adapter handles a request.
   */
  private resolveAdapter(request: Request): ProviderAdapter {
    const providerName = request.provider ?? this.default_provider;
    if (!providerName) {
      throw new ConfigurationError(
        "No provider specified and no default provider configured. " +
        "Set a provider on the request or configure a default_provider on the Client.",
      );
    }

    const adapter = this.providers.get(providerName);
    if (!adapter) {
      throw new ConfigurationError(
        `Provider "${providerName}" is not registered. ` +
        `Available providers: ${[...this.providers.keys()].join(", ") || "(none)"}`,
      );
    }

    return adapter;
  }

  /**
   * Send a blocking request. Does NOT retry automatically.
   */
  async complete(request: Request): Promise<Response> {
    const adapter = this.resolveAdapter(request);

    // Fill in provider name on the request
    const enrichedRequest: Request = {
      ...request,
      provider: request.provider ?? adapter.name,
    };

    // Build middleware chain
    const handler = buildMiddlewareChain(
      this.middlewareList,
      (req) => adapter.complete(req),
    );

    return handler(enrichedRequest);
  }

  /**
   * Send a streaming request. Returns an async iterable of StreamEvent.
   */
  stream(request: Request): AsyncIterable<StreamEvent> {
    const adapter = this.resolveAdapter(request);

    const enrichedRequest: Request = {
      ...request,
      provider: request.provider ?? adapter.name,
    };

    // Build stream middleware chain.
    // Also wrap complete middlewares as passthrough stream middlewares.
    const allStreamMiddleware: StreamMiddleware[] = [
      ...this.middlewareList.map(wrapMiddlewareForStream),
      ...this.streamMiddlewareList,
    ];

    const handler = buildStreamMiddlewareChain(
      allStreamMiddleware,
      (req) => adapter.stream(req),
    );

    return handler(enrichedRequest);
  }

  /**
   * Release all adapter resources.
   */
  async close(): Promise<void> {
    for (const adapter of this.providers.values()) {
      if (adapter.close) {
        await adapter.close();
      }
    }
  }

  /**
   * Get registered provider names.
   */
  get providerNames(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Get default provider name.
   */
  get defaultProvider(): string | undefined {
    return this.default_provider;
  }
}

// --- Module-level default client ---

let _defaultClient: Client | undefined;

export function getDefaultClient(): Client {
  if (!_defaultClient) {
    _defaultClient = Client.from_env();
  }
  return _defaultClient;
}

export function setDefaultClient(client: Client): void {
  _defaultClient = client;
}
