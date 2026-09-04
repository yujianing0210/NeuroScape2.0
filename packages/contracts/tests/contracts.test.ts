import { describe, expect, it } from 'vitest';
import { audioLibrary, resolveAudioEnvelope } from '../src/index.js';
import type { NeuroState, RuntimeWorldState } from '../src/index.js';

describe('shared contracts', () => {
  it('accepts canonical contract fixtures', () => {
    const neuroState: NeuroState = {
      timestampMs: 0,
      arousal: { value: 0.4, trend: 'decreasing' },
      confidence: 0.9,
    };
    const runtimeState: RuntimeWorldState = {
      timestampMs: 0,
      listener: {
        worldPosition: [0, 0, 0],
        orientation: [0, 0, 0, 1],
        velocity: [0, 0, 0],
        semanticLocation: 'forest_entry',
      },
      ambient: [],
      action: [],
      event: [],
    };

    expect(neuroState.arousal.value).toBe(0.4);
    expect(runtimeState.listener.worldPosition).toEqual([0, 0, 0]);
  });

  it('loads the canonical authored audio library including motion durations', () => {
    expect(audioLibrary).toHaveLength(27);
    expect(
      audioLibrary.find((asset) => asset.asset_id === 'forest_bird_far_01')
        ?.default_motion.duration,
    ).toBe(6);
    expect(
      audioLibrary.find((asset) => asset.asset_id === 'forest_wind_leaves_01')
        ?.default_motion.duration,
    ).toBe(16);
    expect(
      audioLibrary.find(
        (asset) => asset.asset_id === 'forest_leaf_rustle_mid_01',
      )?.auto_delete_after_sec,
    ).toBe(7);
    expect(
      audioLibrary.find((asset) => asset.asset_id === 'stream_lakeside_river')
        ?.asset_ref,
    ).toBe('stream/ambient/lakeside_river.wav');
    expect(
      audioLibrary.find(
        (asset) => asset.asset_id === 'forest_body_slow_creek_steps_01',
      )?.asset_ref,
    ).toBe('stream/action/forest_body_slow_creek_steps_01.wav');
    expect(audioLibrary.some((asset) => asset.asset_id === 'ocean_waves')).toBe(
      false,
    );
    expect(
      audioLibrary.find((asset) => asset.asset_id === 'ocean_waves_soft_01')
        ?.asset_ref,
    ).toBe('ocean_beach/ambient/ocean_waves.wav');
    expect(
      audioLibrary.find((asset) => asset.asset_id === 'meditation_opening')
        ?.planner_eligible,
    ).toBe(false);
  });

  it('publishes deterministic playback, quality, and session contracts', () => {
    const byId = new Map(audioLibrary.map((asset) => [asset.asset_id, asset]));
    expect(
      byId.get('forest_soft_owl_far_01')?.playback_contract
        ?.repeat_count_options,
    ).toEqual([2, 3]);
    expect(byId.get('forest_bird_far_02')?.session_limits).toMatchObject({
      max_appearances: 3,
      min_interval_sec_exclusive: 60,
    });
    expect(byId.get('forest_small_animal_rustle_far_01')?.quality_tier).toBe(
      'limited_use',
    );
    expect(
      byId.get('forest_water_drop_far_01')?.playback_contract
        ?.resolved_lifecycle_sec,
    ).toBeCloseTo(16.823);
    expect(byId.get('body_slow_breath_01')?.asset_ref).toBe(
      'common/action/body_slow_breath_01.wav',
    );
  });

  it('resolves canonical short and environmental envelopes from authored metadata', () => {
    expect(
      resolveAudioEnvelope('forest_bird_far_01', {
        role: 'event',
        durationMs: 6_000,
        fallbackDurationMs: 5_000,
      }),
    ).toMatchObject({ fadeInMs: 500, fadeOutMs: 1_500, source: 'authored' });
    expect(
      resolveAudioEnvelope('forest_soft_owl_far_01', {
        role: 'event',
        durationMs: 16_600,
        fallbackDurationMs: 5_000,
      }),
    ).toMatchObject({ fadeInMs: 400, fadeOutMs: 1_000 });
    expect(
      resolveAudioEnvelope('stream_lakeside_river', {
        role: 'ambient',
        fallbackDurationMs: 1_000,
      }),
    ).toMatchObject({ fadeInMs: 2_000, fadeOutMs: 2_000 });
    expect(
      resolveAudioEnvelope('ocean_waves_soft_01', {
        role: 'ambient',
        fallbackDurationMs: 1_000,
      }),
    ).toMatchObject({ fadeInMs: 4_000, fadeOutMs: 4_000 });
  });

  it('proportionally clamps long authored fades while preserving a plateau', () => {
    expect(
      resolveAudioEnvelope('forest_water_drop_far_01', {
        role: 'event',
        durationMs: 16_823,
        fallbackDurationMs: 1_000,
      }),
    ).toMatchObject({ fadeInMs: 6_000, fadeOutMs: 6_000 });
    const envelope = resolveAudioEnvelope('forest_water_drop_far_01', {
      role: 'event',
      durationMs: 8_000,
      fallbackDurationMs: 1_000,
    });
    expect(envelope.fadeInMs).toBeCloseTo(2_500);
    expect(envelope.fadeOutMs).toBeCloseTo(2_500);
    expect(envelope.minimumPlateauMs).toBe(3_000);
    expect(envelope.fadeInMs + envelope.fadeOutMs).toBeLessThanOrEqual(
      8_000 - envelope.minimumPlateauMs,
    );
  });

  it('keeps compatibility IDs on the existing transition fallback without NaN timing', () => {
    expect(
      resolveAudioEnvelope('ambient.test-alias', {
        role: 'ambient',
        durationMs: 1_000,
        fallbackDurationMs: 2_000,
      }),
    ).toEqual({
      fadeInMs: 250,
      fadeOutMs: 250,
      minimumPlateauMs: 500,
      source: 'transition-fallback',
    });
  });
});
