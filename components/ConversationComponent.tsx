'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Mic, Square } from 'lucide-react';
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
import { MicButtonWithVisualizer } from 'agora-agent-uikit/rtc';
import { DEFAULT_AGENT_UID } from '@/lib/agora';
import {
  getCurrentInProgressMessage,
  getMessageList,
  normalizeTimestampMs,
  normalizeTranscript,
} from '@/lib/conversation';
import { MicrophoneSelector } from './MicrophoneSelector';
import {
  getConversationIssueSeverity,
  type ConnectionIssue,
} from './ConversationErrorCard';
import { AnalysisPanel, type ProsodyData, type SentimentData } from './AnalysisPanel';
import type { ConversationComponentProps } from '@/types/conversation';

const MAX_CONNECTION_ISSUES = 6;

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English', vi: 'Vietnamese', zh: 'Chinese (中文)', ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)', fr: 'French', es: 'Spanish', id: 'Indonesian',
  ms: 'Malay', th: 'Thai', tl: 'Filipino', ta: 'Tamil', my: 'Burmese',
  km: 'Khmer', 'sg-en': 'Singlish', hi: 'Hindi', pa: 'Punjabi',
  bn: 'Bengali', te: 'Telugu', mr: 'Marathi', kn: 'Kannada',
};

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
  listening: 'Listening…',
  thinking:  'Thinking…',
  speaking:  'Speaking…',
  idle:      'Ready',
  silent:    'Ready',
};

export default function ConversationComponent({
  agoraData,
  rtmClient,
  onTokenWillExpire,
  onEndConversation,
  selectedLanguage = 'en',
}: ConversationComponentProps) {
  const client      = useRTCClient();
  const remoteUsers = useRemoteUsers();
  const [isEnabled, setIsEnabled]             = useState(true);
  const [isAgentConnected, setIsAgentConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<string>('CONNECTING');
  const agentUID = process.env.NEXT_PUBLIC_AGENT_UID ?? String(DEFAULT_AGENT_UID);
  const [joinedUID, setJoinedUID] = useState<UID>(0);

  const [rawTranscript, setRawTranscript] = useState<
    TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>[]
  >([]);
  const [agentState, setAgentState]           = useState<AgentState | null>(null);
  const [connectionIssues, setConnectionIssues] = useState<ConnectionIssue[]>([]);

  // Valsea analysis state
  const [prosody, setProsody]                   = useState<ProsodyData | null>(null);
  const [sentiment, setSentiment]               = useState<SentimentData | null>(null);
  const [isProsodyLoading, setIsProsodyLoading]     = useState(false);
  const [isSentimentLoading, setIsSentimentLoading] = useState(false);
  const prevUserMsgCountRef = useRef(0);

  // UI-only refs
  const msgTimestampsRef  = useRef<Map<string, number>>(new Map());
  const transcriptEndRef  = useRef<HTMLDivElement>(null);

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

  // Auto-scroll transcript to bottom
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messageList, currentInProgressMessage]);

  // ─── Prosody: restart-cycle recording ────────────────────────────────────
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
        if (!submitRes.ok) return;
        const { job_id } = await submitRes.json();
        if (!job_id) return;
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (!active) return;
          const pollRes = await fetch(`/api/valsea/prosody/${job_id}`);
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

  // ─── Sentiment: run on full accumulated user transcript ──────────────────
  useEffect(() => {
    const userMessages = messageList.filter((m) => String(m.uid) !== agentUID && m.text);
    if (userMessages.length <= prevUserMsgCountRef.current) return;
    prevUserMsgCountRef.current = userMessages.length;
    const fullTranscript = userMessages.map((m) => m.text).join(' ').trim();
    if (!fullTranscript) return;
    setIsSentimentLoading(true);
    fetch('/api/valsea/sentiment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: fullTranscript }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.sentiment) setSentiment(data as SentimentData); })
      .catch((err) => console.error('[Sentiment]', err))
      .finally(() => setIsSentimentLoading(false));
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

  // Suppress unused-read warnings — state is still written to by event handlers
  void getConversationIssueSeverity;
  void connectionIssues;
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

  const stateLabel = agentState ? (AGENT_STATE_LABEL[agentState] ?? 'Ready') : 'Connecting…';
  const langLabel  = LANGUAGE_LABELS[selectedLanguage] ?? selectedLanguage;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-[#080808] text-white overflow-hidden">
      {/* Hidden remote users — keeps agent audio subscription alive */}
      {remoteUsers.map((user) => (
        <div key={user.uid} className="hidden"><RemoteUser user={user} /></div>
      ))}

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-red-600 flex items-center justify-center font-bold text-white text-sm select-none">
            C
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">CocaCola CX</p>
            <p className="text-[10px] text-white/40 tracking-widest uppercase leading-tight">Voice Agent</p>
          </div>
        </div>
        <button
          onClick={onEndConversation}
          className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-red-500/40 bg-red-500/10 text-red-400 text-xs font-medium hover:bg-red-500/20 transition-colors"
          aria-label="End conversation"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          Connected
        </button>
      </header>

      {/* ── Two-panel main ────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* Left: Transcript */}
        <div className="flex-1 flex flex-col overflow-hidden p-5 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 shrink-0">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-sm font-semibold">Conversation</span>
          </div>
          <p className="text-[10px] text-white/30 tracking-widest uppercase mb-4 shrink-0">
            Live Transcript
          </p>

          <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
            {/* Spacer pushes messages to the bottom — standard chat UX */}
            <div className="flex-1" />
            <div className="flex flex-col gap-3 pr-1">
              {messageList.length === 0 && !currentInProgressMessage && (
                <div className="flex items-center justify-center py-12">
                  <p className="text-xs text-white/20 text-center">Waiting for Maya to speak…</p>
                </div>
              )}
              {messageList.map((msg) => {
                const isAgent = String(msg.uid) === agentUID;
                if (!msgTimestampsRef.current.has(msg.turn_id)) {
                  msgTimestampsRef.current.set(msg.turn_id, Date.now());
                }
                const ts      = msgTimestampsRef.current.get(msg.turn_id)!;
                const timeStr = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return (
                  <div key={msg.turn_id} className={`flex flex-col gap-0.5 ${isAgent ? 'items-start' : 'items-end'}`}>
                    <div
                      className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                        isAgent
                          ? 'bg-white/10 text-white/90 rounded-tl-sm'
                          : 'bg-red-600 text-white rounded-tr-sm'
                      }`}
                    >
                      {msg.text}
                    </div>
                    <span className="text-[10px] text-white/25 px-1">{timeStr}</span>
                  </div>
                );
              })}

              {currentInProgressMessage && (
                <div className="flex flex-col items-start gap-0.5">
                  <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-white/10">
                    <div className="flex gap-1.5 items-center h-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Red vertical divider */}
        <div className="w-px bg-red-600/50 self-stretch shrink-0" />

        {/* Right: Controls */}
        <div className="w-64 sm:w-72 flex flex-col shrink-0 overflow-y-auto">

          {/* Mic / visualizer area */}
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-8 flex-1 min-h-[260px]">
            {/* Large pulsing mic circle */}
            <button
              onClick={handleMicToggle}
              className={`w-28 h-28 rounded-full flex items-center justify-center transition-all duration-300 focus:outline-none active:scale-95 ${
                isEnabled
                  ? 'bg-red-600 shadow-[0_0_48px_rgba(220,38,38,0.45)] hover:shadow-[0_0_64px_rgba(220,38,38,0.6)]'
                  : 'bg-white/10 hover:bg-white/15'
              }`}
              aria-label={isEnabled ? 'Mute microphone' : 'Unmute microphone'}
            >
              <Mic className={`w-10 h-10 ${isEnabled ? 'text-white' : 'text-white/40'}`} />
            </button>

            {/* Status */}
            <div className="flex flex-col items-center gap-0.5">
              <p className="text-xs font-semibold tracking-widest uppercase text-white/70">
                {stateLabel}
              </p>
              <p className="text-xs text-white/30">{langLabel}</p>
            </div>

            {/* Small controls row */}
            <div className="flex items-center gap-3">
              <div className="conversation-mic-host flex items-center justify-center">
                <MicButtonWithVisualizer
                  isEnabled={isEnabled}
                  setIsEnabled={setIsEnabled}
                  track={localMicrophoneTrack}
                  onToggle={handleMicToggle}
                  className="overflow-visible"
                  aria-label={isEnabled ? 'Mute microphone' : 'Unmute microphone'}
                  enabledColor="hsl(var(--primary))"
                  disabledColor="hsl(var(--destructive))"
                />
              </div>
              <button
                onClick={onEndConversation}
                className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center hover:bg-white/10 transition-colors"
                aria-label="Stop conversation"
              >
                <Square className="w-4 h-4 text-red-400" />
              </button>
            </div>
          </div>

          {/* Language / Microphone / Model info */}
          <div className="border-t border-white/5 p-4 flex flex-col gap-3 shrink-0">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[9px] text-white/30 tracking-widest uppercase">Language</span>
                <div className="h-9 px-3 rounded-md bg-white/5 border border-white/10 flex items-center text-xs text-white/60 truncate">
                  {langLabel}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[9px] text-white/30 tracking-widest uppercase">Microphone</span>
                <div className="h-9 flex items-center">
                  <MicrophoneSelector localMicrophoneTrack={localMicrophoneTrack} />
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] text-white/30 tracking-widest uppercase">Model</span>
              <div className="h-9 px-3 rounded-md bg-white/5 border border-white/10 flex items-center text-xs text-white/60 truncate">
                MiniMax Speech 2.8 Turbo
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Valsea analysis panels ────────────────────────────────────────── */}
      <div className="border-t border-white/5 p-4 shrink-0 max-h-52 overflow-y-auto">
        <AnalysisPanel
          prosody={prosody}
          sentiment={sentiment}
          isProsodyLoading={isProsodyLoading}
          isSentimentLoading={isSentimentLoading}
        />
      </div>
    </div>
  );
}
