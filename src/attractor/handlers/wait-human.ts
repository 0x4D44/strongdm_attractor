/**
 * Wait.human handler: blocks until a human selects an option.
 * Derives choices from outgoing edges and presents them via the Interviewer.
 */

import type {
  NodeHandler,
  Node,
  PipelineContext,
  Graph,
  Outcome,
  Interviewer,
  QuestionOption,
} from '../types.js';
import {
  StageStatus,
  QuestionType,
  AnswerValue,
  makeOutcome,
} from '../types.js';

// ---------------------------------------------------------------------------
// Accelerator Key Parsing
// ---------------------------------------------------------------------------

export function parseAcceleratorKey(label: string): string {
  // [K] Label
  const bracketMatch = label.match(/^\[([^\]]+)\]\s*/);
  if (bracketMatch) return bracketMatch[1];

  // K) Label
  const parenMatch = label.match(/^([A-Za-z0-9])\)\s*/);
  if (parenMatch) return parenMatch[1];

  // K - Label
  const dashMatch = label.match(/^([A-Za-z0-9])\s*-\s*/);
  if (dashMatch) return dashMatch[1];

  // First character
  if (label.length > 0) return label[0].toUpperCase();

  return '';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class WaitHumanHandler implements NodeHandler {
  private interviewer: Interviewer;

  constructor(interviewer: Interviewer) {
    this.interviewer = interviewer;
  }

  async handle(
    node: Node,
    context: PipelineContext,
    graph: Graph,
    _logsRoot: string,
  ): Promise<Outcome> {
    // 1. Derive choices from outgoing edges
    const edges = graph.edges.filter(e => e.from === node.id);

    interface Choice {
      key: string;
      label: string;
      to: string;
    }

    const choices: Choice[] = [];
    for (const edge of edges) {
      const label = edge.attrs.label || edge.to;
      const key = parseAcceleratorKey(label);
      choices.push({ key, label, to: edge.to });
    }

    if (choices.length === 0) {
      return makeOutcome({
        status: StageStatus.FAIL,
        failure_reason: 'No outgoing edges for human gate',
      });
    }

    // 2. Build question
    const options: QuestionOption[] = choices.map(c => ({
      key: c.key,
      label: c.label,
    }));

    const question = {
      text: node.attrs.label || 'Select an option:',
      type: QuestionType.SINGLE_SELECT,
      options,
      stage: node.id,
      metadata: {},
    };

    // 3. Present to interviewer
    const answer = await this.interviewer.ask(question);

    // 4. Handle timeout/skip
    if (answer.value === AnswerValue.TIMEOUT) {
      const defaultChoice = (node.attrs as Record<string, unknown>)['human.default_choice'] as string | undefined;
      if (defaultChoice) {
        const matchedChoice = choices.find(c =>
          c.to === defaultChoice || c.key === defaultChoice || c.label === defaultChoice
        );
        if (matchedChoice) {
          return makeOutcome({
            status: StageStatus.SUCCESS,
            suggested_next_ids: [matchedChoice.to],
            context_updates: {
              'human.gate.selected': matchedChoice.key,
              'human.gate.label': matchedChoice.label,
            },
          });
        }
      }
      return makeOutcome({
        status: StageStatus.RETRY,
        failure_reason: 'human gate timeout, no default',
      });
    }

    if (answer.value === AnswerValue.SKIPPED) {
      return makeOutcome({
        status: StageStatus.FAIL,
        failure_reason: 'human skipped interaction',
      });
    }

    // 5. Find matching choice
    let selected = choices[0]; // fallback
    const answerVal = String(answer.value).toLowerCase();
    for (const choice of choices) {
      if (choice.key.toLowerCase() === answerVal ||
          choice.label.toLowerCase() === answerVal ||
          choice.to.toLowerCase() === answerVal) {
        selected = choice;
        break;
      }
    }

    // Also check selected_option
    if (answer.selected_option) {
      const matchByKey = choices.find(c => c.key === answer.selected_option!.key);
      if (matchByKey) selected = matchByKey;
    }

    // 6. Return outcome
    return makeOutcome({
      status: StageStatus.SUCCESS,
      suggested_next_ids: [selected.to],
      context_updates: {
        'human.gate.selected': selected.key,
        'human.gate.label': selected.label,
      },
    });
  }
}
