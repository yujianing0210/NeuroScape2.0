import { describe, expect, it } from 'vitest';
import { AmbientController } from '../../src/controllers/AmbientController.js';
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

function createAmbient() {
  const transitions = new TransitionController(new RuntimeEventBus());
  transitions.initialize();
  const ambient = new AmbientController(
    new SemanticLocationMapper(new SceneGraph(sceneGraphDefinitionFixture)),
    transitions,
  );
  return { ambient, transitions };
}

describe('AmbientController', () => {
  it('transitions global ambient gain without a world position', () => {
    const transitions = new TransitionController(new RuntimeEventBus());
    transitions.initialize();
    const ambient = new AmbientController(
      new SemanticLocationMapper(new SceneGraph(sceneGraphDefinitionFixture)),
      transitions,
    );
    ambient.initialize(
      [
        {
          id: 'wind',
          assetId: 'ambient.wind',
          mode: 'global',
          gain: 0.8,
          active: true,
        },
      ],
      { defaultDurationMs: 1_000, curve: 'linear' },
    );
    ambient.update(500, listener);
    transitions.update(500);
    expect(ambient.getStates(listener)[0]).toMatchObject({
      gain: 0.4,
      active: true,
    });
    expect(ambient.getStates(listener)[0]?.worldPosition).toBeUndefined();
  });

  it('anchors localized ambient and applies only the validated distance policy', () => {
    const transitions = new TransitionController(new RuntimeEventBus());
    transitions.initialize();
    const ambient = new AmbientController(
      new SemanticLocationMapper(new SceneGraph(sceneGraphDefinitionFixture)),
      transitions,
    );
    ambient.initialize(
      [
        {
          id: 'stream',
          assetId: 'ambient.stream',
          mode: 'localized',
          locationId: 'stream_bank',
          gain: 1,
          active: true,
          distancePolicy: {
            mode: 'inverse',
            referenceDistance: 6,
            minGain: 0.2,
          },
        },
      ],
      { defaultDurationMs: 1, curve: 'linear' },
    );
    transitions.update(1);
    const state = ambient.getStates(listener)[0]!;
    expect(state.worldPosition).toEqual([0, 0, -12]);
    expect(state.gain).toBeCloseTo(0.5);
  });

  it('uses gradual authored fades for stream and ocean beds', () => {
    const stream = createAmbient();
    stream.ambient.initialize(
      [
        {
          id: 'water-bed',
          assetId: 'stream_lakeside_river',
          mode: 'localized',
          locationId: 'stream_bank',
          gain: 1,
          active: true,
        },
      ],
      { defaultDurationMs: 750, curve: 'linear' },
    );
    expect(
      stream.transitions.getTransition('ambient:water-bed:gain')?.durationMs,
    ).toBe(2_000);

    const ocean = createAmbient();
    ocean.ambient.initialize(
      [
        {
          id: 'ocean-bed',
          assetId: 'ocean_waves_soft_01',
          mode: 'global',
          gain: 1,
          active: true,
        },
      ],
      { defaultDurationMs: 750, curve: 'linear' },
    );
    expect(
      ocean.transitions.getTransition('ambient:ocean-bed:gain')?.durationMs,
    ).toBe(4_000);
  });

  it('keeps a suppressed environmental source until its authored fade-out completes', () => {
    const { ambient, transitions } = createAmbient();
    ambient.initialize(
      [
        {
          id: 'stream',
          assetId: 'stream_lakeside_river',
          mode: 'localized',
          locationId: 'stream_bank',
          gain: 1,
          active: true,
        },
      ],
      { defaultDurationMs: 500, curve: 'linear' },
    );
    transitions.update(2_000);
    ambient.merge([], { defaultDurationMs: 500, curve: 'linear' });
    expect(transitions.getTransition('ambient:stream:gain')?.durationMs).toBe(
      2_000,
    );
    transitions.update(1_000);
    expect(ambient.getStates(listener)[0]?.gain).toBeCloseTo(0.5);
    expect(ambient.size).toBe(1);
    transitions.update(1_000);
    ambient.update(0, listener);
    expect(ambient.size).toBe(0);
  });

  it('starts an authored fade-out before a planned environmental end', () => {
    const { ambient, transitions } = createAmbient();
    ambient.initialize(
      [
        {
          id: 'ocean',
          assetId: 'ocean_waves_soft_01',
          mode: 'global',
          gain: 1,
          active: true,
          startMs: 0,
          endMs: 20_000,
        },
      ],
      { defaultDurationMs: 500, curve: 'linear' },
    );
    transitions.update(4_000);
    ambient.update(16_000, listener);
    expect(transitions.getTransition('ambient:ocean:gain')?.durationMs).toBe(
      4_000,
    );
    transitions.update(2_000);
    expect(ambient.getStates(listener)[0]?.gain).toBeCloseTo(0.5);
  });

  it('fades out a replaced foundation before fading in its replacement', () => {
    const { ambient, transitions } = createAmbient();
    ambient.initialize(
      [
        {
          id: 'foundation',
          assetId: 'stream_lakeside_river',
          mode: 'global',
          gain: 1,
          active: true,
        },
      ],
      { defaultDurationMs: 500, curve: 'linear' },
    );
    transitions.update(2_000);
    ambient.merge(
      [
        {
          id: 'foundation',
          assetId: 'ocean_waves_soft_01',
          mode: 'global',
          gain: 0.8,
          active: true,
        },
      ],
      { defaultDurationMs: 500, curve: 'linear' },
    );
    expect(ambient.getStates(listener)[0]?.assetId).toBe(
      'stream_lakeside_river',
    );
    expect(
      transitions.getTransition('ambient:foundation:gain')?.durationMs,
    ).toBe(2_000);
    transitions.update(2_000);
    ambient.update(0, listener);
    expect(ambient.getStates(listener)[0]?.assetId).toBe('ocean_waves_soft_01');
    expect(
      transitions.getTransition('ambient:foundation:gain')?.durationMs,
    ).toBe(4_000);
  });
});
