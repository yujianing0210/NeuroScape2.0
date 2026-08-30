import { describe, expect, it } from 'vitest';
import { GainManager } from '../src/audio/GainManager.js';
import {
  PlaybackScheduler,
  type PlaybackTarget,
} from '../src/audio/PlaybackScheduler.js';
import {
  FakeAudioContext,
  FakeAudioParam,
  FakeNode,
  fakeBuffer,
} from './audioFakes.js';

describe('gain and playback scheduling', () => {
  it('protects foreground audibility without exceeding the asset safety cap', () => {
    const gains = new GainManager();
    expect(
      gains.resolveForegroundGain({
        runtimeGain: 0.0212,
        authoredRecommendedGain: 0.24,
        dominantAmbientGain: 0.38,
        salience: 'low',
        maxSafeGain: 0.24,
      }),
    ).toBeCloseTo(0.18);
    expect(
      gains.resolveForegroundGain({
        runtimeGain: 0.4,
        authoredRecommendedGain: 0.24,
        dominantAmbientGain: 0.8,
        salience: 'moderate',
        maxSafeGain: 0.24,
      }),
    ).toBe(0.24);
  });
  it('ramps authoritative gain using AudioParam scheduling', () => {
    const parameter = new FakeAudioParam();
    parameter.value = 0.2;
    new GainManager(0.05).apply(parameter as unknown as AudioParam, 0.8, 3);
    expect(parameter.calls).toEqual([
      ['cancel', 0, 3],
      ['set', 0.2, 3],
      ['ramp', 0.8, 3.05],
    ]);
  });
  it('prevents duplicate playback and recreates one-shot source nodes after reactivation', () => {
    const context = new FakeAudioContext();
    const scheduler = new PlaybackScheduler(
      context as unknown as BaseAudioContext,
    );
    const target: PlaybackTarget = {
      input: new FakeNode() as unknown as AudioNode,
      source: null,
      playing: false,
      activationPlayed: false,
    };
    expect(scheduler.start(target, fakeBuffer, false, 2)).toBe(true);
    expect(scheduler.start(target, fakeBuffer, false, 2)).toBe(false);
    scheduler.stop(target, 2);
    expect(scheduler.start(target, fakeBuffer, false, 2)).toBe(false);
    scheduler.resetActivation(target);
    expect(scheduler.start(target, fakeBuffer, false, 2)).toBe(true);
    expect(context.sources).toHaveLength(2);
  });
  it('schedules a deterministic three-repeat burst without counting repeats as activations', () => {
    const context = new FakeAudioContext();
    const scheduler = new PlaybackScheduler(
      context as unknown as BaseAudioContext,
    );
    const target: PlaybackTarget = {
      input: new FakeNode() as unknown as AudioNode,
      source: null,
      playing: false,
      activationPlayed: false,
    };
    expect(scheduler.startBurst(target, fakeBuffer, 2, 3, 0.5)).toBe(true);
    expect(context.sources.map((source) => source.starts[0])).toEqual([
      2, 3.5, 5,
    ]);
    expect(target.activationPlayed).toBe(true);
    expect(scheduler.startBurst(target, fakeBuffer, 2, 2, 0.5)).toBe(false);
  });

  it('schedules a bounded one-shot envelope and graceful release', () => {
    const parameter = new FakeAudioParam();
    const gains = new GainManager();
    gains.applyEnvelope(parameter as unknown as AudioParam, 0.2, 2, 16, 6, 6);
    expect(parameter.calls).toEqual([
      ['cancel', 0, 2],
      ['set', 0, 2],
      ['ramp', 0.2, 8],
      ['set', 0.2, 12],
      ['ramp', 0, 18],
    ]);
  });
  it('schedules repeat-level burst gains on the Web Audio clock', () => {
    const parameter = new FakeAudioParam();
    new GainManager().applyBurstSequence(
      parameter as unknown as AudioParam,
      [0.05, 0.08, 0.1],
      2,
      5,
      0.8,
    );
    expect(parameter.calls).toEqual([
      ['cancel', 0, 2],
      ['set', 0.05, 2],
      ['set', 0.08, 7.8],
      ['set', 0.1, 13.6],
    ]);
  });
});
