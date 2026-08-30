export interface AudioAssetDefinition {
  assetId: string;
  url: string;
  preload?: boolean;
}
export interface AudioAssetFailure {
  ok: false;
  error: AudioAssetError;
}
export interface AudioAssetSuccess {
  ok: true;
  buffer: AudioBuffer;
}
export type AudioAssetResult = AudioAssetFailure | AudioAssetSuccess;

export class AudioAssetError extends Error {
  constructor(
    readonly code:
      | 'NOT_REGISTERED'
      | 'FETCH_FAILED'
      | 'DECODE_FAILED'
      | 'INVALID_PLAYBACK_POLICY'
      | 'AUDIO_START_TIMEOUT'
      | 'SOURCE_CREATION_FAILED',
    readonly assetId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AudioAssetError';
  }
}

export type AudioFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class AudioAssetManager {
  readonly #manifest = new Map<string, AudioAssetDefinition>();
  readonly #cache = new Map<string, AudioBuffer>();
  readonly #pending = new Map<string, Promise<AudioAssetResult>>();

  constructor(
    assets: readonly AudioAssetDefinition[],
    readonly decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
    readonly fetcher: AudioFetcher = (url) => fetch(url),
  ) {
    assets.forEach((asset) => this.#manifest.set(asset.assetId, asset));
  }

  resolve(assetId: string): AudioAssetDefinition | undefined {
    return this.#manifest.get(assetId);
  }
  get cachedCount(): number {
    return this.#cache.size;
  }

  load(assetId: string): Promise<AudioAssetResult> {
    const cached = this.#cache.get(assetId);
    if (cached) return Promise.resolve({ ok: true, buffer: cached });
    const pending = this.#pending.get(assetId);
    if (pending) return pending;
    const definition = this.resolve(assetId);
    if (!definition)
      return Promise.resolve({
        ok: false,
        error: new AudioAssetError(
          'NOT_REGISTERED',
          assetId,
          `Unknown audio asset: ${assetId}`,
        ),
      });
    const request = this.#load(definition).finally(() =>
      this.#pending.delete(assetId),
    );
    this.#pending.set(assetId, request);
    return request;
  }

  async preload(): Promise<AudioAssetResult[]> {
    return Promise.all(
      [...this.#manifest.values()]
        .filter((asset) => asset.preload)
        .map((asset) => this.load(asset.assetId)),
    );
  }

  clear(): void {
    this.#cache.clear();
    this.#pending.clear();
  }

  async #load(definition: AudioAssetDefinition): Promise<AudioAssetResult> {
    let response: Awaited<ReturnType<AudioFetcher>>;
    try {
      response = await this.fetcher(definition.url);
    } catch (cause) {
      return {
        ok: false,
        error: new AudioAssetError(
          'FETCH_FAILED',
          definition.assetId,
          `Failed to fetch ${definition.assetId}`,
          cause,
        ),
      };
    }
    if (!response.ok)
      return {
        ok: false,
        error: new AudioAssetError(
          'FETCH_FAILED',
          definition.assetId,
          `Failed to fetch ${definition.assetId}: HTTP ${response.status}`,
        ),
      };
    try {
      const buffer = await this.decode(await response.arrayBuffer());
      this.#cache.set(definition.assetId, buffer);
      return { ok: true, buffer };
    } catch (cause) {
      return {
        ok: false,
        error: new AudioAssetError(
          'DECODE_FAILED',
          definition.assetId,
          `Failed to decode ${definition.assetId}`,
          cause,
        ),
      };
    }
  }
}
