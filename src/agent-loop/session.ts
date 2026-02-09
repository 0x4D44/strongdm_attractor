/**
 * Session management — the central orchestrator.
 *
 * Holds conversation state, dispatches tool calls, manages the event stream,
 * and enforces limits. Provides submit(), steer(), follow_up(), and close().
 */

import { randomUUID } from 'node:crypto';
import type {
  Turn,
  SessionConfig,
  ProviderProfile,
  ExecutionEnvironment,
  SubAgentHandle,
} from './types.js';
import {
  SessionState,
  EventKind,
  DEFAULT_SESSION_CONFIG,
} from './types.js';
import { EventEmitter } from './events.js';
import {
  processInput,
  type LLMClient,
  type LoopContext,
} from './loop.js';

export interface SessionOptions {
  provider_profile: ProviderProfile;
  execution_env: ExecutionEnvironment;
  llm_client: LLMClient;
  config?: Partial<SessionConfig>;
  id?: string;
}

export class Session implements LoopContext {
  readonly id: string;
  readonly provider_profile: ProviderProfile;
  readonly execution_env: ExecutionEnvironment;
  readonly event_emitter: EventEmitter;
  readonly llm_client: LLMClient;

  history: Turn[] = [];
  config: SessionConfig;
  state: SessionState = SessionState.IDLE;
  steering_queue: string[] = [];
  followup_queue: string[] = [];
  subagents: Map<string, SubAgentHandle> = new Map();
  abort_signaled = false;

  private _abortController: AbortController | null = null;

  constructor(options: SessionOptions) {
    this.id = options.id ?? randomUUID();
    this.provider_profile = options.provider_profile;
    this.execution_env = options.execution_env;
    this.llm_client = options.llm_client;

    // Merge config with defaults
    this.config = {
      ...DEFAULT_SESSION_CONFIG,
      // Deep-copy maps
      tool_output_limits: new Map(DEFAULT_SESSION_CONFIG.tool_output_limits),
      tool_line_limits: new Map(DEFAULT_SESSION_CONFIG.tool_line_limits),
      ...options.config,
    };

    // Merge any config map overrides
    if (options.config?.tool_output_limits) {
      for (const [k, v] of options.config.tool_output_limits) {
        this.config.tool_output_limits.set(k, v);
      }
    }
    if (options.config?.tool_line_limits) {
      for (const [k, v] of options.config.tool_line_limits) {
        this.config.tool_line_limits.set(k, v);
      }
    }

    this.event_emitter = new EventEmitter(this.id);

    // Emit SESSION_START once at construction
    this.event_emitter.emit(EventKind.SESSION_START, {
      session_id: this.id,
    });
  }

  /**
   * Submit user input to the agent.
   * Runs the agentic loop until natural completion or a limit is hit.
   */
  async submit(input: string): Promise<void> {
    if (this.state === SessionState.CLOSED) {
      throw new Error('Session is closed');
    }
    if (this.state === SessionState.PROCESSING) {
      throw new Error('Session is already processing');
    }

    this.abort_signaled = false;
    this._abortController = new AbortController();

    try {
      await processInput(this, input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.event_emitter.emit(EventKind.ERROR, { error: msg });
      this.state = SessionState.CLOSED;
    }
  }

  /**
   * Queue a steering message to be injected after the current tool round.
   * If the agent is idle, the message is delivered on the next submit().
   */
  steer(message: string): void {
    this.steering_queue.push(message);
  }

  /**
   * Queue a follow-up message to be processed after the current input completes.
   */
  follow_up(message: string): void {
    this.followup_queue.push(message);
  }

  /**
   * Abort the current processing.
   */
  abort(): void {
    this.abort_signaled = true;
    this._abortController?.abort();
  }

  /**
   * Close the session, cleaning up all resources.
   */
  async close(): Promise<void> {
    this.abort();
    this.state = SessionState.CLOSED;

    // Close all subagents
    for (const [id, handle] of this.subagents) {
      if (handle.status === 'running') {
        handle.status = 'failed';
      }
    }

    await this.execution_env.cleanup();

    this.event_emitter.emit(EventKind.SESSION_END, {
      final_state: this.state,
    });
    this.event_emitter.removeAllListeners();
  }

  /**
   * Update reasoning effort mid-session.
   * Takes effect on the next LLM call.
   */
  setReasoningEffort(effort: string | null): void {
    this.config.reasoning_effort = effort;
  }

  /**
   * Get the conversation history.
   */
  getHistory(): ReadonlyArray<Turn> {
    return this.history;
  }

  /**
   * Get the current session state.
   */
  getState(): SessionState {
    return this.state;
  }
}
