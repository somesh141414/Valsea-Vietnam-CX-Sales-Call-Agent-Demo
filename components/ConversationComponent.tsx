'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
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
import { AgentVisualizer } from 'agora-agent-uikit';
import { MicButtonWithVisualizer } from 'agora-agent-uikit/rtc';
import { Button } from '@/components/ui/button';
import { DEFAULT_AGENT_UID } from '@/lib/agora';
import {
  getCurrentInProgressMessage,
  getMessageList,
  mapAgentVisualizerState,
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
  listening:   'Listening…',
  thinking:    'Thinking…',
  speaking:    'Speaking…',
  idle:        'Ready',
  silent:      'Ready',
};

export default function ConversationComponent({
  agoraData,
  rtmClient,
  onTokenWillExpire,
  onEndConversation,
}: ConversationComponentProps) {
  const client       = useRTCClient();
  const remoteUsers  = useRemoteUsers();
  const [isEnabled, setIsEnabled]               = useState(true);
  const [isAgentConnected, setIsAgentConnected] = useState(false);
  const [connectionState, setConnectionState]   = useState<string>('CONNECTING');
  const agentUID = process.env.NEXT_PUBLIC_AGENT_UID ?? String(DEFAULT_AGENT_UID);
  const [joinedUID, setJoinedUID] = useState<UID>(0);

  const [rawTranscript, setRawTranscript] = useState<
    TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>[]
  >([]);
  const [agentState, setAgentState]         = useState<AgentState | null>(null);
  const [connectionIssues, setConnectionIssues] = useState<ConnectionIssue[]>([]);

  // Valsea analysis state
  const [prosody, setProsody]                 = useState<ProsodyData | null>(null);
  const [sentiment, setSentiment]             = useState<SentimentData | null>(null);
  const [isProsodyLoading, setIsProsodyLoading]   = useState(false);
  const [isSentimentLoading, setIsSentimentLoading] = useState(false);
  const prevUserMsgCountRef = useRef(0);

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

  const transcript = useMemo(() => normalizeTranscript(rawTranscript, client?.uid != null ? String(client.uid) : ''), [rawTranscript, client?.uid]);
  const messageList = useMemo(() => getMessageList(transcript), [transcript]);
  const currentInProgressMessage = useMemo(() => getCurrentInProgressMessage(transcript), [transcript]);

  // ─── Prosody: restart-cycle recording ─────────────────────────────────────
  // Each 8-second cycle creates a fresh MediaRecorder so every submitted blob
  // starts with a valid WebM header. Timeslice recording only embeds the header
  // in the first chunk; stitching later chunks produces undecodable files.
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
          // Handle both { emotions: {...} } and flat { frustration: 0.x } shapes
          const emotions: ProsodyData | null =
            data.emotions ?? ('frustration' in data ? data : null);
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
      try {
        rec = new MediaRecorder(stream, { mimeType });
      } catch {
        return; // browser may not support the mimeType
      }
      currentRecorder = rec;

      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        if (!active || chunks.length === 0) { if (active) runCycle(); return; }
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size >= 1000) await submitProsody(blob);
        if (active) runCycle(); // kick off next 8-second window
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

  // ─── Sentiment: run on full accumulated user transcript ────────────────────
  // Concatenate ALL completed user turns so the model has full conversational
  // context, not just the most recent sentence.
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

  // Suppress unused warning — wired to future panel
  void getConversationIssueSeverity;
  void connectionIssues;

  const visualizerState = useMemo(
    () => mapAgentVisualizerState(agentState, isAgentConnected, connectionState),
    [agentState, isAgentConnected, connectionState],
  );

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

  // Recent messages for the inline transcript (last 6 turns, no floating uikit widget)
  const recentMessages = useMemo(() => messageList.slice(-6), [messageList]);

  return (
    <div className="relative flex flex-col w-full gap-3 px-2 pt-2 pb-4">
      {/* ── End button ──────────────────────────────────────────────────── */}
      <div className="absolute top-0 right-0 z-10">
        <Button
          variant="destructive"
          size="icon"
          className="h-9 w-9 rounded-full border-2 border-destructive bg-destructive text-destructive-foreground hover:bg-transparent hover:text-destructive"
          onClick={onEndConversation}
          aria-label="End conversation"
        >
          <X />
        </Button>
      </div>

      {/* ── Agent visualizer ────────────────────────────────────────────── */}
      <div
        className="relative h-52 w-full flex flex-col items-center justify-center gap-2"
        role="region"
        aria-label="AI agent status"
      >
        <AgentVisualizer state={visualizerState} size="lg" />
        <span className="text-xs text-muted-foreground tracking-wide">
          {agentState ? (AGENT_STATE_LABEL[agentState] ?? 'Ready') : 'Connecting…'}
        </span>
        {/* Hidden RemoteUser mounts keep agent audio subscription alive */}
        {remoteUsers.map((user) => (
          <div key={user.uid} className="hidden"><RemoteUser user={user} /></div>
        ))}
      </div>

      {/* ── Mic controls ────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-center gap-3 bg-card/80 backdrop-blur-md border border-border rounded-full px-4 py-2 self-center"
        role="group"
        aria-label="Audio controls"
      >
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
        <MicrophoneSelector localMicrophoneTrack={localMicrophoneTrack} />
      </div>

      {/* ── Inline transcript ───────────────────────────────────────────── */}
      {(recentMessages.length > 0 || currentInProgressMessage) && (
        <div className="flex flex-col gap-2 max-h-44 overflow-y-auto px-1">
          {recentMessages.map((msg) => {
            const isAgent = String(msg.uid) === agentUID;
            return (
              <div key={msg.turn_id} className={`flex ${isAgent ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-2xl text-xs leading-relaxed ${
                    isAgent
                      ? 'bg-muted text-muted-foreground rounded-tl-sm'
                      : 'bg-primary text-primary-foreground rounded-tr-sm'
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            );
          })}
          {currentInProgressMessage && (
            <div className="flex justify-start">
              <div className="max-w-[80%] px-3 py-2 rounded-2xl rounded-tl-sm bg-muted text-muted-foreground text-xs leading-relaxed opacity-70 italic">
                {currentInProgressMessage.text || '…'}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Valsea analysis panels ──────────────────────────────────────── */}
      <AnalysisPanel
        prosody={prosody}
        sentiment={sentiment}
        isProsodyLoading={isProsodyLoading}
        isSentimentLoading={isSentimentLoading}
      />
    </div>
  );
}
