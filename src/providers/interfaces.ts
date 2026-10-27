import { ReelAnalysisOutput } from '../domain/entities.js';

export interface NormalizedCollectedReel {
  platform: 'instagram';
  externalId: string;
  shortCode?: string;
  canonicalUrl: string;
  creatorUsername: string;
  creatorDisplayName?: string | null;
  creatorProfileUrl?: string;
  creatorFollowerCount?: number | null;
  creatorBiography?: string | null;
  caption: string | null;
  hashtags: string[];
  publishedAt: string | null;
  durationSeconds: number | null;
  transcript: string | null;
  transcriptLanguage: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  isPinned: boolean | null;
  isSponsored: boolean | null;
  views: number | null;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  collectedAt: string;
  providerRunId: string;
  rawDataReference?: string | null;
}

export interface CollectionOptions {
  usernames?: string[];
  directReelUrls?: string[];
  resultsLimitPerProfile?: number;
  onlyPostsNewerThan?: string; // ISO date or YYYY-MM-DD
  skipPinnedPosts?: boolean;
  timeoutSecs?: number;
  signal?: AbortSignal;
}

export interface CollectionBatchResult {
  providerName: string;
  providerRunId: string;
  startedAt: string;
  completedAt: string;
  reels: NormalizedCollectedReel[];
  missingFieldsSummary: Record<string, number>;
  errors: Array<{
    target?: string;
    message: string;
    isTransient: boolean;
  }>;
  estimatedCostUsd?: number;
}

export interface ReelCollectionProvider {
  readonly name: string;
  estimateCostUsd(options: CollectionOptions): number;
  collectReels(options: CollectionOptions): Promise<CollectionBatchResult>;
}

export interface DiscoveryQueryOptions {
  hashtags?: string[];
  keywords?: string[];
  maxPostsPerQuery?: number;
  language?: string;
  timeoutSecs?: number;
  signal?: AbortSignal;
}

export interface DiscoveryResult {
  providerName: string;
  providerRunId: string;
  startedAt: string;
  completedAt: string;
  discoveredReels: NormalizedCollectedReel[];
  errors: Array<{
    query?: string;
    message: string;
    isTransient: boolean;
  }>;
  estimatedCostUsd?: number;
}

export interface ReelDiscoveryProvider {
  readonly name: string;
  estimateCostUsd(options: DiscoveryQueryOptions): number;
  discoverReels(options: DiscoveryQueryOptions): Promise<DiscoveryResult>;
}

export interface CompetitorCandidateSignal {
  username: string;
  profileUrl: string;
  displayName: string | null;
  followerCount: number | null;
  niche: string;
  language: string | null;
  discoverySource: string;
  discoveryReason: string;
  nicheRelevanceScore: number; // 0-100
  discoveredReelsCount: number;
  maxViewsObserved: number | null;
  medianViewsObserved: number | null;
  supportingReelUrls: string[];
}

export interface CompetitorDiscoveryInput {
  niche: string;
  keywords: string[];
  hashtags: string[];
  language?: string;
  seedAccounts?: string[];
  maxNewAccounts?: number;
  maxPostsPerQuery?: number;
}

export interface CompetitorDiscoveryProvider {
  readonly name: string;
  discoverCandidates(input: CompetitorDiscoveryInput): Promise<{
    providerRunId: string;
    candidates: CompetitorCandidateSignal[];
    discoveredReels: NormalizedCollectedReel[];
    estimatedCostUsd: number;
  }>;
}

export interface TranscriptResult {
  transcript: string | null;
  language: string | null;
  confidence: number;
  costUsd: number;
  providerName: string;
  limitationNote?: string;
}

export interface TranscriptProvider {
  readonly name: string;
  readonly supportedLanguages: string[];
  readonly costPerMinuteUsd: number;
  transcribe(input: {
    reelId: string;
    canonicalUrl: string;
    mediaUrl: string | null;
    durationSeconds: number | null;
    existingTranscript?: string | null;
  }): Promise<TranscriptResult>;
}

export interface ContentAnalysisInput {
  reelId: string;
  canonicalUrl: string;
  creatorUsername: string;
  caption: string | null;
  hashtags: string[];
  transcript: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  baselineViews: number | null;
  outlierRatio: number | null;
  visualDescription?: string | null;
}

export interface ContentAnalysisProvider {
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  analyzeReel(input: ContentAnalysisInput): Promise<ReelAnalysisOutput>;
}
