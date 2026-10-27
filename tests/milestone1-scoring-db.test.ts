import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateCreatorBaseline,
  calculateEngagementMetrics,
  calculateGrowthMetrics,
  calculateMedian,
  calculateOutlierRatio,
  calculateRecencyScore,
  scoreReel,
} from '../src/domain/scoring.js';
import { createDatabase, rollbackLastMigration, runMigrations } from '../src/db/database.js';
import { ReelRadarRepository } from '../src/db/repository.js';
import { MetricSnapshot, Reel } from '../src/domain/entities.js';

describe('Milestone 1: Viral Detection Engine & Persistence', () => {
  describe('Median & Creator Baseline Calculation', () => {
    it('calculates median accurately for odd and even sample sizes', () => {
      expect(calculateMedian([1000, 5000, 2000])).toBe(2000);
      expect(calculateMedian([1000, 2000, 4000, 8000])).toBe(3000);
      expect(calculateMedian([])).toBeNull();
    });

    it('strictly excludes the current Reel from its own creator baseline', () => {
      const creatorReels = [
        { reelId: 'reel-target', views: 500000, plays: 500000, publishedAt: '2026-10-20T00:00:00Z' },
        { reelId: 'reel-2', views: 10000, plays: 10000, publishedAt: '2026-10-18T00:00:00Z' },
        { reelId: 'reel-3', views: 12000, plays: 12000, publishedAt: '2026-10-16T00:00:00Z' },
        { reelId: 'reel-4', views: 14000, plays: 14000, publishedAt: '2026-10-14T00:00:00Z' },
        { reelId: 'reel-5', views: 16000, plays: 16000, publishedAt: '2026-10-12T00:00:00Z' },
        { reelId: 'reel-6', views: 18000, plays: 18000, publishedAt: '2026-10-10T00:00:00Z' },
      ];

      const res = calculateCreatorBaseline('reel-target', creatorReels, 5);
      // Without reel-target (500,000), the median of [10k, 12k, 14k, 16k, 18k] is 14,000
      expect(res.baselineViews).toBe(14000);
      expect(res.comparableReelCount).toBe(5);
      expect(res.confidence).toBe('high');
    });

    it('labels baseline as low-confidence when creator has fewer than minVideosForBaseline', () => {
      const creatorReels = [
        { reelId: 'reel-1', views: 50000, plays: null, publishedAt: null },
        { reelId: 'reel-2', views: 10000, plays: null, publishedAt: null },
        { reelId: 'reel-3', views: 14000, plays: null, publishedAt: null },
      ];

      const res = calculateCreatorBaseline('reel-1', creatorReels, 5);
      expect(res.baselineViews).toBe(12000);
      expect(res.comparableReelCount).toBe(2);
      expect(res.confidence).toBe('low');
    });

    it('handles zero and null views in baseline and outlier ratio calculations', () => {
      const creatorReels = [
        { reelId: 'reel-1', views: 25000, plays: null, publishedAt: null },
        { reelId: 'reel-2', views: 0, plays: 0, publishedAt: null },
        { reelId: 'reel-3', views: null, plays: null, publishedAt: null },
      ];
      const res = calculateCreatorBaseline('reel-1', creatorReels, 5);
      expect(res.baselineViews).toBeNull();
      expect(res.confidence).toBe('insufficient');

      // Floor protection
      expect(calculateOutlierRatio(5000, 100, 500)).toBe(10); // 5000 / max(100, 500) = 10
      expect(calculateOutlierRatio(null, 5000, 500)).toBeNull();
    });
  });

  describe('Engagement, Recency & Multi-Snapshot Growth', () => {
    it('calculates engagement rate and keeps shares separate, returning null on zero/missing views', () => {
      const valid = calculateEngagementMetrics({
        views: 10000,
        plays: 10000,
        likes: 600,
        comments: 150,
        shares: 250,
      });
      expect(valid.engagementRate).toBe(0.075);
      expect(valid.sharesRate).toBe(0.025);

      const zeroViews = calculateEngagementMetrics({
        views: 0,
        plays: 0,
        likes: 50,
        comments: 10,
        shares: 5,
      });
      expect(zeroViews.engagementRate).toBeNull();
      expect(zeroViews.sharesRate).toBeNull();

      const missingLikes = calculateEngagementMetrics({
        views: 10000,
        plays: null,
        likes: null,
        comments: null,
        shares: 100,
      });
      expect(missingLikes.engagementRate).toBeNull();
      expect(missingLikes.sharesRate).toBe(0.01);
    });

    it('handles missing timestamps in recency calculation', () => {
      const now = new Date('2026-10-24T00:00:00Z');
      expect(calculateRecencyScore(null, now, 14)).toBeNull();
      expect(calculateRecencyScore('invalid-date', now, 14)).toBeNull();
      // Exactly 1 half-life (14 days ago) -> 50.0
      expect(calculateRecencyScore('2026-10-10T00:00:00Z', now, 14)).toBe(50);
    });

    it('calculates growth velocity across unequal intervals and flags decreasing measurements', () => {
      const baseSnap: Omit<MetricSnapshot, 'id' | 'collectedAt' | 'views'> = {
        reelId: 'r1',
        plays: null,
        likes: 100,
        comments: 10,
        shares: 5,
        followerCountAtCollection: 1000,
        providerRunId: 'run-1',
        rawDataReference: null,
      };

      // Single snapshot -> never claims growth
      const single = calculateGrowthMetrics([
        { ...baseSnap, id: 's1', collectedAt: '2026-10-23T00:00:00Z', views: 10000 },
      ]);
      expect(single.viewsPerHour).toBeNull();
      expect(single.snapshotCount).toBe(1);

      // Multi-snapshot across 10 hours (+20,000 views -> 2,000 views/hr)
      const growing = calculateGrowthMetrics([
        { ...baseSnap, id: 's1', collectedAt: '2026-10-23T00:00:00Z', views: 10000 },
        { ...baseSnap, id: 's2', collectedAt: '2026-10-23T03:00:00Z', views: 14500 },
        { ...baseSnap, id: 's3', collectedAt: '2026-10-23T10:00:00Z', views: 30000 },
      ]);
      expect(growing.elapsedHours).toBe(10);
      expect(growing.absoluteViewGain).toBe(20000);
      expect(growing.percentageViewGain).toBe(200);
      expect(growing.viewsPerHour).toBe(2000);
      expect(growing.inconsistentMeasurementFlag).toBe(false);

      // Decreasing measurement -> flags inconsistency rather than inventing positive growth
      const inconsistent = calculateGrowthMetrics([
        { ...baseSnap, id: 's1', collectedAt: '2026-10-23T00:00:00Z', views: 30000 },
        { ...baseSnap, id: 's2', collectedAt: '2026-10-23T05:00:00Z', views: 25000 },
      ]);
      expect(inconsistent.inconsistentMeasurementFlag).toBe(true);
      expect(inconsistent.viewsPerHour).toBeNull();
    });
  });

  describe('Composite Score Normalization & Reweighting', () => {
    it('reweights available components when metrics are missing instead of treating missing as zero', () => {
      const reel: Reel = {
        id: 'reel-breakout',
        platform: 'instagram',
        externalId: 'EXT_1',
        canonicalUrl: 'https://www.instagram.com/reel/EXT_1/',
        accountId: 'acc-1',
        caption: 'Breakout test',
        hashtags: ['ai'],
        publishedAt: null, // missing publication timestamp
        durationSeconds: 30,
        transcript: null,
        transcriptLanguage: null,
        mediaUrl: null,
        thumbnailUrl: null,
        isPinned: false,
        isSponsored: false,
        createdAt: '2026-10-24T00:00:00Z',
        updatedAt: '2026-10-24T00:00:00Z',
      };

      const snapshots: MetricSnapshot[] = [
        {
          id: 'snap-1',
          reelId: 'reel-breakout',
          collectedAt: '2026-10-24T00:00:00Z',
          views: 100000,
          plays: 100000,
          likes: null, // missing likes
          comments: null,
          shares: null,
          followerCountAtCollection: 10000,
          providerRunId: 'run-1',
          rawDataReference: null,
        },
      ];

      const comparable = [1, 2, 3, 4, 5].map((i) => ({
        reelId: `other-${i}`,
        views: 10000,
        plays: 10000,
        publishedAt: '2026-10-15T00:00:00Z',
      }));

      const scored = scoreReel({
        reel,
        snapshots,
        creatorComparableReels: comparable,
        referenceNow: new Date('2026-10-24T02:00:00Z'),
      });

      expect(scored.outlierRatio).toBe(10);
      expect(scored.explanation.classification).toBe('Strong outlier');
      expect(scored.explanation.isComplete).toBe(false);
      // Since only outlierComponent is available, its active weight is reweighted to 1.0
      expect(scored.explanation.activeWeights.outlier).toBe(1);
      expect(scored.overallScore).toBeGreaterThan(85);
    });
  });

  describe('SQLite Database Migrations & Transactional Repository', () => {
    let repo: ReelRadarRepository;

    beforeEach(() => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      repo = new ReelRadarRepository(db);
    });

    it('deduplicates Reels by platform + externalId while preserving historical metric snapshots', () => {
      const firstIngest = repo.ingestNormalizedReel({
        platform: 'instagram',
        externalId: 'REEL_999',
        canonicalUrl: 'https://www.instagram.com/reel/REEL_999/',
        creatorUsername: 'TestCreator',
        caption: 'Initial caption #ai',
        hashtags: ['#AI', 'ai', 'Automation'],
        publishedAt: '2026-10-20T10:00:00Z',
        durationSeconds: 30,
        transcript: null,
        transcriptLanguage: null,
        mediaUrl: null,
        thumbnailUrl: null,
        isPinned: false,
        isSponsored: false,
        views: 10000,
        plays: 10000,
        likes: 500,
        comments: 40,
        shares: 100,
        collectedAt: '2026-10-23T10:00:00Z',
        providerRunId: 'run-1',
      });

      expect(firstIngest.insertedReel).toBe(true);
      expect(firstIngest.reel.hashtags).toEqual(['ai', 'automation']);

      const secondIngest = repo.ingestNormalizedReel({
        platform: 'instagram',
        externalId: 'REEL_999',
        canonicalUrl: 'https://www.instagram.com/reel/REEL_999/',
        creatorUsername: 'testcreator',
        caption: 'Initial caption #ai',
        hashtags: ['ai', 'automation'],
        publishedAt: '2026-10-20T10:00:00Z',
        durationSeconds: 30,
        transcript: 'Added transcript later',
        transcriptLanguage: 'en',
        mediaUrl: null,
        thumbnailUrl: null,
        isPinned: false,
        isSponsored: false,
        views: 25000,
        plays: 25000,
        likes: 1200,
        comments: 95,
        shares: 340,
        collectedAt: '2026-10-24T10:00:00Z',
        providerRunId: 'run-2',
      });

      expect(secondIngest.insertedReel).toBe(false);
      expect(secondIngest.reel.id).toBe(firstIngest.reel.id);
      expect(secondIngest.reel.transcript).toBe('Added transcript later');

      const snapshots = repo.listSnapshotsForReel(firstIngest.reel.id);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]?.views).toBe(10000);
      expect(snapshots[1]?.views).toBe(25000);
    });

    it('supports migration rollback cleanly', () => {
      const rolledBackVersion = rollbackLastMigration(repo.db);
      expect(rolledBackVersion).toBe(1);
      // Re-apply migrations and verify tables work
      runMigrations(repo.db);
      const acc = repo.upsertAccount({
        username: 'after_rollback',
        discoverySource: 'manual',
      });
      expect(acc.username).toBe('after_rollback');
    });
  });
});
