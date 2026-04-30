'use client';

import { useState, useRef, Suspense, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
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

// Only Valsea-ASR-supported languages
const LANGUAGE_OPTIONS = [
  { label: 'Vietnamese (Tiếng Việt)', code: 'vi' },
  { label: 'Indonesian (Bahasa Indonesia)', code: 'id' },
  { label: 'Malay (Bahasa Melayu)', code: 'ms' },
  { label: 'Thai (ภาษาไทย)', code: 'th' },
  { label: 'Filipino (Tagalog)', code: 'tl' },
  { label: 'Tamil (தமிழ்)', code: 'ta' },
  { label: 'Khmer (ភាសាខ្មែរ)', code: 'km' },
] as const;

const AGORA_APP_ID = process.env.NEXT_PUBLIC_AGORA_APP_ID;

export default function LandingPage() {
  const [showConversation, setShowConversation] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('vi');
  const [allowLanguageSwitching, setAllowLanguageSwitching] = useState(false);
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
      const channel = agoraData?.channel;
      if (!channel) throw new Error('Missing channel for token renewal');
      const [rtcResponse, rtmResponse] = await Promise.all([
        fetch(`/api/generate-agora-token?channel=${channel}&uid=${uid}`),
        fetch(`/api/generate-agora-token?channel=${channel}&uid=0`),
      ]);
      const [rtcData, rtmData] = await Promise.all([rtcResponse.json(), rtmResponse.json()]);
      if (!rtcResponse.ok || !rtmResponse.ok) throw new Error('Failed to generate renewal tokens');
      return { rtcToken: rtcData.token, rtmToken: rtmData.token };
    },
    [agoraData],
  );

  const handleChangeLanguage = useCallback(
    async (newLang: string) => {
      // Throw so the caller (handleLangChange) can catch and revert the optimistic update.
      if (!agoraData?.channel || !agoraData.uid) {
        throw new Error('Missing session data for language switch');
      }
      if (agoraData.agentId) {
        // Stop old agent — best-effort, never block the switch on failure.
        try {
          await fetch('/api/stop-conversation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id: agoraData.agentId }),
          });
        } catch (err) {
          console.warn('[lang-switch] stop-conversation failed (continuing):', err);
        }
        // client.stopAgent() signals Agora asynchronously — the agent leaves the RTC
        // channel 1–3 s after the HTTP 200. Wait before starting the replacement so
        // both agents aren't live simultaneously and the old one can't reply in the wrong language.
        await new Promise<void>((r) => setTimeout(r, 1500));
      }
      const res = await fetch('/api/invite-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requester_id: agoraData.uid,
          channel_name: agoraData.channel,
          languageCode: newLang,
          allowLanguageSwitching,
        } as ClientStartRequest),
      });
      if (!res.ok) throw new Error('Failed to restart agent with new language');
      const data: AgentResponse = await res.json();
      setAgoraData((prev) => (prev ? { ...prev, agentId: data.agent_id } : prev));
      setSelectedLanguage(newLang);
    },
    [agoraData, allowLanguageSwitching],
  );

  if (!AGORA_APP_ID) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#09061c] text-white gap-4 p-8 text-center">
        <p className="text-sm text-white/50 max-w-sm">
          <code className="bg-[#7A56AA]/20 px-1.5 py-0.5 rounded text-[#B89AE3] font-mono">
            NEXT_PUBLIC_AGORA_APP_ID
          </code>{' '}
          is not set. Add it to your environment and restart.
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
        throw new Error(`Failed to generate token: ${JSON.stringify(responseData)}`);
      }

      const [agentData, rtm] = await Promise.all([
        fetch('/api/invite-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requester_id: responseData.uid,
            channel_name: responseData.channel,
            languageCode: selectedLanguage,
            allowLanguageSwitching,
          } as ClientStartRequest),
        })
          .then(async (res) => {
            if (!res.ok) { setAgentJoinError(true); return null; }
            return res.json() as Promise<AgentResponse>;
          })
          .catch((err) => {
            console.error('Failed to start agent:', err);
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
        await fetch('/api/stop-conversation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agoraData.agentId }),
        });
      } catch (err) {
        console.error('Error stopping agent:', err);
      }
    }
    rtmClient?.logout().catch((err) => console.error('RTM logout error:', err));
    setRtmClient(null);
    setShowConversation(false);
  };

  // ── Active conversation: full-screen ────────────────────────────────────────
  if (showConversation && agoraData && rtmClient) {
    return (
      <div className="relative">
        {agentJoinError && (
          <div className="absolute top-14 left-0 right-0 z-50 bg-[#3B0B94]/80 text-[#B89AE3] text-xs text-center py-1.5 px-4 border-b border-[#7A56AA]/30">
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
                allowLanguageSwitching={allowLanguageSwitching}
                onChangeLanguage={allowLanguageSwitching ? handleChangeLanguage : undefined}
              />
            </AgoraProvider>
          </ErrorBoundary>
        </Suspense>
      </div>
    );
  }

  // ── Pre-call landing page ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#09061c] text-white relative overflow-hidden p-6">
      {/* Ambient Stage Violet glow — background only, per brand gradient rules */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(ellipse 65% 55% at 50% 55%, rgba(59,11,148,0.28) 0%, transparent 70%)',
        }}
      />

      <div className="z-10 flex flex-col items-center gap-10 w-full max-w-sm animate-fade-up">

        {/* VALSEA brand */}
        <div className="flex flex-col items-center gap-2">
          <Image
            src="/valsea-logo.png"
            alt="valsea"
            width={64}
            height={64}
            className="rounded-2xl"
            priority
          />
          <span className="text-[10px] text-white/30 tracking-[0.22em] uppercase font-medium">
            Speech Intelligence
          </span>
        </div>

        {/* Demo configuration card */}
        <div className="w-full flex flex-col gap-5 border border-[#7A56AA]/20 rounded-2xl bg-[#0e0b22]/70 p-6 backdrop-blur-sm">

          {/* Demo identity — Coke CX context */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-red-600 flex items-center justify-center font-bold text-white text-sm select-none shrink-0">
              C
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight tracking-tight">Coke CX</p>
              <p className="text-[10px] text-white/35 tracking-[0.15em] uppercase leading-tight mt-0.5">
                Valsea Voice Agent Demo
              </p>
            </div>
          </div>

          <div className="h-px bg-[#7A56AA]/15" />

          {/* Agent Language selector */}
          <div className="flex flex-col gap-2">
            <label
              htmlFor="language-select"
              className="text-[10px] text-white/35 tracking-[0.18em] uppercase font-medium"
            >
              Agent Language
            </label>
            <select
              id="language-select"
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              disabled={isLoading}
              className="w-full h-10 rounded-lg border border-[#7A56AA]/25 px-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#7A56AA]/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 appearance-none"
              style={{ backgroundColor: 'rgba(122,86,170,0.08)' }}
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.code} value={opt.code} className="bg-[#120e28] text-white">
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Language switching toggle */}
          <label className="flex items-center gap-3 cursor-pointer select-none group">
            <div className="relative shrink-0">
              <input
                type="checkbox"
                checked={allowLanguageSwitching}
                onChange={(e) => setAllowLanguageSwitching(e.target.checked)}
                disabled={isLoading}
                className="sr-only"
              />
              <div
                className="w-9 h-5 rounded-full transition-colors duration-200"
                style={{
                  backgroundColor: allowLanguageSwitching
                    ? '#7A56AA'
                    : 'rgba(255,255,255,0.1)',
                }}
              />
              <div
                className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200"
                style={{
                  transform: allowLanguageSwitching ? 'translateX(1rem)' : 'translateX(0.125rem)',
                }}
              />
            </div>
            <span className="text-sm text-white/50 group-hover:text-white/65 transition-colors duration-200 leading-snug">
              Allow language switching during call
            </span>
          </label>

          {/* Start button — approved gradient: #3B0B94 → #7A56AA */}
          <button
            onClick={handleStartConversation}
            disabled={isLoading}
            className="w-full h-11 rounded-lg text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2"
            style={{
              background: isLoading
                ? 'rgba(122,86,170,0.4)'
                : 'linear-gradient(135deg, #3B0B94 0%, #7A56AA 100%)',
            }}
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

          {error && (
            <p className="text-xs text-[#B89AE3]/70 text-center leading-relaxed">{error}</p>
          )}
        </div>

        {/* Locked brand sentence */}
        <p className="text-[11px] text-white/22 text-center tracking-wide">
          VALSEA — Built for the Way Asia Really Speaks.
        </p>
      </div>
    </div>
  );
}
