/**
 * Tool registry: register tools, dispatch calls, validate arguments.
 */

import type {
  ToolRegistry as IToolRegistry,
  ToolDefinition,
  RegisteredTool,
  ToolExecutor,
  ExecutionEnvironment,
} from '../types.js';

export class ToolRegistry implements IToolRegistry {
  private _tools = new Map<string, RegisteredTool>();

  /** Register or replace a tool */
  register(tool: RegisteredTool): void {
    this._tools.set(tool.definition.name, tool);
  }

  /** Remove a tool by name */
  unregister(name: string): void {
    this._tools.delete(name);
  }

  /** Look up a registered tool by name */
  get(name: string): RegisteredTool | undefined {
    return this._tools.get(name);
  }

  /** Return all tool definitions (for sending to the LLM) */
  definitions(): ToolDefinition[] {
    return Array.from(this._tools.values()).map((t) => t.definition);
  }

  /** Return all registered tool names */
  names(): string[] {
    return Array.from(this._tools.keys());
  }

  /** Validate arguments against a tool's JSON Schema (basic validation) */
  validate(
    toolName: string,
    args: Record<string, unknown>,
  ): { valid: boolean; error?: string } {
    const tool = this._tools.get(toolName);
    if (!tool) {
      return { valid: false, error: `Unknown tool: ${toolName}` };
    }

    const schema = tool.definition.parameters;
    if (!schema || typeof schema !== 'object') {
      return { valid: true };
    }

    // Basic required-field validation
    const required = (schema as Record<string, unknown>).required;
    if (Array.isArray(required)) {
      for (const field of required) {
        if (typeof field === 'string' && !(field in args)) {
          return {
            valid: false,
            error: `Missing required parameter: ${field}`,
          };
        }
      }
    }

    // Basic type checking for properties
    const properties = (schema as Record<string, unknown>).properties;
    if (properties && typeof properties === 'object') {
      const props = properties as Record<
        string,
        Record<string, unknown>
      >;
      for (const [key, value] of Object.entries(args)) {
        const propSchema = props[key];
        if (!propSchema) continue;
        const expectedType = propSchema.type;
        if (typeof expectedType === 'string') {
          const actualType = typeof value;
          if (
            expectedType === 'string' && actualType !== 'string' ||
            expectedType === 'integer' && (actualType !== 'number' || !Number.isInteger(value)) ||
            expectedType === 'number' && actualType !== 'number' ||
            expectedType === 'boolean' && actualType !== 'boolean'
          ) {
            return {
              valid: false,
              error: `Parameter "${key}" expected type ${expectedType}, got ${actualType}`,
            };
          }
        }
      }
    }

    return { valid: true };
  }

  /**
   * Dispatch a tool call: validate args, execute, and return result string.
   * Throws on unknown tool. Returns error string on validation failure.
   */
  async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    env: ExecutionEnvironment,
  ): Promise<{ output: string; is_error: boolean }> {
    const tool = this._tools.get(toolName);
    if (!tool) {
      return {
        output: `Unknown tool: ${toolName}`,
        is_error: true,
      };
    }

    const validation = this.validate(toolName, args);
    if (!validation.valid) {
      return {
        output: `Validation error: ${validation.error}`,
        is_error: true,
      };
    }

    try {
      const output = await tool.executor(args, env);
      return { output, is_error: false };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        output: `Tool error (${toolName}): ${message}`,
        is_error: true,
      };
    }
  }
}
