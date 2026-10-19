// Types for hawkes-analytics.js (window.hawkesAnalytics) and hawkes-analytics.mjs. Contract: docs/analytics.md in Hawkes Gen.

export type Plain = string | number | boolean | null | undefined;
export type Props = Record<string, unknown>;

export interface HawkesBuild {
  version?: string;
  commit?: string;
  date?: string;
}

export interface HawkesAnalyticsInit {
  /** The product id in Gen's analytics/products.json ("sickofit", "phorigins"…). Nothing is sent without one. */
  product?: string;
  /** Default https://gen.hawkesgen.com/v1/analytics/collect. */
  endpoint?: string;
  /** A version string or { version, commit, date }. window.HAWKES_BUILD wins when the page sets it. */
  build?: string | HawkesBuild;
  /** Log every event to the console and keep it on hawkesAnalytics.debugLog (also ?hawkes-analytics-debug=1). */
  debug?: boolean;
  /** Context to start with (merged into every event). */
  context?: Record<string, Plain>;
}

export interface HawkesAskTheme {
  background?: string;
  color?: string;
  accent?: string;
  font?: string;
  radius?: string;
}

export interface HawkesAsk {
  /** Shown at most once per session, and not for 7 days after the player dismisses it. */
  id: string;
  question: string;
  /** What is being rated ("level 2", "the ending"). */
  context?: string;
  kind?: 'thumbs' | 'stars';
  /** Offer a comment box after the rating. */
  comment?: boolean;
  placeholder?: string;
  thanks?: string;
  theme?: HawkesAskTheme;
}

export interface HawkesFeedback {
  rating?: 'up' | 'down' | 1 | 2 | 3 | 4 | 5;
  text?: string;
  context?: string;
}

export interface HawkesAnalyticsEvent {
  name: string;
  seq: number;
  t: number;
  active: number;
  page: string;
  screen?: string;
  ctx: Record<string, Plain>;
  props?: Props;
  /** Debug mode: when its batch went out. */
  sent?: number;
}

export interface HawkesAnalytics {
  readonly version: number;
  /** Debug mode only: every event made, in order. */
  readonly debugLog: HawkesAnalyticsEvent[];
  init(options: HawkesAnalyticsInit): void;
  config(): { product: string | null; endpoint: string; build?: HawkesBuild; debug: boolean; env: 'live' | 'beta' | 'preview' | 'local'; anon: string; session?: string; optedOut: boolean; flags: { webdriver: boolean; playtest: boolean; internal: boolean } };
  /** A custom event: name ^[a-z][a-z0-9_]{1,39}$. Prefer a standard one (feature) when it fits. */
  track(name: string, props?: Props): void;
  screen(name: string): void;
  /** Merged into every event; a null value removes the key. */
  setContext(ctx: Record<string, Plain>): void;
  /** game_load_start: the game starts loading. */
  loadStart(): void;
  /** game_ready: the player can play (sends ms since loadStart(), else since navigation). */
  ready(props?: Props): void;
  levelStart(level: string | number, props?: Props): void;
  levelEnd(level: string | number, result: 'complete' | 'death' | 'quit' | 'restart', props?: Props): void;
  death(cause: string, props?: Props): void;
  choice(node: string, option: string, props?: Props): void;
  feature(name: string, props?: Props): void;
  video(id: string, action: 'play' | 'complete' | 'skip', at?: number, props?: Props): void;
  feedback(feedback: HawkesFeedback): void;
  error(error: unknown, source?: string, props?: Props): void;
  /** The feedback card. Resolves with what the player said, or null (dismissed, or not shown). */
  ask(options: HawkesAsk): Promise<(HawkesFeedback & { id: string }) | null>;
  optOut(): void;
  optIn(): void;
  /** Mark this browser as J's own (also ?hawkes-internal=1; ?hawkes-internal=0 clears it). */
  internal(on?: boolean): void;
  flush(): void;
}

declare global {
  interface Window {
    hawkesAnalytics: HawkesAnalytics;
    HAWKES_BUILD?: HawkesBuild;
    /** Calls made before the SDK loaded: [method, ...args]. */
    hawkesAnalyticsQ?: unknown[][];
  }
  var hawkesAnalytics: HawkesAnalytics;
}
