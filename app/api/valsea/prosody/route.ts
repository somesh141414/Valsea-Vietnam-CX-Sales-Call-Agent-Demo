import { NextRequest, NextResponse } from 'next/server';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('file') as Blob | null;

    if (!audioFile) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }

    const upstreamForm = new FormData();
    upstreamForm.append('model', 'valsea-prosody');
    upstreamForm.append('file', audioFile, 'audio.webm');

    const response = await fetch('https://api.valsea.ai/v1/prosody', {
      method: 'POST',
      headers: { Authorization: `Bearer ${requireEnv('NEXT_VALSEA_API_KEY')}` },
      body: upstreamForm,
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Prosody submission failed' },
      { status: 500 },
    );
  }
}
