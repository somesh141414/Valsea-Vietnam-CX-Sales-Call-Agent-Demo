'use client';

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
  { key: 'frustration', color: 'bg-red-500' },
  { key: 'stress',      color: 'bg-orange-400' },
  { key: 'politeness',  color: 'bg-green-400' },
  { key: 'hesitation',  color: 'bg-purple-400' },
  { key: 'urgency',     color: 'bg-cyan-400' },
];

const SENTIMENT_STYLE: Record<string, string> = {
  positive: 'text-green-400 border-green-400/40 bg-green-400/10',
  neutral:  'text-yellow-400 border-yellow-400/40 bg-yellow-400/10',
  negative: 'text-red-400 border-red-400/40 bg-red-400/10',
};

function ValseaBadge() {
  return (
    <span className="text-[10px] font-semibold tracking-widest px-2 py-0.5 rounded-full border border-cyan-400/40 text-cyan-400 bg-cyan-400/10 uppercase">
      Valsea
    </span>
  );
}

function PanelShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 backdrop-blur-sm p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground">
          {title}
        </span>
        <ValseaBadge />
      </div>
      {children}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-20 text-xs text-muted-foreground/60">
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
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
      {/* Prosody */}
      <PanelShell title="Prosody Analysis">
        {isProsodyUnavailable ? (
          <EmptyState label="Credits required — top up your Valsea account to enable analysis" />
        ) : isProsodyLoading && !prosody ? (
          <EmptyState label="Analyzing audio — first result in ~5 s…" />
        ) : prosody ? (
          <div className="flex flex-col gap-2.5">
            {PROSODY_METRICS.map(({ key, color }) => (
              <div key={key} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground capitalize w-20 shrink-0">
                  {key}
                </span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${color}`}
                    style={{ width: `${Math.round(prosody[key] * 100)}%` }}
                  />
                </div>
                <span className="text-xs font-medium tabular-nums w-8 text-right">
                  {Math.round(prosody[key] * 100)}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label="Waiting for speech…" />
        )}
      </PanelShell>

      {/* Sentiment */}
      <PanelShell title="Sentiment">
        {isSentimentUnavailable ? (
          <EmptyState label="Credits required — top up your Valsea account to enable analysis" />
        ) : isSentimentLoading && !sentiment ? (
          <EmptyState label="Analyzing…" />
        ) : sentiment ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span
                className={`text-xs font-bold uppercase px-3 py-1 rounded-full border ${SENTIMENT_STYLE[sentiment.sentiment] ?? ''}`}
              >
                {sentiment.sentiment}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(sentiment.confidence * 100)}% confidence
              </span>
            </div>
            {sentiment.reasoning && (
              <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
                {sentiment.reasoning}
              </p>
            )}
            {sentiment.emotions && sentiment.emotions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {sentiment.emotions.slice(0, 6).map((e) => (
                  <span
                    key={e}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
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
    </div>
  );
}
