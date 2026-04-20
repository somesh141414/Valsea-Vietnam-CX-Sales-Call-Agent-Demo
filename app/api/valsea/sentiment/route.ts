import { NextRequest, NextResponse } from 'next/server';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function POST(request: NextRequest) {
  try {
    const { transcript } = await request.json();
    if (!transcript) {
      return NextResponse.json({ error: 'transcript is required' }, { status: 400 });
    }

    const response = await fetch('https://api.valsea.ai/v1/sentiment', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requireEnv('NEXT_VALSEA_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'valsea-sentiment',
        transcript,
        response_format: 'verbose_json',
      }),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sentiment analysis failed' },
      { status: 500 },
    );
  }
}
