import { z } from 'zod';
import { NormalizedCollectedReel } from './interfaces.js';

const OptionalNumber = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((val): number | null => {
    if (val === null || val === undefined || val === '') return null;
    const num = typeof val === 'number' ? val : Number(val);
    return Number.isFinite(num) && num >= 0 ? num : null;
  });

const OptionalBoolean = z
  .union([z.boolean(), z.string(), z.number(), z.null(), z.undefined()])
  .transform((val): boolean | null => {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    const lower = val.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
    return null;
  });

const OptionalHashtags = z
  .union([z.array(z.string()), z.string(), z.null(), z.undefined()])
  .transform((val): string[] => {
    if (!val) return [];
    if (Array.isArray(val)) {
      return val
        .map((h) => h.trim().replace(/^#/, '').toLowerCase())
        .filter(Boolean);
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return parsed
              .map((h) => String(h).trim().replace(/^#/, '').toLowerCase())
              .filter(Boolean);
          }
        } catch {
          // fall through to delimiter split
        }
      }
      return trimmed
        .split(/[;,\s]+/)
        .map((h) => h.trim().replace(/^#/, '').toLowerCase())
        .filter(Boolean);
    }
    return [];
  });

/**
 * Schema covering documented `apify/instagram-reel-scraper` and `apify/instagram-hashtag-scraper`
 * output fields as well as manual JSON/CSV imports.
 * Every field is treated as optional unless required to identify a Reel or its creator.
 */
export const RawInstagramReelItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    shortCode: z.string().optional(),
    code: z.string().optional(),
    url: z.string().optional(),
    canonicalUrl: z.string().optional(),
    ownerUsername: z.string().optional(),
    username: z.string().optional(),
    ownerFullName: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    ownerFollowerCount: OptionalNumber,
    followersCount: OptionalNumber,
    caption: z.string().nullable().optional(),
    hashtags: OptionalHashtags,
    timestamp: z.union([z.string(), z.number(), z.null()]).optional(),
    publishedAt: z.union([z.string(), z.number(), z.null()]).optional(),
    takenAtTimestamp: z.number().optional(),
    collectedAt: z.string().optional(),
    videoDuration: OptionalNumber,
    duration: OptionalNumber,
    durationSeconds: OptionalNumber,
    videoViewCount: OptionalNumber,
    views: OptionalNumber,
    videoPlayCount: OptionalNumber,
    playCount: OptionalNumber,
    plays: OptionalNumber,
    likesCount: OptionalNumber,
    likes: OptionalNumber,
    commentsCount: OptionalNumber,
    comments: OptionalNumber,
    sharesCount: OptionalNumber,
    shares: OptionalNumber,
    transcript: z.string().nullable().optional(),
    transcriptLanguage: z.string().nullable().optional(),
    videoUrl: z.string().nullable().optional(),
    mediaUrl: z.string().nullable().optional(),
    displayUrl: z.string().nullable().optional(),
    thumbnailUrl: z.string().nullable().optional(),
    isPinned: OptionalBoolean,
    isPaidPartnership: OptionalBoolean,
    isSponsored: OptionalBoolean,
    owner: z
      .object({
        username: z.string().optional(),
        full_name: z.string().nullable().optional(),
        id: z.union([z.string(), z.number()]).optional(),
      })
      .optional(),
  })
  .passthrough();

export type RawInstagramReelItem = z.infer<typeof RawInstagramReelItemSchema>;

export function extractHashtagsFromCaption(caption: string | null): string[] {
  if (!caption) return [];
  const matches = caption.match(/#([\p{L}\p{N}_]+)/gu);
  if (!matches) return [];
  return Array.from(new Set(matches.map((m) => m.slice(1).toLowerCase())));
}

export function normalizeTimestamp(
  raw: string | number | null | undefined
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const ms = raw < 10_000_000_000 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function normalizeRawReelItem(
  rawInput: unknown,
  context: {
    providerRunId: string;
    defaultCollectedAt?: string;
    fallbackUsername?: string;
    rawDataReference?: string;
  }
): {
  reel: NormalizedCollectedReel | null;
  missingFields: string[];
  validationError?: string;
} {
  const parsed = RawInstagramReelItemSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      reel: null,
      missingFields: [],
      validationError: parsed.error.issues.map((i) => i.message).join('; '),
    };
  }

  const item = parsed.data;
  const shortCode = item.shortCode || item.code || undefined;
  const externalId =
    (item.id !== undefined && String(item.id).trim() !== '' ? String(item.id).trim() : null) ??
    shortCode ??
    null;

  const creatorUsernameRaw =
    item.ownerUsername ??
    item.username ??
    item.owner?.username ??
    context.fallbackUsername ??
    null;

  if (!externalId || !creatorUsernameRaw) {
    return {
      reel: null,
      missingFields: [],
      validationError: `Missing required identifier (id/shortCode: ${String(
        externalId
      )}) or creator username (${String(creatorUsernameRaw)}).`,
    };
  }

  const creatorUsername = creatorUsernameRaw.trim().replace(/^@/, '').toLowerCase();
  const canonicalUrl =
    item.canonicalUrl ??
    item.url ??
    (shortCode
      ? `https://www.instagram.com/reel/${shortCode}/`
      : `https://www.instagram.com/reel/${externalId}/`);

  const caption = item.caption ?? null;
  const explicitHashtags = item.hashtags ?? [];
  const hashtags =
    explicitHashtags.length > 0 ? explicitHashtags : extractHashtagsFromCaption(caption);

  const publishedAt =
    normalizeTimestamp(item.timestamp) ??
    normalizeTimestamp(item.publishedAt) ??
    normalizeTimestamp(item.takenAtTimestamp);

  const durationSeconds = item.videoDuration ?? item.duration ?? item.durationSeconds ?? null;
  const plays = item.videoPlayCount ?? item.playCount ?? item.plays ?? null;
  const views = item.videoViewCount ?? item.views ?? plays ?? null;
  const likes = item.likesCount ?? item.likes ?? null;
  const comments = item.commentsCount ?? item.comments ?? null;
  const shares = item.sharesCount ?? item.shares ?? null;
  const transcript = item.transcript ?? null;
  const mediaUrl = item.videoUrl ?? item.mediaUrl ?? null;
  const thumbnailUrl = item.displayUrl ?? item.thumbnailUrl ?? null;
  const isPinned = item.isPinned ?? null;
  const isSponsored = item.isPaidPartnership ?? item.isSponsored ?? null;

  const missingFields: string[] = [];
  if (views === null) missingFields.push('views');
  if (likes === null) missingFields.push('likes');
  if (comments === null) missingFields.push('comments');
  if (shares === null) missingFields.push('shares');
  if (publishedAt === null) missingFields.push('publishedAt');
  if (durationSeconds === null) missingFields.push('durationSeconds');
  if (transcript === null) missingFields.push('transcript');

  const collectedAt =
    normalizeTimestamp(item.collectedAt) ??
    context.defaultCollectedAt ??
    new Date().toISOString();

  return {
    reel: {
      platform: 'instagram',
      externalId,
      shortCode,
      canonicalUrl,
      creatorUsername,
      creatorDisplayName: item.ownerFullName ?? item.displayName ?? item.owner?.full_name ?? null,
      creatorProfileUrl: `https://www.instagram.com/${creatorUsername}/`,
      creatorFollowerCount: item.ownerFollowerCount ?? item.followersCount ?? null,
      caption,
      hashtags,
      publishedAt,
      durationSeconds,
      transcript,
      transcriptLanguage: item.transcriptLanguage ?? (transcript ? 'en' : null),
      mediaUrl,
      thumbnailUrl,
      isPinned,
      isSponsored,
      views,
      plays,
      likes,
      comments,
      shares,
      collectedAt,
      providerRunId: context.providerRunId,
      rawDataReference: context.rawDataReference ?? null,
    },
    missingFields,
  };
}
