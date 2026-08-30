import type { ListenerState, TransitionPolicy } from '@neuroscape/contracts';
import { EPSILON, vectorLength } from '../core/math.js';
import type {
  RuntimeEventBus,
  SceneTransitionFailureReason,
  SceneTransitionPhase,
} from '../events/RuntimeEvents.js';

export const SCENE_TRANSITION_STABILIZATION_MS = 5_000;

export interface RuntimeSceneTransitionState {
  readonly transitionId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly phase: SceneTransitionPhase;
  readonly startedAtMs: number;
  readonly arrivalTimeMs: number;
  readonly arrivedAtMs?: number;
  readonly completedAtMs?: number;
}

interface MutableSceneTransitionState {
  transitionId: string;
  fromLocationId: string;
  toLocationId: string;
  phase: SceneTransitionPhase;
  startedAtMs: number;
  arrivalTimeMs: number;
  arrivedAtMs?: number;
  completedAtMs?: number;
}

/**
 * Coordinates semantic scene-transition lifecycle without owning audio assets.
 * JourneyController owns movement; sound controllers remain responsible for
 * deterministic gain execution. This class only defines shared transition
 * timing/state so those systems do not invent competing notions of arrival.
 */
export class SceneTransitionCoordinator {
  #state: MutableSceneTransitionState | undefined;
  #timestampMs = 0;
  #nextId = 1;

  constructor(private readonly events: RuntimeEventBus) {}

  initialize(timestampMs = 0): void {
    this.#timestampMs = timestampMs;
    this.#state = undefined;
    this.#nextId = 1;
  }

  start(options: {
    fromLocationId: string;
    toLocationId: string;
    arrivalTimeMs: number;
  }): RuntimeSceneTransitionState | undefined {
    if (options.fromLocationId === options.toLocationId) return undefined;
    if (
      this.#state &&
      this.#state.phase !== 'complete' &&
      this.#state.fromLocationId === options.fromLocationId &&
      this.#state.toLocationId === options.toLocationId
    )
      return this.state;
    const transitionId = `scene-transition-${this.#nextId++}`;
    this.#state = {
      transitionId,
      fromLocationId: options.fromLocationId,
      toLocationId: options.toLocationId,
      phase: 'traversing',
      startedAtMs: this.#timestampMs,
      arrivalTimeMs: Math.max(this.#timestampMs + 1, options.arrivalTimeMs),
    };
    this.events.emit({
      type: 'SceneTransitionStarted',
      timestampMs: this.#timestampMs,
      transitionId,
      fromLocationId: options.fromLocationId,
      toLocationId: options.toLocationId,
      arrivalTimeMs: this.#state.arrivalTimeMs,
    });
    return this.state;
  }

  update(deltaTimeMs: number, listener: ListenerState): void {
    assertDeltaTime(deltaTimeMs);
    this.#timestampMs += deltaTimeMs;
    const state = this.#state;
    if (!state || state.phase === 'complete') return;

    if (listener.semanticLocation === state.toLocationId) {
      if (state.phase === 'traversing') {
        state.arrivedAtMs = this.#timestampMs;
        this.#setPhase('arriving');
        return;
      }
      if (state.phase === 'arriving') {
        this.#setPhase('stabilizing');
        return;
      }
      if (
        state.phase === 'stabilizing' &&
        this.#timestampMs - (state.arrivedAtMs ?? this.#timestampMs) >=
          SCENE_TRANSITION_STABILIZATION_MS
      ) {
        state.completedAtMs = this.#timestampMs;
        this.#setPhase('complete');
        this.events.emit({
          type: 'SceneTransitionCompleted',
          timestampMs: this.#timestampMs,
          transitionId: state.transitionId,
          fromLocationId: state.fromLocationId,
          toLocationId: state.toLocationId,
          arrivalTimeMs: state.arrivalTimeMs,
          completedAtMs: this.#timestampMs,
        });
      }
      return;
    }

    // Motion evidence keeps the lifecycle in traversal. Do not infer semantic
    // arrival from time alone; JourneyController is the location authority.
    if (
      vectorLength(listener.velocity) > EPSILON &&
      state.phase !== 'traversing'
    )
      this.#setPhase('traversing');
  }

  /** Use the remaining authored traversal time for ambient crossfades only. */
  ambientPolicy(base: TransitionPolicy): TransitionPolicy {
    const state = this.#state;
    if (!state || state.phase !== 'traversing') return base;
    return {
      ...base,
      defaultDurationMs: Math.max(
        base.defaultDurationMs,
        state.arrivalTimeMs - this.#timestampMs,
      ),
    };
  }

  /** Record a failed transition and restore runtime coordination to its origin. */
  rollback(reason: SceneTransitionFailureReason): void {
    const state = this.#state;

    if (!state || state.phase === 'complete') {
      this.#state = undefined;
      return;
    }

    this.events.emit({
      type: 'SceneTransitionFailed',
      timestampMs: this.#timestampMs,
      transitionId: state.transitionId,
      fromLocationId: state.fromLocationId,
      toLocationId: state.toLocationId,
      phase: state.phase,
      reason,
    });

    this.events.emit({
      type: 'SceneTransitionRolledBack',
      timestampMs: this.#timestampMs,
      transitionId: state.transitionId,
      fromLocationId: state.fromLocationId,
      toLocationId: state.toLocationId,
      restoredLocationId: state.fromLocationId,
      reason,
    });

    this.#state = undefined;
  }

  /** Silently discard stale coordination when no rollback semantics are needed. */
  cancel(): void {
    this.#state = undefined;
  }

  get state(): RuntimeSceneTransitionState | undefined {
    return this.#state ? Object.freeze({ ...this.#state }) : undefined;
  }

  get active(): boolean {
    return Boolean(this.#state && this.#state.phase !== 'complete');
  }

  reset(): void {
    this.initialize(0);
  }

  #setPhase(phase: SceneTransitionPhase): void {
    const state = this.#state;
    if (!state || state.phase === phase) return;
    state.phase = phase;
    this.events.emit({
      type: 'SceneTransitionPhaseChanged',
      timestampMs: this.#timestampMs,
      transitionId: state.transitionId,
      fromLocationId: state.fromLocationId,
      toLocationId: state.toLocationId,
      phase,
    });
  }
}

function assertDeltaTime(deltaTimeMs: number): void {
  if (!Number.isFinite(deltaTimeMs) || deltaTimeMs < 0)
    throw new Error('deltaTimeMs must be a non-negative finite number.');
}
