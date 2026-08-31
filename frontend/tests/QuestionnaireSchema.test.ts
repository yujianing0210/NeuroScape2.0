import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QUESTIONNAIRE_VERSION,
  validateSubmission,
  type QuestionnaireSubmission,
} from '../src/questionnaire/questionnaireSchema.js';
import {
  createParticipantRecord,
  saveParticipantRecord,
  withStudyOrder,
} from '../src/questionnaire/questionnairePersistence.js';

afterEach(() => vi.unstubAllGlobals());

describe('participant state persistence', () => {
  it('retries one transient request failure and completes', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('proxy connection reset'))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetcher);

    const saved = await saveParticipantRecord(createParticipantRecord('P013'));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(saved.participantId).toBe('P013');
  });

  it('stops after two failed attempts instead of waiting forever', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetcher);

    await expect(
      saveParticipantRecord(createParticipantRecord('P013')),
    ).rejects.toThrow('after two attempts');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

const submission = (
  overrides: Partial<QuestionnaireSubmission> = {},
): QuestionnaireSubmission => ({
  questionnaireVersion: QUESTIONNAIRE_VERSION,
  participantId: 'P001',
  stage: 'session_post',
  sessionId: 'session-1',
  condition: 'adaptive',
  sessionNumber: 1,
  shownAtIso: '2026-01-01T00:00:00.000Z',
  submittedAtIso: '2026-01-01T00:01:00.000Z',
  answers: [
    ...(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9'] as const).map(
      (questionId) => ({ questionId, value: 4 }),
    ),
    { questionId: 'COMFORT', value: false },
  ],
  ...overrides,
});
describe('study order persistence model', () => {
  it('records a manual override and maps its condition order', () => {
    expect(withStudyOrder(createParticipantRecord('P003'), 'BA')).toMatchObject(
      {
        recommendedOrder: 'AB',
        actualOrder: 'BA',
        assignmentSource: 'manual_override',
        conditionOrder: ['adaptive', 'non-adaptive'],
      },
    );
  });
  it('does not alter order after a session has started', () => {
    const record = createParticipantRecord('P003');
    record.sessions.push({
      sessionNumber: 1,
      sessionId: 's1',
      condition: 'non-adaptive',
      sessionDataFinalized: true,
    });
    expect(withStudyOrder(record, 'BA')).toBe(record);
  });
});
describe('questionnaire schema', () => {
  it('accepts a valid versioned Likert response', () =>
    expect(validateSubmission(submission())).toEqual([]));
  it('rejects missing and out-of-range Likert values', () => {
    expect(validateSubmission(submission({ answers: [] }))).toContain(
      'Q1 must be rated 1–7.',
    );
    expect(
      validateSubmission(
        submission({ answers: [{ questionId: 'Q1', value: 8 }] }),
      ),
    ).toContain('Q1 must be rated 1–7.');
  });
  it('accepts explicit N/A for Q3 and Q4', () => {
    const answers = submission().answers.map((item) =>
      item.questionId === 'Q3' || item.questionId === 'Q4'
        ? { ...item, value: null }
        : item,
    );
    expect(validateSubmission(submission({ answers }))).toEqual([]);
  });
  it('requires comfort text only after a yes response', () => {
    const post = submission({
      stage: 'session_post',
      answers: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9']
        .map((questionId) => ({ questionId: questionId as 'Q1', value: 4 }))
        .concat([{ questionId: 'COMFORT', value: true }]),
    });
    expect(validateSubmission(post)).toContain(
      'Comfort description is required.',
    );
  });
  it('restricts final preference choices', () => {
    const final = submission({
      stage: 'final_comparison',
      sessionId: null,
      condition: null,
      sessionNumber: null,
      answers: [
        { questionId: 'F1', value: 'adaptive' },
        { questionId: 'F2', value: 'Adaptive' },
      ],
    });
    expect(validateSubmission(final)).toContain(
      'A valid preference is required.',
    );
  });
});
