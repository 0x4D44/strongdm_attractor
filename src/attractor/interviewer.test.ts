import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AutoApproveInterviewer,
  QueueInterviewer,
  CallbackInterviewer,
  RecordingInterviewer,
  ConsoleInterviewer,
} from './interviewer.js';
import { QuestionType, AnswerValue } from './types.js';
import type { Question, Answer } from './types.js';

// Mock readline at module level for ESM compatibility
const mockQuestion = vi.fn();
const mockClose = vi.fn();
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    text: 'Test question',
    type: QuestionType.SINGLE_SELECT,
    options: [
      { key: 'A', label: 'Option A' },
      { key: 'B', label: 'Option B' },
    ],
    stage: 'test',
    metadata: {},
    ...overrides,
  };
}

describe('AutoApproveInterviewer', () => {
  it('selects first option for SINGLE_SELECT', async () => {
    const interviewer = new AutoApproveInterviewer();
    const answer = await interviewer.ask(makeQuestion());
    expect(answer.value).toBe('A');
    expect(answer.selected_option).toEqual({ key: 'A', label: 'Option A' });
    expect(answer.text).toBe('Option A');
  });

  it('returns YES for CONFIRM', async () => {
    const interviewer = new AutoApproveInterviewer();
    const answer = await interviewer.ask(makeQuestion({ type: QuestionType.CONFIRM }));
    expect(answer.value).toBe(AnswerValue.YES);
  });

  it('returns auto-approved for FREE_TEXT', async () => {
    const interviewer = new AutoApproveInterviewer();
    const answer = await interviewer.ask(makeQuestion({ type: QuestionType.FREE_TEXT }));
    expect(answer.value).toBe('auto-approved');
  });

  it('askMultiple returns answers for each question', async () => {
    const interviewer = new AutoApproveInterviewer();
    const answers = await interviewer.askMultiple([
      makeQuestion(),
      makeQuestion({ type: QuestionType.CONFIRM }),
    ]);
    expect(answers).toHaveLength(2);
    expect(answers[0].value).toBe('A');
    expect(answers[1].value).toBe(AnswerValue.YES);
  });
});

describe('QueueInterviewer', () => {
  it('returns pre-filled answers in order', async () => {
    const answers: Answer[] = [
      { value: 'first', text: 'first' },
      { value: 'second', text: 'second' },
    ];
    const interviewer = new QueueInterviewer(answers);

    const a1 = await interviewer.ask(makeQuestion());
    const a2 = await interviewer.ask(makeQuestion());

    expect(a1.value).toBe('first');
    expect(a2.value).toBe('second');
  });

  it('returns SKIPPED when queue exhausted', async () => {
    const interviewer = new QueueInterviewer([
      { value: 'only', text: 'only' },
    ]);

    await interviewer.ask(makeQuestion()); // consumes the one answer
    const a = await interviewer.ask(makeQuestion()); // queue empty
    expect(a.value).toBe(AnswerValue.SKIPPED);
  });

  it('enqueue adds more answers', async () => {
    const interviewer = new QueueInterviewer([]);
    interviewer.enqueue({ value: 'added', text: 'added' });
    const a = await interviewer.ask(makeQuestion());
    expect(a.value).toBe('added');
  });

  it('remaining returns queue length', () => {
    const interviewer = new QueueInterviewer([
      { value: 'a', text: 'a' },
      { value: 'b', text: 'b' },
    ]);
    expect(interviewer.remaining()).toBe(2);
  });
});

describe('CallbackInterviewer', () => {
  it('delegates to function', async () => {
    const callback = async (q: Question): Promise<Answer> => {
      return { value: q.options[1]?.key ?? 'none', text: 'callback' };
    };
    const interviewer = new CallbackInterviewer(callback);
    const answer = await interviewer.ask(makeQuestion());
    expect(answer.value).toBe('B');
    expect(answer.text).toBe('callback');
  });

  it('askMultiple delegates each question', async () => {
    let callCount = 0;
    const callback = async (_q: Question): Promise<Answer> => {
      callCount++;
      return { value: `answer-${callCount}`, text: `answer-${callCount}` };
    };
    const interviewer = new CallbackInterviewer(callback);
    const answers = await interviewer.askMultiple([makeQuestion(), makeQuestion()]);
    expect(answers).toHaveLength(2);
    expect(answers[0].value).toBe('answer-1');
    expect(answers[1].value).toBe('answer-2');
  });

  it('inform is a no-op', () => {
    const callback = async (_q: Question): Promise<Answer> => ({
      value: 'x',
      text: 'x',
    });
    const interviewer = new CallbackInterviewer(callback);
    // Should not throw
    interviewer.inform('test message', 'test stage');
  });
});

describe('RecordingInterviewer', () => {
  it('records all question-answer pairs', async () => {
    const inner = new AutoApproveInterviewer();
    const recording = new RecordingInterviewer(inner);

    await recording.ask(makeQuestion());
    await recording.ask(makeQuestion({ type: QuestionType.CONFIRM }));

    expect(recording.recordings).toHaveLength(2);
    expect(recording.recordings[0].question.type).toBe(QuestionType.SINGLE_SELECT);
    expect(recording.recordings[0].answer.value).toBe('A');
    expect(recording.recordings[1].question.type).toBe(QuestionType.CONFIRM);
    expect(recording.recordings[1].answer.value).toBe(AnswerValue.YES);
  });

  it('askMultiple records each question', async () => {
    const inner = new AutoApproveInterviewer();
    const recording = new RecordingInterviewer(inner);

    await recording.askMultiple([
      makeQuestion(),
      makeQuestion({ type: QuestionType.CONFIRM }),
    ]);

    expect(recording.recordings).toHaveLength(2);
  });

  it('delegates inform to inner interviewer', () => {
    const inner = {
      ask: vi.fn().mockResolvedValue({ value: 'x', text: 'x' }),
      askMultiple: vi.fn(),
      inform: vi.fn(),
    };
    const recording = new RecordingInterviewer(inner);

    recording.inform('msg', 'stage');
    expect(inner.inform).toHaveBeenCalledWith('msg', 'stage');
  });
});

describe('AutoApproveInterviewer additional coverage', () => {
  it('selects first option for MULTI_SELECT', async () => {
    const interviewer = new AutoApproveInterviewer();
    const answer = await interviewer.ask(
      makeQuestion({ type: QuestionType.MULTI_SELECT }),
    );
    expect(answer.value).toBe('A');
    expect(answer.selected_option).toEqual({ key: 'A', label: 'Option A' });
  });

  it('returns auto-approved for SINGLE_SELECT with empty options', async () => {
    const interviewer = new AutoApproveInterviewer();
    const answer = await interviewer.ask(
      makeQuestion({ type: QuestionType.SINGLE_SELECT, options: [] }),
    );
    expect(answer.value).toBe('auto-approved');
  });

  it('inform is a no-op', () => {
    const interviewer = new AutoApproveInterviewer();
    // Should not throw
    interviewer.inform('test', 'stage');
  });
});

describe('QueueInterviewer additional coverage', () => {
  it('askMultiple returns answers in parallel', async () => {
    const answers: Answer[] = [
      { value: 'a', text: 'a' },
      { value: 'b', text: 'b' },
      { value: 'c', text: 'c' },
    ];
    const interviewer = new QueueInterviewer(answers);
    const results = await interviewer.askMultiple([
      makeQuestion(),
      makeQuestion(),
      makeQuestion(),
    ]);
    // Note: askMultiple uses Promise.all, so order depends on shift() calls
    expect(results).toHaveLength(3);
  });

  it('inform is a no-op', () => {
    const interviewer = new QueueInterviewer([]);
    interviewer.inform('test', 'stage');
  });

  it('does not mutate original array', () => {
    const original = [{ value: 'x', text: 'x' }];
    const interviewer = new QueueInterviewer(original);
    expect(original).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ConsoleInterviewer
// ---------------------------------------------------------------------------

describe('ConsoleInterviewer', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockQuestion.mockReset();
    mockClose.mockReset();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function setupMockInput(response: string): void {
    mockQuestion.mockImplementation((_query: string, cb: (answer: string) => void) => cb(response));
  }

  it('ask with SINGLE_SELECT returns matched option by key', async () => {
    setupMockInput('A');
    const interviewer = new ConsoleInterviewer();
    const answer = await interviewer.ask(makeQuestion());
    expect(answer.value).toBe('A');
    expect(answer.selected_option).toEqual({ key: 'A', label: 'Option A' });
    expect(answer.text).toBe('Option A');
    interviewer.close();
  });

  it('ask with SINGLE_SELECT returns raw text for unmatched input', async () => {
    setupMockInput('Z');
    const interviewer = new ConsoleInterviewer();
    const answer = await interviewer.ask(makeQuestion());
    expect(answer.value).toBe('Z');
    expect(answer.text).toBe('Z');
    expect(answer.selected_option).toBeUndefined();
    interviewer.close();
  });

  it('ask with CONFIRM returns YES for "yes"', async () => {
    setupMockInput('yes');
    const interviewer = new ConsoleInterviewer();
    const answer = await interviewer.ask(makeQuestion({ type: QuestionType.CONFIRM }));
    expect(answer.value).toBe(AnswerValue.YES);
    expect(answer.text).toBe('yes');
    interviewer.close();
  });

  it('ask with CONFIRM returns NO for "no"', async () => {
    setupMockInput('no');
    const interviewer = new ConsoleInterviewer();
    const answer = await interviewer.ask(makeQuestion({ type: QuestionType.CONFIRM }));
    expect(answer.value).toBe(AnswerValue.NO);
    interviewer.close();
  });

  it('ask with FREE_TEXT returns raw input', async () => {
    setupMockInput('free text input');
    const interviewer = new ConsoleInterviewer();
    const answer = await interviewer.ask(makeQuestion({ type: QuestionType.FREE_TEXT }));
    expect(answer.value).toBe('free text input');
    expect(answer.text).toBe('free text input');
    interviewer.close();
  });

  it('ask with MULTI_SELECT uses findMatchingOption by label', async () => {
    setupMockInput('Option B');
    const interviewer = new ConsoleInterviewer();
    const answer = await interviewer.ask(makeQuestion({ type: QuestionType.MULTI_SELECT }));
    expect(answer.value).toBe('B');
    expect(answer.selected_option).toEqual({ key: 'B', label: 'Option B' });
    interviewer.close();
  });

  it('ask with unknown question type falls through to generic prompt', async () => {
    setupMockInput('generic');
    const interviewer = new ConsoleInterviewer();
    const answer = await interviewer.ask(makeQuestion({
      type: 'UNKNOWN' as QuestionType,
      options: [],
    }));
    expect(answer.value).toBe('generic');
    expect(answer.text).toBe('generic');
    interviewer.close();
  });

  it('askMultiple processes questions sequentially', async () => {
    let callCount = 0;
    mockQuestion.mockImplementation((_query: string, cb: (answer: string) => void) => {
      callCount++;
      cb(`answer-${callCount}`);
    });
    const interviewer = new ConsoleInterviewer();
    const answers = await interviewer.askMultiple([
      makeQuestion({ type: QuestionType.FREE_TEXT }),
      makeQuestion({ type: QuestionType.FREE_TEXT }),
    ]);
    expect(answers).toHaveLength(2);
    expect(answers[0].value).toBe('answer-1');
    expect(answers[1].value).toBe('answer-2');
    interviewer.close();
  });

  it('inform logs formatted message', () => {
    const interviewer = new ConsoleInterviewer();
    interviewer.inform('Pipeline started', 'EXECUTE');
    expect(consoleSpy).toHaveBeenCalledWith('[EXECUTE] Pipeline started');
  });

  it('close() closes readline and is idempotent', async () => {
    setupMockInput('x');
    const interviewer = new ConsoleInterviewer();
    // Force rl creation
    await interviewer.ask(makeQuestion({ type: QuestionType.FREE_TEXT }));
    interviewer.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
    // Second close should be safe (rl is null)
    interviewer.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('findMatchingOption matches case-insensitively by label', async () => {
    setupMockInput('option a');
    const interviewer = new ConsoleInterviewer();
    const answer = await interviewer.ask(makeQuestion());
    // 'option a' matches 'Option A' case-insensitively by label
    expect(answer.value).toBe('A');
    expect(answer.selected_option).toEqual({ key: 'A', label: 'Option A' });
    interviewer.close();
  });

  it('findMatchingOption matches by key case-insensitively', async () => {
    setupMockInput('a');
    const interviewer = new ConsoleInterviewer();
    const answer = await interviewer.ask(makeQuestion());
    // 'a' matches key 'A' case-insensitively
    expect(answer.value).toBe('A');
    interviewer.close();
  });
});
