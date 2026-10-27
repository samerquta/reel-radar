import fs from 'node:fs';
import path from 'node:path';
import {
  CollectionBatchResult,
  CollectionOptions,
  NormalizedCollectedReel,
  ReelCollectionProvider,
} from './interfaces.js';
import { normalizeRawReelItem } from './normalizer.js';

/**
 * Parses RFC-4180 compliant CSV lines supporting quoted fields and commas inside quotes.
 */
export function parseCsvContent(csvText: string): Array<Record<string, string>> {
  const lines: string[] = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i]!;
    if (ch === '"') {
      if (inQuotes && csvText[i + 1] === '"') {
        currentLine += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        currentLine += ch;
      }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (currentLine.trim().length > 0) {
        lines.push(currentLine);
      }
      currentLine = '';
      if (ch === '\r' && csvText[i + 1] === '\n') {
        i++;
      }
    } else {
      currentLine += ch;
    }
  }
  if (currentLine.trim().length > 0) {
    lines.push(currentLine);
  }

  if (lines.length === 0) return [];

  const splitRow = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (ch === ',' && !quoted) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headers = splitRow(lines[0]!);
  const rows: Array<Record<string, string>> = [];

  for (let rowIdx = 1; rowIdx < lines.length; rowIdx++) {
    const values = splitRow(lines[rowIdx]!);
    const record: Record<string, string> = {};
    for (let colIdx = 0; colIdx < headers.length; colIdx++) {
      const key = headers[colIdx];
      if (key) {
        record[key] = values[colIdx] ?? '';
      }
    }
    rows.push(record);
  }

  return rows;
}

export class ManualImportProvider implements ReelCollectionProvider {
  public readonly name = 'manual-import';

  constructor(private readonly filePath: string) {}

  estimateCostUsd(_options: CollectionOptions): number {
    return 0;
  }

  async collectReels(options: CollectionOptions = {}): Promise<CollectionBatchResult> {
    const startedAt = new Date().toISOString();
    const resolvedPath = path.resolve(this.filePath);
    const providerRunId = `import:${path.basename(resolvedPath)}:${Date.now()}`;

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Import file does not exist: ${resolvedPath}`);
    }

    const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
    const ext = path.extname(resolvedPath).toLowerCase();

    let rawRecords: unknown[] = [];
    if (ext === '.json') {
      const parsed = JSON.parse(rawContent);
      rawRecords = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { items?: unknown[] })?.items)
          ? (parsed as { items: unknown[] }).items
          : [parsed];
    } else if (ext === '.csv') {
      rawRecords = parseCsvContent(rawContent);
    } else {
      throw new Error(
        `Unsupported import file format "${ext}". Supported formats: .json, .csv`
      );
    }

    const reels: NormalizedCollectedReel[] = [];
    const missingFieldsSummary: Record<string, number> = {};
    const errors: CollectionBatchResult['errors'] = [];

    const filterUsernames =
      options.usernames && options.usernames.length > 0
        ? new Set(options.usernames.map((u) => u.trim().replace(/^@/, '').toLowerCase()))
        : null;

    for (let i = 0; i < rawRecords.length; i++) {
      const norm = normalizeRawReelItem(rawRecords[i], {
        providerRunId,
        rawDataReference: `file:${path.basename(resolvedPath)}#${i}`,
      });

      if (norm.validationError || !norm.reel) {
        errors.push({
          target: `row-${i}`,
          message: norm.validationError ?? 'Invalid record',
          isTransient: false,
        });
        continue;
      }

      if (filterUsernames && !filterUsernames.has(norm.reel.creatorUsername)) {
        continue;
      }

      reels.push(norm.reel);
      for (const field of norm.missingFields) {
        missingFieldsSummary[field] = (missingFieldsSummary[field] ?? 0) + 1;
      }
    }

    return {
      providerName: this.name,
      providerRunId,
      startedAt,
      completedAt: new Date().toISOString(),
      reels,
      missingFieldsSummary,
      errors,
      estimatedCostUsd: 0,
    };
  }
}
