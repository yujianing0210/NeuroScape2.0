import {
  type ListenerState,
  type Quaternion,
  type RuntimeWorldState,
  type Vector3,
  type PlaybackPolicy,
  type AudioPlaybackEvidence,
  type AudioExecutionDiagnostic,
  type AudioPlaybackEndReason,
  type AudioPlaybackTerminalStatus,
  audioLibraryById,
} from '@neuroscape/contracts';
import { AudioAssetError } from './AudioAssetManager.js';
import type { AudioAssetManager } from './AudioAssetManager.js';
import type { GainManager } from './GainManager.js';
import type { HRTFRenderer, SpatialDiagnostics } from './HRTFRenderer.js';
import type { PlaybackScheduler, PlaybackTarget } from './PlaybackScheduler.js';

export type SourceCategory =
  'globalAmbient' | 'localizedAmbient' | 'action' | 'event';
export interface RuntimeSound {
  id: string;
  adaptationId?: string;
  assetId: string;
  gain: number;
  active: boolean;
  worldPosition?: Vector3;
  lifecycle?: 'waiting' | 'active' | 'finished';
  playback?: PlaybackPolicy;
  plannedStartMs?: number;
  runtimeActivationMs?: number;
  plannedEndMs?: number;
  runtimeFinishedMs?: number;
  foregroundSalience?: 'minimal' | 'low' | 'moderate';
  foregroundEnvelope?: number;
}
export interface ManagedSource extends PlaybackTarget {
  key: string;
  runtimeId: string;
  assetId: string;
  category: SourceCategory;
  gainNode: GainNode;
  spatializer: PannerNode | null;
  playbackState: 'idle' | 'loading' | 'playing' | 'stopped' | 'error';
  error?: AudioAssetError;
  diagnostics?: SpatialDiagnostics;
  generation: number;
  plannedStartMs?: number;
  runtimeActivationMs?: number;
  audioStartMs?: number;
  audioStartAudioTime?: number;
  desiredActive: boolean;
  adaptationId?: string;
  plannedEndMs?: number;
  runtimeFinishedMs?: number;
  runtimeActivationPublished: boolean;
  audioStartedPublished: boolean;
  audioFinishedPublished: boolean;
  terminalPublished: boolean;
}
export interface AudioSourceDiagnostics extends SpatialDiagnostics {
  runtimeId: string;
  assetId: string;
  category: SourceCategory;
  playbackState: ManagedSource['playbackState'];
  gain: number;
  plannedStartMs?: number;
  runtimeActivationMs?: number;
  audioStartMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

export class SourceManager {
  readonly sources = new Map<string, ManagedSource>();
  readonly #context: BaseAudioContext;
  readonly #master: AudioNode;
  readonly #assets: AudioAssetManager;
  readonly #gains: GainManager;
  readonly #playback: PlaybackScheduler;
  readonly #hrtf: HRTFRenderer;
  readonly #onChange: () => void;
  readonly #onEvidence: (evidence: AudioPlaybackEvidence) => void;
  readonly #onDiagnostic: (diagnostic: AudioExecutionDiagnostic) => void;
  #latestTimestampMs = 0;

  constructor(
    context: BaseAudioContext,
    master: AudioNode,
    assets: AudioAssetManager,
    gains: GainManager,
    playback: PlaybackScheduler,
    hrtf: HRTFRenderer,
    onChange: () => void = () => undefined,
    onEvidence: (evidence: AudioPlaybackEvidence) => void = () => undefined,
    onDiagnostic: (diagnostic: AudioExecutionDiagnostic) => void = () =>
      undefined,
  ) {
    this.#context = context;
    this.#master = master;
    this.#assets = assets;
    this.#gains = gains;
    this.#playback = playback;
    this.#hrtf = hrtf;
    this.#onChange = onChange;
    this.#onEvidence = onEvidence;
    this.#onDiagnostic = onDiagnostic;
  }

  reconcile(state: Readonly<RuntimeWorldState>): void {
    this.#latestTimestampMs = state.timestampMs;
    const desired = new Map<
      string,
      { category: SourceCategory; sound: RuntimeSound }
    >();
    state.ambient.forEach((sound) =>
      desired.set(
        `${sound.mode === 'global' ? 'globalAmbient' : 'localizedAmbient'}:${sound.id}`,
        {
          category:
            sound.mode === 'global' ? 'globalAmbient' : 'localizedAmbient',
          sound,
        },
      ),
    );
    state.action.forEach((sound) =>
      desired.set(`action:${sound.id}`, { category: 'action', sound }),
    );
    state.event.forEach((sound) =>
      desired.set(`event:${sound.id}`, { category: 'event', sound }),
    );
    for (const [key, source] of this.sources)
      if (!desired.has(key)) this.#release(key, source, 'cancelled');
    const dominantAmbientGain = state.ambient
      .filter((sound) => sound.active)
      .reduce((maximum, sound) => Math.max(maximum, sound.gain), 0);
    desired.forEach(({ category, sound }, key) =>
      this.#update(
        key,
        category,
        sound,
        state.listener,
        state.timestampMs,
        dominantAmbientGain,
      ),
    );
  }

  diagnostics(): AudioSourceDiagnostics[] {
    return [...this.sources.values()].map((source) => ({
      ...(source.diagnostics ?? {
        relativePosition: [0, 0, 0] as Vector3,
        listenerSpacePosition: [0, 0, 0] as Vector3,
        azimuthDegrees: 0,
        elevationDegrees: 0,
        distance: 0,
      }),
      runtimeId: source.runtimeId,
      assetId: source.assetId,
      category: source.category,
      playbackState: source.playbackState,
      gain: source.gainNode.gain.value,
      plannedStartMs: source.plannedStartMs,
      runtimeActivationMs: source.runtimeActivationMs,
      audioStartMs: source.audioStartMs,
      errorCode: source.error?.code,
      errorMessage: source.error?.message,
    }));
  }

  dispose(): void {
    [...this.sources].forEach(([key, source]) =>
      this.#release(key, source, 'session_ended'),
    );
  }

  #create(
    key: string,
    category: SourceCategory,
    sound: RuntimeSound,
  ): ManagedSource {
    const gainNode = this.#context.createGain();
    const spatializer =
      category === 'globalAmbient' ? null : this.#hrtf.createSpatializer();
    gainNode.connect(spatializer ?? this.#master);
    const source: ManagedSource = {
      key,
      runtimeId: sound.id,
      assetId: sound.assetId,
      category,
      gainNode,
      spatializer,
      input: gainNode,
      source: null,
      playing: false,
      activationPlayed: false,
      playbackState: 'idle',
      generation: 0,
      desiredActive: false,
      runtimeActivationPublished: false,
      audioStartedPublished: false,
      audioFinishedPublished: false,
      terminalPublished: false,
    };
    source.onPlaybackEnded = () => {
      source.playbackState = 'stopped';
      this.#publishFinished(source, 'natural');
      this.#onChange();
    };
    this.sources.set(key, source);
    return source;
  }

  #failIfStalled(source: ManagedSource, timestampMs: number): boolean {
    if (
      source.runtimeActivationMs === undefined ||
      source.playbackState !== 'loading'
    )
      return false;
    const elapsedMs = timestampMs - source.runtimeActivationMs;
    if (elapsedMs < 5_000) return false;
    source.playbackState = 'error';
    source.error = new AudioAssetError(
      'AUDIO_START_TIMEOUT',
      source.assetId,
      `Audio start timeout for ${source.assetId} after ${elapsedMs}ms.`,
    );
    this.#playback.stop(source, this.#context.currentTime);
    this.#publishFailure(source, source.error, timestampMs);
    this.#onChange();
    return true;
  }

  #update(
    key: string,
    category: SourceCategory,
    sound: RuntimeSound,
    listener: ListenerState,
    timestampMs: number,
    dominantAmbientGain: number,
  ): void {
    let source = this.sources.get(key);
    if (source && source.assetId !== sound.assetId) {
      this.#release(key, source);
      source = undefined;
    }
    source ??= this.#create(key, category, sound);
    if (source.adaptationId !== sound.adaptationId) {
      source.adaptationId = sound.adaptationId;
      source.runtimeActivationPublished = false;
      source.audioStartedPublished = false;
      source.audioFinishedPublished = false;
      source.terminalPublished = false;
      source.audioStartMs = undefined;
    }
    source.plannedStartMs = sound.plannedStartMs;
    source.runtimeActivationMs = sound.runtimeActivationMs;
    source.plannedEndMs = sound.plannedEndMs;
    source.runtimeFinishedMs = sound.runtimeFinishedMs;
    if (
      source.adaptationId &&
      source.runtimeActivationMs !== undefined &&
      !source.runtimeActivationPublished
    ) {
      source.runtimeActivationPublished = true;
      this.#publish(source, 'RUNTIME_ACTIVATED', source.runtimeActivationMs);
    }
    if (this.#failIfStalled(source, timestampMs)) return;
    const resolvedGain = this.#resolveGain(
      category,
      sound,
      dominantAmbientGain,
    );
    this.#gains.apply(
      source.gainNode.gain,
      resolvedGain,
      this.#context.currentTime,
    );
    if (source.spatializer && sound.worldPosition) {
      source.diagnostics = this.#hrtf.update(
        key,
        source.spatializer,
        sound.worldPosition,
        listener.worldPosition,
        listener.orientation as Quaternion,
        this.#context.currentTime,
      );
    }
    const shouldPlay =
      sound.active &&
      sound.lifecycle !== 'waiting' &&
      sound.lifecycle !== 'finished';
    source.desiredActive = shouldPlay;
    if (
      shouldPlay &&
      source.playing &&
      source.adaptationId &&
      !source.audioStartedPublished
    ) {
      source.audioStartMs = timestampMs;
      source.audioStartAudioTime = this.#context.currentTime;
      source.audioStartedPublished = true;
      this.#publish(source, 'AUDIO_STARTED', timestampMs);
    }
    if (!shouldPlay) {
      if (source.playbackState === 'loading') source.generation += 1;
      if (source.playing)
        this.#publishFinished(
          source,
          sound.lifecycle === 'finished' ? 'planned_end' : 'cancelled',
          timestampMs,
        );
      else if (
        source.category === 'event' &&
        source.runtimeActivationPublished &&
        !source.terminalPublished
      )
        this.#publishCancelled(source, timestampMs);
      this.#playback.stop(source, this.#context.currentTime);
      this.#playback.resetActivation(source);
      source.playbackState = 'stopped';
      return;
    }
    const playback = sound.playback;
    if (!playback) {
      source.playbackState = 'error';
      source.error = new AudioAssetError(
        'INVALID_PLAYBACK_POLICY',
        sound.assetId,
        `Validated playback policy missing for ${key}.`,
      );
      this.#publishFailure(source, source.error, timestampMs);
      this.#onChange();
      return;
    }
    if (
      source.playing ||
      source.playbackState === 'loading' ||
      (source.activationPlayed &&
        category !== 'globalAmbient' &&
        category !== 'localizedAmbient')
    )
      return;
    source.playbackState = 'loading';
    const generation = ++source.generation;
    const loadRequestedAtAudioTime = this.#context.currentTime;
    void this.#assets.load(sound.assetId).then((result) => {
      if (source?.generation !== generation || this.sources.get(key) !== source)
        return;
      if (!source.desiredActive) return;
      if (this.#failIfStalled(source, this.#latestTimestampMs)) return;
      if (!result.ok) {
        source.playbackState = 'error';
        source.error = result.error;
        this.#publishFailure(
          source,
          result.error,
          this.#sessionNow(timestampMs, loadRequestedAtAudioTime),
        );
        this.#onChange();
        return;
      }
      if (source.playbackState !== 'loading') return;
      const startAt = this.#audioTimeFor(timestampMs);
      const sessionStartMs = this.#sessionNow(
        timestampMs,
        loadRequestedAtAudioTime,
      );
      const remainingLifecycleSeconds =
        playback.spreadAcrossLifecycle && source.plannedEndMs !== undefined
          ? Math.max(0, source.plannedEndMs - sessionStartMs) / 1_000
          : undefined;
      let started: boolean;
      try {
        started =
          playback.mode === 'repeat' || playback.mode === 'repeat-count'
            ? this.#playback.startBurst(
                source,
                result.buffer,
                startAt,
                playback.repeatCount!,
                playback.repeatGapMs! / 1_000,
                remainingLifecycleSeconds,
              )
            : this.#playback.start(
                source,
                result.buffer,
                playback.mode === 'loop' ||
                  playback.mode === 'loop-until-arrival' ||
                  playback.durationPolicy === 'loop-until-end',
                startAt,
              );
      } catch (cause) {
        source.playbackState = 'error';
        source.error = new AudioAssetError(
          'SOURCE_CREATION_FAILED',
          source.assetId,
          `Failed to create or start audio source for ${source.assetId}.`,
          cause,
        );
        this.#publishFailure(
          source,
          source.error,
          this.#sessionNow(timestampMs, loadRequestedAtAudioTime),
        );
        this.#onChange();
        return;
      }
      if (
        started &&
        (playback.mode === 'repeat' || playback.mode === 'repeat-count') &&
        playback.perRepeatGain
      ) {
        this.#gains.applyBurstSequence(
          source.gainNode.gain,
          playback.perRepeatGain,
          startAt,
          result.buffer.duration,
          playback.repeatGapMs! / 1_000,
        );
      }
      if (started) {
        source.playbackState = 'playing';
        source.audioStartMs = Math.max(this.#latestTimestampMs, sessionStartMs);
        source.audioStartAudioTime = this.#context.currentTime;
        source.audioStartedPublished = true;
        this.#publish(source, 'AUDIO_STARTED', source.audioStartMs);
      }
      this.#onChange();
    });
  }

  #audioTimeFor(_timestampMs: number): number {
    // Replay/network delivery already occurs on the authoritative session timeline.
    return this.#context.currentTime;
  }

  #sessionNow(
    baseTimestampMs = this.#latestTimestampMs,
    baseAudioTime = this.#context.currentTime,
  ): number {
    return Math.max(
      this.#latestTimestampMs,
      baseTimestampMs + (this.#context.currentTime - baseAudioTime) * 1_000,
    );
  }

  #publish(
    source: ManagedSource,
    status: AudioPlaybackEvidence['status'],
    timestampMs: number,
    extra: Partial<AudioPlaybackEvidence> = {},
  ): void {
    const layer =
      source.category === 'globalAmbient' ||
      source.category === 'localizedAmbient'
        ? 'ambient'
        : source.category;
    this.#onDiagnostic({
      adaptationId: source.adaptationId,
      sourceId: source.runtimeId,
      assetId: source.assetId,
      layer,
      playbackState:
        status === 'AUDIO_FAILED'
          ? 'error'
          : status === 'AUDIO_STARTED'
            ? 'playing'
            : 'stopped',
      timestampMs,
      audioStartMs: source.audioStartMs,
      audioEndMs: extra.audioEndMs,
      errorCode: extra.failureCode,
      errorMessage: extra.failureReason,
    });
    if (!source.adaptationId) return;
    this.#onEvidence({
      adaptationId: source.adaptationId,
      elementId: source.runtimeId,
      assetId: source.assetId,
      layer,
      status,
      timestampMs,
      plannedStartMs: source.plannedStartMs,
      runtimeActivationMs: source.runtimeActivationMs,
      audioStartMs: source.audioStartMs,
      plannedEndMs: source.plannedEndMs,
      runtimeFinishedMs: source.runtimeFinishedMs,
      ...extra,
    });
  }

  #publishFinished(
    source: ManagedSource,
    endReason: AudioPlaybackEndReason,
    timestampMs = source.audioStartMs !== undefined &&
    source.audioStartAudioTime !== undefined
      ? source.audioStartMs +
        (this.#context.currentTime - source.audioStartAudioTime) * 1_000
      : this.#sessionNow(),
  ): void {
    if (!source.audioStartedPublished || source.audioFinishedPublished) return;
    source.audioFinishedPublished = true;
    this.#publish(source, 'AUDIO_FINISHED', timestampMs, {
      audioEndMs: timestampMs,
      endReason,
      ...(source.category === 'event'
        ? {
            playbackTerminalStatus:
              endReason === 'natural' || endReason === 'planned_end'
                ? ('PLAYED' as const)
                : ('RUNTIME_CANCELLED' as const),
          }
        : {}),
    });
    if (source.category === 'event') source.terminalPublished = true;
  }

  #publishFailure(
    source: ManagedSource,
    error: AudioAssetError,
    timestampMs: number,
  ): void {
    if (source.terminalPublished) return;
    const playbackTerminalStatus: AudioPlaybackTerminalStatus =
      error.code === 'SOURCE_CREATION_FAILED'
        ? 'SOURCE_CREATION_FAILED'
        : error.code === 'FETCH_FAILED' ||
            error.code === 'DECODE_FAILED' ||
            error.code === 'NOT_REGISTERED'
          ? 'ASSET_LOAD_FAILED'
          : 'AUDIO_START_FAILED';
    this.#publish(source, 'AUDIO_FAILED', timestampMs, {
      failureCode: error.code,
      failureReason: error.message,
      ...(source.category === 'event' ? { playbackTerminalStatus } : {}),
    });
    if (source.category === 'event') source.terminalPublished = true;
  }

  #publishCancelled(source: ManagedSource, timestampMs: number): void {
    this.#publish(source, 'AUDIO_FAILED', timestampMs, {
      failureCode: 'RUNTIME_CANCELLED',
      failureReason: `Runtime cancelled ${source.assetId} before playback completed.`,
      playbackTerminalStatus: 'RUNTIME_CANCELLED',
    });
    source.terminalPublished = true;
  }

  #resolveGain(
    category: SourceCategory,
    sound: RuntimeSound,
    dominantAmbientGain: number,
  ): number {
    if (category !== 'event') return sound.gain;
    const asset = audioLibraryById.get(sound.assetId);
    if (!asset) return sound.gain;
    return this.#gains.resolveForegroundGain({
      runtimeGain: sound.gain,
      authoredRecommendedGain:
        asset.recommended_volume * (sound.foregroundEnvelope ?? 1),
      dominantAmbientGain:
        dominantAmbientGain * (sound.foregroundEnvelope ?? 1),
      salience: sound.foregroundSalience ?? 'minimal',
      maxSafeGain: asset.gain_profile?.max_safe_gain ?? 1,
    });
  }

  #release(
    key: string,
    source: ManagedSource,
    endReason: AudioPlaybackEndReason = 'replaced',
  ): void {
    source.generation += 1;
    if (source.playing) this.#publishFinished(source, endReason);
    else if (
      source.category === 'event' &&
      source.runtimeActivationPublished &&
      !source.terminalPublished
    )
      this.#publishCancelled(source, this.#sessionNow());
    this.#playback.stop(source, this.#context.currentTime);
    source.gainNode.disconnect();
    if (source.spatializer) this.#hrtf.release(key, source.spatializer);
    this.sources.delete(key);
  }
}
