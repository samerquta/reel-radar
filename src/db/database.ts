import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE IF NOT EXISTS competitor_accounts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('instagram')),
        username TEXT NOT NULL,
        profile_url TEXT NOT NULL,
        display_name TEXT,
        biography TEXT,
        follower_count INTEGER,
        niche TEXT,
        language TEXT,
        discovery_source TEXT NOT NULL,
        discovery_reason TEXT,
        status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'excluded')),
        first_discovered_at TEXT NOT NULL,
        last_scanned_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform, username)
      );

      CREATE INDEX IF NOT EXISTS idx_competitor_accounts_status ON competitor_accounts(status);
      CREATE INDEX IF NOT EXISTS idx_competitor_accounts_niche ON competitor_accounts(niche);

      CREATE TABLE IF NOT EXISTS reels (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('instagram')),
        external_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES competitor_accounts(id) ON DELETE CASCADE,
        caption TEXT,
        hashtags_json TEXT NOT NULL DEFAULT '[]',
        published_at TEXT,
        duration_seconds REAL,
        transcript TEXT,
        transcript_language TEXT,
        media_url TEXT,
        thumbnail_url TEXT,
        is_pinned INTEGER,
        is_sponsored INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_reels_account_id ON reels(account_id);
      CREATE INDEX IF NOT EXISTS idx_reels_published_at ON reels(published_at);

      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id TEXT PRIMARY KEY,
        reel_id TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
        collected_at TEXT NOT NULL,
        views INTEGER,
        plays INTEGER,
        likes INTEGER,
        comments INTEGER,
        shares INTEGER,
        follower_count_at_collection INTEGER,
        provider_run_id TEXT NOT NULL,
        raw_data_reference TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_metric_snapshots_reel_id ON metric_snapshots(reel_id);
      CREATE INDEX IF NOT EXISTS idx_metric_snapshots_collected_at ON metric_snapshots(collected_at);

      CREATE TABLE IF NOT EXISTS research_runs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('competitor_monitoring', 'viral_discovery', 'manual_import')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partially_failed', 'failed', 'cancelled')),
        records_discovered INTEGER NOT NULL DEFAULT 0,
        records_inserted INTEGER NOT NULL DEFAULT 0,
        records_updated INTEGER NOT NULL DEFAULT 0,
        errors_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_research_runs_started_at ON research_runs(started_at);

      CREATE TABLE IF NOT EXISTS reel_analyses (
        id TEXT PRIMARY KEY,
        reel_id TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
        analyzed_at TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        hook TEXT NOT NULL,
        topic TEXT NOT NULL,
        target_audience TEXT NOT NULL,
        narrative_structure_json TEXT NOT NULL,
        emotional_trigger TEXT NOT NULL,
        call_to_action TEXT NOT NULL,
        editing_observations_json TEXT NOT NULL,
        content_pattern TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        analysis_json TEXT NOT NULL,
        UNIQUE(reel_id, model, prompt_version, content_fingerprint)
      );

      CREATE INDEX IF NOT EXISTS idx_reel_analyses_reel_id ON reel_analyses(reel_id);
      CREATE INDEX IF NOT EXISTS idx_reel_analyses_topic ON reel_analyses(topic);

      CREATE TABLE IF NOT EXISTS viral_scores (
        id TEXT PRIMARY KEY,
        reel_id TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
        calculated_at TEXT NOT NULL,
        baseline_views REAL,
        outlier_ratio REAL,
        engagement_rate REAL,
        recency_score REAL,
        growth_rate REAL,
        overall_score REAL NOT NULL,
        score_version TEXT NOT NULL,
        explanation_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_viral_scores_reel_id ON viral_scores(reel_id);
      CREATE INDEX IF NOT EXISTS idx_viral_scores_overall_score ON viral_scores(overall_score DESC);

      CREATE TABLE IF NOT EXISTS content_ideas (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        niche TEXT NOT NULL,
        proposed_hook TEXT NOT NULL,
        concept TEXT NOT NULL,
        audience_problem TEXT NOT NULL,
        format TEXT NOT NULL,
        suggested_cta TEXT NOT NULL,
        evidence_reel_ids_json TEXT NOT NULL,
        originality_notes TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'tested'))
      );

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        job_name TEXT NOT NULL UNIQUE,
        interval_minutes INTEGER NOT NULL,
        is_paused INTEGER NOT NULL DEFAULT 0,
        is_running INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        next_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        daily_spend_usd REAL NOT NULL DEFAULT 0,
        spend_reset_date TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS scheduled_jobs;
      DROP TABLE IF EXISTS content_ideas;
      DROP TABLE IF EXISTS viral_scores;
      DROP TABLE IF EXISTS reel_analyses;
      DROP TABLE IF EXISTS research_runs;
      DROP TABLE IF EXISTS metric_snapshots;
      DROP TABLE IF EXISTS reels;
      DROP TABLE IF EXISTS competitor_accounts;
    `,
  },
];

export function createDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all() as Array<{ version: number }>;
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      const applyTx = db.transaction(() => {
        db.exec(migration.up);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
        ).run(migration.version, migration.name, new Date().toISOString());
      });
      applyTx();
    }
  }
}

export function rollbackLastMigration(db: Database.Database): number | null {
  const lastRow = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;

  if (!lastRow) {
    return null;
  }

  const migration = MIGRATIONS.find((m) => m.version === lastRow.version);
  if (!migration) {
    throw new Error(`Migration definition not found for version ${lastRow.version}`);
  }

  const rollbackTx = db.transaction(() => {
    db.exec(migration.down);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(migration.version);
  });
  rollbackTx();
  return migration.version;
}
