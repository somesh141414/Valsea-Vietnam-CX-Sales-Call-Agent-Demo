'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Image from 'next/image';
import { Loader2, Activity, Clock, PhoneOff, Mic, MicOff } from 'lucide-react';
import { setParameter } from 'agora-rtc-sdk-ng/esm';
import {
  useRTCClient,
  useLocalMicrophoneTrack,
  useRemoteUsers,
  useClientEvent,
  useJoin,
  usePublish,
  RemoteUser,
  UID,
} from 'agora-rtc-react';
import {
  AgoraVoiceAI,
  AgoraVoiceAIEvents,
  AgentState,
  MessageSalStatus,
  TranscriptHelperMode,
  type TranscriptHelperItem,
  type UserTranscription,
  type AgentTranscription,
} from 'agora-agent-client-toolkit';
import { DEFAULT_AGENT_UID } from '@/lib/agora';
import {
  getCurrentInProgressMessage,
  getMessageList,
  normalizeTimestampMs,
  normalizeTranscript,
} from '@/lib/conversation';
import { MicrophoneSelector } from './MicrophoneSelector';
import {
  ConversationErrorCard,
  getConversationIssueSeverity,
  type ConnectionIssue,
} from './ConversationErrorCard';
import { AnalysisPanel, type ProsodyData, type SentimentData } from './AnalysisPanel';
import type { ConversationComponentProps } from '@/types/conversation';

const MAX_CONNECTION_ISSUES = 6;

// Language display labels — only Valsea-ASR-supported languages
const LANGUAGE_LABELS: Record<string, string> = {
  vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay',
  th: 'Thai', tl: 'Filipino', ta: 'Tamil', km: 'Khmer',
};

// Language options for the mid-call switcher
const VALSEA_LANGUAGES = [
  { label: 'Vietnamese', code: 'vi' },
  { label: 'Indonesian', code: 'id' },
  { label: 'Malay', code: 'ms' },
  { label: 'Thai', code: 'th' },
  { label: 'Filipino', code: 'tl' },
  { label: 'Tamil', code: 'ta' },
  { label: 'Khmer', code: 'km' },
] as const;

type RtmMessageErrorPayload = {
  object: 'message.error';
  module?: string;
  code?: number;
  message?: string;
  send_ts?: number;
};

type RtmSalStatusPayload = {
  object: 'message.sal_status';
  status?: string;
  timestamp?: number;
};

function isRtmMessageErrorPayload(value: unknown): value is RtmMessageErrorPayload {
  return !!value && typeof value === 'object' && (value as { object?: unknown }).object === 'message.error';
}

function isRtmSalStatusPayload(value: unknown): value is RtmSalStatusPayload {
  return !!value && typeof value === 'object' && (value as { object?: unknown }).object === 'message.sal_status';
}

const AGENT_STATE_LABEL: Record<string, string> = {
  listening: 'Listening',
  thinking:  'Thinking',
  speaking:  'Speaking',
  idle:      'Ready',
  silent:    'Ready',
};

export default function ConversationComponent({
  agoraData,
  rtmClient,
  onTokenWillExpire,
  onEndConversation,
  selectedLanguage = 'vi',
  allowLanguageSwitching = false,
  onChangeLanguage,
}: ConversationComponentProps) {
  const client      = useRTCClient();
  const remoteUsers = useRemoteUsers();
  const [isEnabled, setIsEnabled]               = useState(true);
  const [isAgentConnected, setIsAgentConnected] = useState(false);
  const [connectionState, setConnectionState]   = useState<string>('CONNECTING');
  const agentUID = process.env.NEXT_PUBLIC_AGENT_UID ?? String(DEFAULT_AGENT_UID);
  const [joinedUID, setJoinedUID] = useState<UID>(0);

  const [rawTranscript, setRawTranscript] = useState<
    TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>[]
  >([]);
  const [agentState, setAgentState]             = useState<AgentState | null>(null);
  const [connectionIssues, setConnectionIssues] = useState<ConnectionIssue[]>([]);

  // Language switching state
  const [currentLang, setCurrentLang]               = useState(selectedLanguage);
  const [isLanguageSwitching, setIsLanguageSwitching] = useState(false);

  // Sync currentLang when parent updates selectedLanguage (post-switch)
  useEffect(() => {
    setCurrentLang(selectedLanguage);
  }, [selectedLanguage]);

  // Valsea analysis state
  const [prosody, setProsody]                             = useState<ProsodyData | null>(null);
  const [sentiment, setSentiment]                         = useState<SentimentData | null>(null);
  const [isProsodyLoading, setIsProsodyLoading]           = useState(false);
  const [isSentimentLoading, setIsSentimentLoading]       = useState(false);
  const [isProsodyUnavailable, setIsProsodyUnavailable]   = useState(false);
  const [isSentimentUnavailable, setIsSentimentUnavailable] = useState(false);
  const prevUserMsgCountRef = useRef(0);

  const msgTimestampsRef     = useRef<Map<string, number>>(new Map());
  const transcriptEndRef     = useRef<HTMLDivElement>(null);
  const sentimentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestTranscriptRef  = useRef<string>('');

  const addConnectionIssue = useCallback((issue: ConnectionIssue) => {
    setConnectionIssues((prev) => {
      const isDuplicate = prev.some(
        (x) =>
          x.agentUserId === issue.agentUserId &&
          x.code === issue.code &&
          x.message === issue.message &&
          Math.abs(x.timestamp - issue.timestamp) < 1500,
      );
      if (isDuplicate) return prev;
      return [issue, ...prev].slice(0, MAX_CONNECTION_ISSUES);
    });
  }, []);

  // StrictMode guard
  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => { if (!cancelled) setIsReady(true); }, 0);
    return () => { cancelled = true; clearTimeout(id); setIsReady(false); };
  }, []);

  const { isConnected: joinSuccess } = useJoin(
    {
      appid: process.env.NEXT_PUBLIC_AGORA_APP_ID!,
      channel: agoraData.channel,
      token: agoraData.token,
      uid: parseInt(agoraData.uid, 10) || 0,
    },
    isReady,
  );

  const { localMicrophoneTrack } = useLocalMicrophoneTrack(isReady);

  useEffect(() => {
    if (!client) return;
    try { setParameter('ENABLE_AUDIO_PTS', true); } catch {}
  }, [client]);

  useEffect(() => {
    if (joinSuccess && client) {
      const uid = client.uid;
      if (uid !== null && uid !== undefined) setJoinedUID(uid);
    }
  }, [joinSuccess, client]);

  // AgoraVoiceAI init
  useEffect(() => {
    if (!isReady || !joinSuccess) return;
    let cancelled = false;
    (async () => {
      try {
        const ai = await AgoraVoiceAI.init({
          rtcEngine: client,
          rtmConfig: { rtmEngine: rtmClient },
          renderMode: TranscriptHelperMode.TEXT,
          enableLog: true,
        });
        if (cancelled) {
          try { if (AgoraVoiceAI.getInstance() === ai) { ai.unsubscribe(); ai.destroy(); } } catch {}
          return;
        }
        ai.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (t) => setRawTranscript([...t]));
        ai.on(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, (_, event) => setAgentState(event.state));
        ai.on(AgoraVoiceAIEvents.MESSAGE_ERROR, (agentUserId, error) => {
          addConnectionIssue({
            id: `${Date.now()}-${agentUserId}-message-error-${error.code}`,
            source: 'rtm', agentUserId, code: error.code, message: error.message,
            timestamp: normalizeTimestampMs(error.timestamp),
          });
        });
        ai.on(AgoraVoiceAIEvents.MESSAGE_SAL_STATUS, (agentUserId, salStatus) => {
          if (salStatus.status === MessageSalStatus.VP_REGISTER_FAIL || salStatus.status === MessageSalStatus.VP_REGISTER_DUPLICATE) {
            addConnectionIssue({
              id: `${Date.now()}-${agentUserId}-sal-${salStatus.status}`,
              source: 'rtm', agentUserId, code: salStatus.status,
              message: `SAL status: ${salStatus.status}`,
              timestamp: normalizeTimestampMs(salStatus.timestamp),
            });
          }
        });
        ai.on(AgoraVoiceAIEvents.AGENT_ERROR, (agentUserId, error) => {
          addConnectionIssue({
            id: `${Date.now()}-${agentUserId}-agent-error-${error.code}`,
            source: 'agent', agentUserId, code: error.code,
            message: `${error.type}: ${error.message}`,
            timestamp: normalizeTimestampMs(error.timestamp),
          });
        });
        ai.subscribeMessage(agoraData.channel);
      } catch (error) {
        if (!cancelled) console.error('[AgoraVoiceAI] init failed:', error);
      }
    })();
    return () => {
      cancelled = true;
      try { const ai = AgoraVoiceAI.getInstance(); if (ai) { ai.unsubscribe(); ai.destroy(); } } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, joinSuccess]);

  // RTM raw message fallback
  useEffect(() => {
    const handleRtmMessage = (event: { message: string | Uint8Array; publisher: string }) => {
      const payloadText = typeof event.message === 'string' ? event.message : new TextDecoder().decode(event.message);
      let parsed: unknown;
      try { parsed = JSON.parse(payloadText); } catch { return; }
      if (isRtmMessageErrorPayload(parsed)) {
        const p = parsed;
        addConnectionIssue({
          id: `${Date.now()}-${event.publisher}-rtm-msg-error-${p.code ?? 'unknown'}`,
          source: 'rtm-signaling', agentUserId: event.publisher, code: p.code ?? 'unknown',
          message: `${p.module ?? 'unknown'}: ${p.message ?? 'Unknown signaling error'}`,
          timestamp: normalizeTimestampMs(p.send_ts ?? Date.now()),
        });
        return;
      }
      if (isRtmSalStatusPayload(parsed)) {
        const p = parsed;
        if (p.status === 'VP_REGISTER_FAIL' || p.status === 'VP_REGISTER_DUPLICATE') {
          addConnectionIssue({
            id: `${Date.now()}-${event.publisher}-rtm-sal-${p.status}`,
            source: 'rtm-signaling', agentUserId: event.publisher, code: p.status,
            message: `SAL status: ${p.status}`,
            timestamp: normalizeTimestampMs(p.timestamp ?? Date.now()),
          });
        }
      }
    };
    rtmClient.addEventListener('message', handleRtmMessage);
    return () => { rtmClient.removeEventListener('message', handleRtmMessage); };
  }, [rtmClient, addConnectionIssue]);

  const transcript = useMemo(
    () => normalizeTranscript(rawTranscript, client?.uid != null ? String(client.uid) : ''),
    [rawTranscript, client?.uid],
  );
  const messageList              = useMemo(() => getMessageList(transcript), [transcript]);
  const currentInProgressMessage = useMemo(() => getCurrentInProgressMessage(transcript), [transcript]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messageList, currentInProgressMessage]);

  // ─── Prosody: continuous 8-second recording cycles ───────────────────────
  useEffect(() => {
    if (!localMicrophoneTrack || !isReady || !joinSuccess) return;
    let active = true;
    let currentRecorder: MediaRecorder | null = null;
    const msTrack = localMicrophoneTrack.getMediaStreamTrack();
    const stream  = new MediaStream([msTrack]);
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    const submitProsody = async (blob: Blob) => {
      setIsProsodyLoading(true);
      try {
        const form = new FormData();
        form.append('file', blob, 'audio.webm');
        const submitRes = await fetch('/api/valsea/prosody', { method: 'POST', body: form });
        if (!submitRes.ok) {
          if (submitRes.status === 402) setIsProsodyUnavailable(true);
          return;
        }
        const { job_id } = await submitRes.json();
        if (!job_id) return;
        let rateRetries = 0;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (!active) return;
          const pollRes = await fetch(`/api/valsea/prosody/${job_id}`);
          if (pollRes.status === 429 && rateRetries++ < 3) {
            await new Promise((r) => setTimeout(r, 6000));
            i--;
            continue;
          }
          if (!pollRes.ok) break;
          const data = await pollRes.json();
          const emotions: ProsodyData | null = data.emotions ?? ('frustration' in data ? data : null);
          if (emotions) { setProsody(emotions); return; }
          if (data.status === 'failed') break;
        }
      } catch (err) {
        console.error('[Prosody]', err);
      } finally {
        if (active) setIsProsodyLoading(false);
      }
    };

    const runCycle = () => {
      if (!active) return;
      const chunks: Blob[] = [];
      let rec: MediaRecorder;
      try { rec = new MediaRecorder(stream, { mimeType }); } catch { return; }
      currentRecorder = rec;
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        if (!active || chunks.length === 0) { if (active) runCycle(); return; }
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size >= 1000) await submitProsody(blob);
        if (active) runCycle();
      };
      rec.start();
      setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, 8000);
    };
    runCycle();
    return () => {
      active = false;
      if (currentRecorder?.state !== 'inactive') currentRecorder?.stop();
    };
  }, [localMicrophoneTrack, isReady, joinSuccess]);

  // ─── Sentiment: debounced 5 s after last new user message ────────────────
  useEffect(() => {
    const userMessages = messageList.filter((m) => String(m.uid) !== agentUID && m.text);
    if (userMessages.length <= prevUserMsgCountRef.current) return;
    prevUserMsgCountRef.current = userMessages.length;
    const fullTranscript = userMessages.map((m) => m.text).join(' ').trim();
    if (!fullTranscript) return;

    latestTranscriptRef.current = fullTranscript;
    if (sentimentDebounceRef.current) clearTimeout(sentimentDebounceRef.current);
    sentimentDebounceRef.current = setTimeout(() => {
      const transcript = latestTranscriptRef.current;
      if (!transcript) return;
      setIsSentimentLoading(true);
      fetch('/api/valsea/sentiment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      })
        .then((r) => { if (r.status === 402) { setIsSentimentUnavailable(true); return null; } return r.ok ? r.json() : null; })
        .then((data) => { if (data?.sentiment) setSentiment(data as SentimentData); })
        .catch((err) => console.error('[Sentiment]', err))
        .finally(() => setIsSentimentLoading(false));
    }, 5000);
  }, [messageList, agentUID]);

  usePublish([localMicrophoneTrack]);

  useClientEvent(client, 'user-joined', (user) => {
    if (user.uid.toString() === agentUID) setIsAgentConnected(true);
  });
  useClientEvent(client, 'user-left', (user) => {
    if (user.uid.toString() === agentUID) setIsAgentConnected(false);
  });
  useEffect(() => {
    setIsAgentConnected(remoteUsers.some((u) => u.uid.toString() === agentUID));
  }, [remoteUsers, agentUID]);
  useClientEvent(client, 'connection-state-change', (s) => setConnectionState(s));

  const clearConnectionIssues = useCallback(() => setConnectionIssues([]), []);

  // Suppress unused-read lint warnings — written by event handlers, used for side effects
  void getConversationIssueSeverity;
  void isAgentConnected;
  void connectionState;

  const handleMicToggle = useCallback(async () => {
    const next = !isEnabled;
    if (!localMicrophoneTrack) { setIsEnabled(next); return; }
    try { await localMicrophoneTrack.setEnabled(next); setIsEnabled(next); }
    catch (error) { console.error('Failed to toggle microphone:', error); }
  }, [isEnabled, localMicrophoneTrack]);

  const handleTokenWillExpire = useCallback(async () => {
    if (!onTokenWillExpire || !joinedUID) return;
    try {
      const { rtcToken, rtmToken } = await onTokenWillExpire(joinedUID.toString());
      await client?.renewToken(rtcToken);
      await rtmClient.renewToken(rtmToken);
    } catch (error) { console.error('Failed to renew Agora token:', error); }
  }, [client, onTokenWillExpire, joinedUID, rtmClient]);

  useClientEvent(client, 'token-privilege-will-expire', handleTokenWillExpire);

  // Language switching handler
  const handleLangChange = useCallback(
    async (newLang: string) => {
      if (!onChangeLanguage || newLang === currentLang || isLanguageSwitching) return;
      setIsLanguageSwitching(true);
      setCurrentLang(newLang); // optimistic update
      try {
        await onChangeLanguage(newLang);
      } catch (err) {
        console.error('[lang-switch]', err);
        setCurrentLang(selectedLanguage); // revert on failure
      } finally {
        setIsLanguageSwitching(false);
      }
    },
    [onChangeLanguage, currentLang, isLanguageSwitching, selectedLanguage],
  );

  const stateLabel = agentState ? (AGENT_STATE_LABEL[agentState] ?? 'Ready') : 'Connecting';
  const langLabel  = LANGUAGE_LABELS[currentLang] ?? currentLang;

  // Audio bar configs for center visualizer
  const AUDIO_BARS = [
    { h: 20, d: 0,   dur: 900 },
    { h: 34, d: 120, dur: 750 },
    { h: 46, d: 240, dur: 850 },
    { h: 28, d: 360, dur: 700 },
    { h: 42, d: 180, dur: 950 },
    { h: 24, d: 300, dur: 800 },
    { h: 38, d: 60,  dur: 720 },
  ];

  const centerStateText =
    agentState === 'listening' ? 'Valsea is listening...' :
    agentState === 'thinking'  ? 'Valsea is thinking...'  :
    agentState === 'speaking'  ? 'Valsea is speaking...'  :
    agentState                 ? 'Valsea is ready'        :
                                 'Connecting...';

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ backgroundColor: '#09061c', color: '#fff' }}>
      {/* Hidden remote users — keeps agent audio subscription alive */}
      {remoteUsers.map((user) => (
        <div key={user.uid} className="hidden"><RemoteUser user={user} /></div>
      ))}

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-6 py-3 shrink-0"
        style={{ borderBottom: '1px solid rgba(122,86,170,0.2)' }}
      >
        <div className="flex items-center gap-2">
          <Image
            src="/valsea-logo.png"
            alt="Valsea"
            width={32}
            height={32}
            className="rounded-lg shrink-0"
            priority
          />
          <span className="text-sm font-semibold tracking-tight">Voice Agent</span>
        </div>

        <div className="flex items-center gap-2">
          {isLanguageSwitching && (
            <span className="flex items-center gap-1.5 text-[11px]" style={{ color: '#B89AE3' }}>
              <Loader2 className="h-3 w-3 animate-spin" />
              Switching…
            </span>
          )}
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide"
            style={{
              border: '1px solid rgba(122,86,170,0.35)',
              backgroundColor: 'rgba(122,86,170,0.1)',
              color: '#B89AE3',
            }}
          >
            <span
              className="w-2 h-2 rounded-full bg-green-400"
              style={{ animation: 'pulse 2s ease-in-out infinite' }}
            />
            LIVE SESSION
          </div>
        </div>
      </header>

      {/* ── Three-column main ────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* Left: Analysis panels + selectors */}
        <div
          className="w-[450px] flex flex-col shrink-0 overflow-y-auto overflow-hidden"
          style={{ borderRight: '1px solid rgba(122,86,170,0.15)' }}
        >
          <div className="p-4 flex flex-col gap-3 flex-1">
            <AnalysisPanel
              prosody={prosody}
              sentiment={sentiment}
              isProsodyLoading={isProsodyLoading}
              isSentimentLoading={isSentimentLoading}
              isProsodyUnavailable={isProsodyUnavailable}
              isSentimentUnavailable={isSentimentUnavailable}
            />
          </div>

          {/* Language + Microphone selectors */}
          {/* <div
            className="p-4 flex flex-col gap-3 shrink-0"
            style={{ borderTop: '1px solid rgba(122,86,170,0.12)' }}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <span
                  className="text-[9px] tracking-[0.18em] uppercase font-medium"
                  style={{ color: 'rgba(255,255,255,0.28)' }}
                >
                  Language
                </span>
                {allowLanguageSwitching && onChangeLanguage ? (
                  <select
                    value={currentLang}
                    onChange={(e) => handleLangChange(e.target.value)}
                    disabled={isLanguageSwitching}
                    className="h-9 rounded-md px-2 text-xs transition-colors duration-200 appearance-none focus:outline-none focus:ring-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: 'rgba(122,86,170,0.1)',
                      border: '1px solid rgba(122,86,170,0.25)',
                      color: 'rgba(255,255,255,0.7)',
                      // @ts-expect-error focus-ring
                      '--tw-ring-color': '#7A56AA',
                    }}
                  >
                    {VALSEA_LANGUAGES.map((opt) => (
                      <option key={opt.code} value={opt.code} className="bg-[#120e28]">
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div
                    className="h-9 px-3 rounded-md flex items-center text-xs truncate"
                    style={{
                      backgroundColor: 'rgba(122,86,170,0.08)',
                      border: '1px solid rgba(122,86,170,0.18)',
                      color: 'rgba(255,255,255,0.55)',
                    }}
                  >
                    {langLabel}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <span
                  className="text-[9px] tracking-[0.18em] uppercase font-medium"
                  style={{ color: 'rgba(255,255,255,0.28)' }}
                >
                  Microphone
                </span>
                <div className="h-9 flex items-center">
                  <MicrophoneSelector localMicrophoneTrack={localMicrophoneTrack} />
                </div>
              </div>
            </div>
          </div> */}
        </div>

        {/* Center: Robot mascot + visualizer + status */}
        <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8 relative overflow-hidden">
          {/* Ambient purple glow */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'radial-gradient(circle, transparent 35%, rgba(9,6,28,0.75) 58%, #09061c 75%)',
            }}
          />

          {/* Robot image with edge vignette */}
          <div className="relative z-10" style={{ width: 220, height: 220 }}>
            <Image
              src="/valsea-robot2.png"
              alt="Valsea AI mascot"
              width={220}
              height={220}
              style={{ objectFit: 'contain', mixBlendMode: 'screen' }} 
              priority
            />
            {/* Radial fade to blend robot edges into dark background */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  'radial-gradient(circle, transparent 42%, rgba(9,6,28,0.65) 65%, #09061c 80%)',
              }}
            />
          </div>

          {/* Audio bars visualizer */}
          <div className="z-10 flex items-end gap-1.5" style={{ height: 50 }}>
            {AUDIO_BARS.map((bar, i) => (
              <div
                key={i}
                className="w-1.5 rounded-full"
                style={{
                  height: `${bar.h}px`,
                  backgroundColor: '#7A56AA',
                  transformOrigin: 'bottom',
                  animation: agentState
                    ? `audioBar ${bar.dur}ms ease-in-out ${bar.d}ms infinite`
                    : 'none',
                  opacity: agentState === 'listening' ? 0.85 : 0.3,
                  transform: agentState ? undefined : 'scaleY(0.35)',
                  transition: 'opacity 400ms ease',
                }}
              />
            ))}
          </div>

          {/* Status text */}
          <div className="z-10 text-center">
            <p className="text-xl font-semibold tracking-tight">{centerStateText}</p>
            <p className="text-sm mt-1.5" style={{ color: 'rgba(255,255,255,0.35)' }}>
              Processing real-time audio with low latency
            </p>
          </div>
        </div>

        {/* Right: Transcript */}
        <div
          className="w-[450px] flex flex-col shrink-0 overflow-hidden"
          style={{ borderLeft: '1px solid rgba(122,86,170,0.15)' }}
        >
          {/* Transcript header */}
          <div
            className="flex items-center justify-between px-4 py-3 shrink-0"
            style={{ borderBottom: '1px solid rgba(122,86,170,0.15)' }}
          >
            <span
              className="text-[11px] font-semibold tracking-[0.2em] uppercase"
              style={{ color: 'rgba(255,255,255,0.5)' }}
            >
              Transcript
            </span>
            <Clock className="w-3.5 h-3.5" style={{ color: 'rgba(255,255,255,0.22)' }} />
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="flex flex-col p-4 gap-4 min-h-full">
              <div className="flex-1" />

              {messageList.length === 0 && !currentInProgressMessage && (
                <div className="flex items-center justify-center py-12">
                  <p className="text-xs text-center" style={{ color: 'rgba(255,255,255,0.18)' }}>
                    Waiting for the conversation to begin…
                  </p>
                </div>
              )}

              {messageList.map((msg) => {
                const isAgent = String(msg.uid) === agentUID;
                const msgKey  = `${String(msg.uid)}-${msg.turn_id}`;
                if (!msgTimestampsRef.current.has(msgKey)) {
                  msgTimestampsRef.current.set(msgKey, Date.now());
                }
                const ts      = msgTimestampsRef.current.get(msgKey)!;
                const timeStr = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return (
                  <div key={msgKey} className={`flex flex-col gap-1.5 ${isAgent ? 'items-start' : 'items-end'}`}>
                    <div className={`flex items-center gap-2 ${isAgent ? '' : 'flex-row-reverse'}`}>
                      {isAgent ? (
                        <span
                          className="text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: '#7A56AA', color: '#fff' }}
                        >
                          VALSEA
                        </span>
                      ) : (
                        <span
                          className="text-[10px] font-medium tracking-wider"
                          style={{ color: 'rgba(255,255,255,0.35)' }}
                        >
                          USER
                        </span>
                      )}
                      <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.22)' }}>
                        {timeStr}
                      </span>
                    </div>
                    <div
                      className="max-w-[90%] px-3 py-2.5 text-sm leading-relaxed"
                      style={isAgent ? {
                        backgroundColor: 'rgba(59,11,148,0.2)',
                        border: '1px solid rgba(122,86,170,0.22)',
                        borderRadius: '0.75rem',
                        borderTopLeftRadius: '0.2rem',
                        color: 'rgba(255,255,255,0.85)',
                      } : {
                        backgroundColor: '#7A56AA',
                        borderRadius: '0.75rem',
                        borderTopRightRadius: '0.2rem',
                        color: '#fff',
                      }}
                    >
                      {msg.text}
                    </div>
                  </div>
                );
              })}

              {currentInProgressMessage && (
                <div className="flex flex-col items-start gap-1.5">
                  <span
                    className="text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: '#7A56AA', color: '#fff' }}
                  >
                    VALSEA AI
                  </span>
                  <div
                    className="px-3 py-2.5"
                    style={{
                      backgroundColor: 'rgba(59,11,148,0.2)',
                      border: '1px solid rgba(122,86,170,0.22)',
                      borderRadius: '0.75rem',
                      borderTopLeftRadius: '0.2rem',
                    }}
                  >
                    <div className="flex gap-1.5 items-center h-2">
                      {[0, 150, 300].map((delay) => (
                        <span
                          key={delay}
                          className="w-1.5 h-1.5 rounded-full animate-bounce"
                          style={{ backgroundColor: '#B89AE3', animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div ref={transcriptEndRef} />
            </div>
          </div>

          {/* Connection error cards */}
          {connectionIssues.length > 0 && (
            <div
              className="p-3 flex flex-col gap-2 shrink-0"
              style={{ borderTop: '1px solid rgba(122,86,170,0.12)' }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="text-[9px] tracking-[0.18em] uppercase font-medium"
                  style={{ color: 'rgba(255,255,255,0.28)' }}
                >
                  Agent Errors
                </span>
                <button
                  onClick={clearConnectionIssues}
                  className="text-[9px] transition-colors duration-200"
                  style={{ color: 'rgba(255,255,255,0.28)' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.55)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.28)'; }}
                >
                  Clear
                </button>
              </div>
              <div className="flex flex-col gap-1.5 max-h-28 overflow-y-auto">
                {connectionIssues.map((issue) => (
                  <ConversationErrorCard key={issue.id} issue={issue} />
                ))}
              </div>
            </div>
          )}

          {/* Real-time enrichment footer */}
          <div
            className="px-4 py-2.5 shrink-0 flex items-center gap-2"
            style={{
              borderTop: '1px solid rgba(122,86,170,0.15)',
              backgroundColor: 'rgba(122,86,170,0.06)',
            }}
          >
            <span style={{ color: '#7A56AA', fontSize: 12 }}>✦</span>
            <span
              className="text-[10px] tracking-[0.15em] uppercase font-medium"
              style={{ color: 'rgba(184,154,227,0.65)' }}
            >
              Real-Time Enrichment Active
            </span>
          </div>
        </div>
      </div>

      {/* ── Bottom control bar ────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-center gap-8 py-4 px-6 shrink-0"
        style={{ borderTop: '1px solid rgba(122,86,170,0.2)' }}
      >
        {/* Mute toggle */}
        <button
          onClick={handleMicToggle}
          className="flex flex-col items-center gap-1.5 transition-opacity duration-200"
          aria-label={isEnabled ? 'Mute microphone' : 'Unmute microphone'}
        >
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center transition-colors duration-200"
            style={{
              backgroundColor: isEnabled ? 'rgba(255,255,255,0.07)' : 'rgba(122,86,170,0.3)',
              border: `1px solid ${isEnabled ? 'rgba(255,255,255,0.12)' : 'rgba(122,86,170,0.5)'}`,
            }}
          >
            {isEnabled
              ? <Mic    className="w-5 h-5" style={{ color: 'rgba(255,255,255,0.65)' }} />
              : <MicOff className="w-5 h-5" style={{ color: '#B89AE3' }} />
            }
          </div>
          <span
            className="text-[10px] tracking-[0.15em] uppercase font-medium"
            style={{ color: 'rgba(255,255,255,0.38)' }}
          >
            {isEnabled ? 'Mute' : 'Unmute'}
          </span>
        </button>

        {/* End session */}
        <button
          onClick={onEndConversation}
          className="flex items-center gap-2.5 px-8 py-3 ml-4 mb-2 rounded-full text-white font-semibold text-sm transition-colors duration-200"
          style={{ backgroundColor: '#dc2626' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#b91c1c'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#dc2626'; }}
          aria-label="End conversation"
        >
          <PhoneOff className="w-4 h-4" />
          End Session
        </button>

        {/* Microphone selector */}
        <button
          className="flex flex-col items-center gap-1.5"
          aria-label="Microphone selector"
        >
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center"
            style={{
              backgroundColor: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            <MicrophoneSelector localMicrophoneTrack={localMicrophoneTrack} />
          </div>
          <span
            className="text-[10px] tracking-[0.15em] uppercase font-medium"
            style={{ color: 'rgba(255,255,255,0.38)' }}
          >
            Microphone
          </span>
        </button>
      </div>
    </div>
  );
}
