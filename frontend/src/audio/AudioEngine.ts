import type {
  AudioPlaybackEvidence,
  AudioExecutionDiagnostic,
  RuntimeWorldState,
} from '@neuroscape/contracts';
import type { RuntimeStore } from '../runtime/RuntimeStore.js';
import { runtimeStore } from '../runtime/RuntimeStore.js';
import { AudioAssetManager } from './AudioAssetManager.js';
import { AudioContextManager } from './AudioContextManager.js';
import { audioAssetManifest } from './audioAssetManifest.js';
import { GainManager } from './GainManager.js';
import { HRTFRenderer } from './HRTFRenderer.js';
import { PlaybackScheduler } from './PlaybackScheduler.js';
import { SourceManager, type AudioSourceDiagnostics } from './SourceManager.js';
import { MEDITATION_OPENING_URL } from './opening.js';

export type AudioRecordingStatus =
  'idle' | 'recording' | 'stopping' | 'unavailable' | 'error';
export interface AudioEngineState {
  status: 'disabled' | 'enabling' | 'running' | 'suspended' | 'error';
  masterGain: number;
  sourceCount: number;
  recordingStatus: AudioRecordingStatus;
  error?: string;
}
export interface CapturedAudio {
  blob: Blob;
  mimeType: string;
  extension: string;
  durationMs: number;
}

export class AudioEngine {
  readonly #store: RuntimeStore;
  readonly #contexts: AudioContextManager;
  readonly #listeners = new Set<() => void>();
  readonly #evidenceListeners = new Set<
    (evidence: AudioPlaybackEvidence) => void
  >();
  readonly #diagnosticListeners = new Set<
    (diagnostic: AudioExecutionDiagnostic) => void
  >();
  #unsubscribe: (() => void) | null = null;
  #master: GainNode | null = null;
  #sources: SourceManager | null = null;
  #hrtf: HRTFRenderer | null = null;
  #assets: AudioAssetManager | null = null;
  #captureDestination: MediaStreamAudioDestinationNode | null = null;
  #mediaRecorder: MediaRecorder | null = null;
  #openingBuffer: AudioBuffer | null = null;
  #openingSource: AudioBufferSourceNode | null = null;
  readonly #mediaElementSources = new Map<
    HTMLMediaElement,
    MediaElementAudioSourceNode
  >();
  readonly #plannedPreloadAssetIds = new Set<string>();
  #captureChunks: Blob[] = [];
  #captureStartedAtMs = 0;
  #state: AudioEngineState = {
    status: 'disabled',
    masterGain: 1,
    sourceCount: 0,
    recordingStatus: 'idle',
  };

  constructor(
    store: RuntimeStore = runtimeStore,
    contexts = new AudioContextManager(),
  ) {
    this.#store = store;
    this.#contexts = contexts;
  }
  getState = (): AudioEngineState => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  subscribePlaybackEvidence = (
    listener: (evidence: AudioPlaybackEvidence) => void,
  ) => {
    this.#evidenceListeners.add(listener);
    return () => this.#evidenceListeners.delete(listener);
  };
  subscribeExecutionDiagnostics = (
    listener: (diagnostic: AudioExecutionDiagnostic) => void,
  ) => {
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  };
  diagnostics(): AudioSourceDiagnostics[] {
    return this.#sources?.diagnostics() ?? [];
  }

  async enable(): Promise<void> {
    if (this.#state.status === 'running') return;
    this.#set({ ...this.#state, status: 'enabling', error: undefined });
    try {
      await this.#contexts.resume();
      if (!this.#sources) this.#initializeGraph();
      await this.#assets?.preload();
      await this.#loadPlannedAssets();
      this.#unsubscribe ??= this.#store.subscribe((state, previous) => {
        if (
          state.runtimeWorldState !== previous.runtimeWorldState &&
          state.runtimeWorldState
        )
          this.update(state.runtimeWorldState);
      });
      const snapshot = this.#store.getState().runtimeWorldState;
      if (snapshot) this.update(snapshot);
      this.#set({ ...this.#state, status: 'running' });
      this.#store.getState().setAudioRuntime({ status: 'running' });
    } catch (error) {
      this.#set({
        ...this.#state,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      this.#store.getState().setAudioRuntime({ status: 'error' });
    }
  }

  async suspend(): Promise<void> {
    await this.#contexts.suspend();
    this.#set({ ...this.#state, status: 'suspended' });
    this.#store.getState().setAudioRuntime({ status: 'suspended' });
  }
  async startRecording(): Promise<void> {
    await this.enable();
    if (this.#mediaRecorder?.state === 'recording') return;
    const Constructor = globalThis.MediaRecorder;
    if (!Constructor || !this.#captureDestination) {
      this.#set({ ...this.#state, recordingStatus: 'unavailable' });
      throw new Error('Browser master-audio recording is unavailable.');
    }
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = preferred.find((value) =>
      Constructor.isTypeSupported(value),
    );
    this.#captureChunks = [];
    this.#mediaRecorder = new Constructor(
      this.#captureDestination.stream,
      mimeType ? { mimeType } : undefined,
    );
    this.#mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.#captureChunks.push(event.data);
    };
    this.#mediaRecorder.onerror = () =>
      this.#set({ ...this.#state, recordingStatus: 'error' });
    this.#captureStartedAtMs = performance.now();
    this.#mediaRecorder.start(1_000);
    this.#set({ ...this.#state, recordingStatus: 'recording' });
  }
  async stopRecording(): Promise<CapturedAudio | null> {
    const recorder = this.#mediaRecorder;
    if (!recorder) return null;
    this.#set({ ...this.#state, recordingStatus: 'stopping' });
    if (recorder.state !== 'inactive') {
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timeout);
            if (error) reject(error);
            else resolve();
          };
          const timeout = globalThis.setTimeout(
            () =>
              finish(new Error('Browser master-audio recording timed out.')),
            5_000,
          );
          recorder.addEventListener('stop', () => finish(), { once: true });
          recorder.addEventListener(
            'error',
            () => finish(new Error('Browser master-audio recording failed.')),
            { once: true },
          );
          try {
            recorder.stop();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
      } catch (error) {
        this.#mediaRecorder = null;
        this.#captureChunks = [];
        this.#set({ ...this.#state, recordingStatus: 'error' });
        throw error;
      }
    }
    const mimeType =
      recorder.mimeType || this.#captureChunks[0]?.type || 'audio/webm';
    const result = {
      blob: new Blob(this.#captureChunks, { type: mimeType }),
      mimeType,
      extension: mimeType.includes('mp4')
        ? 'm4a'
        : mimeType.includes('ogg')
          ? 'ogg'
          : 'webm',
      durationMs: Math.max(0, performance.now() - this.#captureStartedAtMs),
    };
    this.#mediaRecorder = null;
    this.#captureChunks = [];
    this.#set({ ...this.#state, recordingStatus: 'idle' });
    return result;
  }
  async playOpening(): Promise<void> {
    await this.enable();
    if (!this.#master) throw new Error('Master audio is unavailable.');
    if (!this.#openingBuffer) {
      const response = await fetch(MEDITATION_OPENING_URL);
      if (!response.ok)
        throw new Error(
          `Opening audio failed to load: HTTP ${response.status}`,
        );
      this.#openingBuffer = await this.#contexts.context.decodeAudioData(
        await response.arrayBuffer(),
      );
    }
    this.stopOpening();
    const source = this.#contexts.context.createBufferSource();
    source.buffer = this.#openingBuffer;
    source.loop = false;
    source.connect(this.#master);
    source.onended = () => {
      if (this.#openingSource === source) this.#openingSource = null;
      source.disconnect();
    };
    this.#openingSource = source;
    source.start(this.#contexts.currentTime);
  }
  stopOpening(): void {
    const source = this.#openingSource;
    this.#openingSource = null;
    if (!source) return;
    source.onended = null;
    try {
      source.stop(this.#contexts.currentTime);
    } catch {
      // The one-shot opening may already have ended.
    }
    source.disconnect();
  }
  connectMediaElement(element: HTMLMediaElement): () => void {
    if (!this.#master) throw new Error('Master audio is unavailable.');
    let source = this.#mediaElementSources.get(element);
    if (!source) {
      source = this.#contexts.context.createMediaElementSource(element);
      this.#mediaElementSources.set(element, source);
    }
    source.connect(this.#master);
    return () => source?.disconnect();
  }
  update(state: Readonly<RuntimeWorldState>): void {
    this.#sources?.reconcile(state);
    this.#set({
      ...this.#state,
      sourceCount: this.#sources?.sources.size ?? 0,
    });
  }
  setMasterGain(gain: number): void {
    const value = Math.min(1, Math.max(0, gain));
    this.#state = { ...this.#state, masterGain: value };
    if (this.#master)
      new GainManager().setMaster(
        this.#master.gain,
        value,
        this.#contexts.currentTime,
      );
    this.#emit();
  }
  preloadAssets(assetIds: readonly string[]): void {
    assetIds.forEach((assetId) => this.#plannedPreloadAssetIds.add(assetId));
    void this.#loadPlannedAssets();
  }
  async dispose(): Promise<void> {
    await this.stopRecording();
    this.stopOpening();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#sources?.dispose();
    this.#hrtf?.dispose();
    this.#master?.disconnect();
    this.#assets?.clear();
    this.#sources = null;
    this.#hrtf = null;
    this.#master = null;
    this.#assets = null;
    this.#openingBuffer = null;
    this.#mediaElementSources.forEach((source) => source.disconnect());
    this.#mediaElementSources.clear();
    this.#captureDestination = null;
    await this.#contexts.close();
    this.#set({
      status: 'disabled',
      masterGain: this.#state.masterGain,
      sourceCount: 0,
      recordingStatus: 'idle',
    });
    this.#store.getState().setAudioRuntime({ status: 'idle' });
  }

  #initializeGraph(): void {
    const context = this.#contexts.context;
    this.#master = context.createGain();
    this.#master.gain.setValueAtTime(
      this.#state.masterGain,
      context.currentTime,
    );
    this.#master.connect(context.destination);
    this.#captureDestination =
      typeof context.createMediaStreamDestination === 'function'
        ? context.createMediaStreamDestination()
        : null;
    if (this.#captureDestination)
      this.#master.connect(this.#captureDestination);
    this.#assets = new AudioAssetManager(audioAssetManifest, (data) =>
      context.decodeAudioData(data),
    );
    this.#hrtf = new HRTFRenderer(context, this.#master);
    this.#sources = new SourceManager(
      context,
      this.#master,
      this.#assets,
      new GainManager(),
      new PlaybackScheduler(context),
      this.#hrtf,
      () => this.#emit(),
      (evidence) =>
        this.#evidenceListeners.forEach((listener) => listener(evidence)),
      (diagnostic) =>
        this.#diagnosticListeners.forEach((listener) => listener(diagnostic)),
    );
  }
  async #loadPlannedAssets(): Promise<void> {
    if (!this.#assets) return;
    await Promise.all(
      [...this.#plannedPreloadAssetIds].map((assetId) =>
        this.#assets!.load(assetId),
      ),
    );
  }
  #set(state: AudioEngineState): void {
    this.#state = state;
    this.#emit();
  }
  #emit(): void {
    this.#listeners.forEach((listener) => listener());
  }
}

export const audioEngine = new AudioEngine();
