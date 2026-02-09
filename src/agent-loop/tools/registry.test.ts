import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from './registry.js';
import type {
  RegisteredTool,
  ToolDefinition,
  ExecutionEnvironment,
} from '../types.js';

function makeTool(
  name: string,
  params?: Record<string, unknown>,
  executor?: RegisteredTool['executor'],
): RegisteredTool {
  return {
    definition: {
      name,
      description: `Tool ${name}`,
      parameters: params ?? { type: 'object', properties: {}, required: [] },
    },
    executor: executor ?? (async () => `${name} executed`),
  };
}

const mockEnv = {} as ExecutionEnvironment;

describe('ToolRegistry', () => {
  it('register tool and retrieve by name', () => {
    const reg = new ToolRegistry();
    const tool = makeTool('my_tool');
    reg.register(tool);
    expect(reg.get('my_tool')).toBe(tool);
  });

  it('get returns undefined for unregistered tool', () => {
    const reg = new ToolRegistry();
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('definitions() returns all tool definitions', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('tool_a'));
    reg.register(makeTool('tool_b'));
    const defs = reg.definitions();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name)).toContain('tool_a');
    expect(defs.map((d) => d.name)).toContain('tool_b');
  });

  it('names() returns all tool names', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('tool_a'));
    reg.register(makeTool('tool_b'));
    expect(reg.names()).toEqual(['tool_a', 'tool_b']);
  });

  it('unregister removes tool', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('tool_a'));
    reg.unregister('tool_a');
    expect(reg.get('tool_a')).toBeUndefined();
    expect(reg.names()).toEqual([]);
  });

  it('duplicate registration: later overrides earlier', () => {
    const reg = new ToolRegistry();
    const tool1 = makeTool('my_tool', undefined, async () => 'v1');
    const tool2 = makeTool('my_tool', undefined, async () => 'v2');
    reg.register(tool1);
    reg.register(tool2);
    expect(reg.get('my_tool')).toBe(tool2);
  });

  describe('validate', () => {
    it('returns error for unknown tool', () => {
      const reg = new ToolRegistry();
      const result = reg.validate('nonexistent', {});
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });

    it('passes when no required fields', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('tool_a'));
      const result = reg.validate('tool_a', {});
      expect(result.valid).toBe(true);
    });

    it('fails when required arg is missing', () => {
      const reg = new ToolRegistry();
      reg.register(
        makeTool('read_file', {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
          required: ['file_path'],
        }),
      );
      const result = reg.validate('read_file', {});
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Missing required parameter: file_path');
    });

    it('passes when all required args provided', () => {
      const reg = new ToolRegistry();
      reg.register(
        makeTool('read_file', {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
          required: ['file_path'],
        }),
      );
      const result = reg.validate('read_file', { file_path: '/foo' });
      expect(result.valid).toBe(true);
    });

    it('fails on type mismatch: expected string, got number', () => {
      const reg = new ToolRegistry();
      reg.register(
        makeTool('my_tool', {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        }),
      );
      const result = reg.validate('my_tool', { name: 123 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expected type string');
    });

    it('fails on type mismatch: expected integer, got float', () => {
      const reg = new ToolRegistry();
      reg.register(
        makeTool('my_tool', {
          type: 'object',
          properties: {
            count: { type: 'integer' },
          },
          required: ['count'],
        }),
      );
      const result = reg.validate('my_tool', { count: 3.14 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expected type integer');
    });
  });

  describe('dispatch', () => {
    it('calls executor with parsed args', async () => {
      const reg = new ToolRegistry();
      const executor = vi.fn().mockResolvedValue('output here');
      reg.register(makeTool('my_tool', undefined, executor));

      const result = await reg.dispatch('my_tool', {}, mockEnv);
      expect(result.is_error).toBe(false);
      expect(result.output).toBe('output here');
      expect(executor).toHaveBeenCalledWith({}, mockEnv);
    });

    it('unknown tool returns error result (not exception)', async () => {
      const reg = new ToolRegistry();
      const result = await reg.dispatch('nonexistent', {}, mockEnv);
      expect(result.is_error).toBe(true);
      expect(result.output).toContain('Unknown tool');
    });

    it('validation failure returns error result', async () => {
      const reg = new ToolRegistry();
      reg.register(
        makeTool('read_file', {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        }),
      );
      const result = await reg.dispatch('read_file', {}, mockEnv);
      expect(result.is_error).toBe(true);
      expect(result.output).toContain('Validation error');
    });

    it('executor exception returns error result', async () => {
      const reg = new ToolRegistry();
      reg.register(
        makeTool('bad_tool', undefined, async () => {
          throw new Error('internal failure');
        }),
      );
      const result = await reg.dispatch('bad_tool', {}, mockEnv);
      expect(result.is_error).toBe(true);
      expect(result.output).toContain('Tool error');
      expect(result.output).toContain('internal failure');
    });
  });
});
