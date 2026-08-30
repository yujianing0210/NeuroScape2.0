import { describe, expect, it } from 'vitest';
import { sceneJourneyPlanFixture } from '../fixtures/phase1Fixtures.js';
import { createRuntimeHarness } from '../helpers/createRuntimeHarness.js';

describe('RuntimeController Phase 2 integration', () => {
  it('orchestrates controllers and publishes immutable complete frames', () => {
    const { controller } = createRuntimeHarness();
    controller.initialize(sceneJourneyPlanFixture);
    const state = controller.update(1_000);

    expect(state.timestampMs).toBe(1_000);
    expect(state.listener.worldPosition[2]).toBeLessThan(0);
    expect(state.ambient).toHaveLength(2);
    expect(state.action.some((item) => item.id === 'breathing')).toBe(true);
    expect(state.event.some((item) => item.id === 'bird-001')).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('replaces future journey intention without teleporting the listener', () => {
    const { controller } = createRuntimeHarness();
    controller.initialize(sceneJourneyPlanFixture);
    controller.update(4_000);
    const before = controller.currentState!.listener.worldPosition;

    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'plan-002',
      userJourney: {
        goal: 'return to the entry',
        waypoints: [{ locationId: 'clearing' }, { locationId: 'forest_entry' }],
      },
    });

    expect(controller.currentState!.listener.worldPosition).toEqual(before);
    expect(controller.update(0).listener.worldPosition).toEqual(before);
    expect(controller.update(100).listener.worldPosition).not.toEqual([
      0, 0, 0,
    ]);
  });

  it('reuses compatible sounds and applies replacements immediately', () => {
    const { controller } = createRuntimeHarness();
    controller.initialize(sceneJourneyPlanFixture);
    controller.update(2_000);
    const beforeGain = controller.currentState!.ambient.find(
      (item) => item.id === 'forest-bed',
    )!.gain;

    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'compatible',
      soundscape: {
        ...sceneJourneyPlanFixture.soundscape,
        ambient: sceneJourneyPlanFixture.soundscape.ambient.map((item) =>
          item.id === 'forest-bed' ? { ...item, gain: 0.6 } : item,
        ),
      },
    });
    const compatibleFrame = controller.update(500);
    expect(
      compatibleFrame.ambient.filter((item) => item.id === 'forest-bed'),
    ).toHaveLength(1);
    expect(
      compatibleFrame.ambient.find((item) => item.id === 'forest-bed')!.gain,
    ).toBeGreaterThan(beforeGain);

    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'incompatible',
      soundscape: {
        ...sceneJourneyPlanFixture.soundscape,
        ambient: sceneJourneyPlanFixture.soundscape.ambient.map((item) =>
          item.id === 'forest-bed'
            ? { ...item, assetId: 'ambient.replacement' }
            : item,
        ),
      },
    });
    const fadingFrame = controller.update(1_000);
    expect(
      fadingFrame.ambient.find((item) => item.id === 'forest-bed')!.assetId,
    ).toBe('ambient.replacement');
    controller.update(1_000);
    const replacedFrame = controller.update(1);
    expect(
      replacedFrame.ambient.find((item) => item.id === 'forest-bed')!.assetId,
    ).toBe('ambient.replacement');
  });

  it('preserves the current snapshot when an invalid plan is rejected', () => {
    const { controller } = createRuntimeHarness();
    controller.initialize(sceneJourneyPlanFixture);
    const previous = controller.update(100);
    const invalidPlan = {
      ...sceneJourneyPlanFixture,
      userJourney: { goal: 'invalid', waypoints: [{ locationId: 'missing' }] },
    };
    expect(() => controller.applyPlan(invalidPlan)).toThrow(
      /Invalid SceneJourneyPlan/,
    );
    expect(controller.currentState).toBe(previous);
  });

  it('coordinates an authored scene transition without teleporting', () => {
    const { controller, events } = createRuntimeHarness();
    controller.initialize(sceneJourneyPlanFixture);
    controller.update(1_000);
    const before = controller.currentState!.listener.worldPosition;

    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'scene-transition',
      userJourney: {
        goal: 'move to clearing',
        waypoints: [
          { locationId: 'forest_entry' },
          { locationId: 'clearing', arrivalTimeMs: 26_000 },
        ],
      },
    });

    expect(controller.currentState!.listener.worldPosition).toEqual(before);
    expect(controller.sceneTransitionState).toMatchObject({
      fromLocationId: 'forest_entry',
      toLocationId: 'clearing',
      phase: 'traversing',
      arrivalTimeMs: 26_000,
    });
    controller.update(24_000);
    expect(controller.currentState!.listener.semanticLocation).toBe(
      'forest_entry',
    );
    controller.update(1_000);
    expect(controller.currentState!.listener.semanticLocation).toBe('clearing');
    expect(controller.sceneTransitionState?.phase).toBe('arriving');
    expect(
      events.history.some((event) => event.type === 'SceneTransitionStarted'),
    ).toBe(true);
  });

  it('reconciles scene transition state when a plan rolls back', () => {
    const { controller } = createRuntimeHarness();

    controller.initialize(sceneJourneyPlanFixture);
    controller.update(1_000);

    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'transition-before-rollback',
      userJourney: {
        goal: 'move to clearing',
        waypoints: [
          { locationId: 'forest_entry' },
          { locationId: 'clearing', arrivalTimeMs: 26_000 },
        ],
      },
    });

    expect(controller.sceneTransitionState?.toLocationId).toBe('clearing');

    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'rollback-to-origin',
      userJourney: {
        goal: 'restore origin',
        waypoints: [{ locationId: 'forest_entry', arrivalTimeMs: 0 }],
      },
    });

    expect(controller.sceneTransitionState).toBeUndefined();
  });

  it('crossfades origin and destination ambience across traversal', () => {
    const { controller } = createRuntimeHarness();
    const originPlan = {
      ...sceneJourneyPlanFixture,
      userJourney: {
        goal: 'stay',
        waypoints: [{ locationId: 'forest_entry', arrivalTimeMs: 0 }],
      },
      soundscape: {
        ambient: [
          {
            id: 'origin-bed',
            assetId: 'ambient.forest-wind',
            mode: 'global' as const,
            gain: 0.4,
            active: true,
          },
        ],
        action: [],
        event: [],
      },
    };
    controller.initialize(originPlan);
    controller.update(2_000);
    controller.applyPlan({
      ...originPlan,
      planId: 'crossfade-to-clearing',
      userJourney: {
        goal: 'move',
        waypoints: [
          { locationId: 'forest_entry', arrivalTimeMs: 0 },
          { locationId: 'clearing', arrivalTimeMs: 22_000 },
        ],
      },
      soundscape: {
        ...originPlan.soundscape,
        ambient: [
          {
            id: 'destination-bed',
            assetId: 'ambient.replacement',
            mode: 'global',
            gain: 0.5,
            active: true,
          },
        ],
      },
    });

    const midpoint = controller.update(10_000).ambient;
    const origin = midpoint.find((item) => item.id === 'origin-bed')!;
    const destination = midpoint.find((item) => item.id === 'destination-bed')!;
    expect(origin.gain).toBeCloseTo(0.2);
    expect(destination.gain).toBeCloseTo(0.25);
    expect(destination.gain).toBeGreaterThan(origin.gain);

    controller.update(10_000);
    const arrived = controller.update(0).ambient;
    expect(arrived.some((item) => item.id === 'origin-bed')).toBe(false);
    expect(
      arrived.find((item) => item.id === 'destination-bed')?.gain,
    ).toBeCloseTo(0.5);
  });

  it('restores origin ambience and removes destination ambience on rollback', () => {
    const { controller } = createRuntimeHarness();
    const originPlan = {
      ...sceneJourneyPlanFixture,
      userJourney: {
        goal: 'stay',
        waypoints: [{ locationId: 'forest_entry', arrivalTimeMs: 0 }],
      },
      soundscape: {
        ambient: [
          {
            id: 'origin-bed',
            assetId: 'ambient.forest-wind',
            mode: 'global' as const,
            gain: 0.4,
            active: true,
          },
        ],
        action: [],
        event: [],
      },
    };
    controller.initialize(originPlan);
    controller.update(2_000);
    controller.applyPlan({
      ...originPlan,
      planId: 'crossfade-before-rollback',
      userJourney: {
        goal: 'move',
        waypoints: [
          { locationId: 'forest_entry', arrivalTimeMs: 0 },
          { locationId: 'clearing', arrivalTimeMs: 22_000 },
        ],
      },
      soundscape: {
        ...originPlan.soundscape,
        ambient: [
          {
            id: 'destination-bed',
            assetId: 'ambient.replacement',
            mode: 'global',
            gain: 0.5,
            active: true,
          },
        ],
      },
    });
    controller.update(10_000);
    controller.applyPlan({ ...originPlan, planId: 'restore-origin' });
    controller.update(originPlan.transitionPolicy.defaultDurationMs);
    controller.update(0);
    const settled = controller.currentState!.ambient;
    expect(settled.find((item) => item.id === 'origin-bed')?.gain).toBeCloseTo(
      0.4,
    );
    expect(settled.some((item) => item.id === 'destination-bed')).toBe(false);
  });

  it('continues an active journey when a within-scene audio patch is applied', () => {
    const { controller, events } = createRuntimeHarness();
    let committedLocation = 'forest_entry';
    events.subscribe((event) => {
      if (event.type === 'SemanticLocationChanged')
        committedLocation = event.locationId;
    });

    controller.initialize({
      ...sceneJourneyPlanFixture,
      userJourney: {
        goal: 'remain at the entry',
        waypoints: [{ locationId: 'forest_entry', arrivalTimeMs: 0 }],
      },
    });
    controller.update(1_000);
    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'transition-to-clearing',
      userJourney: {
        goal: 'move to clearing',
        waypoints: [
          { locationId: 'forest_entry', arrivalTimeMs: 0 },
          { locationId: 'clearing', arrivalTimeMs: 26_000 },
        ],
      },
      soundscape: {
        ...sceneJourneyPlanFixture.soundscape,
        action: [
          {
            id: 'transition-footsteps',
            assetId: 'action.footsteps',
            attachment: 'feet',
            relativePosition: [0, -1, 0],
            gain: 0.35,
            active: true,
            startMs: 1_000,
            endMs: 26_000,
            activationCondition: 'listener-moving',
            playback: {
              mode: 'loop-until-arrival',
              durationPolicy: 'truncate-at-end',
            },
          },
        ],
      },
    });
    controller.update(9_000);

    controller.applyPlan(
      {
        ...sceneJourneyPlanFixture,
        planId: 'within-scene-wind-patch',
        userJourney: {
          goal: 'remain at the committed origin',
          waypoints: [{ locationId: 'forest_entry', arrivalTimeMs: 0 }],
        },
        soundscape: {
          ...sceneJourneyPlanFixture.soundscape,
          ambient: sceneJourneyPlanFixture.soundscape.ambient.map((item) =>
            item.id === 'forest-bed' ? { ...item, gain: 0.5 } : item,
          ),
        },
      },
      { preserveActiveJourney: true },
    );

    expect(controller.sceneTransitionState).toMatchObject({
      fromLocationId: 'forest_entry',
      toLocationId: 'clearing',
      phase: 'traversing',
    });
    expect(
      controller.currentState!.action.some(
        (item) => item.id === 'transition-footsteps',
      ),
    ).toBe(true);
    expect(controller.currentState!.listener.semanticLocation).toBe(
      'forest_entry',
    );

    controller.update(16_000);

    expect(controller.currentState!.listener.semanticLocation).toBe('clearing');
    expect(committedLocation).toBe('clearing');
    expect(
      controller.currentState!.action.find(
        (item) => item.id === 'transition-footsteps',
      )?.active,
    ).toBe(false);
    expect(
      events.history.some(
        (event) =>
          event.type === 'SemanticLocationChanged' &&
          event.locationId === 'clearing',
      ),
    ).toBe(true);
    expect(
      events.history.some(
        (event) => event.type === 'SceneTransitionRolledBack',
      ),
    ).toBe(false);
  });

  it('removes loop-until-arrival footsteps when a journey rolls back', () => {
    const { controller } = createRuntimeHarness();
    controller.initialize({
      ...sceneJourneyPlanFixture,
      userJourney: {
        goal: 'stay',
        waypoints: [{ locationId: 'forest_entry', arrivalTimeMs: 0 }],
      },
    });
    controller.update(1_000);
    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'journey-with-looping-steps',
      planningHorizonSec: 40,
      userJourney: {
        goal: 'move',
        waypoints: [
          { locationId: 'forest_entry', arrivalTimeMs: 0 },
          { locationId: 'clearing', arrivalTimeMs: 33_000 },
        ],
      },
      soundscape: {
        ...sceneJourneyPlanFixture.soundscape,
        action: [
          {
            id: 'steps',
            assetId: 'action.steps',
            attachment: 'feet',
            relativePosition: [0, -1, 0],
            gain: 0.3,
            active: true,
            startMs: 1_000,
            endMs: 33_000,
            activationCondition: 'listener-moving',
            playback: {
              mode: 'loop-until-arrival',
              durationPolicy: 'truncate-at-end',
            },
          },
        ],
      },
    });
    controller.update(1_000);
    expect(
      controller.currentState!.action.find((item) => item.id === 'steps')
        ?.active,
    ).toBe(true);
    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'rollback',
      userJourney: {
        goal: 'restore',
        waypoints: [{ locationId: 'forest_entry', arrivalTimeMs: 0 }],
      },
    });
    expect(controller.sceneTransitionState).toBeUndefined();
    controller.update(
      sceneJourneyPlanFixture.transitionPolicy.defaultDurationMs,
    );
    controller.update(0);
    expect(
      controller.currentState!.action.some((item) => item.id === 'steps'),
    ).toBe(false);
  });

  it('requires initialization, validates elapsed time, and supports shutdown', () => {
    const { controller } = createRuntimeHarness();
    expect(() => controller.update(1)).toThrow(/not initialized/);
    controller.initialize(sceneJourneyPlanFixture);
    expect(() => controller.update(-1)).toThrow(/non-negative/);
    controller.shutdown();
    expect(controller.currentState).toBeUndefined();
  });

  it('emits rollback lifecycle when an active scene transition is abandoned', () => {
    const { controller, events } = createRuntimeHarness();

    controller.initialize(sceneJourneyPlanFixture);
    controller.update(1_000);

    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'transition-before-rollback',
      userJourney: {
        goal: 'move to clearing',
        waypoints: [
          { locationId: 'forest_entry' },
          { locationId: 'clearing', arrivalTimeMs: 26_000 },
        ],
      },
    });

    controller.applyPlan({
      ...sceneJourneyPlanFixture,
      planId: 'rollback-to-origin',
      userJourney: {
        goal: 'restore origin',
        waypoints: [{ locationId: 'forest_entry', arrivalTimeMs: 0 }],
      },
    });

    expect(
      events.history.some((event) => event.type === 'SceneTransitionFailed'),
    ).toBe(true);

    expect(
      events.history.some(
        (event) => event.type === 'SceneTransitionRolledBack',
      ),
    ).toBe(true);

    expect(controller.currentState!.listener.semanticLocation).toBe(
      'forest_entry',
    );
  });
});
