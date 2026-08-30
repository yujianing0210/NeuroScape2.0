import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type SavedCalibrationSession,
} from '../../calibration/services/api.js';
import type { Profile } from '../../calibration/types.js';
import { recordingStore } from '../../recording/recordingStore.js';
import { EegTimelinePlot } from '../components/EegTimelinePlot.js';
import {
  loadParticipantRecord,
  saveParticipantRecord,
  withStudyOrder,
} from '../../questionnaire/questionnairePersistence.js';
import type { ParticipantStudyRecord } from '../../questionnaire/questionnaireSchema.js';

export interface CalibrationSessionIntent {
  participantId: string;
  durationMinutes: number;
}
export interface SessionIntent {
  worldDescription: string;
  durationMinutes: number;
  eegSource: 'muse' | 'recorded';
}
export type AdaptiveRunMode = 'mock-fast' | 'study-realtime';
export interface AdaptiveSessionIntent {
  participantId: string;
  runMode: AdaptiveRunMode;
  plannerMode: 'openai' | 'mock';
}

export function HomePage({
  onCalibration,
  onRealTime,
  onNonAdaptive,
  studyRecord,
  onParticipantRecord,
  onDashboard,
}: {
  onCalibration: (intent: CalibrationSessionIntent) => void;
  onRealTime: (profile: Profile, replayFile?: File) => void | Promise<void>;
  onNonAdaptive: (profile: Profile, replayFile?: File) => void | Promise<void>;
  studyRecord: ParticipantStudyRecord | null;
  onParticipantRecord: (record: ParticipantStudyRecord | null) => void;
  onDashboard: () => void;
}) {
  const [participantId, setParticipantId] = useState('P001');
  const [sessions, setSessions] = useState<SavedCalibrationSession[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [eegSource, setEegSource] = useState<'realtime' | 'prerecorded'>(
    'realtime',
  );
  const [replayFile, setReplayFile] = useState<File | null>(null);
  const normalized = participantId.trim().toUpperCase();
  const valid = /^P0*[1-9][0-9]*$/.test(normalized);

  useEffect(() => {
    if (!valid) {
      onParticipantRecord(null);
      return;
    }
    let active = true;
    const timeout = window.setTimeout(
      () =>
        void loadParticipantRecord(normalized)
          .then((record) => {
            if (active) onParticipantRecord(record);
          })
          .catch((reason) => {
            if (active)
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
          }),
      250,
    );
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [normalized, valid, onParticipantRecord]);

  useEffect(() => {
    void api
      .sessions()
      .then((items) => {
        const completed = items.filter((item) => item.completed_at);
        setSessions(completed);
        setSelected(completed[0]?.session_id ?? '');
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);
  const participantSessions = useMemo(
    () => sessions.filter((item) => item.participant_id === normalized),
    [sessions, normalized],
  );
  useEffect(() => {
    if (!participantSessions.some((item) => item.session_id === selected))
      setSelected(participantSessions[0]?.session_id ?? '');
  }, [normalized, sessions, selected, participantSessions]);

  const startRealTime = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const details = await api.session(selected);
      if (!details.profile || details.profile_compatible === false)
        throw new Error(
          details.profile_error ||
            'This session has no compatible calibration profile.',
        );
      if (!(await confirmCondition('adaptive'))) return;
      await onRealTime(
        details.profile,
        eegSource === 'prerecorded' ? (replayFile ?? undefined) : undefined,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const startNonAdaptive = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const details = await api.session(selected);
      if (!details.profile || details.profile_compatible === false)
        throw new Error(
          details.profile_error || 'A compatible baseline profile is required.',
        );
      if (!(await confirmCondition('non-adaptive'))) return;
      await onNonAdaptive(
        details.profile,
        eegSource === 'prerecorded' ? (replayFile ?? undefined) : undefined,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const completed = recordingStore.completed();
  const participantRecord =
    studyRecord?.participantId === normalized ? studyRecord : null;
  const nextCondition = participantRecord?.conditionOrder.find(
    (condition, index) =>
      !participantRecord.sessions.some(
        (item) =>
          item.sessionNumber === index + 1 &&
          item.sessionDataFinalized &&
          item.attemptStatus === 'accepted',
      ),
  );
  const hasStarted = Boolean(participantRecord?.sessions.length);
  const completedCondition = (condition: 'adaptive' | 'non-adaptive') =>
    participantRecord?.sessions.some(
      (item) =>
        item.condition === condition &&
        item.sessionDataFinalized &&
        item.attemptStatus !== 'failed' &&
        item.attemptStatus !== 'excluded',
    ) ?? false;
  const confirmCondition = async (condition: 'adaptive' | 'non-adaptive') => {
    if (!participantRecord || !nextCondition || nextCondition === condition)
      return true;
    const proceed = window.confirm(
      `This participant is assigned to ${participantRecord.actualOrder}. ${condition === 'adaptive' ? 'Adaptive' : 'Non-Adaptive'} is not the next scheduled condition. Continue anyway?`,
    );
    if (!proceed) return false;
    const updated = await saveParticipantRecord({
      ...participantRecord,
      orderDeviations: [
        ...(participantRecord.orderDeviations ?? []),
        {
          attemptedCondition: condition,
          recordedAtIso: new Date().toISOString(),
          reason: 'operator_confirmation',
        },
      ],
    });
    onParticipantRecord(updated);
    return true;
  };
  const changeOrder = async (actualOrder: 'AB' | 'BA') => {
    if (!participantRecord || hasStarted) return;
    setBusy(true);
    try {
      const updated = await saveParticipantRecord(
        withStudyOrder(participantRecord, actualOrder),
      );
      onParticipantRecord(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flow-page home-page">
      <p className="flow-brand">NeuroScape</p>
      <h1>Study Home</h1>
      <label className="home-participant">
        Participant ID
        <input
          aria-label="Participant ID"
          value={participantId}
          onChange={(event) => setParticipantId(event.target.value)}
        />
      </label>
      {!valid && (
        <small>Use P followed by a positive integer, for example P001.</small>
      )}
      {participantRecord && (
        <section className="glass-panel study-order-panel">
          <div>
            <span>Study Order</span>
            <strong>
              Recommended for {normalized}: {participantRecord.recommendedOrder}
            </strong>
          </div>
          <select
            aria-label="Study order"
            value={participantRecord.actualOrder}
            disabled={busy || hasStarted}
            onChange={(event) =>
              void changeOrder(event.target.value as 'AB' | 'BA')
            }
          >
            <option value="AB">A/B — Non-Adaptive → Adaptive</option>
            <option value="BA">B/A — Adaptive → Non-Adaptive</option>
          </select>
          {participantRecord.assignmentSource === 'manual_override' && (
            <small>
              Manual override: this differs from the default assignment for{' '}
              {normalized}.
            </small>
          )}
          {hasStarted && <small>Order is locked after Session 1 starts.</small>}
          <p>
            <span>Next required condition</span>
            <strong>
              {nextCondition
                ? nextCondition === 'adaptive'
                  ? 'Adaptive'
                  : 'Non-Adaptive'
                : participantRecord.finalComparison
                  ? 'Participant Report'
                  : 'Final Comparison'}
            </strong>
          </p>
        </section>
      )}
      {error && (
        <p role="alert" className="summary-error">
          {error}
        </p>
      )}
      {studyRecord?.participantId === normalized && (
        <section className="glass-panel study-progress">
          <h2>Study Progress</h2>
          <p>
            <span>Calibration</span>
            <strong>
              {studyRecord.calibrationQuestionnaire
                ? 'Complete'
                : 'Not complete'}
            </strong>
          </p>
          {studyRecord.conditionOrder.map((condition, index) => {
            const session = studyRecord.sessions.find(
              (item) =>
                item.sessionNumber === index + 1 &&
                item.attemptStatus === 'accepted',
            );
            return (
              <p key={condition}>
                <span>
                  Session {index + 1} ·{' '}
                  {condition === 'adaptive' ? 'Adaptive' : 'Non-Adaptive'}
                </span>
                <strong>
                  {session?.sessionDataFinalized
                    ? 'Complete'
                    : session?.pre
                      ? 'In progress'
                      : 'Not started'}
                </strong>
              </p>
            );
          })}
          <p>
            <span>Final comparison</span>
            <strong>{studyRecord.finalComparison ? 'Complete' : '—'}</strong>
          </p>
          {studyRecord.finalComparison && (
            <button onClick={onDashboard}>Open Participant Dashboard</button>
          )}
        </section>
      )}
      <section className="glass-panel eeg-source-panel">
        <h2>EEG Source</h2>
        <label>
          <input
            type="radio"
            checked={eegSource === 'realtime'}
            onChange={() => setEegSource('realtime')}
          />{' '}
          Real-time EEG
        </label>
        <label>
          <input
            type="radio"
            checked={eegSource === 'prerecorded'}
            onChange={() => setEegSource('prerecorded')}
          />{' '}
          Pre-recorded EEG
        </label>
        {eegSource === 'prerecorded' && (
          <>
            <input
              aria-label="Raw EEG CSV"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) =>
                setReplayFile(event.target.files?.[0] ?? null)
              }
            />
            <small>
              Expected: NeuroScape raw_eeg.csv at 256 Hz with sample_index,
              monotonic_timestamp, TP9, AF7, AF8, and TP10; approximately 10
              minutes (9–10 accepted). Replay runs in realtime while preserving
              original session timestamps.
            </small>
          </>
        )}
      </section>
      <section className="home-entry-grid">
        <article className="glass-panel">
          <span>01</span>
          <h2>Calibration</h2>
          <p>Create and save an EEG calibration profile.</p>
          <button
            disabled={!valid}
            onClick={() =>
              onCalibration({ participantId: normalized, durationMinutes: 10 })
            }
          >
            Enter Calibration
          </button>
        </article>
        <article className="glass-panel">
          <span>02</span>
          <h2>10 min Real-Time Adaptive Meditation</h2>
          <p>Uses live EEG and the selected saved calibration profile.</p>
          <select
            aria-label="Calibration profile"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {!participantSessions.length && (
              <option value="">No completed profiles found</option>
            )}
            {participantSessions.map((item) => (
              <option key={item.session_id} value={item.session_id}>
                {item.participant_id} · {item.session_id}
              </option>
            ))}
          </select>
          <button
            disabled={
              !selected ||
              busy ||
              (Boolean(participantRecord) &&
                !participantRecord?.calibrationQuestionnaire) ||
              (eegSource === 'prerecorded' && !replayFile)
            }
            onClick={() => void startRealTime()}
          >
            {busy
              ? 'Starting…'
              : completedCondition('adaptive')
                ? 'Run Adaptive Meditation Again'
                : 'Start Adaptive Meditation'}
          </button>
        </article>
        <article className="glass-panel">
          <span>03</span>
          <h2>10 min Non-Adaptive Meditation</h2>
          <p>
            Uses the shared opening voice and continuous forest ambience; EEG is
            logged but never changes playback.
          </p>
          <button
            disabled={
              !valid ||
              !selected ||
              busy ||
              (Boolean(participantRecord) &&
                !participantRecord?.calibrationQuestionnaire) ||
              (eegSource === 'prerecorded' && !replayFile)
            }
            onClick={() => void startNonAdaptive()}
          >
            {completedCondition('non-adaptive')
              ? 'Run Non-Adaptive Meditation Again'
              : 'Start Non-Adaptive Meditation'}
          </button>
        </article>
      </section>
      {completed.adaptive && completed.nonAdaptive && (
        <section className="summary-panel home-comparison">
          <h2>Completed Session EEG Comparison</h2>
          <EegTimelinePlot
            recording={completed.adaptive}
            title="Adaptive"
            compact
          />
          <EegTimelinePlot
            recording={completed.nonAdaptive}
            title="Non-Adaptive"
            compact
          />
        </section>
      )}
    </main>
  );
}
