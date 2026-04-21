'use client';

import { useState, useRef, Suspense, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import type { RTMClient } from 'agora-rtm';
import type {
  AgoraTokenData,
  ClientStartRequest,
  AgentResponse,
  AgoraRenewalTokens,
} from '../types/conversation';
import { ErrorBoundary } from './ErrorBoundary';
import { LoadingSkeleton } from './LoadingSkeleton';

const ConversationComponent = dynamic(() => import('./ConversationComponent'), {
  ssr: false,
});

const AgoraProvider = dynamic(
  async () => {
    const { AgoraRTCProvider, default: AgoraRTC } = await import('agora-rtc-react');
    return {
      default: function AgoraProviders({ children }: { children: React.ReactNode }) {
        const clientRef = useRef<ReturnType<typeof AgoraRTC.createClient> | null>(null);
        if (!clientRef.current) {
          clientRef.current = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        }
        return <AgoraRTCProvider client={clientRef.current}>{children}</AgoraRTCProvider>;
      },
    };
  },
  { ssr: false },
);

const LANGUAGE_OPTIONS = [
  { label: 'Vietnamese (Tiếng Việt)', code: 'vi' },
  { label: 'English', code: 'en' },
  { label: 'Chinese (中文)', code: 'zh' },
  { label: 'Japanese (日本語)', code: 'ja' },
  { label: 'Korean (한국어)', code: 'ko' },
  { label: 'French (Français)', code: 'fr' },
  { label: 'Spanish (Español)', code: 'es' },
  { label: 'Indonesian (Bahasa Indonesia)', code: 'id' },
  { label: 'Malay (Bahasa Melayu)', code: 'ms' },
  { label: 'Thai (ภาษาไทย)', code: 'th' },
  { label: 'Filipino (Tagalog)', code: 'tl' },
  { label: 'Tamil (தமிழ்)', code: 'ta' },
  { label: 'Burmese (မြန်မာဘာသာ)', code: 'my' },
  { label: 'Khmer (ភាសាខ្មែរ)', code: 'km' },
  { label: 'Singlish 🇸🇬', code: 'sg-en' },
  { label: 'Hindi (हिन्दी)', code: 'hi' },
  { label: 'Punjabi (ਪੰਜਾਬੀ)', code: 'pa' },
  { label: 'Bengali (বাংলা)', code: 'bn' },
  { label: 'Telugu (తెలుగు)', code: 'te' },
  { label: 'Marathi (मराठी)', code: 'mr' },
  { label: 'Kannada (ಕನ್ನಡ)', code: 'kn' },
] as const;

const AGORA_APP_ID = process.env.NEXT_PUBLIC_AGORA_APP_ID;

export default function LandingPage() {
  // ─── All hooks must be declared before any conditional return ────────────
  const [showConversation, setShowConversation] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('vi');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agoraData, setAgoraData] = useState<AgoraTokenData | null>(null);
  const [rtmClient, setRtmClient] = useState<RTMClient | null>(null);
  const [agentJoinError, setAgentJoinError] = useState(false);

  useEffect(() => {
    import('agora-rtc-react').catch(() => {});
    import('agora-rtm').catch(() => {});
  }, []);

  const handleTokenWillExpire = useCallback(
    async (uid: string): Promise<AgoraRenewalTokens> => {
      try {
        const channel = agoraData?.channel;
        if (!channel) throw new Error('Missing channel for token renewal');
        const [rtcResponse, rtmResponse] = await Promise.all([
          fetch(`/api/generate-agora-token?channel=${channel}&uid=${uid}`),
          fetch(`/api/generate-agora-token?channel=${channel}&uid=0`),
        ]);
        const [rtcData, rtmData] = await Promise.all([rtcResponse.json(), rtmResponse.json()]);
        if (!rtcResponse.ok || !rtmResponse.ok) throw new Error('Failed to generate renewal tokens');
        return { rtcToken: rtcData.token, rtmToken: rtmData.token };
      } catch (error) {
        console.error('Error renewing token:', error);
        throw error;
      }
    },
    [agoraData],
  );

  // ─── Config guard ────────────────────────────────────────────────────────
  if (!AGORA_APP_ID) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#080808] text-white gap-4 p-8 text-center">
        <h2 className="text-lg font-semibold text-red-400">Configuration Error</h2>
        <p className="text-sm text-white/50 max-w-sm">
          <code className="font-mono bg-white/10 px-1 rounded">NEXT_PUBLIC_AGORA_APP_ID</code> is
          not set. Add it to your environment and <strong>restart</strong>.
        </p>
      </div>
    );
  }

  const handleStartConversation = async () => {
    setIsLoading(true);
    setError(null);
    setAgentJoinError(false);
    try {
      const agoraResponse = await fetch('/api/generate-agora-token');
      const responseData = await agoraResponse.json();
      if (!agoraResponse.ok) {
        throw new Error(`Failed to generate Agora token: ${JSON.stringify(responseData)}`);
      }
      const [agentData, rtm] = await Promise.all([
        fetch('/api/invite-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requester_id: responseData.uid,
            channel_name: responseData.channel,
            languageCode: selectedLanguage,
          } as ClientStartRequest),
        })
          .then(async (res) => {
            if (!res.ok) { setAgentJoinError(true); return null; }
            return res.json() as Promise<AgentResponse>;
          })
          .catch((err) => {
            console.error('Failed to start conversation with agent:', err);
            setAgentJoinError(true);
            return null;
          }),
        (async () => {
          const { default: AgoraRTM } = await import('agora-rtm');
          const rtm: RTMClient = new AgoraRTM.RTM(
            process.env.NEXT_PUBLIC_AGORA_APP_ID!,
            String(Date.now()),
          );
          await rtm.login({ token: responseData.token });
          await rtm.subscribe(responseData.channel);
          return rtm;
        })(),
      ]);
      setRtmClient(rtm);
      setAgoraData({ ...responseData, agentId: agentData?.agent_id });
      setShowConversation(true);
    } catch (err) {
      setError('Failed to start conversation. Please try again.');
      console.error('Error starting conversation:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleEndConversation = async () => {
    if (agoraData?.agentId) {
      try {
        const response = await fetch('/api/stop-conversation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agoraData.agentId }),
        });
        if (!response.ok) console.error('Failed to stop agent:', await response.text());
      } catch (error) {
        console.error('Error stopping agent:', error);
      }
    }
    rtmClient?.logout().catch((err) => console.error('RTM logout error:', err));
    setRtmClient(null);
    setShowConversation(false);
  };

  // ─── Active conversation: full-screen ────────────────────────────────────
  if (showConversation && agoraData && rtmClient) {
    return (
      <div className="relative">
        {agentJoinError && (
          <div className="absolute top-14 left-0 right-0 z-50 bg-red-900/80 text-red-200 text-xs text-center py-1.5 px-4 border-b border-red-800/60">
            Agent connection failed — conversation may not work as expected.
          </div>
        )}
        <Suspense fallback={<LoadingSkeleton />}>
          <ErrorBoundary>
            <AgoraProvider>
              <ConversationComponent
                agoraData={agoraData}
                rtmClient={rtmClient}
                onTokenWillExpire={handleTokenWillExpire}
                onEndConversation={handleEndConversation}
                selectedLanguage={selectedLanguage}
              />
            </AgoraProvider>
          </ErrorBoundary>
        </Suspense>
      </div>
    );
  }

  // ─── Pre-call landing page ────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#080808] text-white relative overflow-hidden p-6">
      {/* Ambient red glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(ellipse 50% 40% at 50% 55%, rgba(220,38,38,0.07) 0%, transparent 70%)',
        }}
      />

      <div className="z-10 flex flex-col items-center gap-8 w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-red-600 flex items-center justify-center text-2xl font-bold select-none shadow-[0_0_32px_rgba(220,38,38,0.4)]">
            C
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <h1 className="text-xl font-semibold">CocaCola CX</h1>
            <p className="text-[11px] text-white/40 tracking-widest uppercase">Voice Agent</p>
          </div>
        </div>

        {/* Language selector */}
        <div className="flex flex-col gap-1.5 w-full">
          <label htmlFor="language-select" className="text-[10px] text-white/30 tracking-widest uppercase">
            Agent Language
          </label>
          <select
            id="language-select"
            value={selectedLanguage}
            onChange={(e) => setSelectedLanguage(e.target.value)}
            disabled={isLoading}
            className="w-full h-10 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-red-500/60 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code} className="bg-[#1a1a1a]">
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Start button */}
        <button
          onClick={handleStartConversation}
          disabled={isLoading}
          className="w-full h-11 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 active:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 shadow-[0_0_24px_rgba(220,38,38,0.3)]"
          aria-label={isLoading ? 'Starting conversation' : 'Start conversation'}
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting…
            </>
          ) : (
            'Start Conversation'
          )}
        </button>

        {error && <p className="text-xs text-red-400 text-center">{error}</p>}
      </div>

    </div>
  );
}
