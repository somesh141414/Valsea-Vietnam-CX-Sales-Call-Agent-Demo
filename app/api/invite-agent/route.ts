import { NextRequest, NextResponse } from 'next/server';
import {
  AgoraClient,
  Agent,
  Area,
  BaseSTT,
  ExpiresIn,
  MiniMaxTTS,
  OpenAI,
} from 'agora-agent-server-sdk';
import { ClientStartRequest, AgentResponse } from '@/types/conversation';
import { DEFAULT_AGENT_UID } from '@/lib/agora';

// System prompt that defines the agent's personality and behavior.
const ADA_PROMPT = `You are **Ada**, an agentic developer advocate from **Agora**. You help developers understand and build with Agora's Conversational AI platform.

# What Agora Actually Is
Agora is a real-time communications company. The product you represent is the **Agora Conversational AI Engine** — it lets developers add voice AI agents to any app by connecting ASR, LLM, and TTS into a real-time pipeline over Agora's SD-RTN (Software Defined Real-Time Network). Key facts:
- The product is called the **Conversational AI Engine** (not "Chorus", not "Harmony", or any other name you might invent)
- It runs a full ASR → LLM → TTS pipeline with sub-500ms latency
- It supports Deepgram, Microsoft, and others for ASR; OpenAI, Anthropic, and others for LLM; ElevenLabs, Microsoft, and others for TTS
- Agora's SD-RTN is its global real-time network infrastructure — not "SDRTN"
- MCP in this context means **Model Context Protocol** (Anthropic's open standard for connecting AI models to tools/data), not "multi-channel processing"
- Agora does not have a product called Chorus, Harmony, or any similar name — do not invent product names

# Honesty Rule
If you don't know a specific fact about Agora, say so plainly and suggest checking docs.agora.io. Never invent product names, feature names, or capabilities.

# Persona & Tone
- Friendly, technically credible, concise. You're a peer who builds things, not a support agent.
- Plain English. No marketing fluff.

# Core Behavior Guidelines
- **Default to brief**: This is a voice conversation. Keep most replies to 1–2 sentences. Only go longer if the user explicitly asks for detail or the answer genuinely requires it.
- **Never list or enumerate**: No bullet points, no numbered steps. Say the single most important thing.
- **Clarify before answering**: For anything complex, ask one focused question first.
- **Ask at most one question per turn**: Never stack questions.
- **Guide, don't lecture**: Unlock the next step, not everything at once.`;

// First thing the agent says when a user joins the channel.
const GREETING =
  process.env.NEXT_AGENT_GREETING ??
  `Hi there! I'm Ada, your virtual assistant from Agora. How can I help?`;

// agentUid identifies the AI in the RTC channel — must match NEXT_PUBLIC_AGENT_UID on the client
const agentUid = process.env.NEXT_PUBLIC_AGENT_UID ?? String(DEFAULT_AGENT_UID);

// Language → { voiceId, instruction }
// voiceId: MiniMax speech_2_6_turbo is multilingual — the same voice speaks any language
//          when the LLM outputs text in that language. Update voice IDs here if you have
//          language-specific MiniMax voices available on your account.
const LANGUAGE_CONFIG: Record<string, { voiceId: string; instruction: string }> = {
  en: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in English, regardless of what language the user speaks.',
  },
  vi: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Vietnamese (Tiếng Việt), regardless of what language the user speaks.',
  },
  zh: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Mandarin Chinese (普通话), regardless of what language the user speaks.',
  },
  ja: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Japanese (日本語), regardless of what language the user speaks.',
  },
  ko: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Korean (한국어), regardless of what language the user speaks.',
  },
  fr: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in French (Français), regardless of what language the user speaks.',
  },
  es: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Spanish (Español), regardless of what language the user speaks.',
  },
  id: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Indonesian (Bahasa Indonesia), regardless of what language the user speaks.',
  },
  ms: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Malay (Bahasa Melayu), regardless of what language the user speaks.',
  },
  th: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Thai (ภาษาไทย), regardless of what language the user speaks.',
  },
  tl: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Filipino (Tagalog), regardless of what language the user speaks.',
  },
  ta: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Tamil (தமிழ்), regardless of what language the user speaks.',
  },
  my: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Burmese (မြန်မာဘာသာ), regardless of what language the user speaks.',
  },
  km: {
    voiceId: 'English_captivating_female1',
    instruction: 'Always respond in Khmer (ភាសាខ្មែរ), regardless of what language the user speaks.',
  },
  'sg-en': {
    voiceId: 'English_captivating_female1',
    // Singlish is a creole — instruct the LLM to mimic its characteristic style
    instruction: 'Always respond in Singlish (Singaporean English creole). Use characteristic Singlish features: sentence-final particles like "lah", "leh", "lor", "meh", "sia", "can?"; direct grammar influenced by Malay and Hokkien; and a casual, friendly tone. For example: "Can do one lah, no worries!" or "Wah, that one very good leh."',
  },
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Custom Valsea STT wrapper — 'valsea' is a backend-only vendor not yet in the SDK types,
// so we cast through unknown to satisfy the SttConfig discriminated union.
class ValseasTT extends BaseSTT {
  toConfig() {
    return {
      vendor: 'valsea',
      language: 'vi-VN',
      params: {
        uri: 'wss://api.valsea.ai/v1/realtime',
        auth_mode: 'header',
        header_name: 'Authorization',
        header_value: `Bearer ${requireEnv('NEXT_VALSEA_API_KEY')}`,
        audio_format: 'pcm16',
        sample_rate: 16000,
        model: 'valsea-rtt',
        enable_correction: true,
        language: "chinese",
      },
    } as unknown as ReturnType<BaseSTT['toConfig']>;
  }
}

export async function POST(request: NextRequest) {
  try {
    // --- 1. Parse request ---

    const body: ClientStartRequest = await request.json();
    const { requester_id, channel_name, languageCode = 'vi' } = body;
    const lang = LANGUAGE_CONFIG[languageCode] ?? LANGUAGE_CONFIG['vi'];

    // Validate required env vars on first request so misconfiguration surfaces
    // with a clear error message rather than a silent failure.
    const appId = requireEnv('NEXT_PUBLIC_AGORA_APP_ID');
    const appCertificate = requireEnv('NEXT_AGORA_APP_CERTIFICATE');

    if (!channel_name || !requester_id) {
      return NextResponse.json(
        { error: 'channel_name and requester_id are required' },
        { status: 400 },
      );
    }

    // --- 2. Build and start the agent ---

    // AgoraClient authenticates API calls to the Agora Conversational AI service.
    const client = new AgoraClient({
      area: Area.US,
      appId,
      appCertificate,
    });

    // Pipeline: Valsea (custom) STT → OpenAI (reseller) LLM → MiniMax (reseller) TTS.
    const agent = new Agent({
      name: `conversation-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      instructions: `${ADA_PROMPT}\n\n# Language\n${lang.instruction}`,
      greeting: GREETING,
      failureMessage: 'Please wait a moment.',
      maxHistory: 50,
      turnDetection: {
        config: {
          speech_threshold: 0.5,
          start_of_speech: {
            mode: 'vad',
            vad_config: {
              interrupt_duration_ms: 160,
              prefix_padding_ms: 300,
            },
          },
          end_of_speech: {
            mode: 'vad',
            vad_config: {
              silence_duration_ms: 480,
            },
          },
        },
      },
      advancedFeatures: { enable_rtm: true, enable_tools: true },
      parameters: { data_channel: 'rtm', enable_error_message: true },
    })
      .withStt(new ValseasTT())
      .withLlm(
        new OpenAI({
          model: 'gpt-4o-mini',
          greetingMessage: GREETING,
          failureMessage: 'Please wait a moment.',
          maxHistory: 15,
          params: {
            max_tokens: 1024,
            temperature: 0.7,
            top_p: 0.95,
          },
        }),
      )
      .withTts(
        new MiniMaxTTS({
          model: 'speech_2_6_turbo',
          voiceId: lang.voiceId,
        }),
      );

    // remoteUids restricts the agent to only process audio from this user
    const session = agent.createSession(client, {
      channel: channel_name,
      agentUid,
      remoteUids: [requester_id],
      idleTimeout: 30,
      expiresIn: ExpiresIn.hours(1),
      debug: true,
    });

    const agentId = await session.start();

    return NextResponse.json({
      agent_id: agentId,
      create_ts: Math.floor(Date.now() / 1000),
      state: 'RUNNING',
    } as AgentResponse);
  } catch (error) {
    console.error('Error starting conversation:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to start conversation',
      },
      { status: 500 },
    );
  }
}
