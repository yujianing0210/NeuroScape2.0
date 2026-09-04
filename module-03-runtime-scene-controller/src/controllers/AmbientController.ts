import type {
  AmbientPlanItem,
  AmbientState,
  ListenerState,
  ResolvedAudioEnvelope,
  TransitionPolicy,
  Vector3,
} from '@neuroscape/contracts';
import { resolveAudioEnvelope } from '@neuroscape/contracts';
import { clamp, distance, EPSILON, plannedDistanceGain } from '../core/math.js';
import type { SemanticLocationMapper } from '../scene-graph/SemanticLocationMapper.js';
import type { TransitionController } from './TransitionController.js';

interface AmbientRuntimeObject {
  plan: AmbientPlanItem;
  id: string;
  assetId: string;
  mode: 'global' | 'localized';
  worldPosition?: Vector3;
  targetGain: number;
  desiredActive: boolean;
  transitionKey: string;
  pendingRemoval: boolean;
  replacement?: AmbientPlanItem;
  startMs: number;
  endMs: number;
  lifecycle: 'waiting' | 'active' | 'finished';
  runtimeActivationMs?: number;
  runtimeFinishedMs?: number;
  envelope: ResolvedAudioEnvelope;
}

export class AmbientController {
  readonly #objects = new Map<string, AmbientRuntimeObject>();
  #policy: TransitionPolicy = { defaultDurationMs: 1, curve: 'linear' };
  #timestampMs = 0;

  constructor(
    private readonly locationMapper: SemanticLocationMapper,
    private readonly transitions: TransitionController,
  ) {}

  initialize(
    items: readonly AmbientPlanItem[],
    policy: TransitionPolicy,
  ): void {
    this.#objects.clear();
    this.#policy = policy;
    this.#timestampMs = 0;
    items.forEach((item) => this.create(item));
  }

  merge(items: readonly AmbientPlanItem[], policy: TransitionPolicy): void {
    this.#policy = policy;
    const incoming = new Map(items.map((item) => [item.id, item]));
    for (const object of this.#objects.values()) {
      const item = incoming.get(object.id);
      if (!item) {
        this.beginRemoval(object);
        continue;
      }
      incoming.delete(object.id);
      if (!this.isCompatible(object, item)) {
        object.replacement = structuredClone(item);
        this.beginRemoval(object);
        continue;
      }
      object.targetGain = item.gain;
      object.plan = structuredClone(item);
      object.desiredActive = item.active;
      object.startMs = item.startMs ?? 0;
      object.endMs = item.endMs ?? Number.POSITIVE_INFINITY;
      object.envelope = this.resolveEnvelope(item);
      object.pendingRemoval = false;
      object.replacement = undefined;
      const currentGain = this.transitions.getValue(object.transitionKey, 0);
      if (!item.active) {
        this.beginRemoval(object);
        continue;
      }
      this.transitions.scheduleGain(
        object.transitionKey,
        currentGain,
        item.gain,
        currentGain > EPSILON
          ? policy.defaultDurationMs
          : object.envelope.fadeInMs,
        policy.curve,
      );
    }
    incoming.forEach((item) => this.create(item));
  }

  update(deltaTimeMs: number, _listener: ListenerState): void {
    this.#timestampMs += deltaTimeMs;
    for (const [id, object] of this.#objects) {
      if (
        object.pendingRemoval &&
        this.transitions.isComplete(object.transitionKey)
      ) {
        this.#objects.delete(id);
        this.transitions.release(object.transitionKey);
        if (object.replacement) this.create(object.replacement);
        continue;
      }
      if (object.pendingRemoval) continue;
      const nextLifecycle = executionLifecycle(object, this.#timestampMs);
      if (nextLifecycle !== object.lifecycle) {
        object.lifecycle = nextLifecycle;
        if (nextLifecycle === 'active')
          object.runtimeActivationMs = this.#timestampMs;
        if (nextLifecycle === 'finished')
          object.runtimeFinishedMs = this.#timestampMs;
        if (nextLifecycle === 'finished') this.beginRemoval(object, 0);
        else
          this.transitions.scheduleGain(
            object.transitionKey,
            this.transitions.getValue(object.transitionKey, 0),
            object.targetGain,
            object.envelope.fadeInMs,
            this.#policy.curve,
          );
      }
      if (
        object.lifecycle === 'active' &&
        Number.isFinite(object.endMs) &&
        !object.pendingRemoval &&
        this.#timestampMs >= object.endMs - object.envelope.fadeOutMs
      ) {
        this.beginRemoval(
          object,
          Math.max(0, object.endMs - this.#timestampMs),
        );
      }
    }
  }

  getStates(listener: ListenerState): AmbientState[] {
    return [...this.#objects.values()].map((object) => {
      const transitionedGain = this.transitions.getValue(
        object.transitionKey,
        0,
      );
      const distanceGain = object.worldPosition
        ? plannedDistanceGain(
            distance(listener.worldPosition, object.worldPosition),
            object.plan.distancePolicy,
          )
        : 1;
      const gain = clamp(transitionedGain * distanceGain);
      const lifecycle = object.lifecycle;
      const state: AmbientState = {
        id: object.id,
        adaptationId: object.plan.adaptationId,
        assetId: object.assetId,
        mode: object.mode,
        gain,
        active: lifecycle === 'active' && gain > EPSILON,
        lifecycle,
        distancePolicy: structuredClone(object.plan.distancePolicy),
        playback: structuredClone(object.plan.playback),
        plannedStartMs: object.startMs,
        runtimeActivationMs: object.runtimeActivationMs,
        plannedEndMs: Number.isFinite(object.endMs) ? object.endMs : undefined,
        runtimeFinishedMs: object.runtimeFinishedMs,
      };
      if (object.worldPosition) state.worldPosition = [...object.worldPosition];
      return state;
    });
  }

  get size(): number {
    return this.#objects.size;
  }

  reset(): void {
    this.#objects.clear();
    this.#timestampMs = 0;
  }

  private create(item: AmbientPlanItem): void {
    const transitionKey = `ambient:${item.id}:gain`;
    const object: AmbientRuntimeObject = {
      plan: structuredClone(item),
      id: item.id,
      assetId: item.assetId,
      mode: item.mode,
      targetGain: item.gain,
      desiredActive: item.active,
      transitionKey,
      pendingRemoval: false,
      startMs: item.startMs ?? 0,
      endMs: item.endMs ?? Number.POSITIVE_INFINITY,
      lifecycle: 'waiting',
      envelope: this.resolveEnvelope(item),
    };
    object.lifecycle = executionLifecycle(object, this.#timestampMs);
    if (object.lifecycle === 'active')
      object.runtimeActivationMs = this.#timestampMs;
    if (object.lifecycle === 'finished')
      object.runtimeFinishedMs = this.#timestampMs;
    if (item.mode === 'localized' && item.locationId) {
      object.worldPosition = this.locationMapper.resolve(item.locationId);
    }
    this.#objects.set(item.id, object);
    if (
      item.active &&
      executionLifecycle(object, this.#timestampMs) === 'active'
    ) {
      this.transitions.scheduleActivation(
        transitionKey,
        item.gain,
        object.envelope.fadeInMs,
        this.#policy.curve,
      );
    }
  }

  private beginRemoval(
    object: AmbientRuntimeObject,
    requestedDurationMs?: number,
  ): void {
    if (object.pendingRemoval) return;
    object.envelope = this.resolveEnvelope(object.plan);
    const durationMs = requestedDurationMs ?? object.envelope.fadeOutMs;
    object.pendingRemoval = true;
    object.desiredActive = false;
    const currentGain = this.transitions.getValue(object.transitionKey, 0);
    this.transitions.scheduleRemoval(
      object.transitionKey,
      currentGain,
      currentGain > EPSILON ? durationMs : 0,
      this.#policy.curve,
    );
  }

  private resolveEnvelope(item: AmbientPlanItem): ResolvedAudioEnvelope {
    const startMs = item.startMs ?? 0;
    const endMs = item.endMs ?? Number.POSITIVE_INFINITY;
    return resolveAudioEnvelope(item.assetId, {
      role: 'ambient',
      durationMs: Number.isFinite(endMs)
        ? Math.max(0, endMs - startMs)
        : undefined,
      fallbackDurationMs: this.#policy.defaultDurationMs,
    });
  }

  private isCompatible(
    object: AmbientRuntimeObject,
    item: AmbientPlanItem,
  ): boolean {
    if (object.assetId !== item.assetId || object.mode !== item.mode)
      return false;
    if (item.mode === 'localized' && item.locationId) {
      const nextPosition = this.locationMapper.resolve(item.locationId);
      return (
        distance(object.worldPosition ?? [0, 0, 0], nextPosition) <= EPSILON
      );
    }
    return true;
  }
}

function executionLifecycle(
  object: Pick<AmbientRuntimeObject, 'startMs' | 'endMs' | 'desiredActive'>,
  timestampMs: number,
): 'waiting' | 'active' | 'finished' {
  if (timestampMs < object.startMs) return 'waiting';
  if (timestampMs >= object.endMs) return 'finished';
  return object.desiredActive ? 'active' : 'finished';
}
