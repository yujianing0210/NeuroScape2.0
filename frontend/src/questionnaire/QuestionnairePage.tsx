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
    'My attention often drifted into thoughts unrelated to the meditation.',
  ],
  ['Q3', 'I felt relaxed during the session.'],
  ['Q4', 'I felt like I was inside the environment created by the sounds.'],
  ['Q5', 'The sounds seemed to fit together naturally.'],
  ['Q6', 'The sounds distracted me from the meditation.'],
] as const;
const finalQuestions = [
  ['F1', 'The sound environment in Session 1 felt responsive to me.'],
  ['F2', 'The sound environment in Session 2 felt responsive to me.'],
] as const;

export function QuestionnairePage({
  stage,
  participantId,
  sessionNumber,
  sessionId,
  condition,
  onSubmit,
}: {
  stage: QuestionnaireStage;
  participantId: string;
  sessionNumber?: 1 | 2;
  sessionId?: string;
  condition?: StudyCondition;
  onSubmit: (submission: QuestionnaireSubmission) => Promise<void>;
}) {
  const shownAt = useRef(new Date().toISOString());
  const [ratings, setRatings] = useState<Partial<Record<QuestionId, number>>>(
    {},
  );
  const [comfort, setComfort] = useState<boolean | null>(null);
  const [comfortText, setComfortText] = useState('');
  const [preference, setPreference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title =
    stage === 'calibration_post'
      ? 'Calibration Reflection'
      : stage === 'session_pre'
        ? `Session ${sessionNumber}`
        : stage === 'session_post'
          ? `Session ${sessionNumber} Reflection`
          : 'Compare the Two Sessions';
  const requiredIds =
    stage === 'calibration_post'
      ? ['C1', 'C2', 'C3']
      : stage === 'session_pre'
        ? ['M1']
        : stage === 'session_post'
          ? ['M1', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']
          : ['F1', 'F2'];
  const complete =
    requiredIds.every((id) => ratings[id as QuestionId]) &&
    (stage !== 'session_post' ||
      (comfort !== null && (!comfort || comfortText.trim()))) &&
    (stage !== 'final_comparison' || preference);
  const submit = async () => {
    const answers: QuestionnaireAnswer[] = Object.entries(ratings).map(
      ([questionId, value]) => ({
        questionId: questionId as QuestionId,
        value: value!,
      }),
    );
    if (stage === 'session_post') {
      answers.push({ questionId: 'COMFORT', value: comfort });
      if (comfort)
        answers.push({ questionId: 'COMFORT_TEXT', value: comfortText.trim() });
    }
    if (stage === 'final_comparison')
      answers.push({ questionId: 'F3', value: preference });
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
    if (validateSubmission(submission).length) return;
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
          <p>
            Please answer based on the five-minute breathing practice you just
            completed.
          </p>
        )}
        {stage === 'session_pre' && (
          <>
            <p>Please answer based on how you feel right now.</p>
            <LikertQuestion
              question="How relaxed do you feel right now?"
              value={ratings.M1}
              onChange={(value) => setRatings({ ...ratings, M1: value })}
              low="Not at all relaxed"
              high="Extremely relaxed"
            />
          </>
        )}
        {stage === 'calibration_post' &&
          calibration.map(([id, q, low, high]) => (
            <LikertQuestion
              key={id}
              question={q}
              value={ratings[id]}
              onChange={(value) => setRatings({ ...ratings, [id]: value })}
              low={low}
              high={high}
            />
          ))}
        {stage === 'session_post' && (
          <>
            <p>Please answer based on how you feel right now.</p>
            <LikertQuestion
              question="How relaxed do you feel right now?"
              value={ratings.M1}
              onChange={(value) => setRatings({ ...ratings, M1: value })}
              low="Not at all relaxed"
              high="Extremely relaxed"
            />
            <hr />
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
            {post.map(([id, q]) => (
              <LikertQuestion
                key={id}
                question={q}
                value={ratings[id]}
                onChange={(value) => setRatings({ ...ratings, [id]: value })}
                low="Strongly disagree"
                high="Strongly agree"
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
            {finalQuestions.map(([id, q]) => (
              <LikertQuestion
                key={id}
                question={q}
                value={ratings[id]}
                onChange={(value) => setRatings({ ...ratings, [id]: value })}
                low="Strongly disagree"
                high="Strongly agree"
              />
            ))}
            <fieldset className="choice-question">
              <legend>
                If you were to do another meditation session, which of the two
                would you prefer to use?
              </legend>
              {['Session 1', 'Session 2', 'No preference'].map((choice) => (
                <label key={choice}>
                  <input
                    type="radio"
                    name="preference"
                    checked={preference === choice}
                    onChange={() => setPreference(choice)}
                  />{' '}
                  {choice}
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
