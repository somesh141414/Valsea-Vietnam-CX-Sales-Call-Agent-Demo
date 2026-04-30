'use client';

import { BarChart2, Waves } from 'lucide-react';

export type ProsodyData = {
  frustration: number;
  stress: number;
  politeness: number;
  hesitation: number;
  urgency: number;
};

export type SentimentData = {
  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;
  reasoning?: string;
  emotions?: string[];
};

interface AnalysisPanelProps {
  prosody: ProsodyData | null;
  sentiment: SentimentData | null;
  isProsodyLoading: boolean;
  isSentimentLoading: boolean;
  isProsodyUnavailable?: boolean;
  isSentimentUnavailable?: boolean;
}

const PROSODY_METRICS: { key: keyof ProsodyData; color: string }[] = [
  { key: 'frustration', color: '#ef4444' },
  { key: 'stress',      color: '#f97316' },
  { key: 'politeness',  color: '#4ade80' },
  { key: 'hesitation',  color: '#a78bfa' },
  { key: 'urgency',     color: '#22d3ee' },
];

const SENTIMENT_STYLE: Record<string, { badge: string; dot: string }> = {
  positive: { badge: 'text-green-400 border-green-400/40 bg-green-400/10',  dot: '#4ade80' },
  neutral:  { badge: 'text-yellow-400 border-yellow-400/40 bg-yellow-400/10', dot: '#facc15' },
  negative: { badge: 'text-red-400 border-red-400/40 bg-red-400/10',        dot: '#f87171' },
};

function PanelShell({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3"
      style={{
        backgroundColor: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(122,86,170,0.22)',
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold tracking-tight" style={{ color: 'rgba(255,255,255,0.9)' }}>
          {title}
        </span>
        <span style={{ color: 'rgba(184,154,227,0.45)' }}>{icon}</span>
      </div>
      {children}
    </div>
  );
}

function MetricLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-[9px] font-medium tracking-[0.18em] uppercase"
      style={{ color: 'rgba(255,255,255,0.38)' }}
    >
      {children}
    </span>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-16 text-xs" style={{ color: 'rgba(255,255,255,0.25)' }}>
      {label}
    </div>
  );
}

export function AnalysisPanel({
  prosody,
  sentiment,
  isProsodyLoading,
  isSentimentLoading,
  isProsodyUnavailable,
  isSentimentUnavailable,
}: AnalysisPanelProps) {
  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Sentiment */}
      <PanelShell title="Sentiment" icon={<BarChart2 className="w-4 h-4" />}>
        {isSentimentUnavailable ? (
          <EmptyState label="Credits required to enable" />
        ) : isSentimentLoading && !sentiment ? (
          <EmptyState label="Analyzing…" />
        ) : sentiment ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span
                className={`text-xs font-bold uppercase px-3 py-1 rounded-full border ${SENTIMENT_STYLE[sentiment.sentiment]?.badge ?? ''}`}
              >
                {sentiment.sentiment}
              </span>
              <div className="flex flex-col">
                <MetricLabel>Confidence</MetricLabel>
                <span className="text-sm font-semibold tabular-nums" style={{ color: 'rgba(255,255,255,0.85)' }}>
                  {Math.round(sentiment.confidence * 100)}%
                </span>
              </div>
            </div>
            {sentiment.reasoning && (
              <p className="text-xs leading-relaxed line-clamp-3" style={{ color: 'rgba(255,255,255,0.45)' }}>
                {sentiment.reasoning}
              </p>
            )}
            {sentiment.emotions && sentiment.emotions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {sentiment.emotions.slice(0, 5).map((e) => (
                  <span
                    key={e}
                    className="text-[10px] px-2 py-0.5 rounded-full"
                    style={{
                      backgroundColor: 'rgba(122,86,170,0.18)',
                      border: '1px solid rgba(122,86,170,0.3)',
                      color: 'rgba(184,154,227,0.8)',
                    }}
                  >
                    {e}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <EmptyState label="Waiting for speech…" />
        )}
      </PanelShell>

      {/* Prosody */}
      <PanelShell title="Prosody" icon={<Waves className="w-4 h-4" />}>
        {isProsodyUnavailable ? (
          <EmptyState label="Credits required to enable" />
        ) : isProsodyLoading && !prosody ? (
          <EmptyState label="Analyzing audio…" />
        ) : prosody ? (
          <div className="flex flex-col gap-2.5">
            {PROSODY_METRICS.map(({ key, color }) => (
              <div key={key} className="flex items-center gap-3">
                <MetricLabel>{key}</MetricLabel>
                <div
                  className="flex-1 h-2 rounded-full overflow-hidden"
                  style={{ backgroundColor: 'rgba(255,255,255,0.07)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${Math.round(prosody[key] * 100)}%`, backgroundColor: color }}
                  />
                </div>
                <span
                  className="text-xs font-semibold tabular-nums w-8 text-right"
                  style={{ color: 'rgba(255,255,255,0.7)' }}
                >
                  {Math.round(prosody[key] * 100)}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label="Waiting for speech…" />
        )}
      </PanelShell>
    </div>
  );
}
