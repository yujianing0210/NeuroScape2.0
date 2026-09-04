import { describe, expect, it } from 'vitest';
import {
  createForestBasePlan,
  materializeBasePlan,
  materializeSemanticDecision2,
  footstepAssetForTransition,
  phase1Config,
  SCENE_TRAVERSAL_DURATION_MS,
  TRANSITION_FOOTSTEP_GAIN_PRESET,
  TRAVERSAL_DURATION_PRESETS_MS,
  validateAndProjectPatch,
} from '../src/index.js';
import type {
  AdaptationDecision,
  Decision2SemanticOutput,
} from '../src/index.js';

const decision = (
  scope: 'within-scene' | 'scene-transition',
): AdaptationDecision => ({
  decision: 'adapt',
  intent: 'refresh_engagement',
  salience: 'low',
  adaptationBasis: 'progression_driven',
  evidenceSummary: {
    relation: 'baseline-consistent',
    trajectory: 'stable',
    confidence: 'high',
  },
  reason: 'test',
  maintainReason: null,
  constraintsForDecision2: [],
  shouldAdapt: true,
  goal: 'refresh-engagement',
  scope,
  rationale: 'test',
  provider: 'test',
});

describe('semantic Decision 2 materializer', () => {
  it('materializes an authored bird pass with motion-bound repeating playback', () => {
    const basePlan = createForestBasePlan(phase1Config);
    const patch = materializeSemanticDecision2({
      adaptationId: 'bird-motion',
      output: {
        status: 'CHANGE_PROPOSED',
        destinationNodeId: null,
        changes: [
          {
            operation: 'INSERT',
            assetId: 'forest_bird_far_01',
            targetElementId: null,
            semanticRole: 'event',
            mixIntent: 'default',
          },
        ],
        selectedAssetIds: ['forest_bird_far_01'],
        reasonCodes: [],
        rationale: 'test motion-bound event',
      },
      decision: decision('within-scene'),
      basePlan,
      nowMs: 200_000,
      config: phase1Config,
    });
    const event = patch.operations[0]?.insertedElement?.payload as
      import('@neuroscape/contracts').EventPlanItem | undefined;
    expect(event?.motion).toMatchObject({ motionMode: 'pass-by' });
    expect(event?.motion?.startPosition).not.toEqual(
      event?.motion?.endPosition,
    );
    expect(event?.durationMs).toBe(6_000);
    expect(event?.playback).toEqual({
      mode: 'loop',
      durationPolicy: 'loop-until-end',
    });
  });

  it('resolves authored playback/gain and commits a canonical adjacent journey projection', () => {
    const basePlan = createForestBasePlan(phase1Config);
    const output: Decision2SemanticOutput = {
      status: 'CHANGE_PROPOSED',
      destinationNodeId: 'stream_bank',
      changes: [
        {
          operation: 'INSERT',
          assetId: 'stream_lakeside_river',
          targetElementId: null,
          semanticRole: 'foundation',
          mixIntent: 'slightly_softer',
        },
      ],
      selectedAssetIds: ['stream_lakeside_river'],
      reasonCodes: ['COHERENT_WATER_TRANSITION'],
      rationale: 'test',
    };
    const patch = materializeSemanticDecision2({
      adaptationId: 'a1',
      output,
      decision: decision('scene-transition'),
      basePlan,
      nowMs: 200_000,
      config: phase1Config,
    });
    expect(patch.journeyUpdate).toMatchObject({
      fromNodeId: 'forest_clearing',
      toNodeId: 'stream_bank',
    });
    const inserted = patch.operations[0]?.insertedElement;
    expect(inserted?.payload.playback).toBeDefined();
    expect(inserted?.gain).toBe(0.255);
    expect(patch.operations[0]?.transitionMs).toBe(SCENE_TRAVERSAL_DURATION_MS);
    expect(patch.operations).toContainEqual(
      expect.objectContaining({
        operation: 'SUPPRESS',
        targetElementId: 'base-ambient',
        transitionMs: SCENE_TRAVERSAL_DURATION_MS,
        systemGenerated: 'scene_transition_foundation_handoff',
      }),
    );
    const locomotion = patch.operations.find(
      (operation) => operation.systemGenerated === 'scene_transition_footsteps',
    );
    expect(locomotion?.insertedElement?.assetId).toBe(
      'forest_body_slow_creek_steps_01',
    );
    expect(locomotion?.insertedElement?.payload).toMatchObject({
      attachment: 'feet',
      activationCondition: 'listener-moving',
      playback: { mode: 'loop-until-arrival' },
    });
    expect(
      locomotion!.insertedElement!.endMs - locomotion!.insertedElement!.startMs,
    ).toBe(SCENE_TRAVERSAL_DURATION_MS);
    expect(
      patch.journeyUpdate!.arrivalTimeMs -
        (200_000 + phase1Config.executionFreezeBufferMs),
    ).toBe(SCENE_TRAVERSAL_DURATION_MS);

    expect(inserted?.startMs).toBe(
      200_000 + phase1Config.executionFreezeBufferMs,
    );
    const validation = validateAndProjectPatch({
      basePlan,
      acceptedPatches: [],
      proposedPatch: patch,
      nowMs: 200_000,
      config: phase1Config,
    });
    expect(validation.valid).toBe(true);
    const foundation = validation.projectedPlan?.scheduledElements.find(
      (element) => element.assetId === 'stream_lakeside_river',
    );
    expect(
      foundation!.endMs - patch.journeyUpdate!.arrivalTimeMs,
    ).toBeGreaterThanOrEqual(phase1Config.destinationStabilizationMinMs);
    expect(
      materializeBasePlan(validation.projectedPlan!).userJourney.waypoints.at(
        -1,
      )?.locationId,
    ).toBe('stream_bank');
  });

  it('uses a restrained transition-action gain floor for quiet footsteps', () => {
    const basePlan = createForestBasePlan(phase1Config);
    const patch = materializeSemanticDecision2({
      adaptationId: 'quiet-steps',
      output: {
        status: 'CHANGE_PROPOSED',
        destinationNodeId: 'dense_forest',
        changes: [
          {
            operation: 'INSERT',
            assetId: 'forest_ambient_bed_02',
            targetElementId: null,
            semanticRole: 'foundation',
            mixIntent: null,
          },
        ],
        selectedAssetIds: ['forest_ambient_bed_02'],
        reasonCodes: [],
        rationale: 'test',
      },
      decision: decision('scene-transition'),
      basePlan,
      nowMs: 200_000,
      config: phase1Config,
    });
    const footsteps = patch.operations.find(
      (operation) => operation.systemGenerated === 'scene_transition_footsteps',
    )?.insertedElement;
    expect(footsteps?.assetId).toBe('forest_grass_footstep_01');
    expect(footsteps?.gain).toBe(TRANSITION_FOOTSTEP_GAIN_PRESET);
    expect((footsteps?.payload as { gain: number }).gain).toBe(
      TRANSITION_FOOTSTEP_GAIN_PRESET,
    );
  });

  it('maps normal and slow traversal presets to distinct deterministic durations', () => {
    const basePlan = createForestBasePlan(phase1Config);
    const make = (traversalPreset: 'normal' | 'slow') =>
      materializeSemanticDecision2({
        adaptationId: `pace-${traversalPreset}`,
        output: {
          status: 'CHANGE_PROPOSED',
          destinationNodeId: 'stream_bank',
          traversalPreset,
          changes: [
            {
              operation: 'INSERT',
              assetId: 'stream_lakeside_river',
              targetElementId: null,
              semanticRole: 'foundation',
              mixIntent: null,
            },
          ],
          selectedAssetIds: ['stream_lakeside_river'],
          reasonCodes: [],
          rationale: 'test',
        },
        decision: decision('scene-transition'),
        basePlan,
        nowMs: 200_000,
        config: phase1Config,
      });
    const normal = make('normal');
    const slow = make('slow');
    const start = 200_000 + phase1Config.executionFreezeBufferMs;
    expect(normal.journeyUpdate!.arrivalTimeMs - start).toBe(
      TRAVERSAL_DURATION_PRESETS_MS.normal,
    );
    expect(slow.journeyUpdate!.arrivalTimeMs - start).toBe(
      TRAVERSAL_DURATION_PRESETS_MS.slow,
    );
    expect(slow.journeyUpdate!.arrivalTimeMs).toBeGreaterThan(
      normal.journeyUpdate!.arrivalTimeMs,
    );
  });

  it('selects authored footsteps for forest, city, water, and beach surfaces', () => {
    expect(footstepAssetForTransition('forest_clearing', 'dense_forest')).toBe(
      'forest_grass_footstep_01',
    );
    expect(footstepAssetForTransition('forest_edge', 'city_park')).toBe(
      'citypark_walk_on_the_street',
    );
    expect(footstepAssetForTransition('forest_edge', 'beach_shore')).toBe(
      'ocean_wet_sand_footstep_01',
    );
    expect(footstepAssetForTransition('stream_bank', 'lakeside_river')).toBe(
      'forest_body_slow_creek_steps_01',
    );
  });

  it('hands the same active foundation from one committed destination to the next', () => {
    const basePlan = createForestBasePlan(phase1Config);
    const transition = (
      adaptationId: string,
      destinationNodeId: string,
      assetId: string,
      committedBasePlan = basePlan,
      nowMs = 200_000,
    ) =>
      materializeSemanticDecision2({
        adaptationId,
        output: {
          status: 'CHANGE_PROPOSED',
          destinationNodeId,
          changes: [
            {
              operation: 'INSERT',
              assetId,
              targetElementId: null,
              semanticRole: 'foundation',
              mixIntent: 'default',
            },
          ],
          selectedAssetIds: [assetId],
          reasonCodes: [],
          rationale: 'test handoff',
        },
        decision: decision('scene-transition'),
        basePlan: committedBasePlan,
        nowMs,
        config: phase1Config,
      });
    const first = transition('first', 'stream_bank', 'stream_lakeside_river');
    const firstValidation = validateAndProjectPatch({
      basePlan,
      acceptedPatches: [],
      proposedPatch: first,
      nowMs: 200_000,
      config: phase1Config,
    });
    expect(firstValidation.valid).toBe(true);
    const committedStream = firstValidation.projectedPlan!;
    const second = transition(
      'second',
      'lakeside_river',
      'stream_lakeside_river',
      committedStream,
      350_000,
    );
    expect(second.journeyUpdate).toMatchObject({
      fromNodeId: 'stream_bank',
      toNodeId: 'lakeside_river',
    });
    expect(
      second.operations.filter(
        (operation) =>
          operation.operation === 'INSERT' &&
          operation.insertedElement?.assetId === 'stream_lakeside_river',
      ),
    ).toHaveLength(0);
    expect(second.operations).toContainEqual(
      expect.objectContaining({
        operation: 'REPLACE',
        replacementAssetId: 'stream_lakeside_river',
        destinationFoundationFor: 'lakeside_river',
      }),
    );
    const secondValidation = validateAndProjectPatch({
      basePlan: committedStream,
      acceptedPatches: [first],
      proposedPatch: second,
      nowMs: 350_000,
      config: phase1Config,
    });
    expect(secondValidation.valid).toBe(true);
    expect(
      secondValidation.projection.projectedAmbientLayers,
    ).toBeLessThanOrEqual(phase1Config.maxAmbientLayers);
    expect(
      secondValidation.projection.projectedConcurrentSources,
    ).toBeLessThanOrEqual(phase1Config.maxConcurrentSources);
    expect(
      secondValidation.projectedPlan?.scheduledElements.filter(
        (element) => element.assetId === 'stream_lakeside_river',
      ),
    ).toHaveLength(1);
    expect(
      secondValidation.projectedPlan?.scheduledElements.find(
        (element) => element.assetId === 'stream_lakeside_river',
      )?.destinationFoundationFor,
    ).toBe('lakeside_river');
  });

  it('replaces the prior committed foundation when the next asset differs', () => {
    const basePlan = createForestBasePlan(phase1Config);
    basePlan.journey.waypoints.push({
      locationId: 'stream_bank',
      arrivalTimeMs: 200_000,
    });
    basePlan.scheduledElements = [
      {
        ...basePlan.scheduledElements[0]!,
        elementId: 'committed-stream-foundation',
        assetId: 'stream_lakeside_river',
        destinationFoundationFor: 'stream_bank',
        payload: {
          ...basePlan.scheduledElements[0]!.payload,
          assetId: 'stream_lakeside_river',
          mode: 'localized',
          locationId: 'stream_bank',
        },
      },
    ];
    const patch = materializeSemanticDecision2({
      adaptationId: 'different-foundation',
      output: {
        status: 'CHANGE_PROPOSED',
        destinationNodeId: 'forest_clearing',
        changes: [
          {
            operation: 'INSERT',
            assetId: 'forest_ambient_bed_01',
            targetElementId: null,
            semanticRole: 'foundation',
            mixIntent: 'default',
          },
        ],
        selectedAssetIds: ['forest_ambient_bed_01'],
        reasonCodes: [],
        rationale: 'different foundation handoff',
      },
      decision: decision('scene-transition'),
      basePlan,
      nowMs: 350_000,
      config: phase1Config,
    });
    expect(patch.operations).toContainEqual(
      expect.objectContaining({
        operation: 'INSERT',
        destinationFoundationFor: 'forest_clearing',
      }),
    );
    expect(patch.operations).toContainEqual(
      expect.objectContaining({
        operation: 'SUPPRESS',
        targetElementId: 'committed-stream-foundation',
        systemGenerated: 'scene_transition_foundation_handoff',
      }),
    );
  });

  it('rejects locomotion from within-scene output and incoherent destination audio', () => {
    const basePlan = createForestBasePlan(phase1Config);
    const make = (
      scope: 'within-scene' | 'scene-transition',
      assetId: string,
    ) =>
      materializeSemanticDecision2({
        adaptationId: 'a2',
        decision: decision(scope),
        basePlan,
        nowMs: 200_000,
        config: phase1Config,
        output: {
          status: 'CHANGE_PROPOSED',
          destinationNodeId: 'stream_bank',
          changes: [
            {
              operation: 'INSERT',
              assetId,
              targetElementId: null,
              semanticRole: 'event',
              mixIntent: 'default',
            },
          ],
          selectedAssetIds: [assetId],
          reasonCodes: [],
          rationale: 'test',
        },
      });
    expect(make('within-scene', 'forest_bird_far_01').status).toBe(
      'NO_SAFE_PATCH',
    );
    expect(make('scene-transition', 'citypark_dog').reasonCodes).toContain(
      'SCENE_AUDIO_INCOHERENT',
    );
    expect(
      validateAndProjectPatch({
        basePlan,
        acceptedPatches: [],
        proposedPatch: make('scene-transition', 'forest_water_drop_far_01'),
        nowMs: 200_000,
        config: phase1Config,
      }).violations,
    ).toContain('DESTINATION_ACOUSTIC_FOUNDATION_MISSING');
  });
});
