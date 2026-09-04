export interface PlaybackTarget {
  input: AudioNode;
  source: AudioBufferSourceNode | null;
  playing: boolean;
  activationPlayed: boolean;
  onPlaybackEnded?: () => void;
  sources?: Set<AudioBufferSourceNode>;
}

export class PlaybackScheduler {
  constructor(readonly context: BaseAudioContext) {}
  start(
    target: PlaybackTarget,
    buffer: AudioBuffer,
    loop: boolean,
    when: number,
  ): boolean {
    if (target.playing || (!loop && target.activationPlayed)) return false;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(target.input);
    target.source = source;
    target.playing = true;
    target.activationPlayed = true;
    source.onended = () => {
      if (target.source === source) {
        target.source = null;
        target.playing = false;
        target.onPlaybackEnded?.();
      }
      source.disconnect();
    };
    source.start(Math.max(when, this.context.currentTime));
    return true;
  }
  startBurst(
    target: PlaybackTarget,
    buffer: AudioBuffer,
    when: number,
    repeatCount: number,
    repeatGapSeconds: number,
    lifecycleSeconds?: number,
  ): boolean {
    if (target.playing || target.activationPlayed) return false;
    const count = Math.max(1, Math.floor(repeatCount));
    const start = Math.max(when, this.context.currentTime);
    target.sources = new Set();
    target.playing = true;
    target.activationPlayed = true;
    const minimumInterval = buffer.duration + repeatGapSeconds;
    const distributedInterval =
      lifecycleSeconds !== undefined && count > 1
        ? Math.max(0, lifecycleSeconds - buffer.duration) / (count - 1)
        : minimumInterval;
    const interval = Math.max(minimumInterval, distributedInterval);
    for (let index = 0; index < count; index += 1) {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = false;
      source.connect(target.input);
      target.sources.add(source);
      if (index === 0) target.source = source;
      source.onended = () => {
        target.sources?.delete(source);
        source.disconnect();
        if (!target.sources?.size) {
          target.source = null;
          target.playing = false;
          target.onPlaybackEnded?.();
        }
      };
      source.start(start + index * interval);
    }
    return true;
  }
  stop(target: PlaybackTarget, when: number): void {
    const sources = target.sources?.size
      ? [...target.sources]
      : target.source
        ? [target.source]
        : [];
    target.sources?.clear();
    target.source = null;
    target.playing = false;
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop(Math.max(when, this.context.currentTime));
      } catch {
        /* already ended */
      }
      source.disconnect();
    }
  }
  resetActivation(target: PlaybackTarget): void {
    target.activationPlayed = false;
  }
  dispose(targets: Iterable<PlaybackTarget>): void {
    for (const target of targets) this.stop(target, this.context.currentTime);
  }
}
