import {
  AdaptivePlannerEngine,
  MockDecisionProvider,
  MockPlanningProvider,
  OpenAIDecisionProvider,
  OpenAIPlanningProvider,
  createMockTbrReplay,
  createForestBasePlan,
  assignSharedBasePlan,
  materializeBasePlan,
  mockCalibrationProfile,
  phase1Config,
  type AdaptiveCheckpointResult,
  type AttentionState,
  type CalibrationProfile,
  type TbrEpoch,
  type AdaptationTerminalOutcome,
} from '@neuroscape/adaptive-planner';
import {
  NEUROSCAPE_PROTOCOL_VERSION,
  type AdaptiveTraceRecord,
  type NeuroState,
  type ServerMessage,
  type AudioPlaybackEvidence,
} from '@neuroscape/contracts';
import { audioEngine } from '../audio/AudioEngine.js';
import {
  ActionController,
  AmbientController,
  EventController,
  JourneyController,
  PlanValidator,
  RuntimeController,
  RuntimeEventBus,
  RuntimeWorldStateBuilder,
  SceneGraph,
  SemanticLocationMapper,
  TransitionController,
} from '@neuroscape/runtime-scene-controller';
import { runtimeDiagnostics } from '../debug/index.js';
import {
  dispatchServerMessage,
  parseServerMessage,
} from '../network/protocol.js';
import { sessionRecorder } from '../recording/recordingStore.js';
import { runtimeStore, type RuntimeStore } from '../runtime/RuntimeStore.js';
import { forestSceneGraph } from './canonicalForestScenario.js';

export interface AdaptiveHarnessState {
  status: 'idle' | 'running' | 'paused' | 'ended';
  timestampMs: number;
  checkpointCount: number;
  adaptationCount: number;
  planAppliedCount: number;
  runtimeActivatedAdaptationCount: number;
  experiencedAdaptationCount: number;
  audioFailedAdaptationCount: number;
}
export type AdaptiveRunMode = 'mock-fast' | 'study-realtime';
export interface AdaptiveHarnessStartOptions {
  sessionId?: string;
  runMode?: AdaptiveRunMode;
  plannerMode?: 'openai' | 'mock';
  calibrationProfile?: CalibrationProfile;
  epochSource?: AdaptiveEpochSource;
  sessionDurationMs?: number;
  participantId?: string;
  condition?: 'adaptive' | 'non-adaptive';
}
export interface AdaptiveEpochSource {
  next(sessionTimestampMs?: number): Promise<TbrEpoch | null>;
}
export interface AdaptiveIntervalApi {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
const intervals: AdaptiveIntervalApi = {
  set: (callback, milliseconds) => setInterval(callback, milliseconds),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function attentionStateForEpoch(
  result: AdaptiveCheckpointResult | null,
  states: readonly AttentionState[],
  epochTimestampMs: number,
): AttentionState | undefined {
  if (result?.state.timestampMs === epochTimestampMs) return result.state;
  for (let index = states.length - 1; index >= 0; index -= 1) {
    const state = states[index];
    if (state?.timestampMs === epochTimestampMs) return state;
  }
  return undefined;
}

export class AdaptiveIntegrationHarness {
  readonly #store: RuntimeStore;
  readonly #intervals: AdaptiveIntervalApi;
  readonly #listeners = new Set<() => void>();
  #sessionId = 'adaptive-mock-session';
  #runMode: AdaptiveRunMode = 'mock-fast';
  #plannerMode: 'openai' | 'mock' = 'openai';
  #condition: 'adaptive' | 'non-adaptive' = 'adaptive';
  #runtime: RuntimeController | null = null;
  #planner: AdaptivePlannerEngine | null = null;
  #timer: unknown;
  #busy = false;
  #epochIndex = 0;
  #replay = createMockTbrReplay();
  #epochSource: AdaptiveEpochSource | null = null;
  #calibrationProfile = mockCalibrationProfile;
  #sessionDurationMs = phase1Config.sessionDurationMs;
  #state: AdaptiveHarnessState = {
    status: 'idle',
    timestampMs: 0,
    checkpointCount: 0,
    adaptationCount: 0,
    planAppliedCount: 0,
    runtimeActivatedAdaptationCount: 0,
    experiencedAdaptationCount: 0,
    audioFailedAdaptationCount: 0,
  };
  #unsubscribeEvidence: (() => void) | null = null;
  #unsubscribeAudioDiagnostics: (() => void) | null = null;
  readonly #runtimeActivatedIds = new Set<string>();
  readonly #experiencedIds = new Set<string>();
  readonly #audioFailedIds = new Set<string>();

  constructor(
    store: RuntimeStore = runtimeStore,
    intervalApi: AdaptiveIntervalApi = intervals,
  ) {
    this.#store = store;
    this.#intervals = intervalApi;
  }
  getState = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(options: AdaptiveHarnessStartOptions = {}): void {
    this.end(false);
    this.#sessionId = options.sessionId ?? 'adaptive-mock-session';
    this.#runMode = options.runMode ?? 'mock-fast';
    this.#plannerMode = options.plannerMode ?? 'openai';
    this.#condition = options.condition ?? 'adaptive';
    this.#epochSource = options.epochSource ?? null;
    this.#calibrationProfile =
      options.calibrationProfile ?? mockCalibrationProfile;
    this.#sessionDurationMs =
      options.sessionDurationMs ?? phase1Config.sessionDurationMs;
    this.#store.getState().resetSessionStreams();
    this.#runtimeActivatedIds.clear();
    this.#experiencedIds.clear();
    this.#audioFailedIds.clear();
    this.#unsubscribeEvidence = audioEngine.subscribePlaybackEvidence(
      (evidence) => this.handlePlaybackEvidence(evidence),
    );
    this.#unsubscribeAudioDiagnostics =
      audioEngine.subscribeExecutionDiagnostics((diagnostic) =>
        sessionRecorder.appendAudioExecutionDiagnostic(diagnostic),
      );
    runtimeDiagnostics.reset();
    this.#runtime = this.createRuntime();
    const assignment = assignSharedBasePlan(options.participantId ?? 'P001');
    const basePlan = createForestBasePlan(phase1Config);
    const initialPlan = materializeBasePlan(basePlan);
    this.#planner =
      this.#condition === 'adaptive'
        ? new AdaptivePlannerEngine({
            config: phase1Config,
            profile: this.#calibrationProfile,
            initialPlan,
            basePlan,
            decisionProvider:
              this.#plannerMode === 'openai'
                ? new OpenAIDecisionProvider({ sessionId: this.#sessionId })
                : new MockDecisionProvider(),
            planningProvider:
              this.#plannerMode === 'openai'
                ? new OpenAIPlanningProvider({ sessionId: this.#sessionId })
                : new MockPlanningProvider(),
          })
        : null;
    this.#runtime.initialize(initialPlan);
    this.#epochIndex = 0;
    this.#state = {
      status: 'running',
      timestampMs: 0,
      checkpointCount: 0,
      adaptationCount: 0,
      planAppliedCount: 0,
      runtimeActivatedAdaptationCount: 0,
      experiencedAdaptationCount: 0,
      audioFailedAdaptationCount: 0,
    };
    this.dispatch('PlannerStatus', 0, {
      status: 'ready',
      message:
        this.#condition === 'adaptive'
          ? `Module 01/02 ${this.#plannerMode === 'openai' ? 'OpenAI GPT-5.6' : 'mock'} providers ready · opening phase`
          : `Non-Adaptive ${basePlan.planId} ready · EEG cannot alter playback`,
    });
    this.trace(0, 'base-plan', 'deterministic', `Loaded ${basePlan.planId}`, {
      basePlanId: basePlan.planId,
      basePlanVersion: basePlan.version,
      profileId: basePlan.profile.profileId,
      assignment,
    });
    this.dispatch('SceneJourneyPlan', 0, initialPlan);
    this.dispatch('RuntimeWorldState', 0, this.#runtime.currentState!);
    this.dispatch('SessionStatus', 0, {
      status: 'running',
      elapsedTimeMs: 0,
      message:
        this.#runMode === 'mock-fast'
          ? `${this.#sessionDurationMs / 60_000}-minute adaptive mock replay · 10× accelerated`
          : this.#epochSource
            ? `${this.#sessionDurationMs / 60_000}-minute adaptive session · realtime EEG source`
            : `${this.#sessionDurationMs / 60_000}-minute adaptive study replay · realtime`,
    });
    this.startTimer();
    this.emit();
  }

  pause(): void {
    if (this.#state.status !== 'running') return;
    this.clearTimer();
    this.#state = { ...this.#state, status: 'paused' };
    this.dispatch('SessionStatus', this.#state.timestampMs, {
      status: 'paused',
      elapsedTimeMs: this.#state.timestampMs,
    });
    this.emit();
  }
  resume(): void {
    if (this.#state.status !== 'paused') return;
    this.#state = { ...this.#state, status: 'running' };
    this.dispatch('SessionStatus', this.#state.timestampMs, {
      status: 'running',
      elapsedTimeMs: this.#state.timestampMs,
    });
    this.startTimer();
    this.emit();
  }
  end(publish = true): void {
    this.clearTimer();
    this.#unsubscribeEvidence?.();
    this.#unsubscribeEvidence = null;
    this.#unsubscribeAudioDiagnostics?.();
    this.#unsubscribeAudioDiagnostics = null;
    this.#runtime?.shutdown();
    this.#runtime = null;
    this.#planner = null;
    if (publish) {
      this.dispatch('SessionStatus', this.#state.timestampMs, {
        status: 'ended',
        elapsedTimeMs: this.#state.timestampMs,
        message: 'Adaptive mock session complete; recording bundle is ready.',
      });
      this.#state = { ...this.#state, status: 'ended' };
      this.emit();
    }
  }

  async tick(deltaTimeMs = 1_000): Promise<void> {
    if (this.#busy || !this.#runtime || this.#state.status !== 'running')
      return;
    this.#busy = true;
    try {
      const nextTimestamp = Math.min(
        this.#sessionDurationMs,
        this.#state.timestampMs + deltaTimeMs,
      );
      const epochs: TbrEpoch[] = [];
      if (this.#epochSource) {
        const epoch = await this.#epochSource.next(nextTimestamp);
        if (epoch) epochs.push(epoch);
      } else {
        while (
          this.#epochIndex < this.#replay.length &&
          this.#replay[this.#epochIndex]!.timestampMs <= nextTimestamp
        )
          epochs.push(this.#replay[this.#epochIndex++]!);
      }
      for (const epoch of epochs) {
        this.trace(
          epoch.timestampMs,
          'eeg-epoch',
          this.#epochSource ? 'live-eeg' : 'deterministic',
          `${this.#epochSource ? 'Live Muse' : 'Mock'} log-TBR epoch ${epoch.valid ? 'accepted' : 'rejected'}`,
          epoch,
        );
        sessionRecorder.appendEegMetric({
          timestampMs: epoch.timestampMs,
          theta: epoch.theta ?? null,
          beta: epoch.beta ?? null,
          tbr: epoch.logTbr,
          tbrBaseline: this.#calibrationProfile.baselineLogTbr,
          valid: epoch.valid,
          qualityScore: epoch.qualityScore,
          artifactFlags: [...epoch.artifactFlags],
        });
        if (!this.#planner) continue;
        if (this.#plannerMode === 'openai')
          void this.processEpoch(epoch).catch((error) =>
            this.handleUnhandledEpochError(epoch, error),
          );
        else await this.processEpoch(epoch);
      }
      const startedAt = performance.now();
      const snapshot = this.#runtime.update(
        nextTimestamp - this.#state.timestampMs,
      );
      for (const terminal of this.#planner?.expireRuntimeApplications(
        snapshot.timestampMs,
      ) ?? [])
        this.traceTerminal(terminal);
      runtimeDiagnostics.recordModule03Update(performance.now() - startedAt);
      this.dispatch('RuntimeWorldState', snapshot.timestampMs, snapshot);
      this.dispatch('SessionStatus', snapshot.timestampMs, {
        status: 'running',
        elapsedTimeMs: snapshot.timestampMs,
        message: this.#epochSource
          ? 'Adaptive realtime EEG session'
          : 'Adaptive mock replay',
      });
      this.#state = { ...this.#state, timestampMs: snapshot.timestampMs };
      this.emit();
      if (snapshot.timestampMs >= this.#sessionDurationMs) this.end();
    } finally {
      this.#busy = false;
    }
  }

  private async processEpoch(epoch: TbrEpoch): Promise<void> {
    const planner = this.#planner;
    if (!planner || this.#state.status !== 'running') return;
    let result: AdaptiveCheckpointResult | null = null;
    try {
      result = await planner.ingest(epoch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trace(
        epoch.timestampMs,
        'llm-error',
        this.#plannerMode === 'openai' ? 'openai' : 'mock-llm',
        message,
        {
          message,
          plannerMode: this.#plannerMode,
          fallback: 'continue_base_plan',
        },
      );
      this.dispatch('PlannerStatus', epoch.timestampMs, {
        status: 'error',
        message: `Planner error; Base Plan playback continues. ${message}`,
      });
    }
    if (planner !== this.#planner || this.#state.status !== 'running') return;
    // OpenAI checkpoints run without blocking the audio/runtime clock. A slow
    // older request can therefore finish after newer epochs have already been
    // interpreted. Never pair that older epoch envelope with the latest state.
    const state = attentionStateForEpoch(
      result,
      planner.attentionStates,
      epoch.timestampMs,
    );
    if (state)
      this.dispatch(
        'NeuroState',
        state.timestampMs,
        this.toProtocolNeuroState(state),
      );
    if (!result) return;
    try {
      this.handleCheckpoint(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (result.futurePatch)
        this.traceTerminal(
          planner.acknowledgeApplication(
            result.futurePatch.adaptationId,
            'FAILED',
            result.state.timestampMs,
          ),
        );
      this.trace(
        result.state.timestampMs,
        'plan-error',
        'deterministic',
        `Plan application failed: ${message}`,
        {
          message,
          planId: result.plan?.planId,
          fallback: 'continue_base_plan',
        },
      );
      this.dispatch('PlannerStatus', result.state.timestampMs, {
        status: 'error',
        message: `Plan rejected; Base Plan playback continues. ${message}`,
      });
    }
  }

  private handleUnhandledEpochError(epoch: TbrEpoch, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.trace(
      epoch.timestampMs,
      'llm-error',
      this.#plannerMode === 'openai' ? 'openai' : 'mock-llm',
      `Unhandled epoch processing error: ${message}`,
      {
        message,
        plannerMode: this.#plannerMode,
        fallback: 'continue_base_plan',
      },
    );
  }

  private handleCheckpoint(result: AdaptiveCheckpointResult): void {
    this.#state = {
      ...this.#state,
      checkpointCount: this.#state.checkpointCount + 1,
    };
    this.trace(
      result.state.timestampMs,
      'attention-state',
      'deterministic',
      `${result.state.baselineRelation}; trend ${result.state.trend}`,
      result.state,
    );
    if (result.outcome) {
      this.trace(
        result.state.timestampMs,
        'reflection-outcome',
        'deterministic',
        `${result.outcome.adaptationId}: ${result.outcome.observedResponse}`,
        result.outcome,
      );
    }
    this.trace(
      result.state.timestampMs,
      'eligibility',
      'deterministic',
      result.eligibility.eligible
        ? 'Eligible for Decision 1'
        : `Maintain: ${result.eligibility.reasons.join(', ')}`,
      result.eligibility,
    );
    if (!result.eligibility.eligible) {
      this.dispatch('PlannerStatus', result.state.timestampMs, {
        status: 'ready',
        message: `Eligibility gate: ${result.eligibility.reasons.join(', ')}. Maintain current soundscape.`,
      });
      return;
    }
    if (result.decision) {
      this.trace(
        result.state.timestampMs,
        'decision-1',
        result.decision.provider.startsWith('openai') ? 'openai' : 'mock-llm',
        result.decision.rationale,
        { ...result.decision, timing: result.timing },
      );
      this.dispatch('PlannerStatus', result.state.timestampMs, {
        status: result.decision.shouldAdapt ? 'planning' : 'ready',
        message: `Decision 1 · ${result.decision.shouldAdapt ? 'adapt' : 'maintain'}: ${result.decision.rationale}`,
      });
    }
    if (result.terminalOutcome && !result.planning)
      this.traceTerminal(result.terminalOutcome);
    if (result.planning && !result.plan) {
      this.trace(
        result.state.timestampMs,
        'decision-2',
        result.planning.provider.startsWith('openai') ? 'openai' : 'mock-llm',
        result.planning.rationale,
        {
          ...result.planning,
          timing: result.timing,
          selectionTrace: result.selectionTrace,
        },
      );
      this.traceTerminal(result.terminalOutcome);
    }
    if (result.planning && result.plan && this.#runtime) {
      const planAppliedMs =
        result.timing.patchValidationCompleteMs ?? result.state.timestampMs;
      result.timing.planAppliedMs = planAppliedMs;
      this.trace(
        result.state.timestampMs,
        'decision-2',
        result.planning.provider.startsWith('openai') ? 'openai' : 'mock-llm',
        result.planning.rationale,
        {
          ...result.planning,
          timing: result.timing,
          selectionTrace: result.selectionTrace,
        },
      );
      this.#runtime.applyPlan(result.plan, {
        // The planner's committed Base Plan intentionally remains at the
        // origin until semantic arrival. A concurrent within-scene patch must
        // therefore not let that origin journey cancel the active transition.
        preserveActiveJourney:
          result.futurePatch !== undefined &&
          result.futurePatch.journeyUpdate === undefined,
      });
      audioEngine.preloadAssets(result.planning.selectedAssetIds);
      if (result.futurePatch) {
        const terminal = this.#planner?.acknowledgeApplication(
          result.futurePatch.adaptationId,
          'PLAN_APPLIED',
          planAppliedMs,
        );
        this.traceTerminal(terminal);
        this.trace(
          planAppliedMs,
          'patch-lifecycle',
          'deterministic',
          result.futurePatch.journeyUpdate
            ? `${result.futurePatch.adaptationId} transition started`
            : `${result.futurePatch.adaptationId} applied`,
          {
            patch: result.futurePatch,
            validation: result.patchValidation,
            lifecycle: result.lifecycle,
            ...(result.futurePatch.journeyUpdate
              ? {
                  transitionState: 'TRANSITION_STARTED',
                  originNodeId: result.futurePatch.journeyUpdate.fromNodeId,
                  destinationNodeId: result.futurePatch.journeyUpdate.toNodeId,
                  arrivalTimeMs: result.futurePatch.journeyUpdate.arrivalTimeMs,
                }
              : {}),
          },
        );
      }
      this.dispatch('SceneJourneyPlan', planAppliedMs, result.plan);
      this.trace(
        planAppliedMs,
        'plan-applied',
        'deterministic',
        `Module 03 accepted ${result.plan.planId}`,
        {
          planId: result.plan.planId,
          selectedAssetIds: result.planning.selectedAssetIds,
          timing: result.timing,
          selectionTrace: result.selectionTrace,
        },
      );
      this.dispatch('PlannerStatus', result.state.timestampMs, {
        status: 'ready',
        message: `Decision 2 · ${result.planning.rationale}`,
      });
      this.#state = {
        ...this.#state,
        planAppliedCount: this.#state.planAppliedCount + 1,
      };
      if (result.futurePatch)
        this.recordPlanApplied(result.futurePatch.adaptationId, result);
    }
  }

  private recordPlanApplied(
    adaptationId: string,
    result: AdaptiveCheckpointResult,
  ): void {
    const sounds = result.plan
      ? [
          ...result.plan.soundscape.ambient.map((item) => ({
            ...item,
            layer: 'ambient' as const,
            plannedStartMs: item.startMs,
            plannedEndMs: item.endMs,
          })),
          ...result.plan.soundscape.action.map((item) => ({
            ...item,
            layer: 'action' as const,
            plannedStartMs: item.startMs,
            plannedEndMs: item.endMs,
          })),
          ...result.plan.soundscape.event.map((item) => ({
            ...item,
            layer: 'event' as const,
            plannedStartMs: item.activationTimeMs,
            plannedEndMs: item.activationTimeMs + item.durationMs,
          })),
        ].filter((item) => item.adaptationId === adaptationId)
      : [];
    sounds.forEach((sound) => {
      const operation = result.futurePatch?.operations.find(
        (item) => item.insertedElement?.elementId === sound.id,
      );
      sessionRecorder.appendAudioPlaybackEvidence({
        adaptationId,
        elementId: sound.id,
        assetId: sound.assetId,
        layer: sound.layer,
        status: 'PLAN_APPLIED',
        timestampMs: result.timing.planAppliedMs ?? result.state.timestampMs,
        plannedStartMs: sound.plannedStartMs,
        plannedEndMs: sound.plannedEndMs,
        decision2RequestStartMs: result.timing.decision2RequestStartMs,
        decision2ResponseMs: result.timing.decision2ResponseMs,
        patchValidationCompleteMs: result.timing.patchValidationCompleteMs,
        planAppliedMs: result.timing.planAppliedMs,
        eligibleCandidateCount: result.selectionTrace?.eligibleCandidateCount,
        retrievedCandidateIds: result.selectionTrace?.retrievedCandidateIds,
        recentlyUsedAssetIds: result.selectionTrace?.recentlyUsedAssetIds,
        selectedAssetIds: result.planning?.selectedAssetIds,
        selectedByDecision2:
          result.planning?.semanticOutput?.selectedAssetIds.includes(
            sound.assetId,
          ) ?? false,
        systemGenerated:
          operation?.systemGenerated === 'scene_transition_footsteps'
            ? 'scene_transition_locomotion'
            : false,
        validated: result.patchValidation?.valid ?? false,
      });
    });
  }

  private handlePlaybackEvidence(evidence: AudioPlaybackEvidence): void {
    sessionRecorder.appendAudioPlaybackEvidence(evidence);
    if (this.#condition !== 'adaptive') return;
    if (evidence.status === 'RUNTIME_ACTIVATED') {
      if (!this.#runtimeActivatedIds.has(evidence.adaptationId)) {
        this.#runtimeActivatedIds.add(evidence.adaptationId);
        this.#planner?.acknowledgeApplication(
          evidence.adaptationId,
          'RUNTIME_ACTIVATED',
          evidence.timestampMs,
        );
      }
    } else if (evidence.status === 'AUDIO_STARTED') {
      if (!this.#experiencedIds.has(evidence.adaptationId)) {
        this.#experiencedIds.add(evidence.adaptationId);
        this.#planner?.acknowledgeApplication(
          evidence.adaptationId,
          'AUDIO_STARTED',
          evidence.audioStartMs ?? evidence.timestampMs,
        );
      }
    } else if (evidence.status === 'AUDIO_FINISHED') {
      this.#planner?.acknowledgeApplication(
        evidence.adaptationId,
        'AUDIO_FINISHED',
        evidence.audioEndMs ?? evidence.timestampMs,
      );
    } else if (evidence.status === 'AUDIO_FAILED') {
      if (!this.#audioFailedIds.has(evidence.adaptationId)) {
        this.#audioFailedIds.add(evidence.adaptationId);
        this.#planner?.acknowledgeApplication(
          evidence.adaptationId,
          'AUDIO_FAILED',
          evidence.timestampMs,
        );
      }
    }
    this.#state = {
      ...this.#state,
      adaptationCount: this.#experiencedIds.size,
      runtimeActivatedAdaptationCount: this.#runtimeActivatedIds.size,
      experiencedAdaptationCount: this.#experiencedIds.size,
      audioFailedAdaptationCount: this.#audioFailedIds.size,
    };
    this.emit();
  }

  private toProtocolNeuroState(state: AttentionState): NeuroState {
    return {
      timestampMs: state.timestampMs,
      arousal: {
        // Protocol 1.0 compatibility only; baseline reasoning lives in
        // `attention` and this value must not be rendered as focus percentage.
        value: 0.5,
        trend:
          state.trend === 'increasing'
            ? 'increasing'
            : state.trend === 'decreasing'
              ? 'decreasing'
              : 'stable',
      },
      confidence: state.confidence,
      attention: {
        currentLogTbr: state.currentLogTbr,
        baselineLogTbr: state.baselineLogTbr,
        baselineMad: state.baselineMad,
        baselineScale: state.baselineScale,
        effectiveBaselineScale: state.effectiveBaselineScale,
        deltaFromBaseline: state.deltaFromBaseline,
        tbrRatioToBaseline: state.tbrRatioToBaseline,
        tbrPercentChange: state.tbrPercentChange,
        robustDeltaFromBaseline: state.robustDeltaFromBaseline,
        baselineRelation: state.baselineRelation,
        trajectory: state.trajectory,
        robustDeltaSlope: state.robustDeltaSlope,
        measurementConfidence: state.measurementConfidence,
        signalQuality: state.signalQuality,
        stateEstimationVersion: state.stateEstimationVersion,
        trend: state.trend,
        variabilityMad: state.variabilityMad,
        sustainedElevatedWindows: state.sustainedElevatedWindows,
        sustainedReducedWindows: state.sustainedReducedWindows,
        phase: state.phase,
        validEpochCount: state.validEpochCount,
      },
    };
  }

  private trace(
    timestampMs: number,
    kind: AdaptiveTraceRecord['kind'],
    source: AdaptiveTraceRecord['source'],
    summary: string,
    data: object,
  ): void {
    sessionRecorder.appendAdaptiveTrace({
      timestampMs,
      kind,
      source,
      summary,
      data: structuredClone(data) as Record<string, unknown>,
    });
  }
  private traceTerminal(outcome?: AdaptationTerminalOutcome): void {
    if (!outcome) return;
    this.trace(
      outcome.checkpointTimestampMs,
      'adaptation-terminal',
      'deterministic',
      `${outcome.adaptationId}: ${outcome.terminalStatus}`,
      outcome,
    );
  }
  private createRuntime(): RuntimeController {
    const graph = new SceneGraph(forestSceneGraph),
      mapper = new SemanticLocationMapper(graph),
      events = new RuntimeEventBus(),
      transitions = new TransitionController(events);
    events.subscribe((event) => {
      if (event.type !== 'SemanticLocationChanged') return;
      const terminal = this.#planner?.acknowledgeJourneyArrival(
        event.locationId,
        event.timestampMs,
      );
      this.traceTerminal(terminal);
      this.trace(
        event.timestampMs,
        'patch-lifecycle',
        'deterministic',
        `Runtime arrived at ${event.locationId}`,
        {
          transitionState: 'COMMITTED',
          transitionStateHistory: [
            'PLANNED',
            'TRANSITION_STARTED',
            'ARRIVED',
            'COMMITTED',
          ],
          originNodeId: event.previousLocationId,
          destinationNodeId: event.locationId,
          arrivalTimeMs: event.timestampMs,
          runtimeSemanticLocation: event.locationId,
        },
      );
    });
    return new RuntimeController({
      validator: new PlanValidator(graph),
      stateBuilder: new RuntimeWorldStateBuilder(),
      journey: new JourneyController(mapper, events),
      ambient: new AmbientController(mapper, transitions),
      action: new ActionController(transitions),
      event: new EventController(mapper, transitions, events),
      transitions,
      events,
    });
  }
  private dispatch(
    type: ServerMessage['type'],
    timestampMs: number,
    payload: unknown,
  ): void {
    const parsed = parseServerMessage(
      {
        type,
        protocolVersion: NEUROSCAPE_PROTOCOL_VERSION,
        sessionId: this.#sessionId,
        timestampMs,
        payload,
      },
      this.#sessionId,
    );
    if (!parsed.valid)
      throw new Error(`Adaptive protocol failure: ${parsed.error}`);
    dispatchServerMessage(parsed.message, this.#store, performance.now());
  }
  private startTimer(): void {
    this.#timer = this.#intervals.set(
      () => void this.tick(),
      this.#runMode === 'mock-fast' ? 100 : 1_000,
    );
  }
  private clearTimer(): void {
    if (this.#timer !== undefined) this.#intervals.clear(this.#timer);
    this.#timer = undefined;
  }
  private emit(): void {
    this.#listeners.forEach((listener) => listener());
  }
}

export const adaptiveIntegrationHarness = new AdaptiveIntegrationHarness();
