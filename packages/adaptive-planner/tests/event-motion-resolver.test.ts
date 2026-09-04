import { describe, expect, it } from 'vitest';
import { audioLibraryById } from '@neuroscape/contracts';
import { resolveEventMotionPlayback } from '../src/event-motion-resolver.js';

function asset(id: string) {
  const value = audioLibraryById.get(id);
  if (!value) throw new Error(`Missing test asset ${id}.`);
  return value;
}

describe('authored event motion resolver', () => {
  it('binds a short bird clip to its authored pass-by lifecycle', () => {
    const resolved = resolveEventMotionPlayback(asset('forest_bird_far_01'), {
      elementId: 'bird-pass',
      gain: 0.24,
    });
    expect(resolved.motion).toMatchObject({ motionMode: 'pass-by' });
    expect(resolved.motion.startPosition).not.toEqual(
      resolved.motion.endPosition,
    );
    expect(resolved.durationMs).toBe(6_000);
    expect(resolved.playback).toEqual({
      mode: 'loop',
      durationPolicy: 'loop-until-end',
    });
    expect(resolved.distancePolicy?.mode).toBe('inverse');
  });

  it('resolves approach-recede motion without turning its true one-shot into a loop', () => {
    const resolved = resolveEventMotionPlayback(asset('boat_horn_far_01'), {
      elementId: 'horn-pass',
      gain: 0.2,
    });
    expect(resolved.motion).toMatchObject({
      motionMode: 'approach-recede',
      controlPoint: [-3.5, 0.5, 5.5],
    });
    expect(resolved.durationMs).toBe(9_000);
    expect(resolved.playback.mode).toBe('once');
  });

  it('chooses both authored owl counts deterministically and keeps gains safe', () => {
    const owl = asset('forest_soft_owl_far_01');
    const resolutions = Array.from({ length: 24 }, (_, index) =>
      resolveEventMotionPlayback(owl, {
        elementId: `owl-${index}`,
        gain: 0.8,
      }),
    );
    expect(
      [...new Set(resolutions.map((item) => item.playback.repeatCount))].sort(),
    ).toEqual([2, 3]);
    expect(
      resolveEventMotionPlayback(owl, {
        elementId: 'stable-owl',
        gain: 0.8,
      }),
    ).toEqual(
      resolveEventMotionPlayback(owl, {
        elementId: 'stable-owl',
        gain: 0.8,
      }),
    );
    for (const resolved of resolutions) {
      expect(resolved.durationMs).toBe(16_600);
      expect(resolved.playback.spreadAcrossLifecycle).toBe(true);
      expect(resolved.playback.perRepeatGain).toHaveLength(
        resolved.playback.repeatCount!,
      );
      expect(
        Math.max(...(resolved.playback.perRepeatGain ?? [])),
      ).toBeLessThanOrEqual(owl.gain_profile!.max_safe_gain);
    }
  });

  it('keeps a local one-shot transient finite while resolving deterministic motion', () => {
    const rustle = asset('forest_leaf_rustle_mid_01');
    const first = resolveEventMotionPlayback(rustle, {
      elementId: 'rustle',
      gain: 0.2,
    });
    const replay = resolveEventMotionPlayback(rustle, {
      elementId: 'rustle',
      gain: 0.2,
    });
    expect(first.motion.motionMode).toBe('orbit-arc');
    expect(first.motion).toEqual(replay.motion);
    expect(first.playback.mode).toBe('once');
    expect(first.durationMs).toBe(7_000);
  });
});
