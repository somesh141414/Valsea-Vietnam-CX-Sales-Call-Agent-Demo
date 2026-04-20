import { NextRequest, NextResponse } from 'next/server';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Checks job status, then fetches result if completed — one round-trip for the client.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const authHeader = { Authorization: `Bearer ${requireEnv('NEXT_VALSEA_API_KEY')}` };

    const statusRes = await fetch(`https://api.valsea.ai/v1/prosody/${jobId}`, {
      headers: authHeader,
    });
    const statusData = await statusRes.json();

    if (statusData.status !== 'completed') {
      return NextResponse.json(statusData, { status: statusRes.status });
    }

    const resultRes = await fetch(`https://api.valsea.ai/v1/prosody/${jobId}/result`, {
      headers: authHeader,
    });
    const resultData = await resultRes.json();
    return NextResponse.json(resultData, { status: resultRes.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Prosody poll failed' },
      { status: 500 },
    );
  }
}
