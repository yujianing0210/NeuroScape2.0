import { describe, expect, it } from 'vitest';
import type { AudioPlaybackEvidence } from '@neuroscape/contracts';
import { AudioAssetManager } from '../src/audio/AudioAssetManager.js';
import { GainManager } from '../src/audio/GainManager.js';
import { HRTFRenderer } from '../src/audio/HRTFRenderer.js';
import { PlaybackScheduler } from '../src/audio/PlaybackScheduler.js';
import { SourceManager } from '../src/audio/SourceManager.js';
import {
  FakeAudioContext,
  FakeNode,
  FakePanner,
  fakeBuffer,
} from './audioFakes.js';
import { snapshot } from './fixtures.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('SourceManager', () => {
  it('raises a canonical event above a dominant ambient audibility floor', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager(
        [{ assetId: 'forest_leaf_rustle_mid_01', url: '/rustle' }],
        async () => fakeBuffer,
        async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(1),
        }),
      ),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
    );
    const state = snapshot();
    state.ambient = [{ ...state.ambient[0]!, gain: 0.38 }];
    state.action = [];
    state.event = [
      {
        ...state.event[0]!,
        assetId: 'forest_leaf_rustle_mid_01',
        gain: 0.0212,
        foregroundSalience: 'low',
      },
    ];
    manager.reconcile(state);
    await flush();
    expect(manager.sources.get('event:bird')?.gainNode.gain.value).toBeCloseTo(
      0.18,
    );
    state.event[0] = {
      ...state.event[0]!,
      gain: 0,
      foregroundEnvelope: 0,
    };
    manager.reconcile(state);
    expect(manager.sources.get('event:bird')?.gainNode.gain.value).toBe(0);
  });

  it('records one-shot completion as the PLAYED terminal outcome', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const evidence: AudioPlaybackEvidence[] = [];
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager(
        [{ assetId: 'event.bird', url: '/bird' }],
        async () => fakeBuffer,
        async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(1),
        }),
      ),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
      () => undefined,
      (event) => evidence.push(event),
    );
    const state = snapshot(1_000);
    state.ambient = [];
    state.action = [];
    state.event = [
      {
        ...state.event[0]!,
        adaptationId: 'adapt-event',
        runtimeActivationMs: 1_000,
      },
    ];
    manager.reconcile(state);
    await flush();
    context.sources[0]?.onended?.();
    expect(evidence.at(-1)).toMatchObject({
      status: 'AUDIO_FINISHED',
      playbackTerminalStatus: 'PLAYED',
    });
  });
  it('executes explicit loop/duration policy and exposes start timing', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager(
        [{ assetId: 'event.bird', url: '/bird' }],
        async () => fakeBuffer,
        async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(1),
        }),
      ),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
    );
    const state = snapshot(1_250);
    state.ambient = [];
    state.action = [];
    state.event = [
      {
        ...state.event[0]!,
        plannedStartMs: 1_000,
        runtimeActivationMs: 1_200,
        plannedEndMs: 5_000,
        playback: { mode: 'loop', durationPolicy: 'loop-until-end' },
      },
    ];
    manager.reconcile(state);
    await flush();
    expect(context.sources[0]?.loop).toBe(true);
    expect(manager.diagnostics()[0]).toMatchObject({
      plannedStartMs: 1_000,
      runtimeActivationMs: 1_200,
      audioStartMs: 1_250,
    });

    state.timestampMs = 5_000;
    state.event[0] = {
      ...state.event[0]!,
      active: false,
      lifecycle: 'finished',
    };
    manager.reconcile(state);
    expect(context.sources[0]?.stops).toEqual([2]);
  });

  it('truncates a buffer longer than the validated interval', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager(
        [{ assetId: 'event.bird', url: '/bird' }],
        async () => ({ duration: 30 }) as AudioBuffer,
        async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(1),
        }),
      ),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
    );
    const state = snapshot(1_000);
    state.ambient = [];
    state.action = [];
    state.event = [
      {
        ...state.event[0]!,
        plannedStartMs: 1_000,
        runtimeActivationMs: 1_000,
        plannedEndMs: 2_000,
        playback: { mode: 'once', durationPolicy: 'truncate-at-end' },
      },
    ];
    manager.reconcile(state);
    await flush();
    expect(context.sources[0]?.loop).toBe(false);
    state.timestampMs = 2_000;
    state.event[0] = {
      ...state.event[0]!,
      active: false,
      lifecycle: 'finished',
    };
    manager.reconcile(state);
    expect(context.sources[0]?.stops).toEqual([2]);
  });

  it('owns one persistent graph per object, bypasses HRTF globally, and prevents duplicate starts', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const assets = [
      'ambient.wind',
      'ambient.water',
      'action.breath',
      'event.bird',
    ].map((assetId) => ({ assetId, url: `/${assetId}` }));
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager(
        assets,
        async () => fakeBuffer,
        async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(1),
        }),
      ),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
    );
    const state = snapshot();
    manager.reconcile(state);
    await flush();
    expect(manager.sources.size).toBe(4);
    expect(manager.sources.get('globalAmbient:wind')?.spatializer).toBeNull();
    expect(
      manager.sources.get('localizedAmbient:water')?.spatializer,
    ).not.toBeNull();
    expect(context.panners).toHaveLength(3);
    expect(
      manager.sources.get('globalAmbient:wind')?.gainNode.gain.value,
    ).toBeCloseTo(0.4);
    expect(
      manager.sources.get('localizedAmbient:water')?.gainNode.gain.value,
    ).toBeCloseTo(0.8);
    expect(manager.sources.get('action:breath')?.gainNode.gain.value).toBe(0.5);
    expect(manager.sources.get('event:bird')?.gainNode.gain.value).toBe(0.6);
    expect(context.sources).toHaveLength(4);
    manager.reconcile(state);
    await flush();
    expect(context.sources).toHaveLength(4);
    expect(
      (
        manager.sources.get('action:breath')
          ?.spatializer as unknown as FakePanner
      ).positionX.value,
    ).toBe(8);
    expect(
      (manager.sources.get('event:bird')?.spatializer as unknown as FakePanner)
        .positionX.value,
    ).toBe(-4);
  });

  it('cleans removed sources and all remaining graphs on shutdown', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager(
        [{ assetId: 'ambient.wind', url: '/wind' }],
        async () => fakeBuffer,
        async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(1),
        }),
      ),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
    );
    const state = snapshot();
    state.ambient = [state.ambient[0]!];
    state.action = [];
    state.event = [];
    manager.reconcile(state);
    await flush();
    const gain = manager.sources.get('globalAmbient:wind')!
      .gainNode as unknown as FakeNode;
    state.ambient = [];
    manager.reconcile(state);
    expect(manager.sources.size).toBe(0);
    expect(gain.disconnected).toBe(true);
    manager.dispose();
  });

  it('reports global playback from runtime activation through actual start and planned finish', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const evidence: AudioPlaybackEvidence[] = [];
    let resolveFetch!: (value: {
      ok: boolean;
      status: number;
      arrayBuffer(): Promise<ArrayBuffer>;
    }) => void;
    const fetchPending = new Promise<{
      ok: boolean;
      status: number;
      arrayBuffer(): Promise<ArrayBuffer>;
    }>((resolve) => {
      resolveFetch = resolve;
    });
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager(
        [{ assetId: 'ambient.wind', url: '/wind' }],
        async () => fakeBuffer,
        async () => fetchPending,
      ),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
      () => undefined,
      (event) => evidence.push(event),
    );
    const state = snapshot(1_250);
    state.ambient = [
      {
        ...state.ambient[0]!,
        adaptationId: 'adapt-global',
        plannedStartMs: 1_000,
        runtimeActivationMs: 1_200,
        plannedEndMs: 5_000,
      },
    ];
    state.action = [];
    state.event = [];
    manager.reconcile(state);
    expect(evidence.map((event) => event.status)).toEqual([
      'RUNTIME_ACTIVATED',
    ]);

    context.currentTime = 2.5;
    resolveFetch({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(1),
    });
    await flush();
    await flush();
    expect(evidence.at(-1)).toMatchObject({
      status: 'AUDIO_STARTED',
      layer: 'ambient',
      plannedStartMs: 1_000,
      runtimeActivationMs: 1_200,
      audioStartMs: 1_750,
    });

    state.timestampMs = 5_000;
    state.ambient[0] = {
      ...state.ambient[0]!,
      active: false,
      lifecycle: 'finished',
      runtimeFinishedMs: 5_000,
    };
    manager.reconcile(state);
    expect(evidence.at(-1)).toMatchObject({
      status: 'AUDIO_FINISHED',
      audioEndMs: 5_000,
      endReason: 'planned_end',
    });
  });

  it('fails a stalled runtime activation instead of silently leaving it unstarted', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const evidence: AudioPlaybackEvidence[] = [];
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager(
        [{ assetId: 'event.bird', url: '/bird' }],
        async () => fakeBuffer,
        async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(1),
        }),
      ),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
      () => undefined,
      (event) => evidence.push(event),
    );
    const state = snapshot(1_250);
    state.ambient = [];
    state.action = [];
    state.event = [
      {
        ...state.event[0]!,
        adaptationId: 'adapt-stalled',
        plannedStartMs: 1_000,
        runtimeActivationMs: 1_200,
        plannedEndMs: 10_000,
        active: true,
        lifecycle: 'active',
        playback: { mode: 'once', durationPolicy: 'truncate-at-end' },
      },
    ];
    manager.reconcile(state);
    await flush();
    expect(evidence.at(0)).toMatchObject({ status: 'RUNTIME_ACTIVATED' });

    const source = manager.sources.get('event:bird');
    expect(source).toBeDefined();
    source!.playbackState = 'loading';
    source!.runtimeActivationMs = 1_200;
    state.timestampMs = 7_000;
    manager.reconcile(state);
    expect(evidence.at(-1)).toMatchObject({
      status: 'AUDIO_FAILED',
      failureCode: 'AUDIO_START_TIMEOUT',
      assetId: 'event.bird',
      playbackTerminalStatus: 'AUDIO_START_FAILED',
    });
  });

  it('reports an explicit audio failure and never counts it as started', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const evidence: AudioPlaybackEvidence[] = [];
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager([], async () => fakeBuffer),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
      () => undefined,
      (event) => evidence.push(event),
    );
    const state = snapshot(2_000);
    state.ambient = [];
    state.action = [];
    state.event = [
      {
        ...state.event[0]!,
        adaptationId: 'adapt-failed',
        plannedStartMs: 1_800,
        runtimeActivationMs: 2_000,
      },
    ];
    manager.reconcile(state);
    await flush();
    expect(evidence.map((event) => event.status)).toEqual([
      'RUNTIME_ACTIVATED',
      'AUDIO_FAILED',
    ]);
    expect(evidence.at(-1)).toMatchObject({
      failureCode: 'NOT_REGISTERED',
      elementId: 'bird',
      assetId: 'event.bird',
    });
  });

  it('emits general failure diagnostics for a Base Plan source without adaptation evidence', async () => {
    const context = new FakeAudioContext();
    const master = new FakeNode() as unknown as AudioNode;
    const evidence: AudioPlaybackEvidence[] = [];
    const diagnostics: import('@neuroscape/contracts').AudioExecutionDiagnostic[] =
      [];
    const manager = new SourceManager(
      context as unknown as BaseAudioContext,
      master,
      new AudioAssetManager([], async () => fakeBuffer),
      new GainManager(),
      new PlaybackScheduler(context as unknown as BaseAudioContext),
      new HRTFRenderer(context as unknown as BaseAudioContext, master),
      () => undefined,
      (event) => evidence.push(event),
      (event) => diagnostics.push(event),
    );
    const state = snapshot(2_000);
    state.ambient = [];
    state.action = [];
    state.event = [{ ...state.event[0]!, adaptationId: undefined }];
    manager.reconcile(state);
    await flush();
    expect(evidence).toEqual([]);
    expect(diagnostics.at(-1)).toMatchObject({
      sourceId: 'bird',
      assetId: 'event.bird',
      playbackState: 'error',
      errorCode: 'NOT_REGISTERED',
    });
  });
});
