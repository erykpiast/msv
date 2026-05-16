// Shared shape definitions for the inspector view.
// The JS loader/view-builder consumes these via JSDoc `@typedef import`;
// the React SPA consumes them via `import type`.

export type Persona = {
  id: string;
  name: string;
  tradition?: string;
  stance?: string;
  description?: string;
};

export type SubQ = {
  id: string;
  question: string;
  rationale: string;
  assigned_pair: [string, string];
  pair_distinctness_score?: number;
};

export type MoveType = 'Claim' | 'Support' | 'Rebut' | 'Question' | 'Concede';

export type Move = {
  move_id: string;
  by_persona_id: string;
  type: MoveType;
  content: string;
  evidence_basis?: string;
  confidence: number;
  references_move_id: string | null;
  timestamp?: string;
  attempt?: number | null;
  synthesized?: boolean;
  usage?: TokenUsage | null;
};

export type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

export type SurvivingClaim = {
  claim_id: string;
  originating_move_id: string;
  content: string;
  confidence_after_debate: number;
  concession_status?: string | null;
};

export type ReactionType = 'Rebut' | 'Concede' | 'Question' | 'Support';

export type Reaction = {
  by_persona_id: string;
  type: ReactionType;
  content: string;
  confidence: number;
  references_claim_id?: string;
};

export type CrossPollinationEntry = {
  claim_id: string;
  reactions: Reaction[];
  target_node_id: string | null;
};

export type ForumNode = {
  node_id: string;
  claim_id: string;
  /**
   * Invariant: equals a key in InvestigationView.debates — currently the
   * sub-question id of the debate that produced this surviving claim.
   * The SPA relies on this to resolve a node back to its originating debate
   * (ForumGraph, NodeDrawer). If the pipeline ever decouples these ids,
   * those components need an explicit mapping.
   */
  working_group_id: string;
  content: string;
  aggregate_confidence: number;
  contradiction_with_node_id: string | null;
  has_open_question: boolean;
  reactions: Reaction[];
  survival_rank: number | null;
};

export type ContradictionEdge = {
  from_node_id: string;
  to_node_id: string;
  reason: string;
};

export type WebSearchResult = {
  title: string;
  url: string;
  page_age?: string;
};

export type WebSearchPayload = {
  query: string;
  results: WebSearchResult[];
};

export type StageKey =
  | 'discovery'
  | 'coordinator_initial'
  | 'debates'
  | 'cross_pollination'
  | 'forum'
  | 'coordinator_spawn'
  | 'synthesis';

export type StageStatus = 'done' | 'partial' | 'skipped' | 'failed' | 'not_run';

export type Stage = {
  key: StageKey;
  label: string;
  status: StageStatus;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  /** Short one-line description of what happened in this stage, when known. */
  summary: string | null;
  /** Section id to jump to for the full detail (e.g., 'discovery', 'coordinator'). */
  detail_ref: string;
};

export type Budget = {
  used_executor_calls: number;
  max_executor_calls: number;
  used_total_tokens: number;
  max_total_tokens: number;
  runtime_ms: number | null;
};

export type DiscoveryView = {
  search_queries: string[];
  web_search_results: WebSearchPayload[];
  candidate_personas: Persona[];
  selected_persona_ids: string[];
  fixed_personas: string[];
  selection_distinctness: Record<string, number>;
};

export type CoordinatorView = {
  initial: { decided_at: string | null; sub_questions: SubQ[] } | null;
  // `spawn` is null when the spawn round has not executed yet; populated when
  // the coordinator emitted either a decision or a `declined` log record.
  spawn: {
    decided_at: string | null;
    sub_questions: SubQ[];
    reason: string | null;
    declined: boolean;
  } | null;
};

export type ConfidencePoint = {
  move_id: string;
  persona_id: string;
  confidence: number;
  type: MoveType;
};

export type DebateView = {
  sub_question: SubQ | null;
  pair: Persona[];
  moves: Move[];
  surviving_claims: SurvivingClaim[];
  terminated_by: string | null;
  confidence_trajectory: ConfidencePoint[];
  synthesized_move_count: number;
};

export type ContradictionVerdict = {
  contradicts: boolean;
  reason: string;
  usage: TokenUsage | null;
};

export type ForumView = {
  nodes: ForumNode[];
  contradiction_edges: ContradictionEdge[];
  contradiction_verdicts: Record<string, ContradictionVerdict>;
};

export type SynthesisView = {
  report: string;
  headline_findings: string[];
  open_tensions: string[];
} | null;

export type PersonaInteractionCell = {
  Rebut: number;
  Concede: number;
  Question: number;
  Support: number;
};

export type PersonaInteractions = Record<
  string,
  Record<string, PersonaInteractionCell>
>;

export type ParseErrorEntry = {
  kind: string | null;
  stage: string | null;
  persona_id: string | null;
  errors: unknown;
  raw: unknown;
  ts: string | null;
};

export type InvestigationView = {
  id: string;
  raw_capture: string;
  status: 'pending' | 'investigating' | 'ready' | 'archived';
  parent_id: string | null;
  captured_at: string | null;
  last_action_at: string | null;
  model: string | null;
  budget: Budget;
  stages: Stage[];
  discovery: DiscoveryView;
  coordinator: CoordinatorView;
  debates: Record<string, DebateView>;
  cross_pollination: CrossPollinationEntry[];
  forum: ForumView;
  synthesis: SynthesisView;
  persona_interactions: PersonaInteractions;
  parse_errors: ParseErrorEntry[];
};
