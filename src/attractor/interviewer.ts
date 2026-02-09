/**
 * Human-in-the-loop implementations: Interviewer interface and built-in implementations.
 */

import * as readline from 'node:readline';
import type {
  Interviewer,
  Question,
  Answer,
  QuestionOption,
} from './types.js';
import { AnswerValue, QuestionType } from './types.js';

// ---------------------------------------------------------------------------
// AutoApproveInterviewer
// ---------------------------------------------------------------------------

/**
 * Always selects YES for yes/no questions and the first option for multiple choice.
 * Used for automated testing and CI/CD pipelines.
 */
export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    if (question.type === QuestionType.CONFIRM) {
      return { value: AnswerValue.YES, text: 'yes' };
    }

    if (question.type === QuestionType.SINGLE_SELECT || question.type === QuestionType.MULTI_SELECT) {
      if (question.options.length > 0) {
        const first = question.options[0];
        return {
          value: first.key,
          selected_option: first,
          text: first.label,
        };
      }
    }

    return { value: 'auto-approved', text: 'auto-approved' };
  }

  async askMultiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map(q => this.ask(q)));
  }

  inform(_message: string, _stage: string): void {
    // No-op for auto-approve
  }
}

// ---------------------------------------------------------------------------
// ConsoleInterviewer
// ---------------------------------------------------------------------------

/**
 * Reads from standard input. Displays formatted prompts with option keys.
 */
export class ConsoleInterviewer implements Interviewer {
  private rl: readline.Interface | null = null;

  private getRL(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
    return this.rl;
  }

  private prompt(query: string): Promise<string> {
    return new Promise((resolve) => {
      this.getRL().question(query, (answer) => {
        resolve(answer);
      });
    });
  }

  async ask(question: Question): Promise<Answer> {
    console.log(`\n[?] ${question.text}`);

    if (question.type === QuestionType.SINGLE_SELECT || question.type === QuestionType.MULTI_SELECT) {
      for (const option of question.options) {
        console.log(`  [${option.key}] ${option.label}`);
      }
      const response = await this.prompt('Select: ');
      const selected = findMatchingOption(response.trim(), question.options);
      if (selected) {
        return { value: selected.key, selected_option: selected, text: selected.label };
      }
      return { value: response.trim(), text: response.trim() };
    }

    if (question.type === QuestionType.CONFIRM) {
      const response = await this.prompt('[Y/N]: ');
      const isYes = response.trim().toLowerCase().startsWith('y');
      return { value: isYes ? AnswerValue.YES : AnswerValue.NO, text: response.trim() };
    }

    if (question.type === QuestionType.FREE_TEXT) {
      const response = await this.prompt('> ');
      return { value: response, text: response };
    }

    const response = await this.prompt('> ');
    return { value: response, text: response };
  }

  async askMultiple(questions: Question[]): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (const q of questions) {
      answers.push(await this.ask(q));
    }
    return answers;
  }

  inform(message: string, stage: string): void {
    console.log(`[${stage}] ${message}`);
  }

  close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ---------------------------------------------------------------------------
// CallbackInterviewer
// ---------------------------------------------------------------------------

/**
 * Delegates question answering to a provided callback function.
 * Useful for integrating with external systems.
 */
export class CallbackInterviewer implements Interviewer {
  private callback: (question: Question) => Promise<Answer>;

  constructor(callback: (question: Question) => Promise<Answer>) {
    this.callback = callback;
  }

  async ask(question: Question): Promise<Answer> {
    return this.callback(question);
  }

  async askMultiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map(q => this.callback(q)));
  }

  inform(_message: string, _stage: string): void {
    // No-op for callback
  }
}

// ---------------------------------------------------------------------------
// QueueInterviewer
// ---------------------------------------------------------------------------

/**
 * Reads answers from a pre-filled answer queue.
 * Used for deterministic testing and replay.
 */
export class QueueInterviewer implements Interviewer {
  private answers: Answer[];

  constructor(answers: Answer[]) {
    this.answers = [...answers];
  }

  async ask(_question: Question): Promise<Answer> {
    if (this.answers.length > 0) {
      return this.answers.shift()!;
    }
    return { value: AnswerValue.SKIPPED, text: '' };
  }

  async askMultiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map(q => this.ask(q)));
  }

  inform(_message: string, _stage: string): void {
    // No-op
  }

  /**
   * Add more answers to the queue.
   */
  enqueue(...answers: Answer[]): void {
    this.answers.push(...answers);
  }

  /**
   * Check remaining answers in the queue.
   */
  remaining(): number {
    return this.answers.length;
  }
}

// ---------------------------------------------------------------------------
// RecordingInterviewer
// ---------------------------------------------------------------------------

/**
 * Wraps another interviewer and records all question-answer pairs.
 * Used for replay, debugging, and audit trails.
 */
export class RecordingInterviewer implements Interviewer {
  private inner: Interviewer;
  readonly recordings: Array<{ question: Question; answer: Answer }> = [];

  constructor(inner: Interviewer) {
    this.inner = inner;
  }

  async ask(question: Question): Promise<Answer> {
    const answer = await this.inner.ask(question);
    this.recordings.push({ question, answer });
    return answer;
  }

  async askMultiple(questions: Question[]): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (const q of questions) {
      answers.push(await this.ask(q));
    }
    return answers;
  }

  inform(message: string, stage: string): void {
    this.inner.inform?.(message, stage);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findMatchingOption(
  input: string,
  options: QuestionOption[],
): QuestionOption | undefined {
  const lower = input.toLowerCase();
  return options.find(
    o => o.key.toLowerCase() === lower || o.label.toLowerCase() === lower
  );
}
