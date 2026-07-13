import AdmZip from "adm-zip";

/**
 * Parses a Spotify "Extended Streaming History" export ZIP into normalized play
 * records. Two source shapes are tolerated:
 *
 *  - EXTENDED  (`Streaming_History_Audio_*.json`): the rich export with per-play
 *    track URIs, reason_start/end, shuffle/skipped flags, etc.
 *  - ACCOUNT   (`StreamingHistory*.json`): the older "account data" download,
 *    which only has endTime / artistName / trackName / msPlayed and no URIs.
 *    We synthesize a stable `local:track:<artist>::<track>` URI for those so the
 *    same song dedupes across re-imports.
 *
 * Podcast episode rows (episode_name, no track name/uri) are skipped for v0.
 */

export type ImportSource = "EXPORT" | "EXPORT_ACCOUNT";

export interface NormalizedPlay {
  spotifyUri: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
  tsISO: string;
  msPlayed: number;
  skipped: boolean | null;
  reasonStart: string | null;
  reasonEnd: string | null;
  shuffle: boolean | null;
  offline: boolean | null;
  incognito: boolean | null;
  platform: string | null;
  source: ImportSource;
}

/** Extended-format record shape (all fields optional / nullable in the wild). */
interface ExtendedRecord {
  ts?: string | null;
  ms_played?: number | null;
  spotify_track_uri?: string | null;
  master_metadata_track_name?: string | null;
  master_metadata_album_artist_name?: string | null;
  master_metadata_album_album_name?: string | null;
  reason_start?: string | null;
  reason_end?: string | null;
  shuffle?: boolean | null;
  skipped?: boolean | null;
  offline?: boolean | null;
  incognito_mode?: boolean | null;
  platform?: string | null;
  episode_name?: string | null;
}

/** Account-data-format record shape. */
interface AccountRecord {
  endTime?: string | null;
  artistName?: string | null;
  trackName?: string | null;
  msPlayed?: number | null;
}

const EXTENDED_ENTRY_RE = /Streaming_History_Audio.*\.json$/i;
const ACCOUNT_ENTRY_RE = /StreamingHistory.*\.json$/i;

/**
 * Slugifies a value for use inside a synthetic `local:track:` URI. Lowercases,
 * collapses whitespace/punctuation to single dashes, trims dashes.
 */
function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function synthAccountUri(artistName: string, trackName: string): string {
  return `local:track:${slug(artistName)}::${slug(trackName)}`;
}

/**
 * Converts an account-data `endTime` ("YYYY-MM-DD HH:mm", UTC) to an ISO string.
 * Returns null if it doesn't look like the expected shape.
 */
function accountEndTimeToISO(endTime: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    endTime.trim()
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00"] = m;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  );
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseExtendedRecord(rec: ExtendedRecord): NormalizedPlay | null {
  const trackName = rec.master_metadata_track_name ?? null;
  const uri = rec.spotify_track_uri ?? null;

  // Skip rows with neither a track name nor a uri: podcast episodes (which carry
  // episode_name instead) and any junk rows are dropped for v0.
  if (!trackName && !uri) return null;
  // Even if a uri somehow exists, a missing track name means we can't build a
  // meaningful track row — treat as an episode/junk row and skip.
  if (!trackName) return null;

  if (!rec.ts) return null;
  const parsed = new Date(rec.ts);
  if (Number.isNaN(parsed.getTime())) return null;

  const artistName = rec.master_metadata_album_artist_name ?? "Unknown Artist";
  const spotifyUri = uri ?? synthAccountUri(artistName, trackName);

  return {
    spotifyUri,
    trackName,
    artistName,
    albumName: rec.master_metadata_album_album_name ?? null,
    tsISO: parsed.toISOString(),
    msPlayed: typeof rec.ms_played === "number" ? rec.ms_played : 0,
    skipped: typeof rec.skipped === "boolean" ? rec.skipped : null,
    reasonStart: rec.reason_start ?? null,
    reasonEnd: rec.reason_end ?? null,
    shuffle: typeof rec.shuffle === "boolean" ? rec.shuffle : null,
    offline: typeof rec.offline === "boolean" ? rec.offline : null,
    incognito: typeof rec.incognito_mode === "boolean" ? rec.incognito_mode : null,
    platform: typeof rec.platform === "string" ? rec.platform : null,
    source: "EXPORT",
  };
}

function parseAccountRecord(rec: AccountRecord): NormalizedPlay | null {
  const trackName = rec.trackName ?? null;
  if (!trackName) return null;
  if (!rec.endTime) return null;

  const tsISO = accountEndTimeToISO(rec.endTime);
  if (!tsISO) return null;

  const artistName = rec.artistName ?? "Unknown Artist";

  return {
    spotifyUri: synthAccountUri(artistName, trackName),
    trackName,
    artistName,
    albumName: null,
    tsISO,
    msPlayed: typeof rec.msPlayed === "number" ? rec.msPlayed : 0,
    skipped: null,
    reasonStart: null,
    reasonEnd: null,
    shuffle: null,
    offline: null,
    incognito: null,
    platform: null,
    source: "EXPORT_ACCOUNT",
  };
}

function safeParseJsonArray(buf: Buffer): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(buf.toString("utf8"));
  } catch {
    return [];
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Parses a Spotify export ZIP buffer into normalized play records. Never throws
 * on malformed individual entries/records — bad JSON files and rows are skipped.
 */
export function parseExport(zipBuffer: Buffer): NormalizedPlay[] {
  const zip = new AdmZip(zipBuffer);
  const out: NormalizedPlay[] = [];

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;

    const isExtended = EXTENDED_ENTRY_RE.test(name);
    const isAccount = !isExtended && ACCOUNT_ENTRY_RE.test(name);
    if (!isExtended && !isAccount) continue;

    const records = safeParseJsonArray(entry.getData());
    for (const raw of records) {
      if (typeof raw !== "object" || raw === null) continue;
      const normalized = isExtended
        ? parseExtendedRecord(raw as ExtendedRecord)
        : parseAccountRecord(raw as AccountRecord);
      if (normalized) out.push(normalized);
    }
  }

  return out;
}
