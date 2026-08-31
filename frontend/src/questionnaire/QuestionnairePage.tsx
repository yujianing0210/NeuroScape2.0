import { useRef, useState } from 'react';
import { LikertQuestion } from './LikertQuestion.js';
import {
  QUESTIONNAIRE_VERSION,
  validateSubmission,
  type QuestionId,
  type QuestionnaireAnswer,
  type QuestionnaireStage,
  type QuestionnaireSubmission,
  type StudyCondition,
} from './questionnaireSchema.js';
import './questionnaire.css';

const calibration = [
  [
    'C1',
    'During the five-minute breathing practice, how much of the time were you able to stay with the breathing and guidance?',
    'Almost none of the time',
    'Almost all of the time',
  ],
  [
    'C2',
    'How often did your attention drift into thoughts, memories, or plans unrelated to the breathing practice?',
    'Never',
    'Very often',
  ],
  [
    'C3',
    'Overall, how relaxed did you feel during the five-minute breathing practice?',
    'Not at all relaxed',
    'Extremely relaxed',
  ],
] as const;
const post = [
  [
    'Q1',
    'I was able to stay with the present experience during the meditation.',
  ],
  [
    'Q2',
    'My attention often drifted into thoughts, memories, or plans unrelated to the meditation.',
  ],
  [
    'Q3',
    'When my attention began to drift, I was usually able to notice that I was mind wandering.',
  ],
  [
    'Q4',
    'When I noticed that my attention had drifted, I was able to bring it back to the present meditation experience relatively easily.',
  ],
  ['Q5', 'I felt calm and relaxed during the session.'],
  ['Q6', 'I felt like I was inside the environment created by the sounds.'],
  ['Q7', 'The sounds seemed to fit together naturally.'],
  ['Q8', 'The sounds distracted me from the meditation.'],
  ['Q9', 'Overall, I found the audio helpful for my meditation experience.'],
] as const;
const comparisonOptions = [
  ['session1', 'Session 1'],
  ['session2', 'Session 2'],
  ['no_clear_difference', 'Unable to compare / No clear difference'],
] as const;
const preferenceOptions = [
  ['session1', 'Session 1'],
  ['session2', 'Session 2'],
  ['no_preference', 'No preference'],
] as const;

export function QuestionnairePage({
  stage,
  participantId,
  sessionNumber,
  sessionId,
  condition,
  initialSubmission,
  onSubmit,
}: {
  stage: QuestionnaireStage;
  participantId: string;
  sessionNumber?: 1 | 2;
  sessionId?: string;
  condition?: StudyCondition;
  initialSubmission?: QuestionnaireSubmission;
  onSubmit: (submission: QuestionnaireSubmission) => Promise<void>;
}) {
  const shownAt = useRef(new Date().toISOString());
  const initialAnswers = new Map(
    initialSubmission?.answers.map((answer) => [
      answer.questionId,
      answer.value,
    ]),
  );
  const [ratings, setRatings] = useState<
    Partial<Record<QuestionId, number | null>>
  >(() =>
    Object.fromEntries(
      [...initialAnswers].filter(
        ([, value]) => typeof value === 'number' || value === null,
      ),
    ),
  );
  const [comfort, setComfort] = useState<boolean | null>(() => {
    const value = initialAnswers.get('COMFORT');
    return typeof value === 'boolean' ? value : null;
  });
  const [comfortText, setComfortText] = useState(() =>
    String(initialAnswers.get('COMFORT_TEXT') ?? ''),
  );
  const [responsiveness, setResponsiveness] = useState(() =>
    String(initialAnswers.get('F1') ?? ''),
  );
  const [preference, setPreference] = useState(() =>
    String(initialAnswers.get('F2') ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title =
    stage === 'calibration_post'
      ? 'Calibration Reflection'
      : stage === 'session_post'
        ? `Session ${sessionNumber} Reflection`
        : 'Compare the Two Sessions';
  const requiredIds: QuestionId[] =
    stage === 'calibration_post'
      ? ['C1', 'C2', 'C3']
      : stage === 'session_post'
        ? ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9']
        : [];
  const complete =
    requiredIds.every((id) => Object.hasOwn(ratings, id)) &&
    (stage !== 'session_post' ||
      (comfort !== null && (!comfort || Boolean(comfortText.trim())))) &&
    (stage !== 'final_comparison' || Boolean(responsiveness && preference));

  const submit = async () => {
    const answers: QuestionnaireAnswer[] = Object.entries(ratings).map(
      ([questionId, value]) => ({
        questionId: questionId as QuestionId,
        value: value ?? null,
      }),
    );
    if (stage === 'session_post') {
      answers.push({ questionId: 'COMFORT', value: comfort });
      if (comfort)
        answers.push({ questionId: 'COMFORT_TEXT', value: comfortText.trim() });
    }
    if (stage === 'final_comparison') {
      answers.push({ questionId: 'F1', value: responsiveness });
      answers.push({ questionId: 'F2', value: preference });
    }
    const submission: QuestionnaireSubmission = {
      questionnaireVersion: QUESTIONNAIRE_VERSION,
      participantId,
      stage,
      sessionId: sessionId ?? null,
      condition: condition ?? null,
      sessionNumber: sessionNumber ?? null,
      shownAtIso: shownAt.current,
      submittedAtIso: new Date().toISOString(),
      answers,
    };
    const validationErrors = validateSubmission(submission);
    if (validationErrors.length) {
      setError(validationErrors.join(' '));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit(submission);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <main className="questionnaire-page">
      <section className="questionnaire-card">
        <p className="flow-brand">NeuroScape</p>
        <h1>{title}</h1>
        {stage === 'calibration_post' && (
          <>
            <p>
              Please answer based on the five-minute breathing practice you just
              completed.
            </p>
            {calibration.map(([id, question, low, high]) => (
              <LikertQuestion
                key={id}
                question={question}
                value={ratings[id]}
                onChange={(value) => setRatings({ ...ratings, [id]: value })}
                low={low}
                high={high}
              />
            ))}
          </>
        )}
        {stage === 'session_post' && (
          <>
            <p>
              Thinking about the meditation session you just completed, please
              indicate how much you agree with each statement.
            </p>
            <aside className="questionnaire-definition">
              The “present experience” includes what is happening here and now,
              such as your breathing, bodily sensations, and the sounds around
              you. “Mind wandering” refers to becoming absorbed in thoughts,
              memories, or plans unrelated to the present meditation experience.
            </aside>
            {post.map(([id, question]) => (
              <LikertQuestion
                key={id}
                question={question}
                value={ratings[id]}
                onChange={(value) => setRatings({ ...ratings, [id]: value })}
                low="Strongly disagree"
                high="Strongly agree"
                allowNotApplicable={id === 'Q3' || id === 'Q4'}
              />
            ))}
            <fieldset className="choice-question">
              <legend>
                Did you experience any discomfort during this session, such as
                excessive volume, headache, dizziness, anxiety, or sensory
                overload?
              </legend>
              {[false, true].map((choice) => (
                <label key={String(choice)}>
                  <input
                    type="radio"
                    name="comfort"
                    checked={comfort === choice}
                    onChange={() => setComfort(choice)}
                  />{' '}
                  {choice ? 'Yes' : 'No'}
                </label>
              ))}
              {comfort && (
                <label>
                  Please briefly describe.
                  <textarea
                    required
                    value={comfortText}
                    onChange={(event) => setComfortText(event.target.value)}
                  />
                </label>
              )}
            </fieldset>
          </>
        )}
        {stage === 'final_comparison' && (
          <>
            <fieldset className="choice-question">
              <legend>Which session felt more responsive to you?</legend>
              {comparisonOptions.map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="responsiveness"
                    checked={responsiveness === value}
                    onChange={() => setResponsiveness(value)}
                  />{' '}
                  {label}
                </label>
              ))}
            </fieldset>
            <fieldset className="choice-question">
              <legend>
                If you were to do another meditation session, which of the two
                would you prefer to use?
              </legend>
              {preferenceOptions.map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="preference"
                    checked={preference === value}
                    onChange={() => setPreference(value)}
                  />{' '}
                  {label}
                </label>
              ))}
            </fieldset>
          </>
        )}
        {error && (
          <p role="alert" className="summary-error">
            {error}
          </p>
        )}
        <button
          className="questionnaire-submit"
          disabled={!complete || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Saving…' : 'Submit'}
        </button>
      </section>
    </main>
  );
}
