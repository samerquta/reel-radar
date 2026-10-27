import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {
  AccountStatus,
  CompetitorAccount,
  ContentIdea,
  MetricSnapshot,
  Platform,
  Reel,
  ReelAnalysis,
  ReelAnalysisOutput,
  ResearchRun,
  ResearchRunError,
  ResearchRunMode,
  ResearchRunStatus,
  ViralScore,
  ViralScoreExplanation,
} from '../domain/entities.js';
import { NormalizedCollectedReel } from '../providers/interfaces.js';

export function computeContentFingerprint(reel: {
  caption: string | null;
  transcript: string | null;
  hashtags: string[];
}): string {
  const payload = JSON.stringify({
    caption: reel.caption ?? '',
    transcript: reel.transcript ?? '',
    hashtags: [...reel.hashtags].sort(),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export class ReelRadarRepository {
  constructor(public readonly db: Database.Database) {}

  // --- CompetitorAccount ---
  upsertAccount(input: {
    platform?: Platform;
    username: string;
    profileUrl?: string;
    displayName?: string | null;
    biography?: string | null;
    followerCount?: number | null;
    niche?: string | null;
    language?: string | null;
    discoverySource: string;
    discoveryReason?: string | null;
    status?: AccountStatus;
    lastScannedAt?: string | null;
  }): CompetitorAccount {
    const platform = input.platform ?? 'instagram';
    const normalizedUsername = input.username.trim().replace(/^@/, '').toLowerCase();
    const now = new Date().toISOString();
    const profileUrl =
      input.profileUrl ?? `https://www.instagram.com/${normalizedUsername}/`;

    const existing = this.getAccountByUsername(normalizedUsername, platform);
    if (existing) {
      const updatedStatus = input.status ?? existing.status;
      const updatedAt = now;
      this.db
        .prepare(
          `UPDATE competitor_accounts SET
            profile_url = COALESCE(?, profile_url),
            display_name = COALESCE(?, display_name),
            biography = COALESCE(?, biography),
            follower_count = COALESCE(?, follower_count),
            niche = COALESCE(?, niche),
            language = COALESCE(?, language),
            discovery_reason = COALESCE(?, discovery_reason),
            status = ?,
            last_scanned_at = COALESCE(?, last_scanned_at),
            updated_at = ?
          WHERE id = ?`
        )
        .run(
          input.profileUrl ?? null,
          input.displayName ?? null,
          input.biography ?? null,
          input.followerCount ?? null,
          input.niche ?? null,
          input.language ?? null,
          input.discoveryReason ?? null,
          updatedStatus,
          input.lastScannedAt ?? null,
          updatedAt,
          existing.id
        );
      return this.getAccountById(existing.id)!;
    }

    const id = crypto.randomUUID();
    const status: AccountStatus = input.status ?? 'active';
    this.db
      .prepare(
        `INSERT INTO competitor_accounts (
          id, platform, username, profile_url, display_name, biography,
          follower_count, niche, language, discovery_source, discovery_reason,
          status, first_discovered_at, last_scanned_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        platform,
        normalizedUsername,
        profileUrl,
        input.displayName ?? null,
        input.biography ?? null,
        input.followerCount ?? null,
        input.niche ?? null,
        input.language ?? null,
        input.discoverySource,
        input.discoveryReason ?? null,
        status,
        now,
        input.lastScannedAt ?? null,
        now,
        now
      );

    return this.getAccountById(id)!;
  }

  getAccountById(id: string): CompetitorAccount | null {
    const row = this.db
      .prepare('SELECT * FROM competitor_accounts WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapAccountRow(row) : null;
  }

  getAccountByUsername(
    username: string,
    platform: Platform = 'instagram'
  ): CompetitorAccount | null {
    const normalized = username.trim().replace(/^@/, '').toLowerCase();
    const row = this.db
      .prepare('SELECT * FROM competitor_accounts WHERE platform = ? AND username = ?')
      .get(platform, normalized) as Record<string, unknown> | undefined;
    return row ? this.mapAccountRow(row) : null;
  }

  listAccounts(status?: AccountStatus): CompetitorAccount[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM competitor_accounts WHERE status = ? ORDER BY username ASC')
          .all(status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM competitor_accounts ORDER BY username ASC')
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapAccountRow(r));
  }

  updateAccountStatus(username: string, status: AccountStatus): CompetitorAccount | null {
    const existing = this.getAccountByUsername(username);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE competitor_accounts SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, existing.id);
    return this.getAccountById(existing.id);
  }

  markAccountScanned(accountId: string, scannedAt: string = new Date().toISOString()): void {
    this.db
      .prepare('UPDATE competitor_accounts SET last_scanned_at = ?, updated_at = ? WHERE id = ?')
      .run(scannedAt, scannedAt, accountId);
  }

  // --- Reel & MetricSnapshot Transactional Ingestion ---
  ingestNormalizedReel(
    item: NormalizedCollectedReel,
    options: { defaultAccountStatus?: AccountStatus; discoverySource?: string; niche?: string } = {}
  ): {
    account: CompetitorAccount;
    reel: Reel;
    snapshot: MetricSnapshot;
    insertedReel: boolean;
  } {
    const tx = this.db.transaction(() => {
      const existingAccount = this.getAccountByUsername(item.creatorUsername, item.platform);
      const account = this.upsertAccount({
        platform: item.platform,
        username: item.creatorUsername,
        profileUrl: item.creatorProfileUrl,
        displayName: item.creatorDisplayName ?? undefined,
        biography: item.creatorBiography ?? undefined,
        followerCount: item.creatorFollowerCount ?? undefined,
        niche: options.niche ?? existingAccount?.niche ?? undefined,
        discoverySource:
          existingAccount?.discoverySource ?? options.discoverySource ?? 'collection',
        status: existingAccount?.status ?? options.defaultAccountStatus ?? 'active',
        lastScannedAt: item.collectedAt,
      });

      const existingReelRow = this.db
        .prepare('SELECT * FROM reels WHERE platform = ? AND external_id = ?')
        .get(item.platform, item.externalId) as Record<string, unknown> | undefined;

      const now = new Date().toISOString();
      const normalizedHashtags = Array.from(
        new Set(
          item.hashtags
            .map((h) => h.trim().replace(/^#/, '').toLowerCase())
            .filter((h) => h.length > 0)
        )
      );

      let reelId: string;
      let insertedReel = false;

      if (existingReelRow) {
        reelId = String(existingReelRow.id);
        this.db
          .prepare(
            `UPDATE reels SET
              canonical_url = COALESCE(?, canonical_url),
              caption = COALESCE(?, caption),
              hashtags_json = ?,
              published_at = COALESCE(?, published_at),
              duration_seconds = COALESCE(?, duration_seconds),
              transcript = COALESCE(?, transcript),
              transcript_language = COALESCE(?, transcript_language),
              media_url = COALESCE(?, media_url),
              thumbnail_url = COALESCE(?, thumbnail_url),
              is_pinned = COALESCE(?, is_pinned),
              is_sponsored = COALESCE(?, is_sponsored),
              updated_at = ?
            WHERE id = ?`
          )
          .run(
            item.canonicalUrl,
            item.caption,
            JSON.stringify(normalizedHashtags),
            item.publishedAt,
            item.durationSeconds,
            item.transcript,
            item.transcriptLanguage,
            item.mediaUrl,
            item.thumbnailUrl,
            item.isPinned === null ? null : item.isPinned ? 1 : 0,
            item.isSponsored === null ? null : item.isSponsored ? 1 : 0,
            now,
            reelId
          );
      } else {
        reelId = crypto.randomUUID();
        insertedReel = true;
        this.db
          .prepare(
            `INSERT INTO reels (
              id, platform, external_id, canonical_url, account_id, caption,
              hashtags_json, published_at, duration_seconds, transcript,
              transcript_language, media_url, thumbnail_url, is_pinned,
              is_sponsored, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            reelId,
            item.platform,
            item.externalId,
            item.canonicalUrl,
            account.id,
            item.caption,
            JSON.stringify(normalizedHashtags),
            item.publishedAt,
            item.durationSeconds,
            item.transcript,
            item.transcriptLanguage,
            item.mediaUrl,
            item.thumbnailUrl,
            item.isPinned === null ? null : item.isPinned ? 1 : 0,
            item.isSponsored === null ? null : item.isSponsored ? 1 : 0,
            now,
            now
          );
      }

      const snapshotId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO metric_snapshots (
            id, reel_id, collected_at, views, plays, likes, comments, shares,
            follower_count_at_collection, provider_run_id, raw_data_reference
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          snapshotId,
          reelId,
          item.collectedAt,
          item.views,
          item.plays,
          item.likes,
          item.comments,
          item.shares,
          item.creatorFollowerCount ?? account.followerCount ?? null,
          item.providerRunId,
          item.rawDataReference ?? null
        );

      return {
        account,
        reel: this.getReelById(reelId)!,
        snapshot: this.getSnapshotById(snapshotId)!,
        insertedReel,
      };
    });

    return tx();
  }

  getReelById(id: string): Reel | null {
    const row = this.db.prepare('SELECT * FROM reels WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapReelRow(row) : null;
  }

  getReelByExternalId(externalId: string, platform: Platform = 'instagram'): Reel | null {
    const row = this.db
      .prepare('SELECT * FROM reels WHERE platform = ? AND external_id = ?')
      .get(platform, externalId) as Record<string, unknown> | undefined;
    return row ? this.mapReelRow(row) : null;
  }

  listReelsByAccount(accountId: string): Reel[] {
    const rows = this.db
      .prepare('SELECT * FROM reels WHERE account_id = ? ORDER BY published_at DESC')
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapReelRow(r));
  }

  listAllReels(): Reel[] {
    const rows = this.db
      .prepare('SELECT * FROM reels ORDER BY published_at DESC, created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapReelRow(r));
  }

  updateReelTranscript(reelId: string, transcript: string, language: string | null): void {
    this.db
      .prepare(
        'UPDATE reels SET transcript = ?, transcript_language = ?, updated_at = ? WHERE id = ?'
      )
      .run(transcript, language, new Date().toISOString(), reelId);
  }

  getSnapshotById(id: string): MetricSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM metric_snapshots WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSnapshotRow(row) : null;
  }

  listSnapshotsForReel(reelId: string): MetricSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM metric_snapshots WHERE reel_id = ? ORDER BY collected_at ASC')
      .all(reelId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSnapshotRow(r));
  }

  getLatestSnapshotForReel(reelId: string): MetricSnapshot | null {
    const row = this.db
      .prepare(
        'SELECT * FROM metric_snapshots WHERE reel_id = ? ORDER BY collected_at DESC LIMIT 1'
      )
      .get(reelId) as Record<string, unknown> | undefined;
    return row ? this.mapSnapshotRow(row) : null;
  }

  // --- ResearchRun ---
  createResearchRun(input: {
    id?: string;
    provider: string;
    mode: ResearchRunMode;
    startedAt?: string;
  }): ResearchRun {
    const id = input.id ?? crypto.randomUUID();
    const startedAt = input.startedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO research_runs (
          id, provider, mode, started_at, status, records_discovered,
          records_inserted, records_updated, errors_json
        ) VALUES (?, ?, ?, ?, 'running', 0, 0, 0, '[]')`
      )
      .run(id, input.provider, input.mode, startedAt);
    return this.getResearchRunById(id)!;
  }

  completeResearchRun(
    id: string,
    update: {
      status: ResearchRunStatus;
      recordsDiscovered: number;
      recordsInserted: number;
      recordsUpdated: number;
      errors: ResearchRunError[];
      completedAt?: string;
    }
  ): ResearchRun {
    const completedAt = update.completedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE research_runs SET
          completed_at = ?,
          status = ?,
          records_discovered = ?,
          records_inserted = ?,
          records_updated = ?,
          errors_json = ?
        WHERE id = ?`
      )
      .run(
        completedAt,
        update.status,
        update.recordsDiscovered,
        update.recordsInserted,
        update.recordsUpdated,
        JSON.stringify(update.errors),
        id
      );
    return this.getResearchRunById(id)!;
  }

  getResearchRunById(id: string): ResearchRun | null {
    const row = this.db
      .prepare('SELECT * FROM research_runs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapResearchRunRow(row) : null;
  }

  listResearchRuns(limit = 50): ResearchRun[] {
    const rows = this.db
      .prepare('SELECT * FROM research_runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapResearchRunRow(r));
  }

  // --- ViralScore ---
  saveViralScore(score: Omit<ViralScore, 'id'> & { id?: string }): ViralScore {
    const id = score.id ?? crypto.randomUUID();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM viral_scores WHERE reel_id = ?').run(score.reelId);
      this.db
        .prepare(
          `INSERT INTO viral_scores (
            id, reel_id, calculated_at, baseline_views, outlier_ratio,
            engagement_rate, recency_score, growth_rate, overall_score,
            score_version, explanation_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          score.reelId,
          score.calculatedAt,
          score.baselineViews,
          score.outlierRatio,
          score.engagementRate,
          score.recencyScore,
          score.growthRate,
          score.overallScore,
          score.scoreVersion,
          JSON.stringify(score.explanation)
        );
    });
    tx();
    return this.getViralScoreForReel(score.reelId)!;
  }

  getViralScoreForReel(reelId: string): ViralScore | null {
    const row = this.db
      .prepare(
        'SELECT * FROM viral_scores WHERE reel_id = ? ORDER BY calculated_at DESC LIMIT 1'
      )
      .get(reelId) as Record<string, unknown> | undefined;
    return row ? this.mapViralScoreRow(row) : null;
  }

  listViralScoresOrdered(): ViralScore[] {
    const rows = this.db
      .prepare('SELECT * FROM viral_scores ORDER BY overall_score DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapViralScoreRow(r));
  }

  // --- ReelAnalysis ---
  getCachedAnalysis(
    reelId: string,
    model: string,
    promptVersion: string,
    contentFingerprint: string
  ): ReelAnalysis | null {
    const row = this.db
      .prepare(
        `SELECT * FROM reel_analyses
         WHERE reel_id = ? AND model = ? AND prompt_version = ? AND content_fingerprint = ?
         LIMIT 1`
      )
      .get(reelId, model, promptVersion, contentFingerprint) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapAnalysisRow(row) : null;
  }

  getLatestAnalysisForReel(reelId: string): ReelAnalysis | null {
    const row = this.db
      .prepare('SELECT * FROM reel_analyses WHERE reel_id = ? ORDER BY analyzed_at DESC LIMIT 1')
      .get(reelId) as Record<string, unknown> | undefined;
    return row ? this.mapAnalysisRow(row) : null;
  }

  saveReelAnalysis(input: {
    reelId: string;
    model: string;
    promptVersion: string;
    contentFingerprint: string;
    output: ReelAnalysisOutput;
    analyzedAt?: string;
  }): ReelAnalysis {
    const existing = this.getCachedAnalysis(
      input.reelId,
      input.model,
      input.promptVersion,
      input.contentFingerprint
    );
    if (existing) return existing;

    const id = crypto.randomUUID();
    const analyzedAt = input.analyzedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO reel_analyses (
          id, reel_id, analyzed_at, model, prompt_version, content_fingerprint,
          hook, topic, target_audience, narrative_structure_json, emotional_trigger,
          call_to_action, editing_observations_json, content_pattern, evidence_json,
          confidence, analysis_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.reelId,
        analyzedAt,
        input.model,
        input.promptVersion,
        input.contentFingerprint,
        input.output.hook,
        input.output.topic,
        input.output.targetAudience,
        JSON.stringify(input.output.narrativeStructure),
        input.output.emotionalTrigger,
        input.output.callToAction,
        JSON.stringify(input.output.editingObservations),
        input.output.contentPattern,
        JSON.stringify(input.output.evidence),
        input.output.confidence,
        JSON.stringify(input.output)
      );

    return this.getLatestAnalysisForReel(input.reelId)!;
  }

  listAllAnalyses(): ReelAnalysis[] {
    const rows = this.db
      .prepare('SELECT * FROM reel_analyses ORDER BY analyzed_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapAnalysisRow(r));
  }

  // --- ContentIdea ---
  saveContentIdea(idea: Omit<ContentIdea, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): ContentIdea {
    const id = idea.id ?? crypto.randomUUID();
    const createdAt = idea.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO content_ideas (
          id, created_at, niche, proposed_hook, concept, audience_problem,
          format, suggested_cta, evidence_reel_ids_json, originality_notes, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        idea.niche,
        idea.proposedHook,
        idea.concept,
        idea.audienceProblem,
        idea.format,
        idea.suggestedCTA,
        JSON.stringify(idea.evidenceReelIds),
        idea.originalityNotes,
        idea.status
      );
    return this.listContentIdeas().find((c) => c.id === id)!;
  }

  clearProposedContentIdeas(): void {
    this.db.prepare("DELETE FROM content_ideas WHERE status = 'proposed'").run();
  }

  listContentIdeas(): ContentIdea[] {
    const rows = this.db
      .prepare('SELECT * FROM content_ideas ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      createdAt: String(r.created_at),
      niche: String(r.niche),
      proposedHook: String(r.proposed_hook),
      concept: String(r.concept),
      audienceProblem: String(r.audience_problem),
      format: String(r.format),
      suggestedCTA: String(r.suggested_cta),
      evidenceReelIds: JSON.parse(String(r.evidence_reel_ids_json)) as string[],
      originalityNotes: String(r.originality_notes),
      status: r.status as ContentIdea['status'],
    }));
  }

  // --- Row Mappers ---
  private mapAccountRow(r: Record<string, unknown>): CompetitorAccount {
    return {
      id: String(r.id),
      platform: r.platform as Platform,
      username: String(r.username),
      profileUrl: String(r.profile_url),
      displayName: r.display_name !== null ? String(r.display_name) : null,
      biography: r.biography !== null ? String(r.biography) : null,
      followerCount: r.follower_count !== null ? Number(r.follower_count) : null,
      niche: r.niche !== null ? String(r.niche) : null,
      language: r.language !== null ? String(r.language) : null,
      discoverySource: String(r.discovery_source),
      discoveryReason: r.discovery_reason !== null ? String(r.discovery_reason) : null,
      status: r.status as AccountStatus,
      firstDiscoveredAt: String(r.first_discovered_at),
      lastScannedAt: r.last_scanned_at !== null ? String(r.last_scanned_at) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private mapReelRow(r: Record<string, unknown>): Reel {
    return {
      id: String(r.id),
      platform: r.platform as Platform,
      externalId: String(r.external_id),
      canonicalUrl: String(r.canonical_url),
      accountId: String(r.account_id),
      caption: r.caption !== null ? String(r.caption) : null,
      hashtags: JSON.parse(String(r.hashtags_json || '[]')) as string[],
      publishedAt: r.published_at !== null ? String(r.published_at) : null,
      durationSeconds: r.duration_seconds !== null ? Number(r.duration_seconds) : null,
      transcript: r.transcript !== null ? String(r.transcript) : null,
      transcriptLanguage: r.transcript_language !== null ? String(r.transcript_language) : null,
      mediaUrl: r.media_url !== null ? String(r.media_url) : null,
      thumbnailUrl: r.thumbnail_url !== null ? String(r.thumbnail_url) : null,
      isPinned: r.is_pinned === null ? null : Boolean(r.is_pinned),
      isSponsored: r.is_sponsored === null ? null : Boolean(r.is_sponsored),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private mapSnapshotRow(r: Record<string, unknown>): MetricSnapshot {
    return {
      id: String(r.id),
      reelId: String(r.reel_id),
      collectedAt: String(r.collected_at),
      views: r.views !== null ? Number(r.views) : null,
      plays: r.plays !== null ? Number(r.plays) : null,
      likes: r.likes !== null ? Number(r.likes) : null,
      comments: r.comments !== null ? Number(r.comments) : null,
      shares: r.shares !== null ? Number(r.shares) : null,
      followerCountAtCollection:
        r.follower_count_at_collection !== null ? Number(r.follower_count_at_collection) : null,
      providerRunId: String(r.provider_run_id),
      rawDataReference: r.raw_data_reference !== null ? String(r.raw_data_reference) : null,
    };
  }

  private mapResearchRunRow(r: Record<string, unknown>): ResearchRun {
    return {
      id: String(r.id),
      provider: String(r.provider),
      mode: r.mode as ResearchRunMode,
      startedAt: String(r.started_at),
      completedAt: r.completed_at !== null ? String(r.completed_at) : null,
      status: r.status as ResearchRunStatus,
      recordsDiscovered: Number(r.records_discovered),
      recordsInserted: Number(r.records_inserted),
      recordsUpdated: Number(r.records_updated),
      errors: JSON.parse(String(r.errors_json || '[]')) as ResearchRunError[],
    };
  }

  private mapViralScoreRow(r: Record<string, unknown>): ViralScore {
    return {
      id: String(r.id),
      reelId: String(r.reel_id),
      calculatedAt: String(r.calculated_at),
      baselineViews: r.baseline_views !== null ? Number(r.baseline_views) : null,
      outlierRatio: r.outlier_ratio !== null ? Number(r.outlier_ratio) : null,
      engagementRate: r.engagement_rate !== null ? Number(r.engagement_rate) : null,
      recencyScore: r.recency_score !== null ? Number(r.recency_score) : null,
      growthRate: r.growth_rate !== null ? Number(r.growth_rate) : null,
      overallScore: Number(r.overall_score),
      scoreVersion: String(r.score_version),
      explanation: JSON.parse(String(r.explanation_json)) as ViralScoreExplanation,
    };
  }

  private mapAnalysisRow(r: Record<string, unknown>): ReelAnalysis {
    return {
      id: String(r.id),
      reelId: String(r.reel_id),
      analyzedAt: String(r.analyzed_at),
      model: String(r.model),
      promptVersion: String(r.prompt_version),
      hook: String(r.hook),
      topic: String(r.topic),
      targetAudience: String(r.target_audience),
      narrativeStructure: JSON.parse(String(r.narrative_structure_json)) as string[],
      emotionalTrigger: String(r.emotional_trigger),
      callToAction: String(r.call_to_action),
      editingObservations: JSON.parse(String(r.editing_observations_json)) as string[],
      contentPattern: String(r.content_pattern),
      evidence: JSON.parse(String(r.evidence_json)) as string[],
      confidence: Number(r.confidence),
      analysisJson: JSON.parse(String(r.analysis_json)) as ReelAnalysisOutput,
    };
  }
}
