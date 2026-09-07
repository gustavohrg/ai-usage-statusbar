export interface UsageWindow {
  label: string;
  modelGroup?: string;
  utilization: number;
  resetsAt: string;
  kind: 'fiveHour' | 'sevenDay' | 'other';
  usageKnown?: boolean;
}

export interface UsageResult {
  utilization: number;
  resetsAt: string;
}

export interface AgentUsage {
  fiveHour: UsageResult | null;
  sevenDay: UsageResult | null;
  windows?: UsageWindow[];
  error?: string;
  displayHint?: string;
  raw?: {
    usedPercent: number;
    remaining: number;
    limit: number;
    reset: number;
  };
  meta?: {
    segmentSuffix?: string;
    tooltipNotes?: string[];
    primaryLabel?: string;
    hideReset?: boolean;
    compactTooltip?: boolean;
  };
}

export interface CopilotUsageOptions {
  lookbackDays: number;
  includedCredits: number;
  autoModel?: string;
  windowMode?: 'lookbackDays' | 'currentMonth';
}
