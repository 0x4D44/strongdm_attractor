/**
 * Handler registry: register handlers by type, resolve by shape/type.
 */

import type { NodeHandler, Node } from '../types.js';
import { HandlerType, SHAPE_TO_HANDLER_TYPE } from '../types.js';
import { StartHandler } from './start.js';
import { ExitHandler } from './exit.js';
import { CodergenHandler } from './codergen.js';
import { WaitHumanHandler } from './wait-human.js';
import { ConditionalHandler } from './conditional.js';
import { ParallelHandler } from './parallel.js';
import { FanInHandler } from './fan-in.js';
import { ToolHandler } from './tool-handler.js';
import { StackManagerHandler } from './stack-manager.js';
import type { CodergenBackend, Interviewer } from '../types.js';
import type { SubgraphExecutor } from './parallel.js';

export class HandlerRegistry {
  private handlers: Map<string, NodeHandler> = new Map();
  private defaultHandler: NodeHandler;

  constructor() {
    this.defaultHandler = new CodergenHandler();
  }

  /**
   * Register built-in handlers with the given dependencies.
   */
  registerDefaults(opts: {
    backend?: CodergenBackend | null;
    interviewer?: Interviewer;
    subgraphExecutor?: SubgraphExecutor | null;
  } = {}): void {
    this.register(HandlerType.START, new StartHandler());
    this.register(HandlerType.EXIT, new ExitHandler());

    const codergenHandler = new CodergenHandler(opts.backend ?? null);
    this.register(HandlerType.CODERGEN, codergenHandler);
    this.defaultHandler = codergenHandler;

    if (opts.interviewer) {
      this.register(HandlerType.WAIT_HUMAN, new WaitHumanHandler(opts.interviewer));
    }

    this.register(HandlerType.CONDITIONAL, new ConditionalHandler());
    this.register(HandlerType.PARALLEL, new ParallelHandler(opts.subgraphExecutor ?? null));
    this.register(HandlerType.PARALLEL_FAN_IN, new FanInHandler());
    this.register(HandlerType.TOOL, new ToolHandler());
    this.register(HandlerType.STACK_MANAGER_LOOP, new StackManagerHandler());
  }

  /**
   * Register a handler for a type string.
   * Replaces any previously registered handler for the same type.
   */
  register(typeString: string, handler: NodeHandler): void {
    this.handlers.set(typeString, handler);
  }

  /**
   * Resolve a handler for a node, following the 3-step resolution:
   * 1. Explicit `type` attribute
   * 2. Shape-based resolution
   * 3. Default handler (codergen)
   */
  resolve(node: Node): NodeHandler {
    // 1. Explicit type attribute
    if (node.attrs.type && this.handlers.has(node.attrs.type)) {
      return this.handlers.get(node.attrs.type)!;
    }

    // 2. Shape-based resolution
    const handlerType = SHAPE_TO_HANDLER_TYPE[node.attrs.shape];
    if (handlerType && this.handlers.has(handlerType)) {
      return this.handlers.get(handlerType)!;
    }

    // 3. Default
    return this.defaultHandler;
  }

  /**
   * Set the default handler (used when no type or shape match is found).
   */
  setDefaultHandler(handler: NodeHandler): void {
    this.defaultHandler = handler;
  }
}

export { StartHandler } from './start.js';
export { ExitHandler } from './exit.js';
export { CodergenHandler } from './codergen.js';
export { WaitHumanHandler, parseAcceleratorKey } from './wait-human.js';
export { ConditionalHandler } from './conditional.js';
export { ParallelHandler } from './parallel.js';
export type { SubgraphExecutor } from './parallel.js';
export { FanInHandler } from './fan-in.js';
export { ToolHandler } from './tool-handler.js';
export { StackManagerHandler } from './stack-manager.js';
