export class GainManager {
  constructor(readonly rampSeconds = 0.04) {}
  apply(parameter: AudioParam, gain: number, time: number): void {
    parameter.cancelScheduledValues(time);
    parameter.setValueAtTime(parameter.value, time);
    parameter.linearRampToValueAtTime(gain, time + this.rampSeconds);
  }
  setMaster(parameter: AudioParam, gain: number, time: number): void {
    this.apply(parameter, Math.min(1, Math.max(0, gain)), time);
  }
  resolveForegroundGain(options: {
    runtimeGain: number;
    authoredRecommendedGain: number;
    dominantAmbientGain: number;
    salience: 'minimal' | 'low' | 'moderate';
    maxSafeGain: number;
    normalizationGain?: number;
  }): number {
    const salience = {
      minimal: { ambientRatio: 0.28, authoredRatio: 0.55 },
      low: { ambientRatio: 0.4, authoredRatio: 0.75 },
      moderate: { ambientRatio: 0.55, authoredRatio: 0.9 },
    }[options.salience];
    const normalizedAuthored =
      options.authoredRecommendedGain * (options.normalizationGain ?? 1);
    const detectableFloor = Math.max(
      normalizedAuthored * salience.authoredRatio,
      options.dominantAmbientGain * salience.ambientRatio,
    );
    return Math.max(
      0,
      Math.min(
        options.maxSafeGain,
        Math.max(options.runtimeGain, detectableFloor),
      ),
    );
  }
  applyEnvelope(
    parameter: AudioParam,
    peak: number,
    startTime: number,
    durationSeconds: number,
    fadeInSeconds: number,
    fadeOutSeconds: number,
  ): void {
    const end = startTime + Math.max(0, durationSeconds);
    const fadeInEnd = Math.min(end, startTime + Math.max(0, fadeInSeconds));
    const fadeOutStart = Math.max(fadeInEnd, end - Math.max(0, fadeOutSeconds));
    parameter.cancelScheduledValues(startTime);
    parameter.setValueAtTime(0, startTime);
    parameter.linearRampToValueAtTime(peak, fadeInEnd);
    parameter.setValueAtTime(peak, fadeOutStart);
    parameter.linearRampToValueAtTime(0, end);
  }
  release(parameter: AudioParam, time: number, fadeOutSeconds: number): void {
    parameter.cancelScheduledValues(time);
    parameter.setValueAtTime(parameter.value, time);
    parameter.linearRampToValueAtTime(0, time + Math.max(0, fadeOutSeconds));
  }
  applyBurstSequence(
    parameter: AudioParam,
    gains: readonly number[],
    startTime: number,
    clipDurationSeconds: number,
    repeatGapSeconds: number,
  ): void {
    parameter.cancelScheduledValues(startTime);
    gains.forEach((gain, index) => {
      parameter.setValueAtTime(
        gain,
        startTime + index * (clipDurationSeconds + repeatGapSeconds),
      );
    });
  }
}
