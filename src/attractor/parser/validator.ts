/**
 * Pipeline validator: structural and semantic validation of parsed graphs.
 * Produces LintResult diagnostics with error/warning/info severity.
 */

import type { Graph, LintResult, LintRule } from '../types.js';
import { LintSeverity, SHAPE_TO_HANDLER_TYPE } from '../types.js';
import { evaluateCondition } from '../conditions.js';
import { parseStylesheet } from '../stylesheet.js';

// ---------------------------------------------------------------------------
// Built-in lint rules
// ---------------------------------------------------------------------------

const startNodeRule: LintRule = {
  name: 'start_node',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];
    const startNodes: string[] = [];

    for (const [id, node] of graph.nodes) {
      if (node.attrs.shape === 'Mdiamond') {
        startNodes.push(id);
      }
    }

    if (startNodes.length === 0) {
      // Also check by ID
      if (!graph.nodes.has('start') && !graph.nodes.has('Start')) {
        results.push({
          rule: 'start_node',
          severity: LintSeverity.ERROR,
          message: 'Pipeline must have exactly one start node (shape=Mdiamond).',
          fix: 'Add a node with shape=Mdiamond',
        });
      }
    } else if (startNodes.length > 1) {
      results.push({
        rule: 'start_node',
        severity: LintSeverity.ERROR,
        message: `Pipeline must have exactly one start node, found ${startNodes.length}: ${startNodes.join(', ')}`,
      });
    }

    return results;
  },
};

const terminalNodeRule: LintRule = {
  name: 'terminal_node',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];
    const exitNodes: string[] = [];

    for (const [id, node] of graph.nodes) {
      if (node.attrs.shape === 'Msquare') {
        exitNodes.push(id);
      }
    }

    if (exitNodes.length === 0) {
      if (!graph.nodes.has('exit') && !graph.nodes.has('end') && !graph.nodes.has('Exit') && !graph.nodes.has('End')) {
        results.push({
          rule: 'terminal_node',
          severity: LintSeverity.ERROR,
          message: 'Pipeline must have at least one terminal node (shape=Msquare).',
          fix: 'Add a node with shape=Msquare',
        });
      }
    } else if (exitNodes.length > 1) {
      results.push({
        rule: 'terminal_node',
        severity: LintSeverity.ERROR,
        message: `Pipeline must have exactly one exit node, found ${exitNodes.length}: ${exitNodes.join(', ')}`,
      });
    }

    return results;
  },
};

const startNoIncomingRule: LintRule = {
  name: 'start_no_incoming',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];
    const startId = findStartNodeId(graph);
    if (!startId) return results;

    for (const edge of graph.edges) {
      if (edge.to === startId) {
        results.push({
          rule: 'start_no_incoming',
          severity: LintSeverity.ERROR,
          message: `Start node '${startId}' must have no incoming edges, but has one from '${edge.from}'.`,
          node_id: startId,
          edge: { from: edge.from, to: edge.to },
        });
      }
    }

    return results;
  },
};

const exitNoOutgoingRule: LintRule = {
  name: 'exit_no_outgoing',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];
    const exitId = findExitNodeId(graph);
    if (!exitId) return results;

    for (const edge of graph.edges) {
      if (edge.from === exitId) {
        results.push({
          rule: 'exit_no_outgoing',
          severity: LintSeverity.ERROR,
          message: `Exit node '${exitId}' must have no outgoing edges, but has one to '${edge.to}'.`,
          node_id: exitId,
          edge: { from: edge.from, to: edge.to },
        });
      }
    }

    return results;
  },
};

const edgeTargetExistsRule: LintRule = {
  name: 'edge_target_exists',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];

    for (const edge of graph.edges) {
      if (!graph.nodes.has(edge.from)) {
        results.push({
          rule: 'edge_target_exists',
          severity: LintSeverity.ERROR,
          message: `Edge references unknown source node '${edge.from}'.`,
          edge: { from: edge.from, to: edge.to },
        });
      }
      if (!graph.nodes.has(edge.to)) {
        results.push({
          rule: 'edge_target_exists',
          severity: LintSeverity.ERROR,
          message: `Edge references unknown target node '${edge.to}'.`,
          edge: { from: edge.from, to: edge.to },
        });
      }
    }

    return results;
  },
};

const reachabilityRule: LintRule = {
  name: 'reachability',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];
    const startId = findStartNodeId(graph);
    if (!startId) return results;

    // BFS from start
    const visited = new Set<string>();
    const queue = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of graph.edges) {
        if (edge.from === current && !visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push(edge.to);
        }
      }
    }

    for (const [id] of graph.nodes) {
      if (!visited.has(id)) {
        results.push({
          rule: 'reachability',
          severity: LintSeverity.ERROR,
          message: `Node '${id}' is not reachable from the start node.`,
          node_id: id,
        });
      }
    }

    return results;
  },
};

const conditionSyntaxRule: LintRule = {
  name: 'condition_syntax',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];

    for (const edge of graph.edges) {
      if (edge.attrs.condition) {
        try {
          // Parse the condition to check syntax - use a dummy outcome/context
          validateConditionSyntax(edge.attrs.condition);
        } catch (e) {
          results.push({
            rule: 'condition_syntax',
            severity: LintSeverity.ERROR,
            message: `Invalid condition expression on edge ${edge.from} -> ${edge.to}: ${(e as Error).message}`,
            edge: { from: edge.from, to: edge.to },
          });
        }
      }
    }

    return results;
  },
};

const stylesheetSyntaxRule: LintRule = {
  name: 'stylesheet_syntax',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];

    if (graph.attrs.model_stylesheet) {
      try {
        parseStylesheet(graph.attrs.model_stylesheet);
      } catch (e) {
        results.push({
          rule: 'stylesheet_syntax',
          severity: LintSeverity.ERROR,
          message: `Invalid model_stylesheet: ${(e as Error).message}`,
        });
      }
    }

    return results;
  },
};

const typeKnownRule: LintRule = {
  name: 'type_known',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];
    const knownTypes = new Set([
      'start', 'exit', 'codergen', 'wait.human', 'conditional',
      'parallel', 'parallel.fan_in', 'tool', 'stack.manager_loop',
    ]);

    for (const [id, node] of graph.nodes) {
      if (node.attrs.type && !knownTypes.has(node.attrs.type)) {
        results.push({
          rule: 'type_known',
          severity: LintSeverity.WARNING,
          message: `Node '${id}' has unknown handler type '${node.attrs.type}'.`,
          node_id: id,
        });
      }
    }

    return results;
  },
};

const fidelityValidRule: LintRule = {
  name: 'fidelity_valid',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];
    const validFidelities = new Set([
      'full', 'truncate', 'compact',
      'summary:low', 'summary:medium', 'summary:high',
      '', // empty = inherited
    ]);

    for (const [id, node] of graph.nodes) {
      if (node.attrs.fidelity && !validFidelities.has(node.attrs.fidelity)) {
        results.push({
          rule: 'fidelity_valid',
          severity: LintSeverity.WARNING,
          message: `Node '${id}' has invalid fidelity mode '${node.attrs.fidelity}'.`,
          node_id: id,
        });
      }
    }

    for (const edge of graph.edges) {
      if (edge.attrs.fidelity && !validFidelities.has(edge.attrs.fidelity)) {
        results.push({
          rule: 'fidelity_valid',
          severity: LintSeverity.WARNING,
          message: `Edge ${edge.from} -> ${edge.to} has invalid fidelity mode '${edge.attrs.fidelity}'.`,
          edge: { from: edge.from, to: edge.to },
        });
      }
    }

    return results;
  },
};

const retryTargetExistsRule: LintRule = {
  name: 'retry_target_exists',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];

    for (const [id, node] of graph.nodes) {
      if (node.attrs.retry_target && !graph.nodes.has(node.attrs.retry_target)) {
        results.push({
          rule: 'retry_target_exists',
          severity: LintSeverity.WARNING,
          message: `Node '${id}' has retry_target '${node.attrs.retry_target}' which does not exist.`,
          node_id: id,
        });
      }
      if (node.attrs.fallback_retry_target && !graph.nodes.has(node.attrs.fallback_retry_target)) {
        results.push({
          rule: 'retry_target_exists',
          severity: LintSeverity.WARNING,
          message: `Node '${id}' has fallback_retry_target '${node.attrs.fallback_retry_target}' which does not exist.`,
          node_id: id,
        });
      }
    }

    // Graph-level targets
    if (graph.attrs.retry_target && !graph.nodes.has(graph.attrs.retry_target)) {
      results.push({
        rule: 'retry_target_exists',
        severity: LintSeverity.WARNING,
        message: `Graph retry_target '${graph.attrs.retry_target}' does not exist.`,
      });
    }
    if (graph.attrs.fallback_retry_target && !graph.nodes.has(graph.attrs.fallback_retry_target)) {
      results.push({
        rule: 'retry_target_exists',
        severity: LintSeverity.WARNING,
        message: `Graph fallback_retry_target '${graph.attrs.fallback_retry_target}' does not exist.`,
      });
    }

    return results;
  },
};

const goalGateHasRetryRule: LintRule = {
  name: 'goal_gate_has_retry',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];

    for (const [id, node] of graph.nodes) {
      if (node.attrs.goal_gate) {
        const hasNodeRetry = node.attrs.retry_target || node.attrs.fallback_retry_target;
        const hasGraphRetry = graph.attrs.retry_target || graph.attrs.fallback_retry_target;
        if (!hasNodeRetry && !hasGraphRetry) {
          results.push({
            rule: 'goal_gate_has_retry',
            severity: LintSeverity.WARNING,
            message: `Node '${id}' has goal_gate=true but no retry_target or fallback_retry_target configured.`,
            node_id: id,
            fix: 'Add retry_target or fallback_retry_target to the node or graph',
          });
        }
      }
    }

    return results;
  },
};

const promptOnLlmNodesRule: LintRule = {
  name: 'prompt_on_llm_nodes',
  apply(graph: Graph): LintResult[] {
    const results: LintResult[] = [];

    for (const [id, node] of graph.nodes) {
      // Determine if this node resolves to the codergen handler
      const handlerType = node.attrs.type || SHAPE_TO_HANDLER_TYPE[node.attrs.shape];
      if (handlerType === 'codergen' || (!handlerType && node.attrs.shape === 'box')) {
        if (!node.attrs.prompt && node.attrs.label === id) {
          results.push({
            rule: 'prompt_on_llm_nodes',
            severity: LintSeverity.WARNING,
            message: `Node '${id}' resolves to codergen handler but has no prompt or meaningful label.`,
            node_id: id,
            fix: 'Add a prompt attribute to the node',
          });
        }
      }
    }

    return results;
  },
};

// ---------------------------------------------------------------------------
// All built-in rules
// ---------------------------------------------------------------------------

const BUILT_IN_RULES: LintRule[] = [
  startNodeRule,
  terminalNodeRule,
  startNoIncomingRule,
  exitNoOutgoingRule,
  edgeTargetExistsRule,
  reachabilityRule,
  conditionSyntaxRule,
  stylesheetSyntaxRule,
  typeKnownRule,
  fidelityValidRule,
  retryTargetExistsRule,
  goalGateHasRetryRule,
  promptOnLlmNodesRule,
];

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function findStartNodeId(graph: Graph): string | undefined {
  for (const [id, node] of graph.nodes) {
    if (node.attrs.shape === 'Mdiamond') return id;
  }
  if (graph.nodes.has('start')) return 'start';
  if (graph.nodes.has('Start')) return 'Start';
  return undefined;
}

function findExitNodeId(graph: Graph): string | undefined {
  for (const [id, node] of graph.nodes) {
    if (node.attrs.shape === 'Msquare') return id;
  }
  if (graph.nodes.has('exit')) return 'exit';
  if (graph.nodes.has('end')) return 'end';
  if (graph.nodes.has('Exit')) return 'Exit';
  if (graph.nodes.has('End')) return 'End';
  return undefined;
}

function validateConditionSyntax(condition: string): void {
  const clauses = condition.split('&&');
  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;

    // Must contain = or !=
    if (trimmed.includes('!=')) {
      const parts = trimmed.split('!=');
      if (parts.length !== 2) {
        throw new Error(`Invalid clause: '${trimmed}'`);
      }
      if (!parts[0].trim()) {
        throw new Error(`Missing key in clause: '${trimmed}'`);
      }
    } else if (trimmed.includes('=')) {
      const parts = trimmed.split('=');
      if (parts.length !== 2) {
        throw new Error(`Invalid clause: '${trimmed}'`);
      }
      if (!parts[0].trim()) {
        throw new Error(`Missing key in clause: '${trimmed}'`);
      }
    }
    // Bare key is allowed (truthy check)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validate(graph: Graph, extraRules?: LintRule[]): LintResult[] {
  const rules = [...BUILT_IN_RULES];
  if (extraRules) {
    rules.push(...extraRules);
  }

  const diagnostics: LintResult[] = [];
  for (const rule of rules) {
    diagnostics.push(...rule.apply(graph));
  }

  return diagnostics;
}

export function validateOrRaise(graph: Graph, extraRules?: LintRule[]): LintResult[] {
  const diagnostics = validate(graph, extraRules);
  const errors = diagnostics.filter(d => d.severity === LintSeverity.ERROR);

  if (errors.length > 0) {
    const messages = errors.map(e => `[${e.rule}] ${e.message}`).join('\n');
    throw new Error(`Validation failed with ${errors.length} error(s):\n${messages}`);
  }

  return diagnostics;
}
