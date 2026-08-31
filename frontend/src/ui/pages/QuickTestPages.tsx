import {
  answerValue,
  QUESTION_METADATA,
  type ParticipantStudyRecord,
  type StudyCondition,
} from '../../questionnaire/questionnaireSchema.js';

const conditionLabel = (condition: StudyCondition) =>
  condition === 'adaptive' ? 'Adaptive' : 'Non-Adaptive';
const rating = (value: unknown) =>
  typeof value === 'number' ? `${value} / 7` : '—';
export function QuickTestStagePage({
  kind,
  sessionNumber,
  condition,
  busy,
  error,
  onComplete,
}: {
  kind: 'calibration' | 'session';
  sessionNumber?: 1 | 2;
  condition?: StudyCondition;
  busy: boolean;
  error?: string;
  onComplete: () => Promise<void>;
}) {
  return (
    <main className="flow-page quick-test-page">
      <section className="glass-panel quick-test-card">
        <p className="quick-test-badge">DEVELOPER · QUICK TEST MODE</p>
        <h1>
          {kind === 'calibration'
            ? 'Calibration Stage'
            : `Session ${sessionNumber} Stage`}
        </h1>
        {condition && (
          <p>
            Internal condition: <strong>{conditionLabel(condition)}</strong>
          </p>
        )}
        <div className="quick-test-status">
          <p>
            Live EEG streaming <strong>Skipped</strong>
          </p>
          <p>
            {kind === 'calibration'
              ? 'Five-minute calibration'
              : 'Ten-minute meditation'}{' '}
            <strong>Ready to skip</strong>
          </p>
          <p>
            Audio playback <strong>Skipped</strong>
          </p>
        </div>
        <p>
          This developer bypass preserves the downstream questionnaire and
          persistence flow. It does not create physiological EEG values.
        </p>
        {error && (
          <p role="alert" className="summary-error">
            {error}
          </p>
        )}
        <button disabled={busy} onClick={() => void onComplete()}>
          {busy ? 'Saving…' : 'Skip / Complete Stage (Quick Test)'}
        </button>
      </section>
    </main>
  );
}

export function QuickStageSummaryPage({
  record,
  kind,
  sessionNumber,
  onContinue,
  onHome,
}: {
  record: ParticipantStudyRecord;
  kind: 'calibration' | 'session';
  sessionNumber?: 1 | 2;
  onContinue: () => void;
  onHome: () => void;
}) {
  const session = sessionNumber
    ? record.sessions.find(
        (item) =>
          item.sessionNumber === sessionNumber &&
          item.attemptStatus === 'accepted',
      )
    : undefined;
  const ids = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'] as const;
  return (
    <main className="flow-page quick-test-page">
      <section className="glass-panel quick-test-card">
        <p className="quick-test-badge">DEVELOPER · QUICK TEST MODE</p>
        <h1>
          {kind === 'calibration'
            ? 'Calibration Quick Summary'
            : `Session ${sessionNumber} Quick Summary`}
        </h1>
        {kind === 'calibration' ? (
          <div className="quick-summary-list">
            {(['C1', 'C2', 'C3'] as const).map((id) => (
              <p key={id}>
                <span>{QUESTION_METADATA[id].label}</span>
                <strong>
                  {rating(answerValue(record.calibrationQuestionnaire, id))}
                </strong>
              </p>
            ))}
            <p>
              <span>Data saved</span>
              <strong>Yes</strong>
            </p>
            <p>
              <span>EEG source</span>
              <strong>Quick Test / skipped</strong>
            </p>
          </div>
        ) : (
          <>
            <p>
              Condition:{' '}
              <strong>
                {session ? conditionLabel(session.condition) : '—'}
              </strong>
            </p>
            <div className="quick-summary-list">
              <p>
                <span>Pre-session relaxation</span>
                <strong>{rating(answerValue(session?.pre, 'M1'))}</strong>
              </p>
              <p>
                <span>Post-session relaxation</span>
                <strong>{rating(answerValue(session?.post, 'M1'))}</strong>
              </p>
              <p>
                <span>Change</span>
                <strong>
                  {typeof answerValue(session?.pre, 'M1') === 'number' &&
                  typeof answerValue(session?.post, 'M1') === 'number'
                    ? Number(answerValue(session?.post, 'M1')) -
                      Number(answerValue(session?.pre, 'M1'))
                    : '—'}
                </strong>
              </p>
              {ids.map((id) => (
                <p key={id}>
                  <span>{QUESTION_METADATA[id].label}</span>
                  <strong>{rating(answerValue(session?.post, id))}</strong>
                </p>
              ))}
              <p>
                <span>Comfort issue</span>
                <strong>
                  {answerValue(session?.post, 'COMFORT') === true
                    ? 'Yes'
                    : 'No'}
                </strong>
              </p>
              <p>
                <span>EEG streaming / duration</span>
                <strong>Skipped</strong>
              </p>
              <p>
                <span>Questionnaire saved</span>
                <strong>Yes</strong>
              </p>
            </div>
          </>
        )}
        <div className="quick-summary-actions">
          <button onClick={onContinue}>Continue</button>
          <button onClick={onHome}>Back to Results / Home</button>
        </div>
      </section>
    </main>
  );
}

export function QuickStudySummaryPage({
  record,
  onHome,
  onDashboard,
}: {
  record: ParticipantStudyRecord;
  onHome: () => void;
  onDashboard: () => void;
}) {
  const sessions = [1, 2].map((number) =>
    record.sessions.find(
      (item) =>
        item.sessionNumber === number && item.attemptStatus === 'accepted',
    ),
  );
  const ids = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'] as const;
  return (
    <main className="flow-page comparison-page quick-study-summary">
      <header className="comparison-header">
        <div>
          <p className="quick-test-badge">DEVELOPER · QUICK TEST MODE</p>
          <h1>Study Quick Summary · {record.participantId}</h1>
          <p>
            Order {record.actualOrder}:{' '}
            {record.conditionOrder.map(conditionLabel).join(' → ')} · EEG
            skipped
          </p>
        </div>
        <div>
          <button onClick={onDashboard}>Open Full Report</button>
          <button onClick={onHome}>Study Home</button>
        </div>
      </header>
      <section className="glass-panel">
        <h2>Study Metadata</h2>
        <div className="quick-summary-list">
          <p>
            <span>Quick Test Mode</span>
            <strong>Yes</strong>
          </p>
          <p>
            <span>Questionnaires complete</span>
            <strong>{record.questionnaireComplete ? 'Yes' : 'No'}</strong>
          </p>
          {sessions.map((session, index) => (
            <p key={index}>
              <span>Session {index + 1}</span>
              <strong>
                {session ? conditionLabel(session.condition) : 'Missing'}
              </strong>
            </p>
          ))}
        </div>
      </section>
      <section className="glass-panel">
        <h2>Calibration</h2>
        <div className="quick-summary-list">
          {(['C1', 'C2', 'C3'] as const).map((id) => (
            <p key={id}>
              <span>{QUESTION_METADATA[id].label}</span>
              <strong>
                {rating(answerValue(record.calibrationQuestionnaire, id))}
              </strong>
            </p>
          ))}
        </div>
      </section>
      <section className="glass-panel comparison-table">
        <h2>Session 1 vs Session 2</h2>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Session 1</th>
              <th>Session 2</th>
              <th>Difference (S2 − S1)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>M1 Pre</th>
              <td>{answerValue(sessions[0]?.pre, 'M1') ?? '—'}</td>
              <td>{answerValue(sessions[1]?.pre, 'M1') ?? '—'}</td>
              <td>—</td>
            </tr>
            <tr>
              <th>M1 Post</th>
              <td>{answerValue(sessions[0]?.post, 'M1') ?? '—'}</td>
              <td>{answerValue(sessions[1]?.post, 'M1') ?? '—'}</td>
              <td>—</td>
            </tr>
            {ids.map((id) => {
              const a = answerValue(sessions[0]?.post, id),
                b = answerValue(sessions[1]?.post, id);
              return (
                <tr key={id}>
                  <th>{QUESTION_METADATA[id].label}</th>
                  <td>{a ?? '—'}</td>
                  <td>{b ?? '—'}</td>
                  <td>
                    {typeof a === 'number' && typeof b === 'number'
                      ? `${b - a >= 0 ? '+' : ''}${b - a}`
                      : '—'}
                  </td>
                </tr>
              );
            })}
            <tr>
              <th>Comfort issue</th>
              <td>
                {answerValue(sessions[0]?.post, 'COMFORT') === true
                  ? 'Yes'
                  : 'No'}
              </td>
              <td>
                {answerValue(sessions[1]?.post, 'COMFORT') === true
                  ? 'Yes'
                  : 'No'}
              </td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </section>
      <section className="glass-panel">
        <h2>Final Comparison</h2>
        <div className="quick-summary-list">
          <p>
            <span>Session 1 responsiveness</span>
            <strong>{rating(answerValue(record.finalComparison, 'F1'))}</strong>
          </p>
          <p>
            <span>Session 2 responsiveness</span>
            <strong>{rating(answerValue(record.finalComparison, 'F2'))}</strong>
          </p>
          <p>
            <span>Preferred session</span>
            <strong>
              {String(answerValue(record.finalComparison, 'F3') ?? '—')}
            </strong>
          </p>
        </div>
      </section>
    </main>
  );
}
