import {
  GrowthMetrics,
  MetricSnapshot,
  Reel,
  ViralClassification,
  ViralScore,
  ViralScoreExplanation,
} from './entities.js';

export const SCORE_VERSION = 'v1.0.0';

export interface ScoringConfig {
  minVideosForBaseline: number;
  baselineFloorViews: number;
  recencyHalfLifeDays: number;
  strongOutlierRatioThreshold: number;
  breakoutRatioThreshold: number;
  emergingRatioThreshold: number;
  highAbsoluteReachViewsThreshold: number;
  weights: {
    outlier: number;
    engagement: number;
    growth: number;
    recency: number;
    topic: number;
  };
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  minVideosForBaseline: 5,
  baselineFloorViews: 500,
  recencyHalfLifeDays: 14,
  strongOutlierRatioThreshold: 5.0,
  breakoutRatioThreshold: 2.5,
  emergingRatioThreshold: 1.5,
  highAbsoluteReachViewsThreshold: 100_000,
  weights: {
    outlier: 0.45,
    engagement: 0.20,
    growth: 0.15,
    recency: 0.10,
    topic: 0.10,
  },
};

export interface ComparableCreatorReel {
  reelId: string;
  views: number | null;
  plays: number | null;
  publishedAt: string | null;
  durationSeconds?: number | null;
}

export interface ScoreReelInput {
  reel: Reel;
  snapshots: MetricSnapshot[]; // chronological or unsorted
  creatorComparableReels: ComparableCreatorReel[]; // includes or excludes current reel; engine always filters out current reel
  crossCreatorTopicCount?: number; // number of distinct creators covering this topic/hashtag cluster
  referenceNow?: Date;
  config?: Partial<ScoringConfig>;
}

export function resolveEffectiveViews(snapshot: {
  views: number | null;
  plays: number | null;
}): number | null {
  if (typeof snapshot.views === 'number' && Number.isFinite(snapshot.views) && snapshot.views >= 0) {
    return snapshot.views;
  }
  if (typeof snapshot.plays === 'number' && Number.isFinite(snapshot.plays) && snapshot.plays >= 0) {
    return snapshot.plays;
  }
  return null;
}

export function calculateMedian(values: number[]): number | null {
  const valid = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Calculates creator baseline views by taking the median of eligible comparable Reels
 * published by the same creator, strictly excluding the current Reel from its own baseline.
 */
export function calculateCreatorBaseline(
  currentReelId: string,
  creatorReels: ComparableCreatorReel[],
  minVideosForBaseline: number
): {
  baselineViews: number | null;
  comparableReelCount: number;
  confidence: 'high' | 'low' | 'insufficient';
} {
  const otherReels = creatorReels.filter((r) => r.reelId !== currentReelId);
  const validViews: number[] = [];

  for (const r of otherReels) {
    const v = resolveEffectiveViews(r);
    if (v !== null && v > 0) {
      validViews.push(v);
    }
  }

  const comparableReelCount = validViews.length;
  if (comparableReelCount === 0) {
    return {
      baselineViews: null,
      comparableReelCount: 0,
      confidence: 'insufficient',
    };
  }

  const baselineViews = calculateMedian(validViews);
  const confidence = comparableReelCount >= minVideosForBaseline ? 'high' : 'low';

  return {
    baselineViews,
    comparableReelCount,
    confidence,
  };
}

/**
 * Calculates outlierRatio = currentReelViews / max(baselineViews, configuredFloor)
 */
export function calculateOutlierRatio(
  currentReelViews: number | null,
  baselineViews: number | null,
  baselineFloorViews: number
): number | null {
  if (currentReelViews === null || currentReelViews < 0) return null;
  if (baselineViews === null) return null;
  const denominator = Math.max(baselineViews, Math.max(1, baselineFloorViews));
  return Number((currentReelViews / denominator).toFixed(4));
}

/**
 * Calculates engagementRate = (likes + comments) / views
 * Returns null if views are missing/zero or both likes and comments are missing.
 */
export function calculateEngagementMetrics(snapshot: {
  views: number | null;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}): {
  engagementRate: number | null;
  sharesRate: number | null;
} {
  const views = resolveEffectiveViews(snapshot);
  if (views === null || views <= 0) {
    return { engagementRate: null, sharesRate: null };
  }

  let engagementRate: number | null = null;
  if (snapshot.likes !== null && snapshot.likes >= 0) {
    const comments = snapshot.comments !== null && snapshot.comments >= 0 ? snapshot.comments : 0;
    engagementRate = Number(((snapshot.likes + comments) / views).toFixed(6));
  }

  let sharesRate: number | null = null;
  if (snapshot.shares !== null && snapshot.shares >= 0) {
    sharesRate = Number((snapshot.shares / views).toFixed(6));
  }

  return { engagementRate, sharesRate };
}

/**
 * Compares historical snapshots for the same Reel.
 * Never describes a Reel as rapidly growing if there is only one snapshot.
 * Flags inconsistent or decreasing measurements rather than inventing a growth rate.
 */
export function calculateGrowthMetrics(snapshots: MetricSnapshot[]): GrowthMetrics {
  if (snapshots.length <= 1) {
    return {
      snapshotCount: snapshots.length,
      elapsedHours: null,
      absoluteViewGain: null,
      percentageViewGain: null,
      viewsPerHour: null,
      inconsistentMeasurementFlag: false,
      note:
        snapshots.length === 0
          ? 'No metric snapshots available.'
          : 'Single snapshot only; multi-snapshot history required to measure growth velocity.',
    };
  }

  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime()
  );

  // Check for any decreasing view counts across sequential snapshots
  let inconsistentMeasurementFlag = false;
  for (let i = 1; i < sorted.length; i++) {
    const prevViews = resolveEffectiveViews(sorted[i - 1]!);
    const currViews = resolveEffectiveViews(sorted[i]!);
    if (prevViews !== null && currViews !== null && currViews < prevViews) {
      inconsistentMeasurementFlag = true;
    }
  }

  const earliest = sorted[0]!;
  const latest = sorted[sorted.length - 1]!;
  const startViews = resolveEffectiveViews(earliest);
  const endViews = resolveEffectiveViews(latest);

  const startMs = new Date(earliest.collectedAt).getTime();
  const endMs = new Date(latest.collectedAt).getTime();
  const elapsedHours = (endMs - startMs) / (1000 * 60 * 60);

  if (
    startViews === null ||
    endViews === null ||
    !Number.isFinite(elapsedHours) ||
    elapsedHours <= 0.05
  ) {
    return {
      snapshotCount: sorted.length,
      elapsedHours: Number.isFinite(elapsedHours) ? Number(elapsedHours.toFixed(2)) : null,
      absoluteViewGain: null,
      percentageViewGain: null,
      viewsPerHour: null,
      inconsistentMeasurementFlag,
      note: 'Snapshots lack valid view counts or sufficient elapsed time (>3 minutes) to compute velocity.',
    };
  }

  const absoluteViewGain = endViews - startViews;
  if (absoluteViewGain < 0 || inconsistentMeasurementFlag) {
    return {
      snapshotCount: sorted.length,
      elapsedHours: Number(elapsedHours.toFixed(2)),
      absoluteViewGain,
      percentageViewGain:
        startViews > 0 ? Number(((absoluteViewGain / startViews) * 100).toFixed(2)) : null,
      viewsPerHour: null,
      inconsistentMeasurementFlag: true,
      note: 'Decreasing or inconsistent view counts detected across snapshots; growth rate flagged as unreliable.',
    };
  }

  const percentageViewGain =
    startViews > 0 ? Number(((absoluteViewGain / startViews) * 100).toFixed(2)) : null;
  const viewsPerHour = Number((absoluteViewGain / elapsedHours).toFixed(2));

  return {
    snapshotCount: sorted.length,
    elapsedHours: Number(elapsedHours.toFixed(2)),
    absoluteViewGain,
    percentageViewGain,
    viewsPerHour,
    inconsistentMeasurementFlag: false,
    note: `Gained +${absoluteViewGain.toLocaleString()} views over ${elapsedHours.toFixed(1)}h (${viewsPerHour.toFixed(1)} views/hr).`,
  };
}

/**
 * Calculates exponential recency decay score (0-100) using half-life in days.
 * Returns null if publishedAt is missing or invalid.
 */
export function calculateRecencyScore(
  publishedAt: string | null,
  referenceNow: Date,
  halfLifeDays: number
): number | null {
  if (!publishedAt) return null;
  const pubMs = new Date(publishedAt).getTime();
  if (!Number.isFinite(pubMs)) return null;

  const ageDays = Math.max(0, (referenceNow.getTime() - pubMs) / (1000 * 60 * 60 * 24));
  const decay = Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
  return Number((decay * 100).toFixed(2));
}

/**
 * Logarithmic scaling of outlier ratio into a 0-100 component score:
 * - Ratio 1.0x (baseline) -> ~35
 * - Ratio 2.5x (breakout) -> ~65
 * - Ratio 5.0x (strong outlier) -> ~85
 * - Ratio 10.0x+ -> 100
 */
export function normalizeOutlierComponent(outlierRatio: number | null): number | null {
  if (outlierRatio === null || outlierRatio < 0) return null;
  if (outlierRatio === 0) return 0;
  const logVal = Math.log2(outlierRatio + 1); // ratio=1 -> 1, ratio=3 -> 2, ratio=7 -> 3, ratio=15 -> 4
  const score = Math.min(100, Math.max(0, (logVal / Math.log2(11)) * 100));
  return Number(score.toFixed(2));
}

/**
 * Normalizes engagement rate into 0-100 component score.
 * Typical Instagram Reel engagement rate is ~2% - 8%.
 */
export function normalizeEngagementComponent(
  engagementRate: number | null,
  sharesRate: number | null
): number | null {
  if (engagementRate === null) return null;
  // Base score from likes+comments rate (8% -> ~85 pts, 12%+ -> 100 pts)
  const baseScore = Math.min(100, (Math.sqrt(engagementRate) / Math.sqrt(0.12)) * 90);
  const shareBonus =
    sharesRate !== null && sharesRate > 0 ? Math.min(15, (sharesRate / 0.02) * 15) : 0;
  return Number(Math.min(100, baseScore + shareBonus).toFixed(2));
}

/**
 * Normalizes views-per-hour growth velocity into 0-100 component score.
 */
export function normalizeGrowthComponent(viewsPerHour: number | null): number | null {
  if (viewsPerHour === null || viewsPerHour < 0) return null;
  if (viewsPerHour === 0) return 0;
  // Log-scale views per hour: 100 v/h -> ~50, 1000 v/h -> ~75, 10000 v/h -> 100
  const score = Math.min(100, (Math.log10(viewsPerHour + 1) / 4) * 100);
  return Number(score.toFixed(2));
}

/**
 * Normalizes cross-creator topic confirmation into 0-100 component score.
 */
export function normalizeTopicComponent(crossCreatorTopicCount?: number): number | null {
  if (crossCreatorTopicCount === undefined || crossCreatorTopicCount <= 0) return null;
  if (crossCreatorTopicCount === 1) return 25;
  if (crossCreatorTopicCount === 2) return 60;
  if (crossCreatorTopicCount === 3) return 85;
  return 100;
}

export function classifyViralPattern(params: {
  effectiveViews: number | null;
  outlierRatio: number | null;
  baselineConfidence: 'high' | 'low' | 'insufficient';
  growth: GrowthMetrics;
  config: ScoringConfig;
}): { classification: ViralClassification; reasons: string[]; warnings: string[] } {
  const { effectiveViews, outlierRatio, baselineConfidence, growth, config } = params;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (effectiveViews === null || effectiveViews <= 0) {
    warnings.push('Missing or zero view/play count on latest snapshot.');
    return {
      classification: 'Insufficient evidence',
      reasons: ['View count is unavailable or zero; cannot verify performance.'],
      warnings,
    };
  }

  if (baselineConfidence === 'low') {
    warnings.push(
      `Low-confidence creator baseline (fewer than ${config.minVideosForBaseline} comparable Reels).`
    );
  } else if (baselineConfidence === 'insufficient') {
    warnings.push('No comparable creator Reels available to establish a creator-relative baseline.');
  }

  if (growth.inconsistentMeasurementFlag) {
    warnings.push('Inconsistent or decreasing view measurements observed across snapshots.');
  }

  // Check outlier ratios when baseline exists
  if (outlierRatio !== null) {
    if (
      outlierRatio >= config.strongOutlierRatioThreshold &&
      baselineConfidence === 'high'
    ) {
      reasons.push(
        `Outperformed creator median baseline by ${outlierRatio.toFixed(2)}x (high-confidence baseline).`
      );
      if (growth.viewsPerHour && growth.viewsPerHour > 100) {
        reasons.push(`Sustained velocity of ${growth.viewsPerHour.toFixed(0)} views/hr.`);
      }
      return { classification: 'Strong outlier', reasons, warnings };
    }

    if (outlierRatio >= config.breakoutRatioThreshold) {
      reasons.push(
        `Breakout performance at ${outlierRatio.toFixed(2)}x creator baseline (${baselineConfidence} baseline confidence).`
      );
      return { classification: 'Breakout', reasons, warnings };
    }

    if (
      outlierRatio >= config.emergingRatioThreshold ||
      (growth.viewsPerHour !== null && growth.viewsPerHour >= 250 && outlierRatio >= 1.2)
    ) {
      reasons.push(
        `Emerging traction at ${outlierRatio.toFixed(2)}x creator baseline.`
      );
      if (growth.viewsPerHour !== null && growth.viewsPerHour > 0) {
        reasons.push(`Measured velocity: ${growth.viewsPerHour.toFixed(1)} views/hr.`);
      }
      return { classification: 'Emerging', reasons, warnings };
    }
  }

  // High absolute reach fallback (e.g., when creator baseline is insufficient or creator always gets huge views)
  if (effectiveViews >= config.highAbsoluteReachViewsThreshold) {
    reasons.push(
      `Achieved high absolute reach (${effectiveViews.toLocaleString()} views)${
        outlierRatio !== null
          ? ` at ${outlierRatio.toFixed(2)}x creator baseline`
          : ' without a multi-video creator baseline'
      }.`
    );
    return { classification: 'High absolute reach', reasons, warnings };
  }

  if (baselineConfidence === 'insufficient') {
    reasons.push(
      `Insufficient comparable videos from this creator to compute an outlier ratio, and views (${effectiveViews.toLocaleString()}) are below the high absolute reach threshold.`
    );
    return { classification: 'Insufficient evidence', reasons, warnings };
  }

  reasons.push(
    `Performance (${effectiveViews.toLocaleString()} views, ${outlierRatio?.toFixed(2) ?? 'N/A'}x baseline) is within the creator's normal baseline range.`
  );
  return { classification: 'Normal performance', reasons, warnings };
}

export function scoreReel(input: ScoreReelInput): Omit<ViralScore, 'id'> {
  const config: ScoringConfig = {
    ...DEFAULT_SCORING_CONFIG,
    ...input.config,
    weights: {
      ...DEFAULT_SCORING_CONFIG.weights,
      ...(input.config?.weights ?? {}),
    },
  };

  const now = input.referenceNow ?? new Date();
  const sortedSnapshots = [...input.snapshots].sort(
    (a, b) => new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime()
  );
  const latestSnapshot =
    sortedSnapshots.length > 0 ? sortedSnapshots[sortedSnapshots.length - 1]! : null;

  const effectiveViews = latestSnapshot ? resolveEffectiveViews(latestSnapshot) : null;

  const baselineResult = calculateCreatorBaseline(
    input.reel.id,
    input.creatorComparableReels,
    config.minVideosForBaseline
  );

  const outlierRatio = calculateOutlierRatio(
    effectiveViews,
    baselineResult.baselineViews,
    config.baselineFloorViews
  );

  const { engagementRate, sharesRate } = latestSnapshot
    ? calculateEngagementMetrics(latestSnapshot)
    : { engagementRate: null, sharesRate: null };

  const growth = calculateGrowthMetrics(sortedSnapshots);
  const recencyScore = calculateRecencyScore(
    input.reel.publishedAt,
    now,
    config.recencyHalfLifeDays
  );

  // Component scores (0-100 or null when missing)
  let outlierComponent = normalizeOutlierComponent(outlierRatio);
  if (outlierComponent !== null && baselineResult.confidence === 'low') {
    // Dampen low-confidence baseline slightly so single-comparison outliers don't dominate high-confidence ones
    outlierComponent = Number((outlierComponent * 0.85).toFixed(2));
  }

  const engagementComponent = normalizeEngagementComponent(engagementRate, sharesRate);
  const growthComponent = normalizeGrowthComponent(growth.viewsPerHour);
  const recencyComponent = recencyScore;
  const topicComponent = normalizeTopicComponent(input.crossCreatorTopicCount);

  // Dynamic reweighting: do NOT let missing metrics silently become zero
  const rawWeights = {
    outlier: outlierComponent !== null ? config.weights.outlier : 0,
    engagement: engagementComponent !== null ? config.weights.engagement : 0,
    growth: growthComponent !== null ? config.weights.growth : 0,
    recency: recencyComponent !== null ? config.weights.recency : 0,
    topic: topicComponent !== null ? config.weights.topic : 0,
  };

  const weightSum =
    rawWeights.outlier +
    rawWeights.engagement +
    rawWeights.growth +
    rawWeights.recency +
    rawWeights.topic;

  const activeWeights =
    weightSum > 0
      ? {
          outlier: Number((rawWeights.outlier / weightSum).toFixed(4)),
          engagement: Number((rawWeights.engagement / weightSum).toFixed(4)),
          growth: Number((rawWeights.growth / weightSum).toFixed(4)),
          recency: Number((rawWeights.recency / weightSum).toFixed(4)),
          topic: Number((rawWeights.topic / weightSum).toFixed(4)),
        }
      : { outlier: 0, engagement: 0, growth: 0, recency: 0, topic: 0 };

  let overallScore = 0;
  if (weightSum > 0 && effectiveViews !== null && effectiveViews > 0) {
    overallScore =
      (outlierComponent ?? 0) * activeWeights.outlier +
      (engagementComponent ?? 0) * activeWeights.engagement +
      (growthComponent ?? 0) * activeWeights.growth +
      (recencyComponent ?? 0) * activeWeights.recency +
      (topicComponent ?? 0) * activeWeights.topic;

    // If outlierComponent is missing (insufficient creator baseline), cap score unless high absolute reach
    if (outlierComponent === null) {
      const reachCap =
        effectiveViews >= config.highAbsoluteReachViewsThreshold ? 75 : 45;
      overallScore = Math.min(overallScore, reachCap);
    }
  }

  overallScore = Number(Math.min(100, Math.max(0, overallScore)).toFixed(2));

  const { classification, reasons, warnings } = classifyViralPattern({
    effectiveViews,
    outlierRatio,
    baselineConfidence: baselineResult.confidence,
    growth,
    config,
  });

  if (recencyScore === null) {
    warnings.push('Publication timestamp missing; recency score marked unavailable.');
  }
  if (engagementRate === null && effectiveViews !== null && effectiveViews > 0) {
    warnings.push('Likes/comments counts unavailable; engagement rate omitted from composite score.');
  }

  const isComplete =
    outlierComponent !== null &&
    engagementComponent !== null &&
    recencyComponent !== null &&
    baselineResult.confidence === 'high';

  const explanation: ViralScoreExplanation = {
    classification,
    baselineConfidence: baselineResult.confidence,
    comparableReelCount: baselineResult.comparableReelCount,
    effectiveViews,
    sharesRate,
    growth,
    topicConfirmationCount: input.crossCreatorTopicCount ?? 0,
    componentScores: {
      outlierComponent,
      engagementComponent,
      growthComponent,
      recencyComponent,
      topicComponent,
    },
    activeWeights,
    isComplete,
    reasons,
    warnings,
  };

  return {
    reelId: input.reel.id,
    calculatedAt: now.toISOString(),
    baselineViews: baselineResult.baselineViews,
    outlierRatio,
    engagementRate,
    recencyScore,
    growthRate: growth.viewsPerHour,
    overallScore,
    scoreVersion: SCORE_VERSION,
    explanation,
  };
}
