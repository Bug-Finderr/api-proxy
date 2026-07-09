export declare const FAKE: {
  openai: string;
  anthropic: string;
  gemini: string;
};
export declare const ADMIN_SECRET: string;

export interface Captured {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockUpstream {
  url: string;
  last(): Captured | null;
  reset(): void;
  close(): Promise<void>;
}

export declare function startMockUpstream(): Promise<MockUpstream>;
export declare function seedToken(
  url: string,
  opts: { token: string; providers: string[]; label?: string },
): Promise<void>;
