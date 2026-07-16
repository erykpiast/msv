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

// --- v5 types ---

export type Territory = {
  /**
   * Canonical territory identifier (slugged, e.g. `t_001`). Emitted by the
   * coordinator and used as the key in `InvestigationView.working_groups` and
   * for routing in the SPA. Prefer this field for lookups.
   */
  id: string;
  /**
   * Duplicate of `id` preserved for back-compat with code paths that read
   * raw coordinator output (and with the slug persisted on each pair_debates
   * entry by `working_group.js`). Always equals `id` in practice. Resolvers
   * fall back to this when `id` is missing — see `territoryKey()` in
   * `src/working_group.js` and `src/inspect/view/build.js`.
   */
  territory_id: string;
  name: string;
  description: string;
  rationale?: string;
  assigned_pair: [string, string];
  pair_distinctness_score?: number;
};

export type CandidateQuestion = {
  candidate_id: string;
  by_persona_id: string;
  predicted_confidence: number;
  question: string;
  rationale?: string;
};

export type AdversarialMark = {
  candidate_id: string;
  marker_persona_id: string;
  could_answer_from_priors: boolean;
  rationale?: string;
};

export type AlignedQuestion = {
  aligned_id: string;
  question: string;
  origin: 'aligned' | string;
  by_persona_id?: string;
  source_candidate_ids: string[];
};

export type EvidenceRef = { observation_id: string } | { finding_id: string };

export type Finding = {
  finding_id: string;
  content: string;
  source_url?: string;
  source_title?: string;
  quality?: 'primary' | 'secondary' | 'indirect';
  /** Cosmetic display label set by the per-sub-stage WG nicknamer at the end
   * of the researcher sub-stage. Absent on older logs predating the
   * researcher-stage nicknamer or when the nicknamer's LLM call failed. */
  nickname?: string;
};

export type ResearcherReport = {
  report_id: string;
  aligned_id: string;
  by_persona_id?: string;
  outcome: 'useful' | 'partial' | 'dead_end';
  findings: Finding[];
  search_trace: string[];
};

export type Observation = {
  observation_id: string;
  by_persona_id: string;
  report_id: string;
  content: string;
  cited_finding_ids: string[];
  /** Cosmetic display label set by the per-sub-stage WG nicknamer. Absent on older
   * logs predating the nicknamer or when the nicknamer's LLM call failed. */
  nickname?: string;
};

export type DeadEndQuestion = {
  aligned_id: string;
  territory_id: string;
  originating_persona_id?: string;
  outcome_summary: string;
};

export type QuestionLandscapeEntry = {
  territory_id: string;
  territory_name: string;
  questions: Array<{ question: string; origin: string }>;
};

export type WorkingGroupView = {
  territory: Territory | null;
  pair: Persona[];
  candidate_questions: CandidateQuestion[];
  adversarial_marks: AdversarialMark[];
  aligned_questions: AlignedQuestion[];
  researcher_reports: ResearcherReport[];
  observations: Observation[];
  moves: (Move | AlignmentMove)[];
  surviving_claims: SurvivingClaim[];
  terminated_by: string | null;
  confidence_trajectory: ConfidencePoint[];
};

export type MoveType = 'Claim' | 'Support' | 'Rebut' | 'Question' | 'Concede';
export type AlignmentMoveType = 'Propose' | 'Sharpen' | 'Merge' | 'Drop' | 'Defer';

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
  /** wg.moves mixes alignment and debate moves; this field discriminates. */
  stage?: 'alignment' | 'debate';
  // v5 only — observation and finding citations for Claims
  evidence_refs?: EvidenceRef[];
  /** Cosmetic display label set by the per-sub-stage WG nicknamer. Absent on older
   * logs predating the nicknamer or when the nicknamer's LLM call failed. */
  nickname?: string;
};

/** Alignment-stage move recorded in wg.moves with stage='alignment'.
 * Distinct schema from debate Move: targets candidate questions (not other
 * moves) and uses the `AlignmentMoveType` union. */
export type AlignmentMove = {
  move_id: string;
  by_persona_id: string;
  type: AlignmentMoveType;
  content: string;
  stage: 'alignment';
  candidate_id?: string;
  merged_candidate_ids?: string[];
  rationale?: string;
  is_final?: boolean;
  timestamp?: string;
  attempt?: number | null;
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
  /** Cosmetic display label propagated from the originating move's nickname.
   * Additional claims off the same move get -c2, -c3 suffixes. Absent when
   * the originating move has no nickname. */
  nickname?: string;
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
  /** Cosmetic display label set by the end-of-forum nicknamer. Absent on
   * older logs predating the nicknamer, when the nicknamer's LLM call
   * failed, or when the node had no usable content to name. */
  nickname?: string;
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

export type WebSearchError = {
  code: string | null;
};

export type WebSearchPayload = {
  query: string;
  results: WebSearchResult[];
  result_count?: number;
  /**
   * `null` when the search succeeded (including legitimate zero-hit results).
   * `undefined` only in log records written before error reporting was added;
   * the discovery loader normalizes those to `null` on read.
   */
  error?: WebSearchError | null;
};

export type StageKey =
  | 'discovery'
  | 'coordinator_initial'
  | 'debates'
  | 'cross_pollination'
  | 'forum'
  | 'coordinator_spawn'
  | 'synthesis';

export type StageStatus = 'done' | 'partial' | 'skipped' | 'failed' | 'not_run' | 'in_progress';

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
  // v5 only
  used_researcher_tool_calls?: number;
  max_researcher_tool_calls?: number;
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
  // v5 only — territories replace sub_questions
  territories: Territory[];
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

export type SynthesisSection = {
  area_title: string;
  area_summary: string;
  key_findings: SynthesisFinding[];
};

export type SynthesisFinding = {
  content: string;
  confidence: 'high' | 'medium' | 'low';
};

export type SynthesisTensionPoint = {
  title: string;
  description: string;
  sides: SynthesisSide[];
  resolution: string | null;
};

export type SynthesisSide = {
  label: string;
  position: string;
};

export type SynthesisReference = {
  url: string;
  title: string;
  summary: string;
  key_observations: string[];
};

export type SynthesisNextPassProposal = {
  topic: string;
  rationale: string;
  territory_hint?: string;
};

export type SynthesisBreadthArea = {
  label: string;
  finding_indices: number[];
};

export type SynthesisBreadth = {
  n_areas: number;
  evenness: number;
  areas: SynthesisBreadthArea[];
  model: string;
  computed_at: string;
};

export type SynthesisView = {
  report: string;
  headline_findings: string[];
  open_tensions: string[];
  // v5 only
  question_landscape?: QuestionLandscapeEntry[];
  dead_end_summary?: string;
  // v5 structured report fields (added 2026-05-19)
  sections?: SynthesisSection[];
  tension_points?: SynthesisTensionPoint[];
  key_references?: SynthesisReference[];
  next_pass_proposals?: SynthesisNextPassProposal[];
  // realized-breadth metric (issue #33)
  breadth?: SynthesisBreadth;
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

export type ForumViewV5 = ForumView & {
  dead_end_questions: DeadEndQuestion[];
};

export type LastFailure = {
  reason: string;
  stage?: string;
  territory_id?: string;
  sub_stage?: string;
  at?: string;
};

export type InvestigationView = {
  id: string;
  raw_capture: string;
  status: 'pending' | 'investigating' | 'ready' | 'archived';
  parent_id: string | null;
  captured_at: string | null;
  last_action_at: string | null;
  model: string | null;
  schema_version: 'v4' | 'v5';
  budget: Budget;
  stages: Stage[];
  discovery: DiscoveryView;
  coordinator: CoordinatorView;
  // v4: keyed by sub_question_id; v5: empty (use working_groups instead)
  debates: Record<string, DebateView>;
  // v5 only: keyed by territory_id; empty for v4
  working_groups: Record<string, WorkingGroupView>;
  cross_pollination: CrossPollinationEntry[];
  forum: ForumView | ForumViewV5;
  synthesis: SynthesisView;
  persona_interactions: PersonaInteractions;
  parse_errors: ParseErrorEntry[];
  last_failure?: LastFailure;
};
