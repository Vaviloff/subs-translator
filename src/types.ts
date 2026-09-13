export interface Cue {
  index: number;
  timing: string;
  lines: string[];
  position: string | null;
}

export interface ParsedSubs {
  cues: Cue[];
  eol: string;
}

export interface TokenUsage {
  in: number;
  out: number;
}

export interface ProgressEntry {
  i: number;
  h: string;
  ru: string;
  src?: string;
  tokens?: TokenUsage;
  model?: string;
  at?: string;
}

export interface CompletionClient {
  chat: { completions: { create(body: unknown): Promise<unknown> } };
}

export interface CompletionLike {
  choices?: { message?: { content?: string | null } }[] | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export interface PoolEntry {
  name: string;
  baseUrl?: string;
  apiKey?: string | null;
  model: string;
  extraBody?: Record<string, unknown> | null;
  client: CompletionClient;
  dead: boolean;
  failures: number;
}

export interface PoolInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  model: string;
  extraBody?: Record<string, unknown> | null;
  client?: CompletionClient;
}

export interface Pool {
  endpoints: PoolEntry[];
  next(): PoolEntry | null;
  disable(name: string): void;
  aliveCount(): number;
}

export interface EndpointConfig {
  name: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  extraBody: Record<string, unknown> | null;
}

export interface PrevEntry {
  index: number;
  src: string;
  ru: string;
}

export interface NextEntry {
  index: number;
  src: string;
}

export type TranslateFn = (req: { cue: Cue; user: string; source: string }) => Promise<{
  text: string;
  usage?: TokenUsage;
  endpoint?: string;
  model?: string;
}>;
