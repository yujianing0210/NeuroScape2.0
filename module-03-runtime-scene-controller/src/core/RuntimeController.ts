import type {
  RuntimeWorldState,
  SceneJourneyPlan,
} from '@neuroscape/contracts';
import type { ActionController } from '../controllers/ActionController.js';
import type { AmbientController } from '../controllers/AmbientController.js';
import type { EventController } from '../controllers/EventController.js';
import type { JourneyController } from '../controllers/JourneyController.js';
import type { TransitionController } from '../controllers/TransitionController.js';
import {
  SceneTransitionCoordinator,
  type RuntimeSceneTransitionState,
} from '../controllers/SceneTransitionCoordinator.js';
import type { RuntimeEventBus } from '../events/RuntimeEvents.js';
import { noopRuntimeLogger, type RuntimeLogger } from '../logging/index.js';
import type { PlanValidator } from '../validation/PlanValidator.js';
import type { RuntimeWorldStateBuilder } from './RuntimeWorldStateBuilder.js';

export interface RuntimeControllerDependencies {
  validator: PlanValidator;
  stateBuilder: RuntimeWorldStateBuilder;
  journey: JourneyController;
  ambient: AmbientController;
  action: ActionController;
  event: EventController;
  transitions: TransitionController;
  events: RuntimeEventBus;
  logger?: RuntimeLogger;
}

export interface ApplyPlanOptions {
  /** Merge a non-journey patch without replacing an in-flight journey. */
  preserveActiveJourney?: boolean;
}

export class RuntimeController {
  #activePlan: SceneJourneyPlan | undefined;
  #currentState: RuntimeWorldState | undefined;
  #timestampMs = 0;
  readonly #validator: PlanValidator;
  readonly #stateBuilder: RuntimeWorldStateBuilder;
  readonly #journey: JourneyController;
  readonly #ambient: AmbientController;
  readonly #action: ActionController;
  readonly #event: EventController;
  readonly #transitions: TransitionController;
  readonly #events: RuntimeEventBus;
  readonly #sceneTransitions: SceneTransitionCoordinator;
  readonly #logger: RuntimeLogger;

  constructor(dependencies: RuntimeControllerDependencies) {
    this.#validator = dependencies.validator;
    this.#stateBuilder = dependencies.stateBuilder;
    this.#journey = dependencies.journey;
    this.#ambient = dependencies.ambient;
    this.#action = dependencies.action;
    this.#event = dependencies.event;
    this.#transitions = dependencies.transitions;
    this.#events = dependencies.events;
    this.#sceneTransitions = new SceneTransitionCoordinator(this.#events);
    this.#logger = dependencies.logger ?? noopRuntimeLogger;
    this.#events.subscribe((event) => {
      this.#logger.log({
        timestampMs: event.timestampMs,
        module: 'RuntimeEvent',
        severity: 'debug',
        eventType: event.type,
        message: event.type,
        payload: event,
      });
    });
  }

  initialize(plan: SceneJourneyPlan): void {
    const validatedPlan = this.requireValidPlan(plan);
    this.#timestampMs = 0;
    this.#transitions.initialize(0);
    this.#journey.initialize(validatedPlan, 0);
    const listener = this.#journey.getListenerState();
    this.#ambient.initialize(
      validatedPlan.soundscape.ambient,
      validatedPlan.transitionPolicy,
    );
    this.#action.initialize(
      validatedPlan.soundscape.action,
      validatedPlan.transitionPolicy,
      listener,
    );
    this.#event.initialize(
      validatedPlan.soundscape.event,
      validatedPlan.transitionPolicy,
      0,
    );
    this.#activePlan = validatedPlan;
    this.#sceneTransitions.initialize(0);
    this.#currentState = this.buildSnapshot(listener);
    this.#logger.log({
      timestampMs: 0,
      module: 'RuntimeController',
      severity: 'info',
      eventType: 'initialized',
      message: `Initialized runtime with plan ${validatedPlan.planId}.`,
    });
  }

  update(deltaTimeMs: number): RuntimeWorldState {
    if (!this.#currentState)
      throw new Error('RuntimeController is not initialized.');
    assertDeltaTime(deltaTimeMs);
    this.#timestampMs += deltaTimeMs;

    const listener = this.#journey.update(deltaTimeMs);
    this.#sceneTransitions.update(deltaTimeMs, listener);
    this.#ambient.update(deltaTimeMs, listener);
    this.#action.update(deltaTimeMs, listener);
    this.#event.update(deltaTimeMs, listener);
    this.#transitions.update(deltaTimeMs);
    this.#currentState = this.buildSnapshot(listener);
    return this.#currentState;
  }

  applyPlan(plan: SceneJourneyPlan, options: ApplyPlanOptions = {}): void {
    const validatedPlan = this.requireValidPlan(plan);
    if (!this.#currentState) {
      this.initialize(validatedPlan);
      return;
    }

    const currentListener = this.#journey.getListenerState();
    const activeTransition = this.#sceneTransitions.state;
    const preserveActiveJourney =
      options.preserveActiveJourney === true &&
      activeTransition !== undefined &&
      activeTransition.phase !== 'complete';
    const destination = validatedPlan.userJourney.waypoints.at(-1);

    if (preserveActiveJourney) {
      // A within-scene patch is an audio merge, not an implicit cancellation of
      // the already accepted journey transaction. Keep its future waypoint so
      // JourneyController can remain the semantic-arrival authority.
    } else if (
      destination &&
      destination.locationId !== currentListener.semanticLocation &&
      (destination.arrivalTimeMs === undefined ||
        destination.arrivalTimeMs > this.#timestampMs)
    ) {
      this.#sceneTransitions.start({
        fromLocationId: currentListener.semanticLocation,
        toLocationId: destination.locationId,
        arrivalTimeMs:
          destination.arrivalTimeMs ??
          this.#timestampMs + validatedPlan.transitionPolicy.defaultDurationMs,
      });
    } else {
      // A rollback/replacement can restore the origin plan while Runtime still
      // holds transition coordination for the abandoned destination.
      if (
        activeTransition &&
        activeTransition.phase !== 'complete' &&
        activeTransition.toLocationId !== currentListener.semanticLocation
      )
        this.#sceneTransitions.rollback('plan-replaced-before-arrival');
    }

    if (!preserveActiveJourney) this.#journey.replacePlan(validatedPlan);
    const listener = this.#journey.getListenerState();
    this.#ambient.merge(
      validatedPlan.soundscape.ambient,
      this.#sceneTransitions.ambientPolicy(validatedPlan.transitionPolicy),
    );
    const actionItems = preserveActiveJourney
      ? preserveJourneyActions(
          this.#activePlan?.soundscape.action ?? [],
          validatedPlan.soundscape.action,
        )
      : validatedPlan.soundscape.action;
    this.#action.merge(
      actionItems,
      validatedPlan.transitionPolicy,
      listener,
    );
    this.#event.merge(
      validatedPlan.soundscape.event,
      validatedPlan.transitionPolicy,
    );
    this.#activePlan = preserveActiveJourney && this.#activePlan
      ? {
          ...validatedPlan,
          userJourney: structuredClone(this.#activePlan.userJourney),
          soundscape: { ...validatedPlan.soundscape, action: structuredClone(actionItems) },
        }
      : validatedPlan;
    // Publish the newly validated schedule immediately. Controllers retain
    // future elements as waiting; no clock advancement or early activation is
    // introduced at the merge boundary.
    this.#currentState = this.buildSnapshot(listener);
    this.#logger.log({
      timestampMs: this.#timestampMs,
      module: 'RuntimeController',
      severity: 'info',
      eventType: 'planAccepted',
      message: `Merged plan ${validatedPlan.planId} without resetting the runtime world.`,
    });
  }

  shutdown(): void {
    const timestampMs = this.#timestampMs;
    this.#journey.reset();
    this.#ambient.reset();
    this.#action.reset();
    this.#event.reset();
    this.#transitions.reset();
    this.#sceneTransitions.reset();
    this.#activePlan = undefined;
    this.#currentState = undefined;
    this.#timestampMs = 0;
    this.#logger.log({
      timestampMs,
      module: 'RuntimeController',
      severity: 'info',
      eventType: 'shutdown',
      message: 'Runtime shut down.',
    });
  }

  get currentState(): RuntimeWorldState | undefined {
    return this.#currentState;
  }

  get activePlan(): SceneJourneyPlan | undefined {
    return this.#activePlan;
  }

  get events(): RuntimeEventBus {
    return this.#events;
  }

  get sceneTransitionState(): RuntimeSceneTransitionState | undefined {
    return this.#sceneTransitions.state;
  }

  private buildSnapshot(
    listener: RuntimeWorldState['listener'],
  ): RuntimeWorldState {
    return this.#stateBuilder.build({
      timestampMs: this.#timestampMs,
      listener,
      journey: this.#journey.getJourneyState(),
      ambient: this.#ambient.getStates(listener),
      action: this.#action.getStates(),
      event: this.#event.getStates(listener),
    });
  }

  private requireValidPlan(candidate: unknown): SceneJourneyPlan {
    const result = this.#validator.validate(candidate);
    if (!result.valid || !result.plan) {
      this.#logger.log({
        timestampMs: this.#timestampMs,
        module: 'RuntimeController',
        severity: 'error',
        eventType: 'planRejected',
        message: result.errors.join(' '),
      });
      throw new Error(`Invalid SceneJourneyPlan: ${result.errors.join(' ')}`);
    }
    return result.plan;
  }
}

function preserveJourneyActions(
  active: SceneJourneyPlan['soundscape']['action'],
  incoming: SceneJourneyPlan['soundscape']['action'],
): SceneJourneyPlan['soundscape']['action'] {
  const merged = new Map(incoming.map((item) => [item.id, item]));
  active
    .filter((item) => item.playback?.mode === 'loop-until-arrival')
    .forEach((item) => {
      if (!merged.has(item.id)) merged.set(item.id, item);
    });
  return [...merged.values()];
}

function assertDeltaTime(deltaTimeMs: number): void {
  if (!Number.isFinite(deltaTimeMs) || deltaTimeMs < 0) {
    throw new Error('deltaTimeMs must be a non-negative finite number.');
  }
}
