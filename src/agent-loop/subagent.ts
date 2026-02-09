/**
 * Subagent support — spawn child sessions for parallel/scoped work.
 *
 * Subagents get independent history but share the parent's execution environment.
 * Depth limiting prevents recursive spawning (default max depth: 1).
 */

import { randomUUID } from 'node:crypto';
import type {
  RegisteredTool,
  ToolDefinition,
  ExecutionEnvironment,
  ProviderProfile,
  SubAgentHandle,
  SubAgentResult,
} from './types.js';
import { EventKind } from './types.js';
import { Session } from './session.js';
import type { LLMClient } from './loop.js';

// ---------------------------------------------------------------------------
// Subagent Manager
// ---------------------------------------------------------------------------

export class SubAgentManager {
  private _parent: Session;
  private _agents = new Map<string, SubAgentSession>();
  private _depth: number;

  constructor(parent: Session, depth: number = 0) {
    this._parent = parent;
    this._depth = depth;
  }

  /** Spawn a new subagent */
  async spawn(opts: {
    task: string;
    working_dir?: string;
    model?: string;
    max_turns?: number;
  }): Promise<SubAgentHandle> {
    if (this._depth >= this._parent.config.max_subagent_depth) {
      throw new Error(
        `Max subagent depth (${this._parent.config.max_subagent_depth}) reached. Cannot spawn sub-sub-agents.`,
      );
    }

    const id = randomUUID();
    const env = this._parent.execution_env;

    // Create profile override with optional model
    const profile = this._parent.provider_profile;
    const childProfile: ProviderProfile = opts.model
      ? { ...profile, model: opts.model }
      : profile;

    const childSession = new Session({
      provider_profile: childProfile,
      execution_env: env,
      llm_client: this._parent.llm_client,
      config: {
        max_turns: opts.max_turns ?? 50,
        max_subagent_depth: 0, // subagents cannot spawn sub-sub-agents
      },
    });

    const agentSession: SubAgentSession = {
      id,
      session: childSession,
      task: opts.task,
      status: 'running',
      result: null,
    };
    this._agents.set(id, agentSession);
    this._parent.subagents.set(id, {
      id,
      status: 'running',
      result: null,
    });

    this._parent.event_emitter.emit(EventKind.SUBAGENT_SPAWN, {
      agent_id: id,
      task: opts.task,
    });

    // Start processing in the background
    agentSession.promise = childSession
      .submit(opts.task)
      .then(() => {
        agentSession.status = 'completed';
        const lastAssistant = childSession.history
          .filter((t) => t.kind === 'assistant')
          .pop();
        const output =
          lastAssistant && lastAssistant.kind === 'assistant'
            ? lastAssistant.content
            : '';
        agentSession.result = {
          output,
          success: true,
          turns_used: childSession.history.filter(
            (t) => t.kind === 'assistant',
          ).length,
        };
        this._parent.subagents.set(id, {
          id,
          status: 'completed',
          result: agentSession.result,
        });
        this._parent.event_emitter.emit(EventKind.SUBAGENT_COMPLETE, {
          agent_id: id,
          result: agentSession.result,
        });
      })
      .catch((err) => {
        agentSession.status = 'failed';
        agentSession.result = {
          output: err instanceof Error ? err.message : String(err),
          success: false,
          turns_used: childSession.history.filter(
            (t) => t.kind === 'assistant',
          ).length,
        };
        this._parent.subagents.set(id, {
          id,
          status: 'failed',
          result: agentSession.result,
        });
        this._parent.event_emitter.emit(EventKind.SUBAGENT_COMPLETE, {
          agent_id: id,
          result: agentSession.result,
        });
      });

    return { id, status: 'running', result: null };
  }

  /** Send a message to a running subagent */
  async sendInput(agentId: string, message: string): Promise<string> {
    const agent = this._agents.get(agentId);
    if (!agent) {
      throw new Error(`Subagent not found: ${agentId}`);
    }
    if (agent.status !== 'running') {
      throw new Error(
        `Subagent ${agentId} is not running (status: ${agent.status})`,
      );
    }

    // Queue as a follow-up on the child session
    agent.session.follow_up(message);
    return `Message sent to subagent ${agentId}`;
  }

  /** Wait for a subagent to complete */
  async wait(agentId: string): Promise<SubAgentResult> {
    const agent = this._agents.get(agentId);
    if (!agent) {
      throw new Error(`Subagent not found: ${agentId}`);
    }

    if (agent.promise) {
      await agent.promise;
    }

    return (
      agent.result ?? {
        output: '',
        success: false,
        turns_used: 0,
      }
    );
  }

  /** Close a subagent */
  async close(agentId: string): Promise<string> {
    const agent = this._agents.get(agentId);
    if (!agent) {
      throw new Error(`Subagent not found: ${agentId}`);
    }

    agent.session.abort();
    agent.status = 'completed';
    this._parent.subagents.set(agentId, {
      id: agentId,
      status: 'completed',
      result: agent.result,
    });
    this._agents.delete(agentId);
    return `Subagent ${agentId} closed.`;
  }
}

interface SubAgentSession {
  id: string;
  session: Session;
  task: string;
  status: 'running' | 'completed' | 'failed';
  result: SubAgentResult | null;
  promise?: Promise<void>;
}

// ---------------------------------------------------------------------------
// Subagent tool definitions — exported for profile registration
// ---------------------------------------------------------------------------

export const SUBAGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'spawn_agent',
    description: 'Spawn a subagent to handle a scoped task autonomously.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Natural language task description.' },
        working_dir: { type: 'string', description: 'Subdirectory to scope the agent to.' },
        model: { type: 'string', description: "Model override (default: parent's model)." },
        max_turns: { type: 'integer', description: 'Turn limit (default: 50).' },
      },
      required: ['task'],
    },
  },
  {
    name: 'send_input',
    description: 'Send a message to a running subagent.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'ID of the subagent.' },
        message: { type: 'string', description: 'Message to send.' },
      },
      required: ['agent_id', 'message'],
    },
  },
  {
    name: 'wait',
    description: 'Wait for a subagent to complete and return its result.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'ID of the subagent.' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'close_agent',
    description: 'Terminate a subagent.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'ID of the subagent.' },
      },
      required: ['agent_id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Subagent tools — registered on profiles
// ---------------------------------------------------------------------------

export function createSubagentTools(
  manager: SubAgentManager,
): RegisteredTool[] {
  const spawnDef: ToolDefinition = {
    name: 'spawn_agent',
    description:
      'Spawn a subagent to handle a scoped task autonomously.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Natural language task description.',
        },
        working_dir: {
          type: 'string',
          description: 'Subdirectory to scope the agent to.',
        },
        model: {
          type: 'string',
          description: "Model override (default: parent's model).",
        },
        max_turns: {
          type: 'integer',
          description: 'Turn limit (default: 50).',
        },
      },
      required: ['task'],
    },
  };

  const sendInputDef: ToolDefinition = {
    name: 'send_input',
    description: 'Send a message to a running subagent.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'ID of the subagent.',
        },
        message: {
          type: 'string',
          description: 'Message to send.',
        },
      },
      required: ['agent_id', 'message'],
    },
  };

  const waitDef: ToolDefinition = {
    name: 'wait',
    description:
      'Wait for a subagent to complete and return its result.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'ID of the subagent.',
        },
      },
      required: ['agent_id'],
    },
  };

  const closeAgentDef: ToolDefinition = {
    name: 'close_agent',
    description: 'Terminate a subagent.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'ID of the subagent.',
        },
      },
      required: ['agent_id'],
    },
  };

  return [
    {
      definition: spawnDef,
      executor: async (args) => {
        const handle = await manager.spawn({
          task: args.task as string,
          working_dir: args.working_dir as string | undefined,
          model: args.model as string | undefined,
          max_turns: args.max_turns as number | undefined,
        });
        return JSON.stringify({
          agent_id: handle.id,
          status: handle.status,
        });
      },
    },
    {
      definition: sendInputDef,
      executor: async (args) => {
        return manager.sendInput(
          args.agent_id as string,
          args.message as string,
        );
      },
    },
    {
      definition: waitDef,
      executor: async (args) => {
        const result = await manager.wait(args.agent_id as string);
        return JSON.stringify(result);
      },
    },
    {
      definition: closeAgentDef,
      executor: async (args) => {
        return manager.close(args.agent_id as string);
      },
    },
  ];
}
