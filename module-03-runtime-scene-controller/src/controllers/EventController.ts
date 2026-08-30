import type {
  EventPlanItem,
  EventState,
  ListenerState,
  TransitionPolicy,
  Vector3,
} from '@neuroscape/contracts';
import {
  EPSILON,
  plannedDistanceGain,
  lerpVector,
  scaleVector,
  smoothstep,
  smoothstepDerivative,
  subtractVector,
} from '../core/math.js';
import type { RuntimeEventBus } from '../events/RuntimeEvents.js';
import type { SemanticLocationMapper } from '../scene-graph/SemanticLocationMapper.js';
import type { TransitionController } from './TransitionController.js';

interface NumericTrajectoryWaypoint {
  position: Vector3;
  timestampMs: number;
}

interface EventRuntimeObject {
  plan: EventPlanItem;
  id: string;
  assetId: string;
  activationTimeMs: number;
  durationMs: number;
  baseGain: number;
  trajectory: NumericTrajectoryWaypoint[];
  worldPosition: Vector3;
  velocity: Vector3;
  lifecycle: 'waiting' | 'active' | 'finished';
  transitionKey: string;
  removalScheduled: boolean;
  finishedPublished: boolean;
  replacement?: EventPlanItem;
  runtimeActivationMs?: number;
  runtimeFinishedMs?: number;
}

export const SHORT_EVENT_ENVELOPE = Object.freeze({
  fadeInMs: 750,
  fadeOutMs: 1_000,
  minimumAudiblePlateauMs: 3_000,
}); // TBD_PILOT

export class EventController {
  readonly #objects = new Map<string, EventRuntimeObject>();
  #policy: TransitionPolicy = { defaultDurationMs: 1, curve: 'linear' };
  #timestampMs = 0;

  constructor(
    private readonly locationMapper: SemanticLocationMapper,
    private readonly transitions: TransitionController,
    private readonly events: RuntimeEventBus,
  ) {}

  initialize(
    items: readonly EventPlanItem[],
    policy: TransitionPolicy,
    timestampMs = 0,
  ): void {
    this.#objects.clear();
    this.#policy = policy;
    this.#timestampMs = timestampMs;
    items.forEach((item) => this.create(item));
  }

  merge(items: readonly EventPlanItem[], policy: TransitionPolicy): void {
    this.#policy = policy;
    const incoming = new Map(items.map((item) => [item.id, item]));
    const replacements: EventPlanItem[] = [];
    for (const object of this.#objects.values()) {
      const item = incoming.get(object.id);
      if (!item) {
        this.beginRemoval(object);
        continue;
      }
      incoming.delete(item.id);
      if (object.assetId !== item.assetId) {
        this.#objects.delete(object.id);
        this.transitions.release(object.transitionKey);
        replacements.push(item);
        continue;
      }
      this.mergeCompatible(object, item);
    }
    [...incoming.values(), ...replacements].forEach((item) =>
      this.create(item),
    );
  }

  update(deltaTimeMs: number, _listener: ListenerState): void {
    this.#timestampMs += deltaTimeMs;
    for (const [id, object] of this.#objects) {
      if (object.lifecycle === 'finished') {
        if (object.finishedPublished) {
          this.#objects.delete(id);
          this.transitions.release(object.transitionKey);
          if (object.replacement) this.create(object.replacement);
        }
        continue;
      }

      if (
        object.removalScheduled &&
        this.transitions.isComplete(object.transitionKey)
      ) {
        object.lifecycle = 'finished';
        object.runtimeFinishedMs = this.#timestampMs;
        object.velocity = [0, 0, 0];
        object.finishedPublished = true;
        this.events.emit({
          type: 'EventFinished',
          timestampMs: this.#timestampMs,
          eventId: object.id,
        });
        continue;
      }

      if (
        object.lifecycle === 'waiting' &&
        this.#timestampMs >= object.activationTimeMs
      ) {
        if (this.#timestampMs >= object.activationTimeMs + object.durationMs) {
          object.lifecycle = 'finished';
          object.runtimeFinishedMs = this.#timestampMs;
          object.finishedPublished = true;
          this.events.emit({
            type: 'EventFinished',
            timestampMs: this.#timestampMs,
            eventId: object.id,
          });
          continue;
        }
        object.lifecycle = 'active';
        object.runtimeActivationMs = this.#timestampMs;
        this.events.emit({
          type: 'EventSpawned',
          timestampMs: this.#timestampMs,
          eventId: object.id,
        });
        this.transitions.scheduleActivation(
          object.transitionKey,
          object.baseGain,
          this.envelope(object).fadeInMs,
          this.#policy.curve,
        );
      }

      if (object.lifecycle !== 'active') continue;
      const sample = sampleTrajectory(
        object.trajectory,
        this.#timestampMs,
        object.plan.interpolation ?? 'linear',
      );
      object.worldPosition = sample.position;
      object.velocity = sample.velocity;

      const endTimeMs = object.activationTimeMs + object.durationMs;
      if (this.#timestampMs >= endTimeMs) {
        object.lifecycle = 'finished';
        object.runtimeFinishedMs = this.#timestampMs;
        object.velocity = [0, 0, 0];
        object.finishedPublished = true;
        this.transitions.release(object.transitionKey);
        this.events.emit({
          type: 'EventFinished',
          timestampMs: this.#timestampMs,
          eventId: object.id,
        });
        continue;
      }
      const fadeDurationMs = this.envelope(object).fadeOutMs;
      if (
        !object.removalScheduled &&
        this.#timestampMs >= endTimeMs - fadeDurationMs
      ) {
        const remainingMs = Math.max(0, endTimeMs - this.#timestampMs);
        object.removalScheduled = true;
        this.transitions.scheduleRemoval(
          object.transitionKey,
          this.transitions.getValue(object.transitionKey, 0),
          remainingMs,
          this.#policy.curve,
        );
      }
    }
  }

  getStates(listener: ListenerState): EventState[] {
    return [...this.#objects.values()].map((object) => {
      const envelopeGain = this.transitions.getValue(object.transitionKey, 0);
      const gain =
        envelopeGain *
        plannedDistanceGain(
          Math.hypot(
            object.worldPosition[0] - listener.worldPosition[0],
            object.worldPosition[1] - listener.worldPosition[1],
            object.worldPosition[2] - listener.worldPosition[2],
          ),
          object.plan.distancePolicy,
        );
      return {
        id: object.id,
        adaptationId: object.plan.adaptationId,
        assetId: object.assetId,
        worldPosition: [...object.worldPosition],
        velocity: [...object.velocity],
        gain,
        lifecycle: object.lifecycle,
        active: object.lifecycle === 'active' && gain > EPSILON,
        plannedStartMs: object.activationTimeMs,
        runtimeActivationMs: object.runtimeActivationMs,
        plannedEndMs: object.activationTimeMs + object.durationMs,
        runtimeFinishedMs: object.runtimeFinishedMs,
        distancePolicy: structuredClone(object.plan.distancePolicy),
        playback: structuredClone(object.plan.playback),
        foregroundSalience: object.plan.foregroundSalience,
        foregroundEnvelope:
          object.baseGain > EPSILON
            ? Math.max(0, Math.min(1, envelopeGain / object.baseGain))
            : 0,
      };
    });
  }

  get size(): number {
    return this.#objects.size;
  }

  reset(): void {
    this.#objects.clear();
    this.#timestampMs = 0;
  }

  private create(item: EventPlanItem): void {
    const trajectory = this.resolveTrajectory(item);
    const firstPosition = trajectory[0]?.position;
    if (!firstPosition)
      throw new Error(`Event ${item.id} requires a trajectory.`);
    this.#objects.set(item.id, {
      plan: structuredClone(item),
      id: item.id,
      assetId: item.assetId,
      activationTimeMs: item.activationTimeMs,
      durationMs: item.durationMs,
      baseGain: item.gain,
      trajectory,
      worldPosition: [...firstPosition],
      velocity: [0, 0, 0],
      lifecycle: 'waiting',
      transitionKey: `event:${item.id}:gain`,
      removalScheduled: false,
      finishedPublished: false,
    });
  }

  private mergeCompatible(
    object: EventRuntimeObject,
    item: EventPlanItem,
  ): void {
    object.baseGain = item.gain;
    object.plan = structuredClone(item);
    object.activationTimeMs = item.activationTimeMs;
    object.durationMs = item.durationMs;
    object.replacement = undefined;
    if (
      object.lifecycle === 'active' &&
      item.trajectoryUpdatePolicy === 'continue-from-current-position'
    ) {
      const future = this.resolveTrajectory(item).filter(
        (waypoint) => waypoint.timestampMs > this.#timestampMs,
      );
      object.trajectory = [
        { position: [...object.worldPosition], timestampMs: this.#timestampMs },
        ...future,
      ];
      this.transitions.scheduleGain(
        object.transitionKey,
        this.transitions.getValue(object.transitionKey, 0),
        item.gain,
        this.#policy.defaultDurationMs,
        this.#policy.curve,
      );
    } else {
      object.trajectory = this.resolveTrajectory(item);
    }
  }

  private beginRemoval(object: EventRuntimeObject): void {
    if (object.removalScheduled) return;
    object.removalScheduled = true;
    this.transitions.scheduleRemoval(
      object.transitionKey,
      this.transitions.getValue(object.transitionKey, 0),
      this.envelope(object).fadeOutMs,
      this.#policy.curve,
    );
  }

  private resolveTrajectory(item: EventPlanItem): NumericTrajectoryWaypoint[] {
    return item.trajectory.map((waypoint) => ({
      position: this.locationMapper.resolve(waypoint.locationId),
      timestampMs: waypoint.timestampMs,
    }));
  }

  private envelope(object: EventRuntimeObject): {
    fadeInMs: number;
    fadeOutMs: number;
  } {
    const availableFadeMs = Math.max(
      0,
      object.durationMs - SHORT_EVENT_ENVELOPE.minimumAudiblePlateauMs,
    );
    const authoredFadeTotalMs =
      SHORT_EVENT_ENVELOPE.fadeInMs + SHORT_EVENT_ENVELOPE.fadeOutMs;
    const scale = Math.min(1, availableFadeMs / authoredFadeTotalMs);
    return {
      fadeInMs: SHORT_EVENT_ENVELOPE.fadeInMs * scale,
      fadeOutMs: SHORT_EVENT_ENVELOPE.fadeOutMs * scale,
    };
  }
}

function sampleTrajectory(
  trajectory: readonly NumericTrajectoryWaypoint[],
  timestampMs: number,
  interpolation: 'linear' | 'smoothstep',
): { position: Vector3; velocity: Vector3 } {
  const first = trajectory[0];
  if (!first) return { position: [0, 0, 0], velocity: [0, 0, 0] };
  if (timestampMs <= first.timestampMs) {
    return { position: [...first.position], velocity: [0, 0, 0] };
  }
  for (let index = 0; index < trajectory.length - 1; index += 1) {
    const from = trajectory[index]!;
    const to = trajectory[index + 1]!;
    if (timestampMs <= to.timestampMs) {
      const durationMs = Math.max(1, to.timestampMs - from.timestampMs);
      const progress = Math.max(
        0,
        Math.min(1, (timestampMs - from.timestampMs) / durationMs),
      );
      const delta = subtractVector(to.position, from.position);
      const eased =
        interpolation === 'smoothstep' ? smoothstep(progress) : progress;
      return {
        position: lerpVector(from.position, to.position, eased),
        velocity: scaleVector(
          delta,
          ((interpolation === 'smoothstep'
            ? smoothstepDerivative(progress)
            : 1) /
            durationMs) *
            1000,
        ),
      };
    }
  }
  return {
    position: [...trajectory[trajectory.length - 1]!.position],
    velocity: [0, 0, 0],
  };
}
