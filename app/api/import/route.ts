import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { runImport } from "@/lib/import/runImport";

// Export ZIPs can be large; give the request room to parse + ingest.
export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // ~200MB

/**
 * POST multipart/form-data with a "file" field (a Spotify export ZIP). Parses
 * and ingests the plays synchronously (fine for v0) and returns a summary.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { error: "Missing 'file' upload" },
      { status: 400 }
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_UPLOAD_BYTES} bytes)` },
      { status: 413 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = file.name || "export.zip";

  try {
    const result = await runImport(user.id, buffer, filename);
    return NextResponse.json({
      id: result.id,
      filename: result.filename,
      status: result.status,
      rowsTotal: result.rowsTotal,
      rowsImported: result.rowsImported,
      rowsSkipped: result.rowsSkipped,
      error: result.error,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Import failed: ${message}` },
      { status: 500 }
    );
  }
}

/** GET returns the user's last 10 imports (most recent first). */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const imports = await db.exportImport.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return NextResponse.json({ imports });
}
