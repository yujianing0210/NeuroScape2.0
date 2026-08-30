import type { SceneJourneyPlan } from '@neuroscape/contracts';
import type { AdaptivePlannerConfig } from './config.js';
import {
  prepareDecision2Input,
  validateDecision2Selection,
} from './audio-retrieval.js';
import { evaluateEligibility, restrictionsFor } from './gate.js';
import { AttentionInterpreter } from './interpreter.js';
import { mergePlanPatch } from './plan-merge.js';
import { materializeBasePlan, type BaseScenePlan } from './base-plan.js';
import {
  normalizeLegacyPlanPatch,
  validateAndProjectPatch,
  type FutureScenePatch,
} from './patching.js';
import { materializeSemanticDecision2 } from './semantic-materializer.js';
import {
  evaluateAdaptationOutcome,
  SessionAdaptationMemory,
  transitionLifecycle,
  type AdaptationLifecycle,
  type AdaptationOutcome,
} from './reflection.js';
import type {
  AdaptationHistoryItem,
  AdaptationTerminalOutcome,
  AdaptiveCheckpointResult,
  AttentionState,
  CalibrationProfile,
  DecisionProvider,
  PlanningProvider,
  TbrEpoch,
} from './types.js';

export class AdaptivePlannerEngine {
  readonly #config: AdaptivePlannerConfig;
  readonly #profile: CalibrationProfile;
  readonly #interpreter: AttentionInterpreter;
  readonly #decisionProvider: DecisionProvider;
  readonly #planningProvider: PlanningProvider;
  readonly #checkpointStates: AttentionState[] = [];
  readonly #history: AdaptationHistoryItem[] = [];
  #currentPlan: SceneJourneyPlan;
  #transitionUntilMs = 0;
  #basePlan?: BaseScenePlan;
  readonly #acceptedPatches: FutureScenePatch[] = [];
  readonly #pendingApplications = new Map<
    string,
    {
      basePlan: BaseScenePlan;
      plan: SceneJourneyPlan;
      patch: FutureScenePatch;
      historyItem: AdaptationHistoryItem;
      transitionUntilMs: number;
      lastSpatialProgressionMs: number;
      terminalBase: Omit<
        AdaptationTerminalOutcome,
        | 'terminalStatus'
        | 'failureStage'
        | 'reasonCodes'
        | 'validationViolations'
      >;
      previousBasePlan?: BaseScenePlan;
      previousPlan?: SceneJourneyPlan;
      previousTransitionUntilMs?: number;
      previousLastSpatialProgressionMs?: number;
      previousAcceptedPatches?: FutureScenePatch[];
      previousHistory?: AdaptationHistoryItem[];
    }
  >();
  readonly #lifecycles = new Map<string, AdaptationLifecycle>();
  readonly #memory = new SessionAdaptationMemory();
  #requestSequence = 0;
  #plannerRequestInFlight = false;
  #lastSpatialProgressionMs: number;
  #nextCheckpointMs: number;

  constructor(options: {
    config: AdaptivePlannerConfig;
    profile: CalibrationProfile;
    initialPlan: SceneJourneyPlan;
    decisionProvider: DecisionProvider;
    planningProvider: PlanningProvider;
    basePlan?: BaseScenePlan;
  }) {
    this.#config = options.config;
    this.#profile = options.profile;
    this.#basePlan = options.basePlan
      ? structuredClone(options.basePlan)
      : undefined;
    this.#currentPlan = this.#basePlan
      ? materializeBasePlan(this.#basePlan)
      : structuredClone(options.initialPlan);
    this.#decisionProvider = options.decisionProvider;
    this.#planningProvider = options.planningProvider;
    this.#interpreter = new AttentionInterpreter(
      options.profile,
      options.config,
    );
    this.#nextCheckpointMs = this.#config.openingDurationMs;
    this.#lastSpatialProgressionMs = this.#config.openingDurationMs;
  }

  async ingest(epoch: TbrEpoch): Promise<AdaptiveCheckpointResult | null> {
    const rawState = this.#interpreter.ingest(epoch);
    if (!this.isCheckpoint(epoch.timestampMs)) return null;
    const state = this.withCheckpointTrend(rawState);
    this.#checkpointStates.push(state);
    const outcome = this.evaluatePendingOutcome(state);
    const lastMeaningfulChange =
      this.#history.at(-1)?.timestampMs ?? this.#config.openingDurationMs;
    const secondsSinceLastMeaningfulChange = Math.max(
      0,
      (state.timestampMs - lastMeaningfulChange) / 1_000,
    );
    const stasisPressure =
      state.timestampMs - lastMeaningfulChange >=
      this.#config.maxMeaningfulStasisMs;
    const secondsSinceLastSpatialProgression = Math.max(
      0,
      (state.timestampMs - this.#lastSpatialProgressionMs) / 1_000,
    );
    const spatialElapsedMs = state.timestampMs - this.#lastSpatialProgressionMs;
    const progressionPressure =
      spatialElapsedMs >= this.#config.progressionPressureHighMs
        ? ('high' as const)
        : spatialElapsedMs >= this.#config.progressionPressureMediumMs
          ? ('medium' as const)
          : ('low' as const);
    const pendingSceneTransition = this.hasPendingSceneTransition();
    const restrictions = restrictionsFor(state, this.#history, this.#config);
    if (pendingSceneTransition) restrictions.allowSceneTransition = false;
    const eligibility = {
      ...evaluateEligibility(
        state,
        this.#profile,
        this.#history,
        this.#config,
        this.#transitionUntilMs,
        stasisPressure,
      ),
      secondsSinceLastMeaningfulChange,
      stasisPressure,
      secondsSinceLastSpatialProgression,
      progressionPressure,
      transitionInProgress: state.timestampMs < this.#transitionUntilMs,
      ...(this.#basePlan
        ? {
            basePlan: structuredClone(this.#basePlan),
            upcomingBaseHorizon: structuredClone(
              this.#basePlan.scheduledElements.filter(
                (element) =>
                  element.startMs >=
                    state.timestampMs + this.#config.executionFreezeBufferMs &&
                  element.startMs <=
                    state.timestampMs +
                      this.#config.executionFreezeBufferMs +
                      this.#config.patchHorizonMs,
              ),
            ),
            relevantPriorOutcomes: this.#memory.retrieve({
              trajectory: state.trajectory,
              scenePhase: state.phase,
            }),
          }
        : {}),
    };
    const result: AdaptiveCheckpointResult = {
      state,
      eligibility,
      timing: {},
      ...(outcome ? { outcome } : {}),
    };
    if (!eligibility.eligible) return result;
    if (this.#plannerRequestInFlight) {
      result.eligibility = {
        ...result.eligibility,
        eligible: false,
        reasons: ['planner_request_in_progress'],
      };
      return result;
    }
    const adaptiveProgress = Math.max(
      0,
      Math.min(
        1,
        (state.timestampMs - this.#config.openingDurationMs) /
          (this.#config.sessionDurationMs - this.#config.openingDurationMs),
      ),
    );
    const expectedByNow = Math.floor(
      adaptiveProgress * this.#config.targetAdaptationsMin,
    );
    const context = {
      state,
      profile: structuredClone(this.#profile),
      recentStates: structuredClone(this.#checkpointStates.slice(-6)),
      currentPlan: structuredClone(this.#currentPlan),
      history: structuredClone(this.#history),
      restrictions,
      secondsSinceLastMeaningfulChange,
      stasisPressure,
      secondsSinceLastSpatialProgression,
      lastSpatialProgressionMs: this.#lastSpatialProgressionMs,
      committedSceneTransitionCount: this.#history.filter(
        (item) => item.scope === 'scene-transition',
      ).length,
      progressionPressure,
      transitionInProgress:
        pendingSceneTransition || state.timestampMs < this.#transitionUntilMs,
      adaptationProgress: {
        applied: this.#history.length,
        targetMin: this.#config.targetAdaptationsMin,
        targetMax: this.#config.targetAdaptationsMax,
        expectedByNow,
        behindPace: this.#history.length < expectedByNow,
      },
    };
    this.#plannerRequestInFlight = true;
    try {
      const requestId = ++this.#requestSequence;
      result.timing.decision1RequestStartMs = state.timestampMs;
      const decision = await this.#decisionProvider.decide(context);
      result.timing.decision1ResponseMs =
        state.timestampMs + Math.ceil(decision.latencyMs ?? 0);
      if (requestId !== this.#requestSequence) {
        result.eligibility.reasons.push('stale_decision_1_response');
        return result;
      }
      result.decision = decision;
      if (!decision.shouldAdapt) return result;
      if (
        decision.scope === 'scene-transition' &&
        this.hasPendingSceneTransition()
      ) {
        result.eligibility.reasons.push('scene_transition_pending');
        return result;
      }
      const adaptationId = `adapt-${state.timestampMs}`;
      const terminal = (
        terminalStatus: AdaptationTerminalOutcome['terminalStatus'],
        failureStage: AdaptationTerminalOutcome['failureStage'],
        reasonCodes: string[],
        selectedAssetIds: string[] = [],
        validationViolations: string[] = [],
        destinationNodeId?: string | null,
      ): AdaptationTerminalOutcome => ({
        checkpointTimestampMs: state.timestampMs,
        adaptationId,
        decision1Intent: decision.intent,
        decision1Scope: decision.scope,
        adaptationBasis: decision.adaptationBasis ?? 'eeg_informed',
        terminalStatus,
        failureStage,
        reasonCodes,
        validationViolations,
        ...(destinationNodeId ? { destinationNodeId } : {}),
        selectedAssetIds,
      });
      result.timing.decision2RequestStartMs = result.timing.decision1ResponseMs;
      const decision2Input = prepareDecision2Input(
        context,
        decision,
        this.#config,
      );
      result.selectionTrace = {
        fullLibrarySize: decision2Input.fullLibrarySize,
        eligibleCandidateCount: decision2Input.eligibleCandidateCount,
        retrievedCandidateIds: [...decision2Input.retrievedCandidateIds],
        recentlyUsedAssetIds: decision2Input.recentlyUsedAssets.map(
          (item) => item.assetId,
        ),
        retrievalAudit: structuredClone(decision2Input.retrievalAudit),
        currentNodeId: decision2Input.currentNodeId,
        reachableNodeIds: decision2Input.reachableNodeIds,
        unavailableDestinationNodeIds:
          decision2Input.unavailableDestinationNodeIds,
        progressionPressure,
        hardEligibleCandidateIds: decision2Input.hardEligibleCandidateIds,
        excludedCandidates: decision2Input.excludedCandidates,
      };
      let planning;
      try {
        planning = await this.#planningProvider.plan(
          context,
          decision,
          decision2Input,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.terminalOutcome = terminal('D2_SCHEMA_REJECTED', 'decision_2', [
          reason,
        ]);
        return result;
      }
      result.timing.decision2ResponseMs =
        result.timing.decision2RequestStartMs +
        Math.ceil(planning.latencyMs ?? 0);
      if (requestId !== this.#requestSequence) {
        result.eligibility.reasons.push('stale_decision_2_response');
        result.terminalOutcome = terminal('D2_NOT_CALLED', 'decision_2', [
          'stale_decision_2_response',
        ]);
        return result;
      }
      try {
        validateDecision2Selection(planning, decision2Input);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.planning = planning;
        result.terminalOutcome = terminal(
          'SEMANTIC_SELECTION_REJECTED',
          'selection',
          [reason],
          [...planning.selectedAssetIds],
          [],
          planning.semanticOutput?.destinationNodeId,
        );
        return result;
      }
      result.selectionTrace.selectedAssetIds = [...planning.selectedAssetIds];
      if (planning.semanticOutput?.destinationNodeId)
        result.selectionTrace.destinationNodeId =
          planning.semanticOutput.destinationNodeId;
      const decision2ResponseSessionMs = result.timing.decision2ResponseMs;
      const validationStartedAt = performance.now();
      const decision2SelectedAssetIds = [...planning.selectedAssetIds];
      let plan: SceneJourneyPlan;
      if (this.#basePlan) {
        let futurePatch: FutureScenePatch;
        try {
          futurePatch = planning.semanticOutput
            ? materializeSemanticDecision2({
                adaptationId,
                output: planning.semanticOutput,
                decision,
                basePlan: this.#basePlan,
                nowMs: decision2ResponseSessionMs,
                config: this.#config,
              })
            : normalizeLegacyPlanPatch({
                adaptationId,
                patch: planning.patch,
                decision,
                basePlan: this.#basePlan,
                nowMs: decision2ResponseSessionMs,
                freezeBufferMs: this.#config.executionFreezeBufferMs,
              });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          result.planning = planning;
          result.terminalOutcome = terminal(
            'MATERIALIZATION_FAILED',
            'materialization',
            [reason],
            [...planning.selectedAssetIds],
            [],
            planning.semanticOutput?.destinationNodeId,
          );
          return result;
        }
        // Include deterministic support assets (for example transition
        // footsteps) in preload, recording, history, and reflection traces.
        const materializedAssetIds = futurePatch.operations.flatMap(
          (operation) => [
            ...(operation.insertedElement
              ? [operation.insertedElement.assetId]
              : []),
            ...(operation.replacementAssetId
              ? [operation.replacementAssetId]
              : []),
          ],
        );
        planning.selectedAssetIds = [
          ...new Set([...planning.selectedAssetIds, ...materializedAssetIds]),
        ];
        result.selectionTrace.selectedAssetIds = [...planning.selectedAssetIds];
        const validation = validateAndProjectPatch({
          basePlan: this.#basePlan,
          acceptedPatches: this.#acceptedPatches,
          proposedPatch: futurePatch,
          nowMs: decision2ResponseSessionMs,
          config: this.#config,
          recentAssetIds: this.#history.flatMap((item) => item.assetIds),
        });
        result.timing.patchValidationCompleteMs =
          decision2ResponseSessionMs +
          Math.ceil(performance.now() - validationStartedAt);
        result.futurePatch = futurePatch;
        result.patchValidation = validation;
        const lifecycle: AdaptationLifecycle = {
          adaptationId: futurePatch.adaptationId,
          patch: futurePatch,
          hypothesis: futurePatch.hypothesis,
          contextBefore: structuredClone(state),
          transitions: [
            { status: 'PROPOSED', timestampMs: state.timestampMs },
            {
              status: validation.valid ? 'VALIDATED' : 'REJECTED',
              timestampMs: state.timestampMs,
              ...(!validation.valid
                ? { reasonCode: validation.violations.join(',') }
                : {}),
            },
          ],
        };
        result.lifecycle = lifecycle;
        this.#lifecycles.set(futurePatch.adaptationId, lifecycle);
        if (
          !validation.valid ||
          futurePatch.status === 'NO_SAFE_PATCH' ||
          !validation.projectedPlan
        ) {
          result.planning = planning;
          const patchBudgetExhausted = validation.violations.includes(
            'PATCH_BUDGET_EXHAUSTED',
          );
          const noSafeChange =
            planning.semanticOutput?.status === 'NO_SAFE_CHANGE';
          result.terminalOutcome = {
            checkpointTimestampMs: state.timestampMs,
            adaptationId: futurePatch.adaptationId,
            decision1Intent: decision.intent,
            decision1Scope: decision.scope,
            adaptationBasis: decision.adaptationBasis ?? 'eeg_informed',
            terminalStatus: patchBudgetExhausted
              ? 'PATCH_BUDGET_EXHAUSTED'
              : noSafeChange
                ? 'D2_NO_SAFE_CHANGE'
                : futurePatch.status === 'NO_SAFE_PATCH'
                  ? 'MATERIALIZATION_FAILED'
                  : 'PATCH_VALIDATION_REJECTED',
            failureStage: noSafeChange
              ? 'decision_2'
              : futurePatch.status === 'NO_SAFE_PATCH'
                ? 'materialization'
                : 'validation',
            reasonCodes: [...futurePatch.reasonCodes],
            validationViolations: [...validation.violations],
            ...(planning.semanticOutput?.destinationNodeId
              ? {
                  destinationNodeId: planning.semanticOutput.destinationNodeId,
                }
              : {}),
            selectedAssetIds: [...planning.selectedAssetIds],
          };
          return result;
        }
        const projectedBasePlan = validation.projectedPlan;
        plan = materializeBasePlan(projectedBasePlan);
        // Runtime validation/application is the commit boundary. Keep the
        // projected state pending so a rejected plan cannot contaminate later
        // Decision 1/2 context, cooldowns, or reflection history.
        const previousBasePlan = this.#basePlan
          ? structuredClone(this.#basePlan)
          : undefined;
        const previousPlan = structuredClone(this.#currentPlan);
        const previousTransitionUntilMs = this.#transitionUntilMs;
        const previousLastSpatialProgressionMs = this.#lastSpatialProgressionMs;
        const previousAcceptedPatches = structuredClone(this.#acceptedPatches);
        const previousHistory = structuredClone(this.#history);
        this.#pendingApplications.set(futurePatch.adaptationId, {
          basePlan: projectedBasePlan,
          plan: structuredClone(plan),
          patch: futurePatch,
          historyItem: {
            adaptationId: futurePatch.adaptationId,
            timestampMs: state.timestampMs,
            goal: decision.goal,
            scope: decision.scope,
            assetIds: planning.selectedAssetIds,
            rationale: `${decision.rationale} ${planning.rationale}`,
            intent: decision.intent,
            salience: decision.salience,
            adaptationBasis: decision.adaptationBasis,
            semanticRoles:
              planning.semanticOutput?.changes.map(
                (change) => change.semanticRole,
              ) ?? [],
            decision2SelectedAssetIds,
            ...(futurePatch.journeyUpdate
              ? { destinationNodeId: futurePatch.journeyUpdate.toNodeId }
              : {}),
          },
          transitionUntilMs:
            state.timestampMs +
            Math.max(...futurePatch.operations.map((op) => op.transitionMs), 0),
          lastSpatialProgressionMs: this.#lastSpatialProgressionMs,
          terminalBase: {
            checkpointTimestampMs: state.timestampMs,
            adaptationId: futurePatch.adaptationId,
            decision1Intent: decision.intent,
            decision1Scope: decision.scope,
            adaptationBasis: decision.adaptationBasis ?? 'eeg_informed',
            ...(futurePatch.journeyUpdate
              ? { destinationNodeId: futurePatch.journeyUpdate.toNodeId }
              : {}),
            selectedAssetIds: [...planning.selectedAssetIds],
          },
          previousBasePlan,
          previousPlan,
          previousTransitionUntilMs,
          previousLastSpatialProgressionMs,
          previousAcceptedPatches,
          previousHistory,
        });
      } else {
        plan = mergePlanPatch(
          this.#currentPlan,
          planning.patch,
          state.timestampMs,
        );
      }
      if (!this.#basePlan) {
        this.#currentPlan = plan;
        this.#transitionUntilMs =
          state.timestampMs +
          Math.max(planning.patch.transitionDurationMs ?? 0, 0);
        this.#history.push({
          adaptationId: `adapt-${state.timestampMs}`,
          timestampMs: state.timestampMs,
          goal: decision.goal,
          scope: decision.scope,
          assetIds: planning.selectedAssetIds,
          rationale: `${decision.rationale} ${planning.rationale}`,
          intent: decision.intent,
          salience: decision.salience,
        });
      }
      result.planning = planning;
      result.plan = structuredClone(plan);
      return result;
    } finally {
      this.#plannerRequestInFlight = false;
    }
  }

  get currentPlan(): SceneJourneyPlan {
    return structuredClone(this.#currentPlan);
  }
  get history(): readonly AdaptationHistoryItem[] {
    return structuredClone(this.#history);
  }

  get lastSpatialProgressionMs(): number {
    return this.#lastSpatialProgressionMs;
  }

  private hasPendingSceneTransition(): boolean {
    return [...this.#pendingApplications.values()].some(
      (pending) => pending.patch.journeyUpdate !== undefined,
    );
  }
  get attentionStates(): readonly AttentionState[] {
    return structuredClone(this.#interpreter.states);
  }
  get acceptedPatches(): readonly FutureScenePatch[] {
    return structuredClone(this.#acceptedPatches);
  }
  get adaptationMemory() {
    return this.#memory.cases;
  }
  acknowledgeApplication(
    adaptationId: string,
    status:
      | 'APPLIED'
      | 'PLAN_APPLIED'
      | 'RUNTIME_ACTIVATED'
      | 'AUDIO_STARTED'
      | 'AUDIO_FINISHED'
      | 'AUDIO_FAILED'
      | 'FAILED',
    timestampMs: number,
  ): AdaptationTerminalOutcome | undefined {
    const lifecycle = this.#lifecycles.get(adaptationId);
    if (!lifecycle) return undefined;
    lifecycle.transitions.push({ status, timestampMs });
    const pending = this.#pendingApplications.get(adaptationId);
    const shouldCommit =
      status === 'APPLIED' ||
      (status === 'PLAN_APPLIED' && !pending?.patch.journeyUpdate);
    if (shouldCommit) {
      if (pending) {
        this.#basePlan = structuredClone(pending.basePlan);
        this.#currentPlan = structuredClone(pending.plan);
        this.#acceptedPatches.push(pending.patch);
        if (pending.patch.journeyUpdate)
          pending.historyItem.timestampMs = timestampMs;
        this.#history.push(pending.historyItem);
        this.#transitionUntilMs = pending.transitionUntilMs;
        if (pending.patch.journeyUpdate)
          this.#lastSpatialProgressionMs = timestampMs;
      }
      lifecycle.appliedAtMs = timestampMs;
    }
    if (
      status === 'AUDIO_STARTED' &&
      lifecycle.audioStartedAtMs === undefined
    ) {
      lifecycle.audioStartedAtMs = timestampMs;
      const historyItem = this.#history.find(
        (item) => item.adaptationId === adaptationId,
      );
      if (historyItem) historyItem.experiencedAtMs = timestampMs;
      lifecycle.transitions.push({
        status: 'WAITING_FOR_OBSERVATION',
        timestampMs:
          timestampMs +
          lifecycle.patch.operations.reduce(
            (max, op) => Math.max(max, op.transitionMs),
            0,
          ),
      });
      lifecycle.transitionCompletedAtMs =
        lifecycle.transitions.at(-1)!.timestampMs;
    }
    if (status === 'AUDIO_FINISHED') lifecycle.audioFinishedAtMs = timestampMs;
    if (status === 'AUDIO_FAILED') lifecycle.audioFailedAtMs = timestampMs;
    if (
      status === 'APPLIED' ||
      (status === 'PLAN_APPLIED' && !pending?.patch.journeyUpdate) ||
      status === 'FAILED'
    )
      this.#pendingApplications.delete(adaptationId);
    if (shouldCommit && pending)
      return {
        ...pending.terminalBase,
        terminalStatus: 'APPLIED',
        failureStage: 'applied',
        reasonCodes: [...pending.patch.reasonCodes],
        validationViolations: [],
      };
    if (status === 'FAILED' && pending) {
      this.#rollbackPendingApplication(adaptationId, pending);
      return {
        ...pending.terminalBase,
        terminalStatus: 'RUNTIME_REJECTED',
        failureStage: 'runtime',
        reasonCodes: ['RUNTIME_REJECTED'],
        validationViolations: [],
      };
    }
    return undefined;
  }

  acknowledgeJourneyArrival(
    destinationNodeId: string,
    timestampMs: number,
  ): AdaptationTerminalOutcome | undefined {
    const pending = [...this.#pendingApplications.values()].find(
      (item) =>
        item.patch.journeyUpdate?.toNodeId === destinationNodeId &&
        item.patch.journeyUpdate.arrivalTimeMs <= timestampMs,
    );
    return pending
      ? this.acknowledgeApplication(
          pending.patch.adaptationId,
          'APPLIED',
          timestampMs,
        )
      : undefined;
  }

  expireRuntimeApplications(timestampMs: number): AdaptationTerminalOutcome[] {
    const outcomes: AdaptationTerminalOutcome[] = [];
    for (const [adaptationId, pending] of [...this.#pendingApplications]) {
      const arrivalTimeMs = pending.patch.journeyUpdate?.arrivalTimeMs;
      if (
        arrivalTimeMs === undefined ||
        timestampMs <= arrivalTimeMs + this.#config.checkpointIntervalMs
      )
        continue;
      const lifecycle = this.#lifecycles.get(adaptationId);
      lifecycle?.transitions.push({
        status: 'FAILED',
        timestampMs,
        reasonCode: 'RUNTIME_TIMEOUT',
      });
      this.#rollbackPendingApplication(adaptationId, pending);
      outcomes.push({
        ...pending.terminalBase,
        terminalStatus: 'RUNTIME_TIMEOUT',
        failureStage: 'runtime',
        reasonCodes: ['RUNTIME_TIMEOUT'],
        validationViolations: [],
      });
    }
    return outcomes;
  }

  #rollbackPendingApplication(
    adaptationId: string,
    pending: {
      basePlan: BaseScenePlan;
      plan: SceneJourneyPlan;
      patch: FutureScenePatch;
      historyItem: AdaptationHistoryItem;
      transitionUntilMs: number;
      lastSpatialProgressionMs: number;
      previousBasePlan?: BaseScenePlan;
      previousPlan?: SceneJourneyPlan;
      previousTransitionUntilMs?: number;
      previousLastSpatialProgressionMs?: number;
      previousAcceptedPatches?: FutureScenePatch[];
      previousHistory?: AdaptationHistoryItem[];
    },
  ): void {
    this.#pendingApplications.delete(adaptationId);
    if (pending.previousBasePlan)
      this.#basePlan = structuredClone(pending.previousBasePlan);
    if (pending.previousPlan)
      this.#currentPlan = structuredClone(pending.previousPlan);
    if (pending.previousTransitionUntilMs !== undefined)
      this.#transitionUntilMs = pending.previousTransitionUntilMs;
    if (pending.previousLastSpatialProgressionMs !== undefined)
      this.#lastSpatialProgressionMs = pending.previousLastSpatialProgressionMs;
    this.#acceptedPatches.length = 0;
    if (pending.previousAcceptedPatches)
      this.#acceptedPatches.push(
        ...structuredClone(pending.previousAcceptedPatches),
      );
    this.#history.length = 0;
    if (pending.previousHistory)
      this.#history.push(...structuredClone(pending.previousHistory));
  }

  private evaluatePendingOutcome(
    state: AttentionState,
  ): AdaptationOutcome | undefined {
    const lifecycle = [...this.#lifecycles.values()].find((item) => {
      const last = item.transitions.at(-1)?.status;
      return (
        item.audioStartedAtMs !== undefined &&
        last !== 'REJECTED' &&
        last !== 'FAILED' &&
        !item.transitions.some(
          (transition) => transition.status === 'UPDATED_EVALUATION',
        ) &&
        item.transitions.some(
          (transition) =>
            transition.status === 'WAITING_FOR_OBSERVATION' ||
            transition.status === 'PROVISIONALLY_EVALUATED',
        )
      );
    });
    if (lifecycle?.audioStartedAtMs === undefined) return undefined;
    const windowStartMs = state.timestampMs - this.#config.analysisWindowMs;
    const outcome = evaluateAdaptationOutcome({
      lifecycle,
      postState: state,
      window: {
        windowStartMs,
        windowEndMs: state.timestampMs,
        concurrentBasePlanChange:
          this.#basePlan?.scheduledElements.some(
            (element) =>
              element.startMs > lifecycle.audioStartedAtMs! &&
              element.startMs <= state.timestampMs,
          ) ?? false,
        concurrentPatchCount: this.#acceptedPatches.filter((patch) => {
          const applied = this.#lifecycles.get(
            patch.adaptationId,
          )?.audioStartedAtMs;
          return (
            applied !== undefined &&
            applied > windowStartMs &&
            applied <= state.timestampMs
          );
        }).length,
      },
    });
    if (outcome.observedResponse === 'not_yet_observable') return outcome;
    const nextStatus = lifecycle.transitions.some(
      (item) => item.status === 'PROVISIONALLY_EVALUATED',
    )
      ? 'UPDATED_EVALUATION'
      : 'PROVISIONALLY_EVALUATED';
    const updated = transitionLifecycle(
      lifecycle,
      nextStatus,
      state.timestampMs,
    );
    this.#lifecycles.set(lifecycle.adaptationId, updated);
    const operation = lifecycle.patch.operations[0];
    this.#memory.add({
      adaptationId: lifecycle.adaptationId,
      contextSignature: {
        positionBand: lifecycle.contextBefore.baselineRelation,
        trajectory: lifecycle.contextBefore.trajectory,
        stability:
          lifecycle.contextBefore.trajectory === 'volatile' ? 'low' : 'medium',
        sceneDensity:
          (this.#basePlan?.scheduledElements.length ?? 0) > 5
            ? 'medium'
            : 'low',
        scenePhase: lifecycle.contextBefore.phase,
      },
      actionSignature: {
        intent: lifecycle.patch.intent,
        layer: operation?.insertedElement?.layer ?? 'mixed',
        operation: operation?.operation ?? 'KEEP',
        assetFamily:
          operation?.insertedElement?.assetFamily ??
          operation?.replacementAssetId?.replace(/_\d+$/, '') ??
          'existing',
        salience: lifecycle.patch.salience,
      },
      outcome: {
        observedResponse: outcome.observedResponse,
        confidence: outcome.outcomeConfidence,
        evidenceCount: outcome.evidenceCount,
      },
      updatedAtMs: state.timestampMs,
    });
    return outcome;
  }

  private isCheckpoint(timestampMs: number): boolean {
    if (timestampMs < this.#nextCheckpointMs) return false;
    do this.#nextCheckpointMs += this.#config.checkpointIntervalMs;
    while (this.#nextCheckpointMs <= timestampMs);
    return true;
  }

  private withCheckpointTrend(state: AttentionState): AttentionState {
    const recent = [
      ...this.#checkpointStates.slice(-(this.#config.trendWindowCount - 1)),
      state,
    ];
    const first = recent[0]?.robustDeltaFromBaseline;
    const current = state.robustDeltaFromBaseline;
    const delta =
      recent.length < this.#config.trendWindowCount ||
      first === null ||
      first === undefined ||
      current === null
        ? null
        : (current - first) / (recent.length - 1);
    const trend =
      delta === null
        ? 'insufficient-history'
        : delta > this.#config.robustDeltaTrendThreshold
          ? 'increasing'
          : delta < -this.#config.robustDeltaTrendThreshold
            ? 'decreasing'
            : 'stable';
    const previous = this.#checkpointStates.at(-1);
    return {
      ...state,
      trend,
      robustDeltaPrevious: recent.at(-2)?.robustDeltaFromBaseline ?? null,
      robustDeltaSlope: delta,
      trajectory:
        delta === null
          ? 'unavailable'
          : state.variabilityMad !== null &&
              state.variabilityMad > this.#config.highVariabilityMad
            ? 'volatile'
            : delta > this.#config.robustDeltaTrendThreshold
              ? 'declining'
              : delta < -this.#config.robustDeltaTrendThreshold
                ? 'improving'
                : 'stable',
      sustainedElevatedWindows:
        state.baselineRelation === 'tbr-elevated'
          ? (previous?.sustainedElevatedWindows ?? 0) + 1
          : 0,
      sustainedReducedWindows:
        state.baselineRelation === 'tbr-reduced'
          ? (previous?.sustainedReducedWindows ?? 0) + 1
          : 0,
    };
  }
}
