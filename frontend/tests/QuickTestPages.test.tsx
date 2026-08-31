import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createParticipantRecord } from '../src/questionnaire/questionnairePersistence.js';
import {
  QUESTIONNAIRE_VERSION,
  type QuestionnaireSubmission,
} from '../src/questionnaire/questionnaireSchema.js';
import {
  QuickStudySummaryPage,
  QuickTestStagePage,
} from '../src/ui/pages/QuickTestPages.js';

const submission = (
  stage: QuestionnaireSubmission['stage'],
  answers: QuestionnaireSubmission['answers'],
  sessionNumber?: 1 | 2,
): QuestionnaireSubmission => ({
  questionnaireVersion: QUESTIONNAIRE_VERSION,
  participantId: 'P999',
  stage,
  sessionId: sessionNumber ? `s${sessionNumber}` : null,
  condition:
    sessionNumber === 1
      ? 'non-adaptive'
      : sessionNumber === 2
        ? 'adaptive'
        : null,
  sessionNumber: sessionNumber ?? null,
  shownAtIso: '2026-01-01T00:00:00Z',
  submittedAtIso: '2026-01-01T00:01:00Z',
  answers,
});
describe('Quick Test developer flow UI', () => {
  it('labels the skipped stage without pretending EEG exists', () => {
    const html = renderToStaticMarkup(
      <QuickTestStagePage
        kind="session"
        sessionNumber={1}
        condition="non-adaptive"
        busy={false}
        onComplete={async () => {}}
      />,
    );
    expect(html).toContain('QUICK TEST MODE');
    expect(html).toContain('Skip / Complete Stage');
    expect(html).toContain('does not create physiological EEG values');
  });
  it('renders independently stored sessions in the final comparison', () => {
    const record = createParticipantRecord('P999');
    record.studyMode = 'quick_test';
    record.calibrationQuestionnaire = submission('calibration_post', [
      { questionId: 'C1', value: 4 },
      { questionId: 'C2', value: 3 },
      { questionId: 'C3', value: 5 },
    ]);
    record.sessions = [1, 2].map((number) => ({
      sessionNumber: number as 1 | 2,
      sessionId: `s${number}`,
      condition:
        number === 1 ? ('non-adaptive' as const) : ('adaptive' as const),
      sessionDataFinalized: true,
      attemptStatus: 'accepted' as const,
      post: submission(
        'session_post',
        [
          ...(
            ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9'] as const
          ).map((questionId) => ({ questionId, value: number + 3 })),
          { questionId: 'COMFORT', value: false },
        ],
        number as 1 | 2,
      ),
    }));
    record.finalComparison = submission('final_comparison', [
      { questionId: 'F1', value: 'session2' },
      { questionId: 'F2', value: 'session2' },
    ]);
    record.questionnaireComplete = true;
    const html = renderToStaticMarkup(
      <QuickStudySummaryPage
        record={record}
        onHome={() => {}}
        onDashboard={() => {}}
      />,
    );
    expect(html).toContain('Session 1 vs Session 2');
    expect(html).toContain('Non-Adaptive');
    expect(html).toContain('Adaptive');
    expect(html).toContain('Overall Helpfulness');
    expect(html).toContain('Session 2');
  });
});
