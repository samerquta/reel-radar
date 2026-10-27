import { z } from 'zod';

export type Platform = 'instagram';

export type AccountStatus = 'candidate' | 'active' | 'excluded';

export interface CompetitorAccount {
  id: string;
  platform: Platform;
  username: string;
  profileUrl: string;
  displayName: string | null;
  biography: string | null;
  followerCount: number | null;
  niche: string | null;
  language: string | null;
  discoverySource: string;
  discoveryReason: string | null;
  status: AccountStatus;
  firstDiscoveredAt: string; // ISO-8601 UTC
  lastScannedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Reel {
  id: string;
  platform: Platform;
  externalId: string;
  canonicalUrl: string;
  accountId: string;
  caption: string | null;
  hashtags: string[]; // Persisted as normalized JSON array
  publishedAt: string | null; // ISO-8601 UTC
  durationSeconds: number | null;
  transcript: string | null;
  transcriptLanguage: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  isPinned: boolean | null;
  isSponsored: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetricSnapshot {
  id: string;
  reelId: string;
  collectedAt: string; // ISO-8601 UTC
  views: number | null;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  followerCountAtCollection: number | null;
  providerRunId: string;
  rawDataReference: string | null;
}

export type ResearchRunMode = 'competitor_monitoring' | 'viral_discovery' | 'manual_import';
export type ResearchRunStatus = 'running' | 'completed' | 'partially_failed' | 'failed' | 'cancelled';

export interface ResearchRunError {
  stage: string;
  target?: string;
  message: string;
  timestamp: string;
  isTransient?: boolean;
}

export interface ResearchRun {
  id: string;
  provider: string;
  mode: ResearchRunMode;
  startedAt: string;
  completedAt: string | null;
  status: ResearchRunStatus;
  recordsDiscovered: number;
  recordsInserted: number;
  recordsUpdated: number;
  errors: ResearchRunError[];
}

export const ReelAnalysisOutputSchema = z.object({
  hook: z.string().min(1),
  topic: z.string().min(1),
  audienceProblem: z.string().min(1),
  targetAudience: z.string().min(1),
  narrativeStructure: z.array(z.string()).min(1),
  emotionalTrigger: z.string().min(1),
  callToAction: z.string().min(1),
  editingObservations: z.array(z.string()),
  contentPattern: z.string().min(1),
  evidence: z.array(z.string()),
  limitations: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export type ReelAnalysisOutput = z.infer<typeof ReelAnalysisOutputSchema>;

export interface ReelAnalysis {
  id: string;
  reelId: string;
  analyzedAt: string;
  model: string;
  promptVersion: string;
  hook: string;
  topic: string;
  targetAudience: string;
  narrativeStructure: string[];
  emotionalTrigger: string;
  callToAction: string;
  editingObservations: string[];
  contentPattern: string;
  evidence: string[];
  confidence: number;
  analysisJson: ReelAnalysisOutput;
}

export type ViralClassification =
  | 'Strong outlier'
  | 'Breakout'
  | 'Emerging'
  | 'High absolute reach'
  | 'Insufficient evidence'
  | 'Normal performance';

export interface GrowthMetrics {
  snapshotCount: number;
  elapsedHours: number | null;
  absoluteViewGain: number | null;
  percentageViewGain: number | null;
  viewsPerHour: number | null;
  inconsistentMeasurementFlag: boolean;
  note: string;
}

export interface ViralScoreExplanation {
  classification: ViralClassification;
  baselineConfidence: 'high' | 'low' | 'insufficient';
  comparableReelCount: number;
  effectiveViews: number | null;
  sharesRate: number | null;
  growth: GrowthMetrics;
  topicConfirmationCount: number;
  componentScores: {
    outlierComponent: number | null;
    engagementComponent: number | null;
    growthComponent: number | null;
    recencyComponent: number | null;
    topicComponent: number | null;
  };
  activeWeights: {
    outlier: number;
    engagement: number;
    growth: number;
    recency: number;
    topic: number;
  };
  isComplete: boolean;
  reasons: string[];
  warnings: string[];
}

export interface ViralScore {
  id: string;
  reelId: string;
  calculatedAt: string;
  baselineViews: number | null;
  outlierRatio: number | null;
  engagementRate: number | null;
  recencyScore: number | null;
  growthRate: number | null; // views per hour when >=2 consistent snapshots exist
  overallScore: number; // 0-100
  scoreVersion: string;
  explanation: ViralScoreExplanation;
}

export type ContentIdeaStatus = 'proposed' | 'approved' | 'rejected' | 'tested';

export interface ContentIdea {
  id: string;
  createdAt: string;
  niche: string;
  proposedHook: string;
  concept: string;
  audienceProblem: string;
  format: string;
  suggestedCTA: string;
  evidenceReelIds: string[];
  originalityNotes: string;
  status: ContentIdeaStatus;
}
