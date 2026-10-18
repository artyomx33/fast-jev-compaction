export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages (or recent human turns); never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped';
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
  /** First `truncateHeadChars` characters of the output, whitespace collapsed, when the budget allows. */
  result_head?: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results reduced to a note and a head. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 30000. */
  maxRequestTokens?: number;
  /** Characters of a tool result shown to Jev as `result_head` and retained when the result is dropped. Default 300. */
  truncateHeadChars?: number;
  /** Quantity guard: refuse when more than this share of candidates would go. Default 1 (off). */
  maxDropRatio?: number;
  /** Wording of the two noul questions. Default 'default'. */
  questionStyle?: QuestionStyle;
  /**
   * Also pin everything from the N-th most recent human turn (a user message
   * with text and no tool_result) to the end: assistant texts, tool calls and
   * their results stay verbatim. Combined with `preserveRecentMessages`; the
   * wider window wins. Default 0 (off); the Claude Code hook defaults to 10.
   */
  preserveRecentHumanTurns?: number;
  /**
   * What a dropped call or result leaves behind. 'digest' (default): 1-3 lines
   * (tool, input head, outcome, size, agent id, key result lines, ledger key);
   * 'line': a one-line stub; 'none': nothing (a dropped call vanishes, a
   * dropped result keeps its truncated head), the upstream behaviour.
   */
  stubMode?: StubMode;
  /** Session id the ledger keys are derived from; '' when absent. */
  sessionId?: string;
  /** Timestamp stored in each ledger entry; defaults to now (ISO). */
  ledgerTs?: string;
}

/** See `CompactOptions.stubMode`. */
export type StubMode = 'none' | 'line' | 'digest';

/**
 * One dropped call's full output, for the per-session ledger
 * (`<ledgerDir>/<sessionId>.jsonl`, one JSON object per line). The stub or
 * digest in the compacted history carries `ledger:<key>`.
 */
export interface LedgerEntry {
  key: string;
  ts: string;
  session: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** The full result text, as it was before compaction. */
  result: string;
  isError: boolean;
}

/**
 * 'default' asks whether an item still matters for what the assistant does
 * next; 'evidence' asks whether it is needed to trust or reproduce a later
 * claim.
 */
export type QuestionStyle = 'default' | 'evidence';

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  maxDropRatio: number;
  questionStyle: QuestionStyle;
  preserveRecentHumanTurns: number;
  stubMode: StubMode;
  sessionId: string;
  ledgerTs: string;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  /**
   * False when the guard refused: `messages` is then the input, unchanged, and
   * the caller must not treat it as a compaction.
   */
  compacted: boolean;
  /** Set when the max-drop guard refused the compaction. */
  guard?: 'max_drop';
  /**
   * Full outputs of the calls whose output the compacted history no longer
   * holds verbatim, for the caller to append to the ledger. Empty when
   * `stubMode` is 'none' or the compaction was refused.
   */
  ledger: LedgerEntry[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    requests: number;
    ms: number;
    /** Dropped calls replaced by a stub ('line') or a digest ('digest'). */
    stubs: number;
    /** Dropped results replaced by a digest ('digest' mode). */
    digests: number;
    /** Human turns inside the pinned recent window, and the message index it starts at. */
    humanTurnsPinned: number;
    pinnedFromIndex: number;
  };
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}
