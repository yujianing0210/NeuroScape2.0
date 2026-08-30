import { describe, expect, it } from 'vitest';
import {
  assignSharedBasePlan,
  createForestBasePlan,
  measureBasePlan,
  materializeBasePlan,
  recommendedStudyOrder,
  normalizeLegacyPlanPatch,
  phase1Config,
  validateAndProjectPatch,
  type FutureScenePatch,
  type SoundscapePlanPatch,
} from '../src/index.js';

describe('shared Base Plan and future patching', () => {
  const a = createForestBasePlan(phase1Config);
  const patchable = structuredClone(a);
  patchable.scheduledElements.push({
    elementId: 'base-bird-early',
    assetId: 'forest_bird_far_01',
    layer: 'event',
    startMs: 155_000,
    endMs: 163_000,
    gain: 0.24,
    salience: 0.25,
    assetFamily: 'forest_bird_far',
    spatialBehavior: 'stationary_distant',
    adjustable: true,
    replaceable: true,
    suppressible: true,
    payload: {
      id: 'base-bird-early',
      assetId: 'forest_bird_far_01',
      activationTimeMs: 155_000,
      durationMs: 8_000,
      trajectory: [{ locationId: 'forest_entry', timestampMs: 155_000 }],
      gain: 0.24,
    },
  });
  it('provides one complete ambient-only Base Plan', () => {
    expect(measureBasePlan(a)).toMatchObject({
      durationMs: 600_000,
      ambientCount: 1,
      eventCount: 0,
      bodyAnchorCount: 0,
    });
    expect(a.scheduledElements.map((item) => item.assetId)).toEqual([
      'forest_ambient_bed_01',
    ]);
  });
  it('assigns the same plan to both experimental conditions', () => {
    const assignment = assignSharedBasePlan('P002');
    expect(assignment.basePlanId).toBe('forest_base');
    expect(assignment.assignmentRuleVersion).toBe('shared_base_v1');
  });
  it.each([
    ['P001', 'AB'],
    ['P003', 'AB'],
    ['P004', 'BA'],
    ['P010', 'BA'],
  ])('derives %s as %s from integer parity', (participantId, expected) => {
    expect(recommendedStudyOrder(participantId)).toBe(expected);
  });
  it('hydrates canonical playback for every materialized Base Plan sound', () => {
    const materialized = materializeBasePlan(a);
    const sounds = [
      ...materialized.soundscape.ambient,
      ...materialized.soundscape.action,
      ...materialized.soundscape.event,
    ];
    expect(sounds).toHaveLength(1);
    expect(sounds.every((sound) => sound.playback !== undefined)).toBe(true);
    expect(materialized.soundscape.ambient[0]?.playback).toEqual({
      mode: 'loop',
      durationPolicy: 'loop-until-end',
    });
    expect(materialized.soundscape.event).toEqual([]);
  });
  it('fails before Runtime when canonical playback cannot be resolved', () => {
    const invalid = structuredClone(a);
    invalid.scheduledElements[0]!.assetId = 'missing-canonical-asset';
    expect(() => materializeBasePlan(invalid)).toThrow(
      'Unknown canonical audio asset',
    );
  });
  const patch = (
    operation: FutureScenePatch['operations'][number],
  ): FutureScenePatch => ({
    adaptationId: 'adapt-1',
    status: 'PATCH_PROPOSED',
    intent: 'reduce_stimulation',
    salience: 'low',
    operations: [operation],
    preservedElementIds: ['base-ambient'],
    hypothesis: {
      mechanismCode: 'REDUCE_FOREGROUND',
      expectedResponseCode: 'REDUCE_VARIABILITY_OR_HALT_DECLINE',
      failureSignalCode: 'CONTINUED_DECLINE_WITH_VALID_SIGNAL',
    },
    priorAdaptationIds: [],
    lessonCode: null,
    lessonConfidence: 'unavailable',
    reasonCodes: ['MINIMAL_SUFFICIENT_PATCH'],
  });
  it.each(['ADJUST', 'RESCHEDULE', 'REPLACE', 'SUPPRESS'] as const)(
    'accepts future %s without touching the freeze buffer',
    (kind) => {
      const target = patchable.scheduledElements.find(
        (e) => e.elementId === 'base-bird-early',
      )!;
      const operation = {
        operation: kind,
        targetElementId: target.elementId,
        effectiveStartMs: 155_000,
        transitionMs: 5_000,
        ...(kind === 'ADJUST' ? { gain: 0.12 } : {}),
        ...(kind === 'REPLACE'
          ? { replacementAssetId: 'forest_bird_far_02' }
          : {}),
      };
      expect(
        validateAndProjectPatch({
          basePlan: patchable,
          acceptedPatches: [],
          proposedPatch: patch(operation),
          nowMs: 60_000,
          config: phase1Config,
        }).valid,
      ).toBe(true);
    },
  );
  it('rejects stale operations inside the minimal handoff buffer and non-minimal INSERT', () => {
    const insertedElement = structuredClone(patchable.scheduledElements[1]!);
    insertedElement.elementId = 'inserted';
    insertedElement.startMs = 200_100;
    insertedElement.endMs = 208_100;
    const result = validateAndProjectPatch({
      basePlan: patchable,
      acceptedPatches: [],
      proposedPatch: patch({
        operation: 'INSERT',
        effectiveStartMs: 200_100,
        transitionMs: 3_000,
        insertedElement,
      }),
      nowMs: 200_000,
      config: phase1Config,
    });
    expect(result.valid).toBe(false);
    expect(result.violations).toContain('operation_inside_freeze_buffer');
    expect(result.violations).not.toContain('insert_not_minimal');
  });
  it('treats NO_SAFE_PATCH as a safe Base Plan continuation', () => {
    const noSafe = {
      ...patch({
        operation: 'KEEP',
        targetElementId: 'base-ambient',
        effectiveStartMs: 220_000,
        transitionMs: 0,
      }),
      status: 'NO_SAFE_PATCH' as const,
      operations: [],
    };
    expect(
      validateAndProjectPatch({
        basePlan: patchable,
        acceptedPatches: [],
        proposedPatch: noSafe,
        nowMs: 200_000,
        config: phase1Config,
      }).valid,
    ).toBe(true);
  });
  it('materializes ADJUST into the runtime payload rather than metadata only', () => {
    const result = validateAndProjectPatch({
      basePlan: patchable,
      acceptedPatches: [],
      proposedPatch: patch({
        operation: 'ADJUST',
        targetElementId: 'base-bird-early',
        effectiveStartMs: 155_000,
        transitionMs: 5_000,
        gain: 0.12,
      }),
      nowMs: 60_000,
      config: phase1Config,
    });
    const element = result.projectedPlan?.scheduledElements.find(
      (item) => item.elementId === 'base-bird-early',
    );
    expect(element?.gain).toBe(0.12);
    expect((element?.payload as { gain: number }).gain).toBe(0.12);
    expect(
      materializeBasePlan(result.projectedPlan!).soundscape.event[0]?.playback,
    ).toEqual({ mode: 'once', durationPolicy: 'truncate-at-end' });
  });

  it('refreshes playback from the replacement asset contract', () => {
    const result = validateAndProjectPatch({
      basePlan: patchable,
      acceptedPatches: [],
      proposedPatch: patch({
        operation: 'REPLACE',
        targetElementId: 'base-bird-early',
        effectiveStartMs: 155_000,
        transitionMs: 1_000,
        replacementAssetId: 'forest_soft_owl_far_01',
      }),
      nowMs: 60_000,
      config: phase1Config,
    });
    expect(result.valid).toBe(true);
    const replaced = materializeBasePlan(
      result.projectedPlan!,
    ).soundscape.event.find((item) => item.id === 'base-bird-early');
    expect(replaced?.assetId).toBe('forest_soft_owl_far_01');
    expect(replaced?.playback).toMatchObject({
      mode: 'repeat',
      durationPolicy: 'truncate-at-end',
      repeatCount: 2,
    });
  });

  it('omits schema-required null locationId from inserted global ambient', () => {
    const futurePatch = normalizeLegacyPlanPatch({
      adaptationId: 'adapt-global-ambient',
      patch: {
        reasoningSummary: 'Add a quiet stream bed.',
        upsertAmbient: [
          {
            id: 'adapt-stream',
            assetId: 'stream_lakeside_river',
            mode: 'global',
            locationId: null,
            gain: 0.58,
            active: true,
          },
        ],
        transitionDurationMs: 4_000,
      } as unknown as SoundscapePlanPatch,
      decision: {
        decision: 'adapt',
        intent: 'support_sustained_focus',
        salience: 'minimal',
        evidenceSummary: {
          position: 'focus-leaning',
          trajectory: 'stable',
          confidence: 'low',
        },
        reason: 'stasis pressure',
        maintainReason: null,
        constraintsForDecision2: [],
        shouldAdapt: true,
        goal: 'support-sustained-focus',
        scope: 'within-scene',
        rationale: 'test',
        provider: 'test',
      },
      basePlan: patchable,
      nowMs: 220_000,
      freezeBufferMs: phase1Config.executionFreezeBufferMs,
    });
    const validation = validateAndProjectPatch({
      basePlan: patchable,
      acceptedPatches: [],
      proposedPatch: futurePatch,
      nowMs: 220_000,
      config: phase1Config,
    });
    expect(validation.valid).toBe(true);
    const runtimePlan = materializeBasePlan(validation.projectedPlan!);
    const stream = runtimePlan.soundscape.ambient.find(
      (item) => item.id === 'adapt-stream',
    );
    expect(stream).not.toHaveProperty('locationId');
  });

  it('projects a model-authored past event into executable runtime time', () => {
    const futurePatch = normalizeLegacyPlanPatch({
      adaptationId: 'adapt-past-event',
      patch: {
        reasoningSummary: 'Add one short cue.',
        upsertEvent: [
          {
            id: 'adapt-rustle',
            assetId: 'forest_leaf_rustle_mid_01',
            activationTimeMs: 12_000,
            durationMs: 7_000,
            trajectory: [
              { locationId: 'clearing', timestampMs: 12_000 },
              { locationId: 'stream_bank', timestampMs: 18_000 },
            ],
            gain: 0.24,
          },
        ],
        transitionDurationMs: 1_000,
      },
      decision: {
        decision: 'adapt',
        intent: 'gently_reorient_attention',
        salience: 'low',
        evidenceSummary: {
          position: 'intermediate',
          trajectory: 'stable',
          confidence: 'low',
        },
        reason: 'test',
        maintainReason: null,
        constraintsForDecision2: [],
        shouldAdapt: true,
        goal: 'gently-reorient',
        scope: 'within-scene',
        rationale: 'test',
        provider: 'test',
      },
      basePlan: patchable,
      nowMs: 220_000,
      freezeBufferMs: phase1Config.executionFreezeBufferMs,
    });
    const inserted = futurePatch.operations[0]?.insertedElement;
    const payload = inserted?.payload as {
      activationTimeMs: number;
      trajectory: Array<{ timestampMs: number }>;
    };
    expect(futurePatch.operations[0]?.effectiveStartMs).toBe(220_250);
    expect(inserted?.startMs).toBe(220_250);
    expect(payload.activationTimeMs).toBe(220_250);
    expect(payload.trajectory.map((point) => point.timestampMs)).toEqual([
      220_250, 226_250,
    ]);
  });

  it('allows objective-safe INSERT without a textual minimality reason code', () => {
    const insertedElement = structuredClone(patchable.scheduledElements[1]!);
    insertedElement.elementId = 'objective-insert';
    insertedElement.assetId = 'forest_leaf_rustle_mid_01';
    insertedElement.assetFamily = 'forest_leaf_rustle_mid';
    insertedElement.startMs = 280_000;
    insertedElement.endMs = 287_000;
    (insertedElement.payload as { id: string; assetId: string }).id =
      insertedElement.elementId;
    (insertedElement.payload as { assetId: string }).assetId =
      insertedElement.assetId;
    const candidate = patch({
      operation: 'INSERT',
      effectiveStartMs: 280_000,
      transitionMs: 1_000,
      insertedElement,
    });
    candidate.reasonCodes = [];
    expect(
      validateAndProjectPatch({
        basePlan: patchable,
        acceptedPatches: [],
        proposedPatch: candidate,
        nowMs: 220_000,
        config: phase1Config,
      }).violations,
    ).not.toContain('insert_not_minimal');
  });

  it('allows an active target to be adjusted but rejects duplicate active-asset INSERT', () => {
    const adjust = validateAndProjectPatch({
      basePlan: patchable,
      acceptedPatches: [],
      proposedPatch: patch({
        operation: 'ADJUST',
        targetElementId: 'base-ambient',
        effectiveStartMs: 220_250,
        transitionMs: 1_000,
        gain: 0.2,
      }),
      nowMs: 220_000,
      config: phase1Config,
    });
    expect(adjust.valid).toBe(true);

    const duplicate = structuredClone(a.scheduledElements[0]!);
    duplicate.elementId = 'duplicate-active-bed';
    duplicate.startMs = 220_250;
    const duplicateResult = validateAndProjectPatch({
      basePlan: patchable,
      acceptedPatches: [],
      proposedPatch: patch({
        operation: 'INSERT',
        effectiveStartMs: 220_250,
        transitionMs: 1_000,
        insertedElement: duplicate,
      }),
      nowMs: 220_000,
      config: phase1Config,
    });
    expect(duplicateResult.violations).toContain(
      'duplicate_active_asset_insert',
    );
  });

  it('allows patch seven and explicitly rejects only the configured patch ceiling', () => {
    const proposed = patch({
      operation: 'ADJUST',
      targetElementId: 'base-ambient',
      effectiveStartMs: 220_250,
      transitionMs: 1_000,
      gain: 0.2,
    });
    const validateAtCount = (count: number) =>
      validateAndProjectPatch({
        basePlan: patchable,
        acceptedPatches: Array.from({ length: count }, (_, index) => ({
          ...structuredClone(proposed),
          adaptationId: `accepted-${index}`,
        })),
        proposedPatch: proposed,
        nowMs: 220_000,
        config: phase1Config,
      });
    expect(phase1Config.maxCumulativePatches).toBe(10);
    expect(phase1Config.targetAdaptationsMax).toBe(6);
    expect(validateAtCount(6).valid).toBe(true);
    expect(validateAtCount(10).violations).toContain('PATCH_BUDGET_EXHAUSTED');
  });

  it('rejects starts beyond session end and consistently truncates allowed late events', () => {
    const latePatch = (
      nowMs: number,
      durationPolicy: 'natural' | 'truncate-at-end',
    ) =>
      normalizeLegacyPlanPatch({
        adaptationId: `late-${nowMs}`,
        patch: {
          reasoningSummary: 'late event',
          upsertEvent: [
            {
              id: 'late-event',
              assetId: 'forest_bird_far_01',
              activationTimeMs: nowMs,
              durationMs: 6_000,
              trajectory: [
                { locationId: 'clearing', timestampMs: nowMs },
                { locationId: 'stream_bank', timestampMs: nowMs + 6_000 },
              ],
              gain: 0.12,
              playback: { mode: 'once', durationPolicy },
            },
          ],
        },
        decision: {
          decision: 'adapt',
          intent: 'gently_reorient_attention',
          salience: 'low',
          evidenceSummary: {
            position: 'intermediate',
            trajectory: 'stable',
            confidence: 'medium',
          },
          reason: 'test',
          maintainReason: null,
          constraintsForDecision2: [],
          shouldAdapt: true,
          goal: 'gently-reorient',
          scope: 'within-scene',
          rationale: 'test',
          provider: 'test',
        },
        basePlan: patchable,
        nowMs,
        freezeBufferMs: phase1Config.executionFreezeBufferMs,
      });

    expect(latePatch(600_000, 'truncate-at-end').status).toBe('NO_SAFE_PATCH');
    expect(latePatch(598_000, 'natural').status).toBe('NO_SAFE_PATCH');
    const truncated = latePatch(598_000, 'truncate-at-end');
    const inserted = truncated.operations[0]!.insertedElement!;
    const payload = inserted.payload as {
      activationTimeMs: number;
      durationMs: number;
      trajectory: Array<{ timestampMs: number }>;
    };
    expect(inserted.startMs).toBe(598_250);
    expect(inserted.endMs).toBe(600_000);
    expect(payload.activationTimeMs).toBe(598_250);
    expect(payload.durationMs).toBe(1_750);
    expect(
      payload.trajectory.every((item) => item.timestampMs <= 600_000),
    ).toBe(true);
  });
});
