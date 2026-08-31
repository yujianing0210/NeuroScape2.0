import {
  answerValue,
  QUESTION_METADATA,
  type ParticipantStudyRecord,
  type StudyCondition,
} from '../../questionnaire/questionnaireSchema.js';
import type { RecordedSession } from '@neuroscape/contracts';
import { useEffect, useMemo, useState } from 'react';
import {
  EegTimelinePlot,
  sharedEegRanges,
} from '../components/EegTimelinePlot.js';

const conditionLabel = (value: StudyCondition) =>
  value === 'adaptive' ? 'Adaptive' : 'Non-Adaptive';
const score = (value: unknown) =>
  typeof value === 'number' ? `${value} / 7` : value === null ? 'N/A' : '—';
const sessionChoiceLabel = (value: unknown) =>
  value === 'session1'
    ? 'Session 1'
    : value === 'session2'
      ? 'Session 2'
      : value === 'no_clear_difference'
        ? 'No clear difference'
        : value === 'no_preference'
          ? 'No preference'
          : '—';
export function ParticipantComparisonPage({
  record,
  onHome,
}: {
  record: ParticipantStudyRecord;
  onHome: () => void;
}) {
  const accepted = record.sessions.filter(
    (item) =>
      item.attemptStatus !== 'failed' && item.attemptStatus !== 'excluded',
  );
  const adaptive = accepted.find((item) => item.condition === 'adaptive');
  const control = accepted.find((item) => item.condition === 'non-adaptive');
  const session1 = accepted.find((item) => item.sessionNumber === 1);
  const session2 = accepted.find((item) => item.sessionNumber === 2);
  const complete = Boolean(
    adaptive?.post && control?.post && record.finalComparison,
  );
  const responsive = answerValue(record.finalComparison, 'F1');
  const pref = answerValue(record.finalComparison, 'F2');
  const preferredNumber =
    pref === 'session1' ? 1 : pref === 'session2' ? 2 : null;
  const mapped = preferredNumber
    ? accepted.find((item) => item.sessionNumber === preferredNumber)?.condition
    : null;
  const comparisons = [
    'Q1',
    'Q2',
    'Q3',
    'Q4',
    'Q5',
    'Q6',
    'Q7',
    'Q8',
    'Q9',
  ] as const;
  const differences = comparisons
    .map((id) => ({
      id,
      a: answerValue(adaptive?.post, id),
      n: answerValue(control?.post, id),
    }))
    .filter(
      (item): item is typeof item & { a: number; n: number } =>
        typeof item.a === 'number' && typeof item.n === 'number',
    )
    .sort((a, b) => Math.abs(b.a - b.n) - Math.abs(a.a - a.n))
    .slice(0, 3);
  const [recordings, setRecordings] = useState<Record<string, RecordedSession>>(
    {},
  );
  const [recordingError, setRecordingError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all(
      accepted.map(async (session) => {
        const response = await fetch(
          `/api/study/sessions/${encodeURIComponent(record.participantId)}/${encodeURIComponent(session.sessionId)}/artifacts/final-session-bundle.json`,
        );
        if (!response.ok)
          throw new Error(
            `Session ${session.sessionNumber} recording is unavailable.`,
          );
        return [
          session.sessionId,
          (await response.json()) as RecordedSession,
        ] as const;
      }),
    )
      .then((items) => {
        if (active) setRecordings(Object.fromEntries(items));
      })
      .catch((error) => {
        if (active)
          setRecordingError(
            error instanceof Error ? error.message : String(error),
          );
      });
    return () => {
      active = false;
    };
  }, [record.participantId, record.updatedAtIso]);
  const orderedRecordings = accepted
    .sort((a, b) => a.sessionNumber - b.sessionNumber)
    .map((session) => recordings[session.sessionId])
    .filter((item): item is RecordedSession => Boolean(item));
  const eegRanges = useMemo(
    () =>
      orderedRecordings.length ? sharedEegRanges(orderedRecordings) : undefined,
    [recordings, record.updatedAtIso],
  );
  return (
    <main className="flow-page comparison-page">
      <header className="comparison-header">
        <div>
          <p className="flow-brand">NeuroScape · Investigator</p>
          <h1>Participant {record.participantId}</h1>
          <p>
            Order: {record.conditionOrder.map(conditionLabel).join(' → ')} ·
            Questionnaire v{record.questionnaireVersion}
          </p>
        </div>
        <div>
          <strong>
            {complete ? 'Questionnaires complete' : 'Study incomplete'}
          </strong>
          <button onClick={onHome}>Study Home</button>
          <button onClick={() => window.print()}>Print / Save PDF</button>
        </div>
      </header>
      {!complete && (
        <section className="glass-panel">
          <h2>Comparison unavailable</h2>
          <p>
            Both session questionnaires and the final comparison are required.
          </p>
        </section>
      )}
      <h2 className="comparison-section-title">A. Self-Report Comparison</h2>
      <section className="dashboard-grid">
        <article className="glass-panel">
          <h2>Calibration Self-Report</h2>
          {(['C1', 'C2', 'C3'] as const).map((id) => (
            <p key={id}>
              <span>{QUESTION_METADATA[id].label}</span>
              <strong>
                {score(answerValue(record.calibrationQuestionnaire, id))}
              </strong>
            </p>
          ))}
        </article>
        <article className="glass-panel">
          <h2>Session Mapping</h2>
          {accepted.map((session) => (
            <p key={session.sessionId}>
              <span>
                Session {session.sessionNumber} ·{' '}
                {conditionLabel(session.condition)}
              </span>
              <strong>{session.sessionId}</strong>
            </p>
          ))}
        </article>
      </section>
      <section className="glass-panel comparison-table">
        <h2>Core Session Self-Report</h2>
        <p>
          Raw 1–7 responses are shown. Lower Mind Wandering and Intrusiveness
          indicate less reported wandering/distraction; values are not
          reverse-scored here.
        </p>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Session 1</th>
              <th>Session 2</th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((id) => (
              <tr key={id}>
                <th>
                  {QUESTION_METADATA[id].label}
                  {(id === 'Q2' || id === 'Q8') && <small> lower = less</small>}
                </th>
                <td>{score(answerValue(session1?.post, id))}</td>
                <td>{score(answerValue(session2?.post, id))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="dashboard-grid">
        <article className="glass-panel">
          <h2>Perceived Responsiveness</h2>
          <p>
            <span>More responsive session</span>
            <strong>{sessionChoiceLabel(responsive)}</strong>
          </p>
        </article>
        <article className="glass-panel">
          <h2>Preference</h2>
          <p>
            {pref
              ? `${sessionChoiceLabel(pref)}${mapped ? ` → ${conditionLabel(mapped)}` : ''}`
              : '—'}
          </p>
        </article>
      </section>
      {accepted.some(
        (session) => answerValue(session.post, 'COMFORT') === true,
      ) && (
        <section className="glass-panel comfort-alert">
          <h2>Comfort notes recorded</h2>
          {accepted
            .filter((session) => answerValue(session.post, 'COMFORT') === true)
            .map((session) => (
              <p key={session.sessionId}>
                <strong>{conditionLabel(session.condition)}</strong>: “
                {String(answerValue(session.post, 'COMFORT_TEXT'))}”
              </p>
            ))}
        </section>
      )}
      {complete && (
        <section className="glass-panel">
          <h2>Interview Follow-Up Cues</h2>
          {differences.map(({ id, a, n }) => (
            <p key={id}>
              {a === n
                ? `${QUESTION_METADATA[id].label} ratings were equal`
                : `${conditionLabel(a > n ? 'adaptive' : 'non-adaptive')} rating was ${Math.abs(a - n)} point${Math.abs(a - n) === 1 ? '' : 's'} higher on ${QUESTION_METADATA[id].label}`}{' '}
              ({a} Adaptive vs {n} Non-Adaptive).
            </p>
          ))}
        </section>
      )}
      <h2 className="comparison-section-title">
        B. EEG + Soundscape Comparison
      </h2>
      {recordingError && (
        <section className="glass-panel">
          <p role="alert">{recordingError}</p>
        </section>
      )}
      {!recordingError && !orderedRecordings.length && (
        <section className="glass-panel">
          <p>Loading session recordings…</p>
        </section>
      )}
      {accepted
        .sort((a, b) => a.sessionNumber - b.sessionNumber)
        .map((session) => {
          const recording = recordings[session.sessionId];
          return (
            <section
              className="glass-panel participant-eeg-report"
              key={`eeg-${session.sessionId}`}
            >
              <h2>
                Session {session.sessionNumber} —{' '}
                {conditionLabel(session.condition)}
              </h2>
              {recording ? (
                <EegTimelinePlot
                  recording={recording}
                  title={`${conditionLabel(session.condition)} EEG + Soundscape`}
                  ranges={eegRanges}
                />
              ) : (
                <p>Recording unavailable.</p>
              )}
            </section>
          );
        })}
    </main>
  );
}
