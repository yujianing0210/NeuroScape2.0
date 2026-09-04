import { describe, expect, it } from 'vitest';
import { EventController } from '../../src/controllers/EventController.js';
import { TransitionController } from '../../src/controllers/TransitionController.js';
import { RuntimeEventBus } from '../../src/events/RuntimeEvents.js';
import { SceneGraph } from '../../src/scene-graph/SceneGraph.js';
import { SemanticLocationMapper } from '../../src/scene-graph/SemanticLocationMapper.js';
import { sceneGraphDefinitionFixture } from '../fixtures/phase1Fixtures.js';

const listener = {
  worldPosition: [0, 0, 0] as [number, number, number],
  orientation: [0, 0, 0, 1] as [number, number, number, number],
  velocity: [0, 0, 0] as [number, number, number],
  semanticLocation: 'forest_entry',
};

function createEvents() {
  const bus = new RuntimeEventBus();
  const transitions = new TransitionController(bus);
  transitions.initialize();
  const controller = new EventController(
    new SemanticLocationMapper(new SceneGraph(sceneGraphDefinitionFixture)),
    transitions,
    bus,
  );
  return { controller, transitions, bus };
}

const eventPlan = {
  id: 'bird',
  assetId: 'event.bird',
  activationTimeMs: 1_000,
  durationMs: 4_000,
  trajectory: [
    { locationId: 'forest_entry', timestampMs: 1_000 },
    { locationId: 'clearing', timestampMs: 5_000 },
  ],
  gain: 0.8,
};

describe('EventController', () => {
  it('uses the authored short envelope for a canonical motion-bound bird', () => {
    const { controller, transitions } = createEvents();
    controller.initialize(
      [
        {
          ...eventPlan,
          assetId: 'forest_bird_far_01',
          activationTimeMs: 0,
          durationMs: 6_000,
          trajectory: undefined,
          motion: {
            motionMode: 'pass-by' as const,
            startPosition: [3.8, 2.2, 5.5] as [number, number, number],
            endPosition: [-2.5, 2, 5.8] as [number, number, number],
          },
          playback: {
            mode: 'loop' as const,
            durationPolicy: 'loop-until-end' as const,
          },
        },
      ],
      { defaultDurationMs: 5_000, curve: 'linear' },
    );
    controller.update(0, listener);
    expect(transitions.getTransition('event:bird:gain')?.durationMs).toBe(500);
    expect(controller.getStates(listener)[0]?.playback).toMatchObject({
      mode: 'loop',
      durationPolicy: 'loop-until-end',
    });
    controller.update(4_500, listener);
    expect(transitions.getTransition('event:bird:gain')?.durationMs).toBe(
      1_500,
    );
  });

  it('moves an orbit-arc event through a restrained partial arc', () => {
    const { controller, transitions } = createEvents();
    controller.initialize(
      [
        {
          ...eventPlan,
          trajectory: undefined,
          durationMs: 8_000,
          motion: {
            motionMode: 'orbit-arc' as const,
            startPosition: [-7, 1, 3] as [number, number, number],
            endPosition: [6, 1, 3] as [number, number, number],
            arcDirection: 'counterclockwise' as const,
          },
        },
      ],
      { defaultDurationMs: 100, curve: 'linear' },
    );
    controller.update(1_000, listener);
    transitions.update(1_000);
    const start = controller.getStates(listener)[0]!.worldPosition;
    controller.update(4_000, listener);
    transitions.update(4_000);
    const middle = controller.getStates(listener)[0]!.worldPosition;
    expect(middle).not.toEqual(start);
    expect(middle[2]).not.toBe(3);
  });

  it('moves a pass-by event from one side of the listener to the other', () => {
    const { controller, transitions } = createEvents();
    controller.initialize(
      [
        {
          ...eventPlan,
          trajectory: undefined,
          durationMs: 8_000,
          motion: {
            motionMode: 'pass-by' as const,
            startPosition: [-7, 1, 3] as [number, number, number],
            controlPoint: [-3.5, 1, -2] as [number, number, number],
            endPosition: [6, 1, 3] as [number, number, number],
          },
        },
      ],
      { defaultDurationMs: 100, curve: 'linear' },
    );
    controller.update(1_000, listener);
    transitions.update(1_000);
    expect(controller.getStates(listener)[0]!.worldPosition[0]).toBeLessThan(0);
    controller.update(6_500, listener);
    transitions.update(6_500);
    expect(controller.getStates(listener)[0]!.worldPosition[0]).toBeGreaterThan(
      0,
    );
  });

  it('keeps repeated uses of one asset as independent event instances', () => {
    const { controller } = createEvents();
    controller.initialize(
      [
        { ...eventPlan, id: 'bird-1' },
        {
          ...eventPlan,
          id: 'bird-2',
          activationTimeMs: 6_000,
          trajectory: eventPlan.trajectory.map((x) => ({
            ...x,
            timestampMs: x.timestampMs + 5_000,
          })),
        },
      ],
      { defaultDurationMs: 100, curve: 'linear' },
    );
    expect(controller.getStates(listener).map((item) => item.id)).toEqual([
      'bird-1',
      'bird-2',
    ]);
    expect(
      new Set(controller.getStates(listener).map((item) => item.assetId)),
    ).toEqual(new Set(['event.bird']));
  });
  it('retains future events as waiting and honors the exact planned end', () => {
    const { controller, transitions } = createEvents();
    controller.initialize([eventPlan], {
      defaultDurationMs: 100,
      curve: 'linear',
    });
    controller.update(999, listener);
    transitions.update(999);
    expect(controller.getStates(listener)[0]).toMatchObject({
      assetId: 'event.bird',
      lifecycle: 'waiting',
      active: false,
    });

    controller.update(1, listener);
    transitions.update(100);
    expect(controller.getStates(listener)[0]?.lifecycle).toBe('active');

    controller.update(4_000, listener);
    transitions.update(4_000);
    expect(controller.getStates(listener)[0]).toMatchObject({
      lifecycle: 'finished',
      active: false,
    });
  });

  it('spawns, moves continuously, finishes, and removes events', () => {
    const { controller, transitions, bus } = createEvents();
    controller.initialize([eventPlan], {
      defaultDurationMs: 1_000,
      curve: 'linear',
    });
    controller.update(1_000, listener);
    transitions.update(1_000);
    expect(controller.getStates(listener)[0]).toMatchObject({
      lifecycle: 'active',
      active: true,
    });
    expect(bus.history.some((event) => event.type === 'EventSpawned')).toBe(
      true,
    );

    controller.update(1_000, listener);
    transitions.update(1_000);
    const moving = controller.getStates(listener)[0]!;
    expect(moving.worldPosition[2]).toBeLessThan(0);
    expect(moving.worldPosition[2]).toBeGreaterThan(-6);
    expect(moving.velocity[2]).toBeLessThan(0);

    controller.update(2_000, listener);
    transitions.update(2_000);
    controller.update(1_000, listener);
    transitions.update(1_000);
    expect(controller.getStates(listener)[0]?.lifecycle).toBe('finished');
    controller.update(0, listener);
    expect(controller.getStates(listener)).toEqual([]);
    expect(bus.history.some((event) => event.type === 'EventFinished')).toBe(
      true,
    );
  });

  it('keeps a three-second audible plateau and does not reuse the generic fade', () => {
    const { controller, transitions } = createEvents();
    controller.initialize([eventPlan], {
      defaultDurationMs: 5_000,
      curve: 'linear',
    });
    controller.update(1_000, listener);
    transitions.update(750);
    expect(controller.getStates(listener)[0]?.gain).toBeCloseTo(0.8);
    expect(controller.getStates(listener)[0]?.foregroundEnvelope).toBe(1);
    controller.update(2_250, listener);
    transitions.update(2_250);
    expect(controller.getStates(listener)[0]?.gain).toBeCloseTo(0.8);
  });

  it('increases resolved gain while an authored event approaches', () => {
    const { controller, transitions } = createEvents();
    controller.initialize(
      [
        {
          ...eventPlan,
          activationTimeMs: 0,
          durationMs: 8_000,
          trajectory: undefined,
          motion: {
            motionMode: 'drift' as const,
            startPosition: [0, 0, 10] as [number, number, number],
            endPosition: [0, 0, 2] as [number, number, number],
          },
          distancePolicy: {
            mode: 'inverse' as const,
            referenceDistance: 2,
            maxDistance: 10,
          },
        },
      ],
      { defaultDurationMs: 100, curve: 'linear' },
    );
    controller.update(0, listener);
    transitions.update(0);
    controller.update(750, listener);
    transitions.update(750);
    const far = controller.getStates(listener)[0]!;
    controller.update(6_000, listener);
    transitions.update(6_000);
    const near = controller.getStates(listener)[0]!;
    expect(near.worldPosition[2]).toBeLessThan(far.worldPosition[2]);
    expect(near.gain).toBeGreaterThanOrEqual(far.gain);
    expect(near.foregroundEnvelope).toBeGreaterThanOrEqual(
      far.foregroundEnvelope!,
    );
  });

  it('decreases resolved gain while an authored event recedes', () => {
    const { controller, transitions } = createEvents();
    controller.initialize(
      [
        {
          ...eventPlan,
          activationTimeMs: 0,
          durationMs: 8_000,
          trajectory: undefined,
          motion: {
            motionMode: 'drift' as const,
            startPosition: [0, 0, 2] as [number, number, number],
            endPosition: [0, 0, 10] as [number, number, number],
          },
          distancePolicy: {
            mode: 'inverse' as const,
            referenceDistance: 2,
            maxDistance: 10,
          },
        },
      ],
      { defaultDurationMs: 100, curve: 'linear' },
    );
    controller.update(0, listener);
    transitions.update(0);
    controller.update(750, listener);
    transitions.update(750);
    const near = controller.getStates(listener)[0]!;
    controller.update(6_000, listener);
    transitions.update(6_000);
    const far = controller.getStates(listener)[0]!;
    expect(far.worldPosition[2]).toBeGreaterThan(near.worldPosition[2]);
    expect(far.gain).toBeLessThanOrEqual(near.gain);
    expect(far.foregroundEnvelope).toBeLessThanOrEqual(
      near.foregroundEnvelope!,
    );
  });

  it('is frame-rate independent along a deterministic trajectory', () => {
    const directHarness = createEvents();
    const splitHarness = createEvents();
    directHarness.controller.initialize([eventPlan], {
      defaultDurationMs: 500,
      curve: 'linear',
    });
    splitHarness.controller.initialize([eventPlan], {
      defaultDurationMs: 500,
      curve: 'linear',
    });
    directHarness.controller.update(1_000, listener);
    directHarness.transitions.update(1_000);
    directHarness.controller.update(1_500, listener);
    directHarness.transitions.update(1_500);
    for (let index = 0; index < 15; index += 1) {
      splitHarness.controller.update(index === 0 ? 1_100 : 100, listener);
      splitHarness.transitions.update(index === 0 ? 1_100 : 100);
    }
    expect(
      splitHarness.controller.getStates(listener)[0]!.worldPosition,
    ).toEqual(directHarness.controller.getStates(listener)[0]!.worldPosition);
  });

  it('continues from the current position only when explicitly requested', () => {
    const { controller, transitions } = createEvents();
    controller.initialize([eventPlan], {
      defaultDurationMs: 100,
      curve: 'linear',
    });
    controller.update(2_000, listener);
    transitions.update(2_000);
    const before = controller.getStates(listener)[0]!.worldPosition;
    controller.merge(
      [
        {
          ...eventPlan,
          durationMs: 6_000,
          trajectoryUpdatePolicy: 'continue-from-current-position' as const,
          trajectory: [{ locationId: 'stream_bank', timestampMs: 7_000 }],
        },
      ],
      { defaultDurationMs: 100, curve: 'linear' },
    );
    controller.update(0, listener);
    expect(controller.getStates(listener)[0]!.worldPosition).toEqual(before);
  });
});
