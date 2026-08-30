import { describe, expect, it } from 'vitest';
import {
  AdaptivePlannerEngine,
  MockDecisionProvider,
  MockPlanningProvider,
  createMockTbrReplay,
  createForestBasePlan,
  initialForestPlan,
  mergePlanPatch,
  mockCalibrationProfile,
  phase1Config,
  type SoundscapePlanPatch,
} from '../src/index.js';

const engine = () =>
  new AdaptivePlannerEngine({
    config: phase1Config,
    profile: mockCalibrationProfile,
    initialPlan: initialForestPlan,
    decisionProvider: new MockDecisionProvider(),
    planningProvider: new MockPlanningProvider(),
  });

describe('adaptive planner Phase 1', () => {
  it('normalizes mock TBR, applies hard gates, and emits Module 03 plans', async () => {
    const planner = engine();
    const checkpoints = [];
    for (const epoch of createMockTbrReplay()) {
      const result = await planner.ingest(epoch);
      if (result) checkpoints.push(result);
    }
    expect(checkpoints[0]?.state.timestampMs).toBe(60_000);
    expect(
      checkpoints.slice(0, 5).map((item) => item.state.timestampMs),
    ).toEqual([60_000, 80_000, 100_000, 120_000, 140_000]);
    const lastCheckpointMs =
      phase1Config.openingDurationMs +
      Math.floor(
        (phase1Config.sessionDurationMs - phase1Config.openingDurationMs) /
          phase1Config.checkpointIntervalMs,
      ) *
        phase1Config.checkpointIntervalMs;
    expect(checkpoints.at(-1)?.state.timestampMs).toBe(lastCheckpointMs);
    expect(checkpoints.at(-1)?.state.phase).toBe('adaptive');
    expect(checkpoints.at(-1)?.eligibility.reasons).not.toContain(
      'closing_phase',
    );
    expect(checkpoints.some((item) => item.decision?.shouldAdapt)).toBe(true);
    expect(checkpoints.some((item) => item.plan !== undefined)).toBe(true);
    expect(
      checkpoints.some((item) =>
        item.plan?.soundscape.action.some(
          (sound) => sound.assetId === 'body_slow_breath_01',
        ),
      ),
    ).toBe(true);
    expect(
      checkpoints.some((item) => item.decision?.scope === 'scene-transition'),
    ).toBe(true);
    expect(
      planner.history.filter((item) => item.scope === 'scene-transition')
        .length,
    ).toBeLessThanOrEqual(phase1Config.maxSceneTransitions);
  });

  it('does not call Decision 2 when Decision 1 maintains', async () => {
    let planningCalls = 0;
    const planner = new AdaptivePlannerEngine({
      config: phase1Config,
      profile: mockCalibrationProfile,
      initialPlan: initialForestPlan,
      decisionProvider: {
        decide: async () => ({
          shouldAdapt: false,
          goal: 'maintain',
          scope: 'maintain',
          rationale: 'test maintain',
          provider: 'test',
        }),
      },
      planningProvider: {
        plan: async () => {
          planningCalls += 1;
          throw new Error('must not run');
        },
      },
    });
    for (const epoch of createMockTbrReplay().slice(0, 10))
      await planner.ingest(epoch);
    expect(planningCalls).toBe(0);
  });

  it('raises spatial progression pressure independently of within-scene change pace', async () => {
    const observed: Array<{
      timestampMs: number;
      pressure: string | undefined;
    }> = [];
    const planner = new AdaptivePlannerEngine({
      config: phase1Config,
      profile: mockCalibrationProfile,
      initialPlan: initialForestPlan,
      decisionProvider: {
        decide: async (context) => {
          observed.push({
            timestampMs: context.state.timestampMs,
            pressure: context.progressionPressure,
          });
          return {
            shouldAdapt: false,
            goal: 'maintain',
            scope: 'maintain',
            rationale: 'observe deterministic progression pacing',
            provider: 'test',
          };
        },
      },
      planningProvider: new MockPlanningProvider(),
    });
    for (const epoch of createMockTbrReplay().filter(
      (item) => item.timestampMs <= 220_000,
    ))
      await planner.ingest(epoch);

    expect(
      observed.find((item) => item.timestampMs === 140_000)?.pressure,
    ).toBe('low');
    expect(
      observed.find((item) => item.timestampMs === 160_000)?.pressure,
    ).toBe('medium');
    expect(
      observed.find((item) => item.timestampMs === 220_000)?.pressure,
    ).toBe('high');
  });

  it('uses checkpoint deadlines when epoch timestamps are not aligned', async () => {
    const planner = engine();
    const template = createMockTbrReplay()[0]!;
    const checkpoints = [];
    for (const timestampMs of [
      10_000, 30_000, 59_000, 61_000, 79_000, 81_000, 101_000,
    ]) {
      const result = await planner.ingest({ ...template, timestampMs });
      if (result) checkpoints.push(result.state.timestampMs);
    }
    expect(checkpoints).toEqual([61_000, 81_000, 101_000]);
  });

  it('does not let a later checkpoint invalidate an in-flight planner transaction', async () => {
    let releaseDecision!: (value: unknown) => void;
    const decision = new Promise((resolve) => {
      releaseDecision = resolve;
    });
    let calls = 0;
    const planner = new AdaptivePlannerEngine({
      config: phase1Config,
      profile: mockCalibrationProfile,
      initialPlan: initialForestPlan,
      decisionProvider: {
        decide: async () => {
          calls += 1;
          return decision as never;
        },
      },
      planningProvider: new MockPlanningProvider(),
    });
    const replay = createMockTbrReplay();
    for (const epoch of replay.filter((item) => item.timestampMs < 60_000))
      await planner.ingest(epoch);
    const first = planner.ingest(
      replay.find((item) => item.timestampMs === 60_000)!,
    );
    let busyResult;
    for (const epoch of replay.filter(
      (item) => item.timestampMs > 60_000 && item.timestampMs <= 100_000,
    ))
      busyResult = await planner.ingest(epoch);
    expect(busyResult?.eligibility).toMatchObject({
      eligible: false,
      reasons: ['planner_request_in_progress'],
    });
    expect(calls).toBe(1);
    releaseDecision({
      shouldAdapt: false,
      goal: 'maintain',
      scope: 'maintain',
      rationale: 'complete first transaction',
      provider: 'test',
    });
    await first;
  });

  it('removes schema-required null locations from global ambient patches', () => {
    const patch = {
      reasoningSummary: 'Replace the global forest bed.',
      upsertAmbient: [
        {
          id: 'forest-bed',
          assetId: 'forest_ambient_bed_02',
          mode: 'global',
          locationId: null,
          gain: 0.44,
          active: true,
        },
      ],
    } as unknown as SoundscapePlanPatch;

    const plan = mergePlanPatch(initialForestPlan, patch, 330_000);
    const forestBed = plan.soundscape.ambient.find(
      (item) => item.id === 'forest-bed',
    );
    expect(forestBed).toEqual({
      id: 'forest-bed',
      adaptationId: 'adapt-330000',
      assetId: 'forest_ambient_bed_02',
      mode: 'global',
      gain: 0.44,
      active: true,
    });
    expect(forestBed).not.toHaveProperty('locationId');
  });

  it.each(['APPLIED', 'FAILED'] as const)(
    'commits a Base Plan proposal only after runtime reports %s',
    async (applicationStatus) => {
      const basePlan = createForestBasePlan(phase1Config);
      const planner = new AdaptivePlannerEngine({
        config: phase1Config,
        profile: mockCalibrationProfile,
        initialPlan: initialForestPlan,
        basePlan,
        decisionProvider: {
          decide: async () => ({
            decision: 'adapt',
            intent: 'support_sustained_focus',
            salience: 'minimal',
            evidenceSummary: {
              position: 'focus-leaning',
              trajectory: 'stable',
              confidence: 'low',
            },
            reason: 'test proposal',
            maintainReason: null,
            constraintsForDecision2: [],
            shouldAdapt: true,
            goal: 'support-sustained-focus',
            scope: 'within-scene',
            rationale: 'test proposal',
            provider: 'test',
          }),
        },
        planningProvider: {
          plan: async (_context, _decision, input) => {
            const candidate = input.candidates.find(
              (item) => item.layer === 'ambient' && !item.currentlyActive,
            )!;
            return {
              patch: {
                reasoningSummary: 'Add a quiet stream.',
                upsertAmbient: [
                  {
                    id: 'pending-stream',
                    assetId: candidate.assetId,
                    mode: 'global',
                    gain: candidate.recommendedVolume,
                    active: true,
                  },
                ],
                transitionDurationMs: 4_000,
              },
              selectedAssetIds: [candidate.assetId],
              candidateAssetIds: input.candidates.map((item) => item.assetId),
              promptVersion: 'test',
              prompt: 'test',
              outputSchema: {},
              rationale: 'test',
              provider: 'test',
            };
          },
        },
      });
      let proposal;
      for (const epoch of createMockTbrReplay()) {
        const result = await planner.ingest(epoch);
        if (result?.futurePatch) {
          proposal = result;
          break;
        }
      }
      expect(proposal?.plan?.soundscape.ambient).toContainEqual(
        expect.objectContaining({ id: 'pending-stream' }),
      );
      expect(planner.currentPlan.soundscape.ambient).not.toContainEqual(
        expect.objectContaining({ id: 'pending-stream' }),
      );
      expect(planner.history).toHaveLength(0);

      planner.acknowledgeApplication(
        proposal!.futurePatch!.adaptationId,
        applicationStatus,
        proposal!.state.timestampMs,
      );

      const committed = applicationStatus === 'APPLIED';
      expect(
        planner.currentPlan.soundscape.ambient.some(
          (item) => item.id === 'pending-stream',
        ),
      ).toBe(committed);
      expect(planner.history).toHaveLength(committed ? 1 : 0);
      expect(planner.acceptedPatches).toHaveLength(committed ? 1 : 0);
    },
  );

  it('commits a scene destination only after runtime arrival acknowledgement', async () => {
    const basePlan = createForestBasePlan(phase1Config);
    let planningCalls = 0;
    const planner = new AdaptivePlannerEngine({
      config: phase1Config,
      profile: mockCalibrationProfile,
      initialPlan: initialForestPlan,
      basePlan,
      decisionProvider: {
        decide: async () => ({
          decision: 'adapt',
          intent: 'refresh_engagement',
          salience: 'low',
          adaptationBasis: 'progression_driven',
          evidenceSummary: {
            relation: 'baseline-consistent',
            trajectory: 'stable',
            confidence: 'high',
          },
          reason: 'test transition',
          maintainReason: null,
          constraintsForDecision2: [],
          shouldAdapt: true,
          goal: 'refresh-engagement',
          scope: 'scene-transition',
          rationale: 'test transition',
          provider: 'test',
        }),
      },
      planningProvider: {
        plan: async (_context, _decision, input) => {
          planningCalls += 1;
          return {
            patch: { reasoningSummary: 'semantic transition' },
            semanticOutput: {
              status: 'CHANGE_PROPOSED',
              destinationNodeId: 'stream_bank',
              changes: [
                {
                  operation: 'INSERT',
                  assetId: 'stream_lakeside_river',
                  targetElementId: null,
                  semanticRole: 'foundation',
                  mixIntent: 'default',
                },
              ],
              selectedAssetIds: ['stream_lakeside_river'],
              reasonCodes: ['DESTINATION_FOUNDATION_SELECTED'],
              rationale: 'Establish Stream Bank identity.',
            },
            selectedAssetIds: ['stream_lakeside_river'],
            candidateAssetIds: input.retrievedCandidateIds,
            promptVersion: input.promptVersion,
            prompt: input.prompt,
            outputSchema: input.outputSchema,
            rationale: 'test',
            provider: 'test',
          };
        },
      },
    });
    let proposal;
    for (const epoch of createMockTbrReplay()) {
      const result = await planner.ingest(epoch);
      if (result?.futurePatch?.journeyUpdate) {
        proposal = result;
        break;
      }
    }
    const update = proposal!.futurePatch!.journeyUpdate!;
    expect(proposal!.patchValidation?.valid).toBe(true);
    const whilePending = await planner.ingest(
      createMockTbrReplay().find(
        (epoch) =>
          epoch.timestampMs >=
          proposal!.state.timestampMs + phase1Config.checkpointIntervalMs,
      )!,
    );
    expect(whilePending?.decision?.scope).toBe('scene-transition');
    expect(whilePending?.planning).toBeUndefined();
    expect(whilePending?.eligibility.reasons).toContain(
      'scene_transition_pending',
    );
    expect(planningCalls).toBe(1);
    planner.acknowledgeApplication(
      proposal!.futurePatch!.adaptationId,
      'PLAN_APPLIED',
      proposal!.state.timestampMs,
    );
    expect(planner.currentPlan.userJourney.waypoints.at(-1)?.locationId).toBe(
      'forest_clearing',
    );
    expect(
      planner.acknowledgeJourneyArrival(
        'stream_bank',
        update.arrivalTimeMs - 1,
      ),
    ).toBeUndefined();
    expect(
      planner.acknowledgeJourneyArrival('stream_bank', update.arrivalTimeMs)
        ?.terminalStatus,
    ).toBe('APPLIED');
    expect(planner.currentPlan.userJourney.waypoints.at(-1)?.locationId).toBe(
      'stream_bank',
    );
  });

  it('materializes and commits two adjacent scene transitions with foundation handoff', async () => {
    const observedCurrentNodeIds: string[] = [];
    const observedReachableNodeIds: string[][] = [];
    const observedDecisionContexts: Array<{
      timestampMs: number;
      currentNodeId: string | undefined;
      lastSpatialProgressionMs: number | undefined;
      committedSceneTransitionCount: number | undefined;
      secondsSinceLastSpatialProgression: number | undefined;
    }> = [];
    const planner = new AdaptivePlannerEngine({
      config: phase1Config,
      profile: mockCalibrationProfile,
      initialPlan: initialForestPlan,
      basePlan: createForestBasePlan(phase1Config),
      decisionProvider: {
        decide: async (context) => {
          observedDecisionContexts.push({
            timestampMs: context.state.timestampMs,
            currentNodeId:
              context.currentPlan.userJourney.waypoints.at(-1)?.locationId,
            lastSpatialProgressionMs: context.lastSpatialProgressionMs,
            committedSceneTransitionCount:
              context.committedSceneTransitionCount,
            secondsSinceLastSpatialProgression:
              context.secondsSinceLastSpatialProgression,
          });
          return context.restrictions.allowSceneTransition
            ? {
                decision: 'adapt',
                intent: 'refresh_engagement',
                salience: 'low',
                adaptationBasis: 'progression_driven',
                evidenceSummary: {
                  relation: context.state.baselineRelation,
                  trajectory: context.state.trajectory,
                  confidence: context.state.measurementConfidence,
                },
                reason: 'test sequential transition',
                maintainReason: null,
                constraintsForDecision2: [],
                shouldAdapt: true,
                goal: 'refresh-engagement',
                scope: 'scene-transition',
                rationale: 'test sequential transition',
                provider: 'test',
              }
            : {
                decision: 'maintain',
                intent: 'maintain',
                salience: 'minimal',
                adaptationBasis: 'none',
                evidenceSummary: {
                  relation: context.state.baselineRelation,
                  trajectory: context.state.trajectory,
                  confidence: context.state.measurementConfidence,
                },
                reason: 'wait for transition cooldown',
                maintainReason: 'transition cooldown',
                constraintsForDecision2: [],
                shouldAdapt: false,
                goal: 'maintain',
                scope: 'maintain',
                rationale: 'wait for transition cooldown',
                provider: 'test',
              };
        },
      },
      planningProvider: {
        plan: async (_context, _decision, input) => {
          observedCurrentNodeIds.push(input.currentNodeId!);
          observedReachableNodeIds.push([...(input.reachableNodeIds ?? [])]);
          const destinationNodeId =
            input.currentNodeId === 'forest_clearing'
              ? 'stream_bank'
              : 'lakeside_river';
          expect(input.reachableNodeIds).toContain(destinationNodeId);
          return {
            patch: { reasoningSummary: 'sequential semantic transition' },
            semanticOutput: {
              status: 'CHANGE_PROPOSED',
              destinationNodeId,
              changes: [
                {
                  operation: 'INSERT',
                  assetId: 'stream_lakeside_river',
                  targetElementId: null,
                  semanticRole: 'foundation',
                  mixIntent: 'default',
                },
              ],
              selectedAssetIds: ['stream_lakeside_river'],
              reasonCodes: ['DESTINATION_FOUNDATION_SELECTED'],
              rationale: 'Reuse the compatible water foundation.',
            },
            selectedAssetIds: ['stream_lakeside_river'],
            candidateAssetIds: input.retrievedCandidateIds,
            promptVersion: input.promptVersion,
            prompt: input.prompt,
            outputSchema: input.outputSchema,
            rationale: 'test sequential transition',
            provider: 'test',
          };
        },
      },
    });
    const replay = createMockTbrReplay();
    let first;
    for (const epoch of replay) {
      const result = await planner.ingest(epoch);
      if (result?.futurePatch?.journeyUpdate) {
        first = result;
        break;
      }
    }
    expect(first?.patchValidation?.valid).toBe(true);
    expect(planner.currentPlan.userJourney.waypoints.at(-1)?.locationId).toBe(
      'forest_clearing',
    );
    planner.acknowledgeApplication(
      first!.futurePatch!.adaptationId,
      'PLAN_APPLIED',
      first!.state.timestampMs,
    );
    const firstArrival = first!.futurePatch!.journeyUpdate!.arrivalTimeMs;
    planner.acknowledgeJourneyArrival('stream_bank', firstArrival);
    expect(planner.currentPlan.userJourney.waypoints.at(-1)?.locationId).toBe(
      'stream_bank',
    );

    let second;
    for (const epoch of replay.filter(
      (candidate) => candidate.timestampMs > firstArrival,
    )) {
      const result = await planner.ingest(epoch);
      if (result?.futurePatch?.journeyUpdate) {
        second = result;
        break;
      }
    }
    expect(observedCurrentNodeIds).toEqual(['forest_clearing', 'stream_bank']);
    const secondContext = observedDecisionContexts.find(
      (context) => context.timestampMs === second?.state.timestampMs,
    );
    expect(secondContext).toMatchObject({
      currentNodeId: 'stream_bank',
      lastSpatialProgressionMs: firstArrival,
      committedSceneTransitionCount: 1,
      secondsSinceLastSpatialProgression:
        (second!.state.timestampMs - firstArrival) / 1_000,
    });
    expect(planner.lastSpatialProgressionMs).toBe(firstArrival);
    expect(observedReachableNodeIds[1]).not.toContain('stream_bank');
    expect(observedReachableNodeIds[1]).toEqual(
      expect.arrayContaining(['forest_clearing', 'lakeside_river']),
    );
    expect(second?.futurePatch?.journeyUpdate).toMatchObject({
      fromNodeId: 'stream_bank',
      toNodeId: 'lakeside_river',
    });
    expect(second?.patchValidation?.valid).toBe(true);
    expect(
      second?.patchValidation?.projection.projectedAmbientLayers,
    ).toBeLessThanOrEqual(phase1Config.maxAmbientLayers);
    expect(
      second?.patchValidation?.projection.projectedConcurrentSources,
    ).toBeLessThanOrEqual(phase1Config.maxConcurrentSources);
    expect(
      second?.futurePatch?.operations.filter(
        (operation) =>
          operation.operation === 'INSERT' &&
          operation.insertedElement?.assetId === 'stream_lakeside_river',
      ),
    ).toHaveLength(0);
    planner.acknowledgeApplication(
      second!.futurePatch!.adaptationId,
      'PLAN_APPLIED',
      second!.state.timestampMs,
    );
    expect(planner.currentPlan.userJourney.waypoints.at(-1)?.locationId).toBe(
      'stream_bank',
    );
    planner.acknowledgeJourneyArrival(
      'lakeside_river',
      second!.futurePatch!.journeyUpdate!.arrivalTimeMs,
    );
    expect(planner.currentPlan.userJourney.waypoints.at(-1)?.locationId).toBe(
      'lakeside_river',
    );
    expect(
      planner.history.filter((item) => item.scope === 'scene-transition'),
    ).toHaveLength(2);
  });

  it('rolls back a timed-out scene transition to the origin plan', async () => {
    const basePlan = createForestBasePlan(phase1Config);
    const planner = new AdaptivePlannerEngine({
      config: phase1Config,
      profile: mockCalibrationProfile,
      initialPlan: initialForestPlan,
      basePlan,
      decisionProvider: {
        decide: async () => ({
          decision: 'adapt',
          intent: 'refresh_engagement',
          salience: 'low',
          adaptationBasis: 'progression_driven',
          evidenceSummary: {
            relation: 'baseline-consistent',
            trajectory: 'stable',
            confidence: 'high',
          },
          reason: 'test transition',
          maintainReason: null,
          constraintsForDecision2: [],
          shouldAdapt: true,
          goal: 'refresh-engagement',
          scope: 'scene-transition',
          rationale: 'test transition',
          provider: 'test',
        }),
      },
      planningProvider: {
        plan: async (_context, _decision, input) => ({
          patch: { reasoningSummary: 'semantic transition' },
          semanticOutput: {
            status: 'CHANGE_PROPOSED',
            destinationNodeId: 'stream_bank',
            changes: [
              {
                operation: 'INSERT',
                assetId: 'stream_lakeside_river',
                targetElementId: null,
                semanticRole: 'foundation',
                mixIntent: 'default',
              },
            ],
            selectedAssetIds: ['stream_lakeside_river'],
            reasonCodes: ['DESTINATION_FOUNDATION_SELECTED'],
            rationale: 'Establish Stream Bank identity.',
          },
          selectedAssetIds: ['stream_lakeside_river'],
          candidateAssetIds: input.retrievedCandidateIds,
          promptVersion: input.promptVersion,
          prompt: input.prompt,
          outputSchema: input.outputSchema,
          rationale: 'test',
          provider: 'test',
        }),
      },
    });
    let proposal: any;
    for (const epoch of createMockTbrReplay()) {
      const result = await planner.ingest(epoch);
      if (result?.futurePatch?.journeyUpdate) {
        proposal = result;
        break;
      }
    }
    expect(proposal!.patchValidation?.valid).toBe(true);
    planner.acknowledgeApplication(
      proposal!.futurePatch!.adaptationId,
      'PLAN_APPLIED',
      proposal!.state.timestampMs,
    );
    const timeout = planner.expireRuntimeApplications(
      proposal!.futurePatch!.journeyUpdate!.arrivalTimeMs +
        phase1Config.checkpointIntervalMs +
        1,
    );
    expect(timeout[0]).toMatchObject({ terminalStatus: 'RUNTIME_TIMEOUT' });
    expect(planner.currentPlan.userJourney.waypoints.at(-1)?.locationId).toBe(
      'forest_clearing',
    );
    expect(planner.history).toHaveLength(0);
  });

  it('returns an explicit terminal status when Decision 2 has no safe change', async () => {
    const basePlan = createForestBasePlan(phase1Config);
    const planner = new AdaptivePlannerEngine({
      config: phase1Config,
      profile: mockCalibrationProfile,
      initialPlan: initialForestPlan,
      basePlan,
      decisionProvider: {
        decide: async () => ({
          decision: 'adapt',
          intent: 'gently_reorient_attention',
          salience: 'low',
          adaptationBasis: 'eeg_informed',
          evidenceSummary: {
            relation: 'tbr-elevated',
            trajectory: 'declining',
            confidence: 'high',
          },
          reason: 'test',
          maintainReason: null,
          constraintsForDecision2: [],
          shouldAdapt: true,
          goal: 'gently-reorient',
          scope: 'within-scene',
          rationale: 'test',
          provider: 'test',
        }),
      },
      planningProvider: {
        plan: async (_context, _decision, input) => ({
          patch: { reasoningSummary: 'no safe change' },
          semanticOutput: {
            status: 'NO_SAFE_CHANGE',
            destinationNodeId: null,
            changes: [],
            selectedAssetIds: [],
            reasonCodes: ['NO_COHERENT_CHANGE'],
            rationale: 'maintain',
          },
          selectedAssetIds: [],
          candidateAssetIds: input.retrievedCandidateIds,
          promptVersion: input.promptVersion,
          prompt: input.prompt,
          outputSchema: input.outputSchema,
          rationale: 'maintain',
          provider: 'test',
        }),
      },
    });
    let terminal;
    for (const epoch of createMockTbrReplay()) {
      const result = await planner.ingest(epoch);
      if (result?.terminalOutcome) {
        terminal = result.terminalOutcome;
        break;
      }
    }
    expect(terminal).toMatchObject({
      terminalStatus: 'D2_NO_SAFE_CHANGE',
      failureStage: 'decision_2',
    });
  });
});
