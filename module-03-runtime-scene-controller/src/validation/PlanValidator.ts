import {
  audioLibraryById,
  validateCanonicalPlaybackPolicy,
  type SceneJourneyPlan,
} from '@neuroscape/contracts';
import type { SceneGraph } from '../scene-graph/SceneGraph.js';

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  plan?: SceneJourneyPlan;
}

export class PlanValidator {
  constructor(private readonly sceneGraph: SceneGraph) {}

  validate(candidate: unknown): PlanValidationResult {
    const errors: string[] = [];
    if (!isRecord(candidate)) {
      return { valid: false, errors: ['Plan must be an object.'] };
    }

    requireString(candidate.planId, 'planId', errors);
    const planningHorizonSec = requirePositiveNumber(
      candidate.planningHorizonSec,
      'planningHorizonSec',
      errors,
    );
    if (candidate.reasoningSummary !== undefined) {
      requireString(candidate.reasoningSummary, 'reasoningSummary', errors);
    }

    this.validateJourney(candidate.userJourney, planningHorizonSec, errors);
    this.validateSoundscape(candidate.soundscape, errors);
    validateTransitionPolicy(candidate.transitionPolicy, errors);

    if (errors.length > 0) return { valid: false, errors };
    const plan = structuredClone(candidate) as unknown as SceneJourneyPlan;
    normalizeAudiblePolicies(plan);
    return {
      valid: true,
      errors: [],
      plan,
    };
  }

  private validateJourney(
    value: unknown,
    horizonSec: number | undefined,
    errors: string[],
  ): void {
    if (!isRecord(value)) {
      errors.push('userJourney must be an object.');
      return;
    }
    requireString(value.goal, 'userJourney.goal', errors);
    if (!Array.isArray(value.waypoints) || value.waypoints.length === 0) {
      errors.push('userJourney.waypoints must contain at least one waypoint.');
      return;
    }

    let previousArrival = -1;
    let previousLocation: string | undefined;
    value.waypoints.forEach((waypoint, index) => {
      const path = `userJourney.waypoints[${index}]`;
      if (!isRecord(waypoint)) {
        errors.push(`${path} must be an object.`);
        return;
      }
      const locationId = requireString(
        waypoint.locationId,
        `${path}.locationId`,
        errors,
      );
      if (locationId && !this.sceneGraph.hasNode(locationId)) {
        errors.push(
          `${path}.locationId references unknown location ${locationId}.`,
        );
      }
      if (locationId && previousLocation && locationId !== previousLocation) {
        const previousNode = this.sceneGraph.getNode(previousLocation);
        if (previousNode && !previousNode.neighbors.includes(locationId)) {
          errors.push(
            `${path}.locationId is not connected to previous location ${previousLocation}.`,
          );
        }
      }
      if (locationId) previousLocation = locationId;

      if (waypoint.arrivalTimeMs !== undefined) {
        const arrival = requireNonNegativeNumber(
          waypoint.arrivalTimeMs,
          `${path}.arrivalTimeMs`,
          errors,
        );
        if (arrival !== undefined) {
          if (arrival < previousArrival)
            errors.push(`${path}.arrivalTimeMs must be monotonic.`);
          if (horizonSec !== undefined && arrival > horizonSec * 1000) {
            errors.push(`${path}.arrivalTimeMs exceeds the planning horizon.`);
          }
          previousArrival = arrival;
        }
      }
      if (waypoint.pauseDurationMs !== undefined) {
        requireNonNegativeNumber(
          waypoint.pauseDurationMs,
          `${path}.pauseDurationMs`,
          errors,
        );
      }
    });
  }

  private validateSoundscape(value: unknown, errors: string[]): void {
    if (!isRecord(value)) {
      errors.push('soundscape must be an object.');
      return;
    }
    const ids = new Set<string>();
    this.validateAmbient(value.ambient, ids, errors);
    validateAction(value.action, ids, errors);
    this.validateEvents(value.event, ids, errors);
    const ambient = Array.isArray(value.ambient) ? value.ambient : [];
    const events = Array.isArray(value.event) ? value.event : [];
    const hasStream = ambient.some(
      (item) =>
        isRecord(item) &&
        typeof item.assetId === 'string' &&
        item.assetId.includes('stream'),
    );
    events.forEach((item, index) => {
      if (!isRecord(item) || item.assetId !== 'forest_water_drop_far_01')
        return;
      const hasWaterLocation =
        Array.isArray(item.trajectory) &&
        item.trajectory.some(
          (waypoint) =>
            isRecord(waypoint) &&
            (waypoint.locationId === 'stream_bank' ||
              waypoint.locationId === 'waterfall'),
        );
      if (!hasStream && !hasWaterLocation)
        errors.push(
          `soundscape.event[${index}] requires an established stream/water context.`,
        );
    });
  }

  private validateAmbient(
    value: unknown,
    ids: Set<string>,
    errors: string[],
  ): void {
    if (!Array.isArray(value)) {
      errors.push('soundscape.ambient must be an array.');
      return;
    }
    value.forEach((item, index) => {
      const path = `soundscape.ambient[${index}]`;
      if (!isRecord(item)) return errors.push(`${path} must be an object.`);
      validateRuntimeObjectIdentity(item, path, ids, errors);
      validateAssetLayer(item.assetId, 'ambient', path, errors);
      if (item.mode !== 'global' && item.mode !== 'localized') {
        errors.push(`${path}.mode must be global or localized.`);
      }
      validateGain(item.gain, `${path}.gain`, errors);
      if (typeof item.active !== 'boolean')
        errors.push(`${path}.active must be boolean.`);
      validateOptionalExecutionWindow(item, path, errors);
      validateDistancePolicy(
        item.distancePolicy,
        `${path}.distancePolicy`,
        errors,
      );
      validatePlaybackPolicy(item.assetId, item.playback, `${path}.playback`, errors);
      if (item.mode === 'localized') {
        const locationId = requireString(
          item.locationId,
          `${path}.locationId`,
          errors,
        );
        if (locationId && !this.sceneGraph.hasNode(locationId)) {
          errors.push(
            `${path}.locationId references unknown location ${locationId}.`,
          );
        }
      } else if (item.locationId !== undefined) {
        errors.push(`${path}.locationId must be omitted for global ambient.`);
      }
    });
  }

  private validateEvents(
    value: unknown,
    ids: Set<string>,
    errors: string[],
  ): void {
    if (!Array.isArray(value)) {
      errors.push('soundscape.event must be an array.');
      return;
    }
    value.forEach((item, index) => {
      const path = `soundscape.event[${index}]`;
      if (!isRecord(item)) return errors.push(`${path} must be an object.`);
      validateRuntimeObjectIdentity(item, path, ids, errors);
      validateAssetLayer(item.assetId, 'event', path, errors);
      requireNonNegativeNumber(
        item.activationTimeMs,
        `${path}.activationTimeMs`,
        errors,
      );
      requirePositiveNumber(item.durationMs, `${path}.durationMs`, errors);
      validateGain(item.gain, `${path}.gain`, errors);
      if (
        item.interpolation !== undefined &&
        item.interpolation !== 'linear' &&
        item.interpolation !== 'smoothstep'
      )
        errors.push(`${path}.interpolation is invalid.`);
      if (
        item.trajectoryUpdatePolicy !== undefined &&
        item.trajectoryUpdatePolicy !== 'replace-at-effective-time' &&
        item.trajectoryUpdatePolicy !== 'continue-from-current-position'
      )
        errors.push(`${path}.trajectoryUpdatePolicy is invalid.`);
      validateDistancePolicy(
        item.distancePolicy,
        `${path}.distancePolicy`,
        errors,
      );
      validatePlaybackPolicy(item.assetId, item.playback, `${path}.playback`, errors);
      validateEventMotion(item.motion, `${path}.motion`, errors);
      if (item.motion === undefined && (!Array.isArray(item.trajectory) || item.trajectory.length === 0)) {
        errors.push(`${path} requires motion or at least one trajectory waypoint.`);
        return;
      }
      if (item.motion !== undefined && item.trajectory !== undefined)
        errors.push(`${path} must not specify both motion and trajectory.`);
      let previousTimestamp = -1;
      (Array.isArray(item.trajectory) ? item.trajectory : []).forEach((waypoint, waypointIndex) => {
        const waypointPath = `${path}.trajectory[${waypointIndex}]`;
        if (!isRecord(waypoint))
          return errors.push(`${waypointPath} must be an object.`);
        const locationId = requireString(
          waypoint.locationId,
          `${waypointPath}.locationId`,
          errors,
        );
        if (locationId && !this.sceneGraph.hasNode(locationId)) {
          errors.push(
            `${waypointPath}.locationId references unknown location ${locationId}.`,
          );
        }
        const timestamp = requireNonNegativeNumber(
          waypoint.timestampMs,
          `${waypointPath}.timestampMs`,
          errors,
        );
        if (timestamp !== undefined) {
          if (timestamp < previousTimestamp) {
            errors.push(`${waypointPath}.timestampMs must be monotonic.`);
          }
          previousTimestamp = timestamp;
        }
      });
    });
  }
}

function validateEventMotion(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  const modes = new Set(['stationary', 'drift', 'pass-by', 'orbit-arc', 'approach-recede']);
  if (typeof value.motionMode !== 'string' || !modes.has(value.motionMode))
    errors.push(`${path}.motionMode is invalid.`);
  if (!isVector3(value.startPosition)) errors.push(`${path}.startPosition must be a Vector3.`);
  if (!isVector3(value.endPosition)) errors.push(`${path}.endPosition must be a Vector3.`);
  if (value.controlPoint !== undefined && !isVector3(value.controlPoint))
    errors.push(`${path}.controlPoint must be a Vector3.`);
  if (value.arcDirection !== undefined && value.arcDirection !== 'clockwise' && value.arcDirection !== 'counterclockwise')
    errors.push(`${path}.arcDirection is invalid.`);
}

function validateAction(
  value: unknown,
  ids: Set<string>,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push('soundscape.action must be an array.');
    return;
  }
  const attachments = new Set(['head', 'chest', 'feet', 'body']);
  value.forEach((item, index) => {
    const path = `soundscape.action[${index}]`;
    if (!isRecord(item)) return errors.push(`${path} must be an object.`);
    validateRuntimeObjectIdentity(item, path, ids, errors);
    validateAssetLayer(item.assetId, 'action', path, errors);
    if (
      typeof item.attachment !== 'string' ||
      !attachments.has(item.attachment)
    ) {
      errors.push(`${path}.attachment is invalid.`);
    }
    if (!isVector3(item.relativePosition))
      errors.push(`${path}.relativePosition must be a Vector3.`);
    validateGain(item.gain, `${path}.gain`, errors);
    if (typeof item.active !== 'boolean')
      errors.push(`${path}.active must be boolean.`);
    validateOptionalExecutionWindow(item, path, errors);
    if (
      item.activationCondition !== undefined &&
      item.activationCondition !== 'always' &&
      item.activationCondition !== 'listener-moving'
    )
      errors.push(`${path}.activationCondition is invalid.`);
    validateDistancePolicy(
      item.distancePolicy,
      `${path}.distancePolicy`,
      errors,
    );
    validatePlaybackPolicy(item.assetId, item.playback, `${path}.playback`, errors);
  });
}

function validateDistancePolicy(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (value === undefined) return;
  if (!isRecord(value) || (value.mode !== 'none' && value.mode !== 'inverse')) {
    errors.push(`${path}.mode must be none or inverse.`);
    return;
  }
  for (const key of ['referenceDistance', 'maxDistance'] as const)
    if (value[key] !== undefined)
      requirePositiveNumber(value[key], `${path}.${key}`, errors);
  if (value.minGain !== undefined)
    validateGain(value.minGain, `${path}.minGain`, errors);
  if (
    typeof value.referenceDistance === 'number' &&
    typeof value.maxDistance === 'number' &&
    value.maxDistance < value.referenceDistance
  )
    errors.push(`${path}.maxDistance must be >= referenceDistance.`);
}

function validatePlaybackPolicy(
  assetId: unknown,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (value === undefined) {
    if (typeof assetId === 'string' && audioLibraryById.has(assetId))
      errors.push(`${path} is required for every canonical playable element.`);
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!['once', 'loop', 'repeat', 'repeat-count', 'loop-until-arrival'].includes(String(value.mode)))
    errors.push(`${path}.mode is invalid.`);
  if (
    value.durationPolicy !== 'natural' &&
    value.durationPolicy !== 'loop-until-end' &&
    value.durationPolicy !== 'truncate-at-end'
  )
    errors.push(`${path}.durationPolicy is invalid.`);
  if (value.repeatCount !== undefined)
    requirePositiveNumber(value.repeatCount, `${path}.repeatCount`, errors);
  if (value.repeatGapMs !== undefined)
    requireNonNegativeNumber(value.repeatGapMs, `${path}.repeatGapMs`, errors);
  if (value.perRepeatGain !== undefined) {
    if (!Array.isArray(value.perRepeatGain))
      errors.push(`${path}.perRepeatGain must be an array.`);
    else
      value.perRepeatGain.forEach((gain, index) =>
        validateGain(gain, `${path}.perRepeatGain[${index}]`, errors),
      );
    if (
      Array.isArray(value.perRepeatGain) &&
      typeof value.repeatCount === 'number' &&
      value.perRepeatGain.length !== value.repeatCount
    )
      errors.push(`${path}.perRepeatGain length must equal repeatCount.`);
  }
  if (
    (value.mode === 'repeat' || value.mode === 'repeat-count') &&
    (value.repeatCount === undefined ||
      value.repeatGapMs === undefined ||
      value.perRepeatGain === undefined)
  )
    errors.push(
      `${path} repeat mode requires repeatCount, repeatGapMs, and perRepeatGain.`,
    );
  if (typeof assetId === 'string' && value.mode !== 'loop-until-arrival')
    validateCanonicalPlaybackPolicy(
      assetId,
      value as unknown as import('@neuroscape/contracts').PlaybackPolicy,
    ).forEach((error) => errors.push(`${path}: ${error}`));
}

/**
 * Authority boundary: semantic audible behavior originates in the validated
 * plan. These compatibility defaults are a validator decision, never a hidden
 * Runtime or renderer choice.
 */
function normalizeAudiblePolicies(plan: SceneJourneyPlan): void {
  plan.soundscape.ambient.forEach((item) => {
    item.distancePolicy ??= { mode: 'none' };
    normalizeDistancePolicy(item.distancePolicy);
    item.playback ??= { mode: 'loop', durationPolicy: 'loop-until-end' };
  });
  plan.soundscape.action.forEach((item) => {
    item.activationCondition ??= 'always';
    item.distancePolicy ??= { mode: 'none' };
    normalizeDistancePolicy(item.distancePolicy);
    item.playback ??= { mode: 'loop', durationPolicy: 'loop-until-end' };
  });
  plan.soundscape.event.forEach((item) => {
    item.interpolation ??= 'linear';
    item.trajectoryUpdatePolicy ??= 'replace-at-effective-time';
    item.distancePolicy ??= { mode: 'none' };
    normalizeDistancePolicy(item.distancePolicy);
    item.playback ??= { mode: 'once', durationPolicy: 'truncate-at-end' };
  });
}

function normalizeDistancePolicy(
  policy: import('@neuroscape/contracts').DistancePolicy,
): void {
  if (policy.mode !== 'inverse') return;
  policy.referenceDistance ??= 1;
  policy.maxDistance ??= 10_000;
  policy.minGain ??= 0;
}

function validateOptionalExecutionWindow(
  item: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (item.startMs === undefined && item.endMs === undefined) return;
  const start = requireNonNegativeNumber(
    item.startMs,
    `${path}.startMs`,
    errors,
  );
  const end = requireNonNegativeNumber(item.endMs, `${path}.endMs`, errors);
  if (start !== undefined && end !== undefined && end <= start)
    errors.push(`${path}.endMs must be greater than startMs.`);
}

function validateAssetLayer(
  assetId: unknown,
  expectedLayer: 'ambient' | 'action' | 'event',
  path: string,
  errors: string[],
): void {
  if (typeof assetId !== 'string') return;
  const asset = audioLibraryById.get(assetId);
  // Legacy demo aliases remain accepted; canonical IDs must match their layer.
  if (asset && asset.layer !== expectedLayer)
    errors.push(
      `${path}.assetId ${assetId} belongs to ${asset.layer}, not ${expectedLayer}.`,
    );
}

function validateTransitionPolicy(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('transitionPolicy must be an object.');
    return;
  }
  requirePositiveNumber(
    value.defaultDurationMs,
    'transitionPolicy.defaultDurationMs',
    errors,
  );
  const curves = new Set(['linear', 'smoothstep']);
  if (typeof value.curve !== 'string' || !curves.has(value.curve)) {
    errors.push('transitionPolicy.curve is invalid.');
  }
}

function validateRuntimeObjectIdentity(
  value: Record<string, unknown>,
  path: string,
  ids: Set<string>,
  errors: string[],
): void {
  const id = requireString(value.id, `${path}.id`, errors);
  requireString(value.assetId, `${path}.assetId`, errors);
  if (id) {
    if (ids.has(id))
      errors.push(`${path}.id duplicates runtime object id ${id}.`);
    ids.add(id);
  }
}

function validateGain(value: unknown, path: string, errors: string[]): void {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    errors.push(`${path} must be between 0 and 1.`);
  }
}

function requireString(
  value: unknown,
  path: string,
  errors: string[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

function requirePositiveNumber(
  value: unknown,
  path: string,
  errors: string[],
): number | undefined {
  if (!isFiniteNumber(value) || value <= 0) {
    errors.push(`${path} must be a positive finite number.`);
    return undefined;
  }
  return value;
}

function requireNonNegativeNumber(
  value: unknown,
  path: string,
  errors: string[],
): number | undefined {
  if (!isFiniteNumber(value) || value < 0) {
    errors.push(`${path} must be a non-negative finite number.`);
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isVector3(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
  );
}
