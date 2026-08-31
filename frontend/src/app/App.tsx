import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { liveRuntimeClient } from '../network/liveRuntime.js';
import { runtimeStore } from '../runtime/RuntimeStore.js';
import {
  HomePage,
  type AdaptiveSessionIntent,
  type CalibrationSessionIntent,
  type SessionIntent,
} from '../ui/pages/HomePage.js';
import { LoadingPage } from '../ui/pages/LoadingPage.js';
import { PreviewPage } from '../ui/pages/PreviewPage.js';
import { SessionPage } from '../ui/pages/SessionPage.js';
import { SummaryPage } from '../ui/pages/SummaryPage.js';
import {
  recordingStore,
  sessionRecorder,
} from '../recording/recordingStore.js';
import {
  integrationHarness,
  longIntegrationHarness,
  spatialDiagnosticHarness,
} from '../integration/IntegrationHarness.js';
import { adaptiveIntegrationHarness } from '../integration/AdaptiveIntegrationHarness.js';
import { audioEngine } from '../audio/AudioEngine.js';
import {
  createStudyArtifactBundle,
  uploadBundleToBackend,
} from '../study/StudyArtifacts.js';
import { studyArtifactStore } from '../study/studyArtifactStore.js';
import { liveSessionId } from '../network/liveRuntime.js';
import { CalibrationPage } from '../calibration/CalibrationPage.js';
import {
  LiveEegEpochSource,
  ReplayEegEpochSource,
  type RawEegRecordingSource,
  toPlannerCalibrationProfile,
} from '../calibration/integration.js';
import type { Profile } from '../calibration/types.js';
import {
  assignSharedBasePlan,
  BASE_PLAN_VERSION,
} from '@neuroscape/adaptive-planner';
import { QuestionnairePage } from '../questionnaire/QuestionnairePage.js';
import {
  createParticipantRecord,
  finalizeSession,
  loadParticipantRecord,
  saveParticipantRecord,
  saveQuickTestSessionArtifacts,
  uploadQuestionnaireArtifact,
} from '../questionnaire/questionnairePersistence.js';
import type {
  ParticipantStudyRecord,
  QuestionnaireStage,
  QuestionnaireSubmission,
  StudyCondition,
} from '../questionnaire/questionnaireSchema.js';
import { ParticipantComparisonPage } from '../ui/pages/ParticipantComparisonPage.js';
import {
  QuickStageSummaryPage,
  QuickStudySummaryPage,
  QuickTestStagePage,
} from '../ui/pages/QuickTestPages.js';

type Page =
  | 'home'
  | 'calibration'
  | 'questionnaire'
  | 'quick-stage'
  | 'quick-summary'
  | 'quick-study-summary'
  | 'artifact-error'
  | 'handoff'
  | 'dashboard'
  | 'loading'
  | 'preview'
  | 'session'
  | 'summary';
export function App() {
  const finalizing = useRef(false);
  const audioCaptureError = useRef<string | null>(null);
  const rawEegSource = useRef<RawEegRecordingSource | null>(null);
  const returnHomeAfterFinalize = useRef(false);
  const [page, setPage] = useState<Page>('home');
  const [studyRecord, setStudyRecord] = useState<ParticipantStudyRecord | null>(
    null,
  );
  const [questionnaireStage, setQuestionnaireStage] =
    useState<QuestionnaireStage>('calibration_post');
  const [artifactError, setArtifactError] = useState('');
  const [quickTestMode, setQuickTestMode] = useState(false);
  const [quickStageKind, setQuickStageKind] = useState<
    'calibration' | 'session'
  >('calibration');
  const [quickSummary, setQuickSummary] = useState<{
    kind: 'calibration' | 'session';
    sessionNumber?: 1 | 2;
  }>({ kind: 'calibration' });
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickError, setQuickError] = useState('');
  const pendingStart = useRef<null | (() => Promise<void>)>(null);
  const calibrationProfile = useRef<Profile | null>(null);
  const currentStudySession = useRef<null | {
    participantId: string;
    sessionId: string;
    sessionNumber: 1 | 2;
    condition: StudyCondition;
    actualOrder: 'AB' | 'BA';
  }>(null);
  const [calibrationIntent, setCalibrationIntent] =
    useState<CalibrationSessionIntent>({
      participantId: 'P001',
      durationMinutes: 10,
    });
  const [mode, setMode] = useState<
    | 'live'
    | 'adaptive'
    | 'non-adaptive'
    | 'demo'
    | 'long-demo'
    | 'diagnostic'
    | 'replay'
  >('live');
  const [realTimeRestartEnabled, setRealTimeRestartEnabled] = useState(false);
  const startAdaptiveAudio = async () => {
    try {
      await audioEngine.startRecording();
    } catch (error) {
      audioCaptureError.current =
        error instanceof Error ? error.message : String(error);
      console.error('Audio capture unavailable; session will continue.', error);
    }
    try {
      await audioEngine.playOpening();
    } catch (error) {
      console.error(
        'Meditation opening unavailable; session will continue.',
        error,
      );
    }
  };
  const sessionStatus = useStore(
    runtimeStore,
    (state) => state.sessionRuntime.status,
  );
  // Live commands connect lazily. Home, demo, and replay modes do not require a backend.
  useEffect(
    () => () => {
      liveRuntimeClient.disconnect();
      adaptiveIntegrationHarness.end(false);
      integrationHarness.end(false);
      longIntegrationHarness.end(false);
      spatialDiagnosticHarness.end(false);
    },
    [],
  );
  useEffect(() => {
    if (page === 'loading' && sessionStatus === 'preview') setPage('preview');
    if (sessionStatus === 'running') setPage('session');
    if (
      sessionStatus === 'ended' &&
      sessionRecorder.active &&
      !finalizing.current
    ) {
      finalizing.current = true;
      void (async () => {
        let audio = null;
        let rawEeg: Blob | null = null;
        const finalizationErrors: string[] = [];
        audioEngine.stopOpening();
        try {
          audio = await audioEngine.stopRecording();
        } catch (error) {
          audioCaptureError.current =
            error instanceof Error ? error.message : String(error);
          console.error(
            'Master-audio finalization failed; study data will still be saved.',
            error,
          );
        }
        try {
          rawEeg = (await rawEegSource.current?.rawCsv()) ?? null;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          finalizationErrors.push(`Raw EEG finalization failed: ${message}`);
          console.error('Raw EEG finalization failed.', error);
        }
        rawEegSource.current = null;
        const recording = recordingStore.stop();
        if (recording?.metadata.participantId) {
          const bundle = createStudyArtifactBundle(
            recording,
            audio,
            [
              ...(audioCaptureError.current ? [audioCaptureError.current] : []),
              ...finalizationErrors,
            ],
            rawEeg,
          );
          studyArtifactStore.setBundle(bundle);
          studyArtifactStore.setBackend({ status: 'saving' });
          try {
            await uploadBundleToBackend(bundle);
            studyArtifactStore.setBackend({
              status: 'saved',
              directory: bundle.folderName,
            });
            setQuestionnaireStage('session_post');
            setPage('questionnaire');
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            studyArtifactStore.setBackend({
              status: 'failed',
              error: message,
            });
            setArtifactError(message);
            setPage('artifact-error');
          }
        } else setPage(returnHomeAfterFinalize.current ? 'home' : 'summary');
        returnHomeAfterFinalize.current = false;
        finalizing.current = false;
      })();
    }
  }, [page, sessionStatus]);
  const start = (intent: SessionIntent) => {
    setRealTimeRestartEnabled(false);
    setMode('live');
    recordingStore.start({
      sessionId: liveSessionId,
      userPrompt: intent.worldDescription,
      eegMode: intent.eegSource,
      startedAtIso: new Date().toISOString(),
    });
    liveRuntimeClient.sendCommand({ command: 'startSession', ...intent });
    setPage('loading');
  };
  const startDemo = () => {
    setRealTimeRestartEnabled(false);
    liveRuntimeClient.disconnect();
    setMode('demo');
    recordingStore.start({
      sessionId: `demo-${Date.now()}`,
      userPrompt: 'Deterministic forest integration scenario',
      eegMode: 'recorded',
      startedAtIso: new Date().toISOString(),
    });
    integrationHarness.start();
    setPage('session');
  };
  const startAdaptive = async (intent: AdaptiveSessionIntent) => {
    const assignment = assignSharedBasePlan(intent.participantId);
    setRealTimeRestartEnabled(false);
    if (intent.plannerMode === 'openai') {
      try {
        const response = await fetch('/api/llm/health');
        const health = (await response.json()) as { configured?: boolean };
        if (!response.ok || !health.configured) {
          window.alert(
            'OpenAI planner is not configured. Add OPENAI_API_KEY to the repository-root .env file and restart npm run dev, or choose Offline mock.',
          );
          return;
        }
      } catch {
        window.alert(
          'The local OpenAI planner service is unavailable. Restart npm run dev or choose Offline mock.',
        );
        return;
      }
    }
    liveRuntimeClient.disconnect();
    setMode('adaptive');
    studyArtifactStore.reset();
    audioCaptureError.current = null;
    const sessionId = `session-${new Date().toISOString().replaceAll(/\D/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
    runtimeStore.getState().resetSessionStreams();
    recordingStore.start({
      sessionId,
      participantId: intent.participantId,
      runMode: intent.runMode,
      plannerMode: intent.plannerMode,
      userPrompt: `10-minute Module 01/02 adaptive replay · ${intent.plannerMode}`,
      eegMode: 'recorded',
      startedAtIso: new Date().toISOString(),
      basePlanId: assignment.basePlanId,
      basePlanVersion: BASE_PLAN_VERSION,
      basePlanProfileId: 'forest_ambient_only_v1',
      assignmentRuleVersion: assignment.assignmentRuleVersion,
      conditionOrder: assignment.conditionOrder,
      basePlanExecutionMode: 'structured-runtime',
    });
    adaptiveIntegrationHarness.start({
      sessionId,
      runMode: intent.runMode,
      plannerMode: intent.plannerMode,
      participantId: intent.participantId,
    });
    setPage('session');
    void startAdaptiveAudio();
  };
  const startCalibratedAdaptive = async (
    profile: Profile,
    replayFile?: File,
    prescribedSessionId?: string,
  ) => {
    const assignment = assignSharedBasePlan(
      profile.participant_id,
      currentStudySession.current
        ? currentStudySession.current.actualOrder === 'BA'
        : undefined,
    );
    try {
      const response = await fetch('/api/llm/health');
      const health = (await response.json()) as { configured?: boolean };
      if (!response.ok || !health.configured)
        throw new Error(
          'OpenAI planner is not configured. Add OPENAI_API_KEY and restart npm run dev.',
        );
      const epochSource = replayFile
        ? new ReplayEegEpochSource(replayFile)
        : new LiveEegEpochSource(profile.session_id);
      await epochSource.start();
      rawEegSource.current = epochSource;
      const plannerProfile = toPlannerCalibrationProfile(profile);
      liveRuntimeClient.disconnect();
      setMode('adaptive');
      setRealTimeRestartEnabled(true);
      studyArtifactStore.reset();
      audioCaptureError.current = null;
      const sessionId =
        prescribedSessionId ??
        `session-${new Date().toISOString().replaceAll(/\D/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
      recordingStore.start({
        sessionId,
        participantId: profile.participant_id,
        runMode: 'study-realtime',
        plannerMode: 'openai',
        userPrompt: `10-minute adaptive session · ${replayFile ? 'realtime raw EEG replay' : 'live Muse EEG'} · calibration ${profile.session_id}`,
        eegMode: replayFile ? 'recorded' : 'muse',
        startedAtIso: new Date().toISOString(),
        calibrationProfile: plannerProfile,
        basePlanId: assignment.basePlanId,
        basePlanVersion: BASE_PLAN_VERSION,
        basePlanProfileId: 'forest_ambient_only_v1',
        assignmentRuleVersion: assignment.assignmentRuleVersion,
        conditionOrder: assignment.conditionOrder,
        basePlanExecutionMode: 'structured-runtime',
      });
      adaptiveIntegrationHarness.start({
        sessionId,
        runMode: 'study-realtime',
        plannerMode: 'openai',
        sessionDurationMs: 10 * 60_000,
        calibrationProfile: plannerProfile,
        epochSource,
        participantId: profile.participant_id,
      });
      setPage('session');
      void startAdaptiveAudio();
    } catch (error) {
      rawEegSource.current = null;
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };
  const startLongDemo = () => {
    setRealTimeRestartEnabled(false);
    liveRuntimeClient.disconnect();
    setMode('long-demo');
    recordingStore.start({
      sessionId: `long-demo-${Date.now()}`,
      userPrompt: 'Long forest perceptual validation scenario',
      eegMode: 'recorded',
      startedAtIso: new Date().toISOString(),
    });
    longIntegrationHarness.start();
    setPage('session');
  };
  const startSpatialDiagnostic = () => {
    setRealTimeRestartEnabled(false);
    liveRuntimeClient.disconnect();
    setMode('diagnostic');
    recordingStore.start({
      sessionId: `diagnostic-${Date.now()}`,
      userPrompt: 'Spatial event HRTF diagnostic scenario',
      eegMode: 'recorded',
      startedAtIso: new Date().toISOString(),
    });
    spatialDiagnosticHarness.start();
    setPage('session');
  };
  // Retained developer entry points while the study UI exposes only the
  // calibrated adaptive/non-adaptive flows.
  void start;
  void startDemo;
  void startAdaptive;
  void startLongDemo;
  void startSpatialDiagnostic;
  const startNonAdaptive = async (
    profile: Profile,
    replayFile?: File,
    prescribedSessionId?: string,
  ) => {
    const participantId = profile.participant_id;
    const assignment = assignSharedBasePlan(
      participantId,
      currentStudySession.current
        ? currentStudySession.current.actualOrder === 'BA'
        : undefined,
    );
    try {
      const epochSource = replayFile
        ? new ReplayEegEpochSource(replayFile)
        : new LiveEegEpochSource(profile.session_id);
      await epochSource.start();
      rawEegSource.current = epochSource;
      const plannerProfile = toPlannerCalibrationProfile(profile);
      liveRuntimeClient.disconnect();
      setMode('non-adaptive');
      setRealTimeRestartEnabled(false);
      studyArtifactStore.reset();
      audioCaptureError.current = null;
      const sessionId =
        prescribedSessionId ??
        `session-${new Date().toISOString().replaceAll(/\D/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
      recordingStore.start({
        sessionId,
        participantId,
        runMode: 'non-adaptive',
        plannerMode: 'fixed',
        eegMode: replayFile ? 'recorded' : 'muse',
        userPrompt: `Fixed non-adaptive Base Plan; ${replayFile ? 'realtime raw EEG replay' : 'Muse EEG'} is analyzed and logged but cannot affect sound`,
        startedAtIso: new Date().toISOString(),
        calibrationProfile: plannerProfile,
        basePlanId: assignment.basePlanId,
        basePlanVersion: BASE_PLAN_VERSION,
        basePlanProfileId: 'forest_ambient_only_v1',
        assignmentRuleVersion: assignment.assignmentRuleVersion,
        conditionOrder: assignment.conditionOrder,
        basePlanExecutionMode: 'structured-runtime',
      });
      adaptiveIntegrationHarness.start({
        sessionId,
        runMode: 'study-realtime',
        plannerMode: 'mock',
        participantId,
        condition: 'non-adaptive',
        calibrationProfile: plannerProfile,
        epochSource,
        sessionDurationMs: 10 * 60_000,
      });
    } catch (error) {
      rawEegSource.current = null;
      window.alert(error instanceof Error ? error.message : String(error));
      return;
    }
    setPage('session');
    void startAdaptiveAudio();
  };
  const beginStudySession = async (
    profile: Profile,
    replayFile: File | undefined,
    condition: StudyCondition,
  ) => {
    const participantId = profile.participant_id;
    const record = await loadParticipantRecord(participantId);
    if (record.studyMode === 'quick_test')
      throw new Error(
        'This participant ID contains Quick Test data. Use a different participant ID for a production session.',
      );
    const sessionNumber = (record.conditionOrder.indexOf(condition) + 1) as
      1 | 2;
    const existing = record.sessions.find(
      (item) =>
        item.sessionNumber === sessionNumber &&
        item.attemptStatus !== 'failed' &&
        item.attemptStatus !== 'excluded',
    );
    if (
      existing?.sessionDataFinalized &&
      !window.confirm(
        `Session ${sessionNumber} is already complete. Run it again using the selected calibration profile? The previous session files will be preserved, and the new run will become the accepted attempt.`,
      )
    )
      return;
    const sessionId =
      existing && !existing.sessionDataFinalized
        ? existing.sessionId
        : `session-${new Date().toISOString().replaceAll(/\D/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
    currentStudySession.current = {
      participantId,
      sessionId,
      sessionNumber,
      condition,
      actualOrder: record.actualOrder,
    };
    setStudyRecord(record);
    pendingStart.current = () =>
      condition === 'adaptive'
        ? startCalibratedAdaptive(profile, replayFile, sessionId)
        : startNonAdaptive(profile, replayFile, sessionId);
    setQuestionnaireStage('session_pre');
    setPage('questionnaire');
  };
  const quickRecord = async (participantId: string) => {
    const record = await loadParticipantRecord(participantId);
    const hasStudyData = Boolean(
      record.calibrationQuestionnaire ||
      record.sessions.length ||
      record.finalComparison,
    );
    if (hasStudyData && record.studyMode !== 'quick_test')
      throw new Error(
        'This participant ID already contains production study data. Use a different test participant ID.',
      );
    if (record.studyMode === 'quick_test') return record;
    return saveParticipantRecord({ ...record, studyMode: 'quick_test' });
  };
  const beginQuickCalibration = async (participantId: string) => {
    const record = await quickRecord(participantId);
    calibrationProfile.current = null;
    setStudyRecord(record);
    setCalibrationIntent({ participantId, durationMinutes: 10 });
    setQuickStageKind('calibration');
    setQuickError('');
    setPage('quick-stage');
  };
  const beginProductionCalibration = async (
    intent: CalibrationSessionIntent,
  ) => {
    const record = await loadParticipantRecord(intent.participantId);
    if (record.studyMode === 'quick_test')
      throw new Error(
        'This participant ID contains Quick Test data. Use a different participant ID for a production calibration.',
      );
    setCalibrationIntent(intent);
    setPage('calibration');
  };
  const beginQuickSession = async (
    participantId: string,
    condition: StudyCondition,
  ) => {
    const record = await quickRecord(participantId);
    if (!record.calibrationQuestionnaire)
      throw new Error(
        'Complete the Quick Test calibration questionnaire first.',
      );
    const sessionNumber = (record.conditionOrder.indexOf(condition) + 1) as
      1 | 2;
    const existing = record.sessions.find(
      (item) =>
        item.sessionNumber === sessionNumber &&
        item.attemptStatus === 'accepted',
    );
    if (existing?.sessionDataFinalized)
      throw new Error(`Session ${sessionNumber} is already complete.`);
    const sessionId =
      existing?.sessionId ??
      `quick-session-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    currentStudySession.current = {
      participantId,
      sessionId,
      sessionNumber,
      condition,
      actualOrder: record.actualOrder,
    };
    setStudyRecord(record);
    pendingStart.current = async () => {
      setQuickStageKind('session');
      setQuickError('');
      setPage('quick-stage');
    };
    setQuestionnaireStage('session_pre');
    setPage('questionnaire');
  };
  const completeQuickStage = async () => {
    setQuickBusy(true);
    setQuickError('');
    try {
      if (quickStageKind === 'calibration') {
        setQuestionnaireStage('calibration_post');
        setPage('questionnaire');
      } else {
        const context = currentStudySession.current!;
        await saveQuickTestSessionArtifacts(
          context.participantId,
          context.sessionId,
          context.sessionNumber,
          context.condition,
        );
        setQuestionnaireStage('session_post');
        setPage('questionnaire');
      }
    } catch (error) {
      setQuickError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuickBusy(false);
    }
  };
  const submitQuestionnaire = async (submission: QuestionnaireSubmission) => {
    const base =
      studyRecord ?? createParticipantRecord(submission.participantId);
    if (submission.stage === 'calibration_post') {
      const next = await saveParticipantRecord({
        ...base,
        calibrationSessionId: calibrationProfile.current?.session_id,
        calibrationCompleted: true,
        calibrationQuestionnaire: submission,
      });
      setStudyRecord(next);
      if (next.studyMode === 'quick_test') {
        setQuickSummary({ kind: 'calibration' });
        setPage('quick-summary');
      } else setPage('home');
      return;
    }
    if (submission.stage === 'session_pre') {
      const context = currentStudySession.current!;
      const sessions = base.sessions
        .filter((item) => item.sessionId !== context.sessionId)
        .map((item) =>
          item.sessionNumber === context.sessionNumber &&
          item.attemptStatus !== 'failed' &&
          item.attemptStatus !== 'excluded'
            ? { ...item, attemptStatus: 'excluded' as const }
            : item,
        );
      sessions.push({
        sessionNumber: context.sessionNumber,
        sessionId: context.sessionId,
        condition: context.condition,
        pre: submission,
        sessionDataFinalized: false,
        attemptStatus: 'accepted',
        ...(base.studyMode === 'quick_test'
          ? {
              quickTest: {
                eegAvailable: false as const,
                eegStreamSkipped: true as const,
                sessionDurationSkipped: true as const,
              },
            }
          : {}),
      });
      const next = await saveParticipantRecord({
        ...base,
        sessions,
        finalComparison: undefined,
      });
      setStudyRecord(next);
      await pendingStart.current?.();
      pendingStart.current = null;
      return;
    }
    if (submission.stage === 'session_post') {
      const context = currentStudySession.current!;
      const existing = base.sessions.find(
        (item) => item.sessionId === context.sessionId,
      );
      await uploadQuestionnaireArtifact(submission, existing?.pre);
      const sessions = base.sessions.map((item) =>
        item.sessionId === context.sessionId
          ? { ...item, post: submission }
          : item,
      );
      let next = await saveParticipantRecord({ ...base, sessions });
      const directory = await finalizeSession(
        context.participantId,
        context.sessionId,
      );
      next = await saveParticipantRecord({
        ...next,
        sessions: next.sessions.map((item) =>
          item.sessionId === context.sessionId
            ? { ...item, sessionDataFinalized: true }
            : item,
        ),
      });
      studyArtifactStore.setBackend({ status: 'saved', directory });
      setStudyRecord(next);
      const completed = next.sessions.filter(
        (item) =>
          item.post &&
          item.sessionDataFinalized &&
          item.attemptStatus === 'accepted',
      );
      if (next.studyMode === 'quick_test') {
        setQuickSummary({
          kind: 'session',
          sessionNumber: context.sessionNumber,
        });
        setPage('quick-summary');
      } else if (
        completed.some((item) => item.condition === 'adaptive') &&
        completed.some((item) => item.condition === 'non-adaptive')
      ) {
        setQuestionnaireStage('final_comparison');
        setPage('questionnaire');
      } else setPage('home');
      return;
    }
    const next = await saveParticipantRecord({
      ...base,
      finalComparison: submission,
    });
    setStudyRecord(next);
    setPage(
      next.studyMode === 'quick_test' ? 'quick-study-summary' : 'handoff',
    );
  };
  if (page === 'home')
    return (
      <HomePage
        studyRecord={studyRecord}
        onParticipantRecord={setStudyRecord}
        onDashboard={() =>
          setPage(
            studyRecord?.studyMode === 'quick_test'
              ? 'quick-study-summary'
              : 'dashboard',
          )
        }
        quickTestMode={quickTestMode}
        onQuickTestModeChange={setQuickTestMode}
        onQuickSession={(participantId, condition) =>
          beginQuickSession(participantId, condition)
        }
        onRealTime={(profile, replayFile) =>
          beginStudySession(profile, replayFile, 'adaptive')
        }
        onNonAdaptive={(profile, replayFile) =>
          beginStudySession(profile, replayFile, 'non-adaptive')
        }
        onCalibration={(intent) => {
          if (quickTestMode)
            void beginQuickCalibration(intent.participantId).catch((error) =>
              window.alert(
                error instanceof Error ? error.message : String(error),
              ),
            );
          else
            void beginProductionCalibration(intent).catch((error) =>
              window.alert(
                error instanceof Error ? error.message : String(error),
              ),
            );
        }}
      />
    );
  if (page === 'quick-stage') {
    const context = currentStudySession.current;
    return (
      <QuickTestStagePage
        kind={quickStageKind}
        sessionNumber={context?.sessionNumber}
        condition={context?.condition}
        busy={quickBusy}
        error={quickError}
        onComplete={completeQuickStage}
      />
    );
  }
  if (page === 'quick-summary' && studyRecord) {
    return (
      <QuickStageSummaryPage
        record={studyRecord}
        kind={quickSummary.kind}
        sessionNumber={quickSummary.sessionNumber}
        onHome={() => setPage('home')}
        onContinue={() => {
          if (quickSummary.kind === 'calibration') {
            setPage('home');
            return;
          }
          const complete = studyRecord.sessions.filter(
            (item) =>
              item.post &&
              item.sessionDataFinalized &&
              item.attemptStatus === 'accepted',
          );
          if (
            complete.some((item) => item.condition === 'adaptive') &&
            complete.some((item) => item.condition === 'non-adaptive')
          ) {
            setQuestionnaireStage('final_comparison');
            setPage('questionnaire');
          } else setPage('home');
        }}
      />
    );
  }
  if (page === 'quick-study-summary' && studyRecord)
    return (
      <QuickStudySummaryPage
        record={studyRecord}
        onHome={() => setPage('home')}
        onDashboard={() => setPage('dashboard')}
      />
    );
  if (page === 'calibration')
    return (
      <CalibrationPage
        initialParticipantId={calibrationIntent.participantId}
        onContinue={async (profile) => {
          calibrationProfile.current = profile;
          const record = await loadParticipantRecord(profile.participant_id);
          setStudyRecord(record);
          setQuestionnaireStage('calibration_post');
          setPage('questionnaire');
        }}
        onHome={() => setPage('home')}
      />
    );
  if (page === 'questionnaire') {
    const context = currentStudySession.current;
    const participantId =
      questionnaireStage === 'calibration_post'
        ? (calibrationProfile.current?.participant_id ??
          calibrationIntent.participantId)
        : (studyRecord?.participantId ??
          context?.participantId ??
          calibrationIntent.participantId);
    const sessionStage =
      questionnaireStage === 'session_pre' ||
      questionnaireStage === 'session_post';
    return (
      <QuestionnairePage
        stage={questionnaireStage}
        participantId={participantId}
        sessionId={sessionStage ? context?.sessionId : undefined}
        sessionNumber={sessionStage ? context?.sessionNumber : undefined}
        condition={sessionStage ? context?.condition : undefined}
        onSubmit={submitQuestionnaire}
      />
    );
  }
  if (page === 'artifact-error')
    return (
      <main className="flow-page">
        <section className="glass-panel">
          <h1>Session data needs attention</h1>
          <p>
            The meditation has ended safely, but its recording could not be
            saved. Do not restart the meditation. Ask the researcher to retry.
          </p>
          {artifactError && (
            <p role="alert" className="summary-error">
              {artifactError}
            </p>
          )}
          <button
            onClick={() =>
              void (async () => {
                const bundle = studyArtifactStore.getState().bundle;
                if (!bundle) return;
                setArtifactError('');
                try {
                  await uploadBundleToBackend(bundle);
                  studyArtifactStore.setBackend({
                    status: 'saved',
                    directory: bundle.folderName,
                  });
                  setQuestionnaireStage('session_post');
                  setPage('questionnaire');
                } catch (error) {
                  setArtifactError(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              })()
            }
          >
            Retry saving session data
          </button>
        </section>
      </main>
    );
  if (page === 'handoff')
    return (
      <main className="flow-page">
        <section className="glass-panel">
          <p className="flow-brand">NeuroScape</p>
          <h1>Questionnaires complete</h1>
          <p>Please return the device to the researcher.</p>
          <button onClick={() => setPage('dashboard')}>
            Researcher: Open Participant Dashboard
          </button>
        </section>
      </main>
    );
  if (page === 'dashboard' && studyRecord)
    return (
      <ParticipantComparisonPage
        record={studyRecord}
        onHome={() => setPage('home')}
      />
    );
  if (page === 'loading') return <LoadingPage />;
  if (page === 'preview')
    return (
      <PreviewPage
        onEnter={() => {
          liveRuntimeClient.sendCommand({ command: 'resumeSession' });
          setPage('session');
        }}
      />
    );
  if (page === 'summary')
    return (
      <SummaryPage
        onHome={() => setPage('home')}
        onReplay={() => {
          setMode('replay');
          setPage('session');
        }}
      />
    );
  const restartCalibratedAdaptive = async (profile: Profile) => {
    adaptiveIntegrationHarness.end(false);
    recordingStore.stop();
    try {
      await audioEngine.stopRecording();
    } catch {
      // A missing/unsupported recording must not prevent a test restart.
    }
    await startCalibratedAdaptive(profile);
  };
  const returnFromSession = () => {
    if (sessionStatus === 'ended' || !sessionRecorder.active) setPage('home');
    else {
      returnHomeAfterFinalize.current = true;
      if (mode === 'adaptive' || mode === 'non-adaptive')
        adaptiveIntegrationHarness.end();
      else runtimeStore.getState().setSessionRuntime({ status: 'ended' });
    }
  };
  return (
    <SessionPage
      mode={mode}
      onHome={returnFromSession}
      onRestartRealTime={
        realTimeRestartEnabled ? restartCalibratedAdaptive : undefined
      }
    />
  );
}
