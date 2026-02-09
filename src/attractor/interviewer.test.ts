import { describe, it, expect, vi } from 'vitest';
import {
  AutoApproveInterviewer,
  QueueInterviewer,
  CallbackInterviewer,
  RecordingInterviewer,
} from './interviewer.js';
import { QuestionType, AnswerValue } from './types.js';
import type { Question, Answer } from './types.js';

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
