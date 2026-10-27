import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { ApifyInstagramReelProvider } from '../src/providers/apify-reel-provider.js';
import { ManualImportProvider } from '../src/providers/manual-import-provider.js';
import { normalizeRawReelItem } from '../src/providers/normalizer.js';

describe('Milestone 2: Apify Reel Collection Adapter, Normalizer & Manual Import', () => {
  describe('Provider Response Validation & Normalization', () => {
    it('normalizes official apify/instagram-reel-scraper output shapes and tracks missing fields without inventing values', () => {
      const rawApifyItem = {
        id: '34819283912',
        shortCode: 'DC123XYZ',
        url: 'https://www.instagram.com/reel/DC123XYZ/',
        ownerUsername: 'TechCreator',
        ownerFullName: 'Tech Creator',
        caption: 'Building local AI agents with #TypeScript and #SQLite!',
        timestamp: '2026-10-21T15:00:00.000Z',
        videoViewCount: 84000,
        videoPlayCount: 91000,
        likesCount: 5200,
        commentsCount: 310,
        // sharesCount intentionally omitted
        videoDuration: 38.2,
        isPinned: false,
        isPaidPartnership: false,
      };

      const res = normalizeRawReelItem(rawApifyItem, {
        providerRunId: 'run-abc',
        defaultCollectedAt: '2026-10-24T00:00:00.000Z',
      });

      expect(res.validationError).toBeUndefined();
      expect(res.reel).not.toBeNull();
      expect(res.reel?.externalId).toBe('34819283912');
      expect(res.reel?.creatorUsername).toBe('techcreator');
      expect(res.reel?.hashtags).toEqual(['typescript', 'sqlite']);
      expect(res.reel?.views).toBe(84000);
      expect(res.reel?.shares).toBeNull();
      expect(res.reel?.transcript).toBeNull();
      expect(res.missingFields).toContain('shares');
      expect(res.missingFields).toContain('transcript');
    });

    it('rejects records missing both externalId/shortCode and creator username', () => {
      const invalidItem = {
        caption: 'Orphan record without id or owner',
        likesCount: 100,
      };
      const res = normalizeRawReelItem(invalidItem, { providerRunId: 'run-invalid' });
      expect(res.reel).toBeNull();
      expect(res.validationError).toContain('Missing required identifier');
    });
  });

  describe('ApifyInstagramReelProvider (Mocked Apify Client)', () => {
    it('retries transient 429/503 errors with exponential backoff and paginates dataset items', async () => {
      let callAttempts = 0;
      const mockActorCall = vi.fn().mockImplementation(async () => {
        callAttempts++;
        if (callAttempts === 1) {
          const err = new Error('Apify API 503 Service Temporarily Unavailable');
          (err as { statusCode?: number }).statusCode = 503;
          throw err;
        }
        return {
          id: 'apify-run-101',
          status: 'SUCCEEDED',
          defaultDatasetId: 'dataset-101',
        };
      });

      const mockListItems = vi
        .fn()
        .mockImplementation(async ({ offset }: { offset: number; limit: number }) => {
          if (offset === 0) {
            return {
              total: 3,
              items: [
                {
                  id: 'R1',
                  shortCode: 'SC1',
                  ownerUsername: 'creator_one',
                  videoViewCount: 15000,
                  likesCount: 900,
                  commentsCount: 40,
                  timestamp: '2026-10-20T10:00:00Z',
                },
                {
                  id: 'R2',
                  shortCode: 'SC2',
                  ownerUsername: 'creator_one',
                  videoViewCount: 45000,
                  likesCount: 3100,
                  commentsCount: 190,
                  timestamp: '2026-10-21T10:00:00Z',
                },
              ],
            };
          }
          return {
            total: 3,
            items: [
              {
                id: 'R3',
                shortCode: 'SC3',
                ownerUsername: 'creator_one',
                videoViewCount: 12000,
                likesCount: 700,
                commentsCount: 30,
                timestamp: '2026-10-22T10:00:00Z',
              },
            ],
          };
        });

      const provider = new ApifyInstagramReelProvider({
        apifyToken: 'mock-token',
        datasetPageSize: 2,
        client: {
          actor: () => ({ call: mockActorCall }) as never,
          dataset: () => ({ listItems: mockListItems }) as never,
        },
      });

      const result = await provider.collectReels({
        usernames: ['creator_one'],
        resultsLimitPerProfile: 10,
        onlyPostsNewerThan: '2026-10-01',
      });

      expect(callAttempts).toBe(2);
      expect(mockActorCall).toHaveBeenCalledWith(
        {
          username: ['creator_one'],
          resultsLimit: 10,
          onlyPostsNewerThan: '2026-10-01',
        },
        { waitSecs: 180 }
      );
      expect(result.reels).toHaveLength(3);
      expect(result.errors).toHaveLength(0);
    });

    it('isolates per-account failures during partial provider failures without aborting healthy accounts', async () => {
      const mockActorCall = vi.fn().mockImplementation(async (input: { username: string[] }) => {
        const target = input.username[0];
        if (target === 'broken_account') {
          const fatalErr = new Error('404 Profile not found');
          (fatalErr as { statusCode?: number }).statusCode = 404;
          throw fatalErr;
        }
        return {
          id: `run-${target}`,
          status: 'SUCCEEDED',
          defaultDatasetId: `ds-${target}`,
        };
      });

      const mockListItems = vi.fn().mockResolvedValue({
        total: 1,
        items: [
          {
            id: 'HEALTHY_1',
            shortCode: 'H1',
            ownerUsername: 'healthy_account',
            videoViewCount: 25000,
          },
        ],
      });

      const provider = new ApifyInstagramReelProvider({
        apifyToken: 'mock-token',
        client: {
          actor: () => ({ call: mockActorCall }) as never,
          dataset: () => ({ listItems: mockListItems }) as never,
        },
      });

      const result = await provider.collectReels({
        usernames: ['healthy_account', 'broken_account'],
      });

      expect(result.reels).toHaveLength(1);
      expect(result.reels[0]?.creatorUsername).toBe('healthy_account');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.target).toBe('broken_account');
      expect(result.errors[0]?.isTransient).toBe(false);
    });
  });

  describe('ManualImportProvider (JSON & CSV)', () => {
    it('imports sample JSON dataset without external credentials', async () => {
      const jsonProvider = new ManualImportProvider(
        path.resolve('./sample-data/reels.json')
      );
      const batch = await jsonProvider.collectReels();
      expect(batch.reels.length).toBeGreaterThanOrEqual(14);
      expect(batch.errors).toHaveLength(0);
      expect(batch.estimatedCostUsd).toBe(0);
    });

    it('imports sample CSV dataset and parses semicolon hashtags and quoted captions', async () => {
      const csvProvider = new ManualImportProvider(
        path.resolve('./sample-data/reels.csv')
      );
      const batch = await csvProvider.collectReels();
      expect(batch.reels).toHaveLength(2);
      expect(batch.reels[0]?.externalId).toBe('SYNTH_CSV_301');
      expect(batch.reels[0]?.hashtags).toEqual(['automation', 'workflows', 'aitools']);
    });
  });
});
