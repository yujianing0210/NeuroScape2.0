import {
  canonicalPlaybackPolicy,
  hasMeaningfulAuthoredMotion,
  type AudioLibraryAsset,
  type AudioLibraryMotion,
  type DistancePolicy,
  type EventMotion,
  type PlaybackPolicy,
  type Vector3,
} from '@neuroscape/contracts';

export interface EventMotionResolutionContext {
  elementId: string;
  gain: number;
}

export interface ResolvedEventMotionPlayback {
  motion: EventMotion;
  durationMs: number;
  playback: PlaybackPolicy;
  distancePolicy?: DistancePolicy;
}

/**
 * Converts authored library metadata into deterministic physical playback.
 * It deliberately has no session clock, network, or LLM dependency so replaying
 * the same element ID always produces the same motion and burst layout.
 */
export function resolveEventMotionPlayback(
  asset: AudioLibraryAsset,
  context: EventMotionResolutionContext,
): ResolvedEventMotionPlayback {
  const motion = resolveMotion(asset, context.elementId);
  const meaningfulMotion = hasMeaningfulAuthoredMotion(asset);
  const authoredMotionMs = positiveMilliseconds(asset.default_motion.duration);
  const fallbackLifecycleMs = positiveMilliseconds(
    asset.playback_contract?.resolved_lifecycle_sec ??
      asset.auto_delete_after_sec ??
      asset.default_motion.duration,
  );
  const durationMs =
    meaningfulMotion && authoredMotionMs > 0
      ? authoredMotionMs
      : fallbackLifecycleMs;
  const playback = resolvePlayback(asset, context, meaningfulMotion);
  return {
    motion,
    durationMs,
    playback,
    ...(meaningfulMotion
      ? { distancePolicy: motionDistancePolicy(motion) }
      : {}),
  };
}

function resolveMotion(
  asset: AudioLibraryAsset,
  elementId: string,
): EventMotion {
  const authored = asset.default_motion;
  const stationary = cloneVector(asset.default_position);
  switch (authored.type) {
    case 'drift':
    case 'approach':
    case 'recede':
      return {
        motionMode: 'drift',
        startPosition: vectorOr(authored.start, stationary),
        endPosition: vectorOr(authored.end, stationary),
      };
    case 'overhead_pass':
      return {
        motionMode: 'pass-by',
        startPosition: vectorOr(authored.start, stationary),
        endPosition: vectorOr(authored.end, stationary),
        ...(authored.mid ? { controlPoint: cloneVector(authored.mid) } : {}),
      };
    case 'approach_recede':
    case 'approach-recede':
      return {
        motionMode: 'approach-recede',
        startPosition: vectorOr(authored.start, stationary),
        endPosition: vectorOr(authored.end, stationary),
        ...(authored.mid ? { controlPoint: cloneVector(authored.mid) } : {}),
      };
    case 'local_random':
      return resolveDeterministicLocalMotion(asset, authored, elementId);
    case 'none':
    case 'stationary':
    default:
      return {
        motionMode: 'stationary',
        startPosition: stationary,
        endPosition: cloneVector(stationary),
      };
  }
}

function resolveDeterministicLocalMotion(
  asset: AudioLibraryAsset,
  authored: AudioLibraryMotion,
  elementId: string,
): EventMotion {
  const center = vectorOr(authored.center, asset.default_position);
  const radius = Math.max(0.05, authored.radius ?? 0.25);
  const hash = stableHash(`${asset.asset_id}:${elementId}`);
  const direction = (hash & 1) === 0 ? 1 : -1;
  const angle = ((hash % 360) * Math.PI) / 180;
  const endAngle = angle + direction * (Math.PI / 2);
  const middleAngle = angle + direction * (Math.PI / 4);
  const point = (phase: number, scale = 1): Vector3 => [
    center[0] + Math.cos(phase) * radius * scale,
    center[1],
    center[2] + Math.sin(phase) * radius * scale,
  ];
  return {
    motionMode: 'orbit-arc',
    startPosition: point(angle),
    controlPoint: point(middleAngle, 0.8),
    endPosition: point(endAngle),
    arcDirection: direction > 0 ? 'counterclockwise' : 'clockwise',
  };
}

function resolvePlayback(
  asset: AudioLibraryAsset,
  context: EventMotionResolutionContext,
  meaningfulMotion: boolean,
): PlaybackPolicy {
  const contract = asset.playback_contract;
  if (!contract)
    throw new Error(
      `Canonical audio asset ${asset.asset_id} has no playback_contract.`,
    );
  const safeGain = Math.max(
    0,
    Math.min(context.gain, asset.gain_profile?.max_safe_gain ?? 1),
  );
  if (contract.mode === 'burst') {
    const repeatCount = stableChoice(
      contract.repeat_count_options,
      `${asset.asset_id}:${context.elementId}`,
    );
    if (!repeatCount)
      throw new Error(
        `Canonical audio asset ${asset.asset_id} has no valid repeat count.`,
      );
    return {
      mode: 'repeat',
      durationPolicy: 'truncate-at-end',
      repeatCount,
      repeatGapMs: contract.inter_repeat_gap_sec * 1_000,
      perRepeatGain: Array.from({ length: repeatCount }, () => safeGain),
      spreadAcrossLifecycle: true,
    };
  }
  if (
    contract.mode === 'single' &&
    meaningfulMotion &&
    contract.requires_gain_motion
  ) {
    return { mode: 'loop', durationPolicy: 'loop-until-end' };
  }
  return canonicalPlaybackPolicy(asset.asset_id, safeGain);
}

function motionDistancePolicy(motion: EventMotion): DistancePolicy {
  const points = [
    motion.startPosition,
    motion.controlPoint,
    motion.endPosition,
  ].filter((point): point is Vector3 => Boolean(point));
  const distances = points.map((point) => Math.hypot(...point));
  const closest = Math.min(...distances);
  const farthest = Math.max(...distances);
  return {
    mode: 'inverse',
    referenceDistance: Math.max(1, closest * 0.6),
    maxDistance: Math.max(1, farthest * 1.25),
    minGain: 0.35,
  };
}

function stableChoice<T>(values: readonly T[], key: string): T | undefined {
  if (!values.length) return undefined;
  return values[stableHash(key) % values.length];
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function positiveMilliseconds(seconds: number | null | undefined): number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1_000)
    : 0;
}

function vectorOr(value: Vector3 | undefined, fallback: Vector3): Vector3 {
  return value ? cloneVector(value) : cloneVector(fallback);
}

function cloneVector(value: Vector3): Vector3 {
  return [value[0], value[1], value[2]];
}
