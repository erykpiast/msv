import type { ReactNode } from 'react';
import { Anchor, Badge, Group, Paper, Skeleton, Stack, Text } from '@mantine/core';
import type { InvestigationView, Move, SynthesisView, WorkingGroupView } from '../../inspect/types';
import { isAlignmentMove } from '../utils/moveStage';
import type { ProgressOverlay } from '../hooks/useLiveProgress';
import type { LeafRef, WorkingGroupSubstage } from '../hooks/useHashRoute';
import { PersonaCard } from '../components/Discovery/PersonaCard';
import { SubQuestionCard } from '../components/Coordinator/SubQuestionCard';
import { MoveCard } from '../components/Debate/MoveCard';
import { EvidencePanel } from '../components/WorkingGroup/EvidencePanel';
import { Markdown } from '../components/Synthesis/Markdown';
import { IdeationPanel } from '../components/WorkingGroup/IdeationPanel';
import { AdversarialPanel } from '../components/WorkingGroup/AdversarialPanel';
import { AlignmentPanel } from '../components/WorkingGroup/AlignmentPanel';
import { ResearcherPanel } from '../components/WorkingGroup/ResearcherPanel';
import { ObservationPanel } from '../components/WorkingGroup/ObservationPanel';
import { DebatePanel } from '../components/WorkingGroup/DebatePanel';
import { ConclusionsPanel } from '../components/WorkingGroup/ConclusionsPanel';
import { WgMapPanel } from '../components/WorkingGroup/WgMapPanel';
import { safeUrl } from '../utils/format';

type Rendered = { title: string; body: ReactNode; raw?: string };

function findWGWhere(
  v: InvestigationView,
  predicate: (wg: WorkingGroupView) => boolean
): WorkingGroupView | undefined {
  return Object.values(v.working_groups ?? {}).find(predicate);
}

function formatConfidence(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—';
}

function synthesisToMarkdown(s: NonNullable<SynthesisView>): string {
  const parts: string[] = [];
  const hasSections = Array.isArray(s.sections) && s.sections.length > 0;

  if (hasSections) {
    for (const section of s.sections!) {
      parts.push(`## ${section.area_title}`);
      if (section.area_summary) parts.push(section.area_summary);
      if (Array.isArray(section.key_findings) && section.key_findings.length) {
        parts.push(
          section.key_findings
            .map((f) => `- _(${f.confidence})_ ${f.content}`)
            .join('\n')
        );
      }
    }
  } else if (s.report) {
    parts.push(s.report);
  }

  if (Array.isArray(s.headline_findings) && s.headline_findings.length && !hasSections) {
    parts.push('## Headline findings');
    parts.push(s.headline_findings.map((f) => `- ${f}`).join('\n'));
  }

  if (Array.isArray(s.tension_points) && s.tension_points.length) {
    parts.push('## Tension points');
    for (const tp of s.tension_points) {
      parts.push(`### ${tp.title}`);
      parts.push(tp.description);
      if (Array.isArray(tp.sides) && tp.sides.length) {
        parts.push(tp.sides.map((side) => `- **${side.label}:** ${side.position}`).join('\n'));
      }
      if (tp.resolution) parts.push(`_Resolved:_ ${tp.resolution}`);
    }
  }

  if (Array.isArray(s.key_references) && s.key_references.length) {
    parts.push('## Most relevant references');
    s.key_references.forEach((ref, i) => {
      parts.push(`### ${i + 1}. [${ref.title}](${ref.url})`);
      if (ref.summary) parts.push(ref.summary);
      if (Array.isArray(ref.key_observations) && ref.key_observations.length) {
        parts.push(ref.key_observations.map((obs) => `- ${obs}`).join('\n'));
      }
    });
  }

  if (Array.isArray(s.next_pass_proposals) && s.next_pass_proposals.length) {
    parts.push('## Dig deeper — next pass proposals');
    s.next_pass_proposals.forEach((p, i) => {
      parts.push(`${i + 1}. **${p.topic}** — ${p.rationale}`);
    });
  }

  if (Array.isArray(s.question_landscape) && s.question_landscape.length && !hasSections) {
    parts.push('## Question landscape');
    parts.push(
      s.question_landscape
        .map((q) => `- ${q.territory_name}: ${q.questions.length} questions`)
        .join('\n')
    );
  }

  if (s.dead_end_summary) {
    parts.push('## Dead ends');
    parts.push(s.dead_end_summary);
  }

  return parts.join('\n\n');
}

// overlay is omitted in static (post-mortem) mode. Only the 'move' and
// 'wgPanel' leaf kinds use it to show skeleton placeholders for in-flight
// content. All other leaf kinds ignore it.
export function renderLeaf(
  leaf: LeafRef,
  view: InvestigationView,
  context?: { territoryId?: string; overlay?: ProgressOverlay }
): Rendered | null {
  const overlay = context?.overlay;
  const personaName = (id: string) =>
    view.discovery.candidate_personas.find((p) => p.id === id)?.name ?? id;

  switch (leaf.kind) {
    case 'persona': {
      const p = view.discovery.candidate_personas.find((x) => x.id === leaf.id);
      if (!p) return null;
      const selected = view.discovery.selected_persona_ids.includes(p.id);
      const distinctness = view.discovery.selection_distinctness[p.id];
      return {
        title: p.name,
        body: <PersonaCard persona={p} selected={selected} distinctness={distinctness} />,
        raw: JSON.stringify(p, null, 2),
      };
    }
    case 'territory': {
      const t = view.coordinator.territories.find((x) => x.territory_id === leaf.id);
      if (!t) return null;
      return {
        title: t.name,
        body: (
          <SubQuestionCard
            sq={{
              id: t.territory_id,
              question: t.description,
              rationale: t.rationale ?? '',
              assigned_pair: t.assigned_pair,
              pair_distinctness_score: t.pair_distinctness_score,
            }}
            personaName={personaName}
          />
        ),
        raw: JSON.stringify(t, null, 2),
      };
    }
    case 'candidate': {
      const wg = findWGWhere(view, (w) =>
        (w.candidate_questions ?? []).some((c) => c.candidate_id === leaf.id)
      );
      const cq = wg?.candidate_questions.find((c) => c.candidate_id === leaf.id);
      if (!cq) return null;
      const byName = personaName(cq.by_persona_id);
      return {
        title: `Candidate: ${cq.candidate_id}`,
        body: (
          <Stack gap="xs">
            <Text>{String(cq.question ?? '')}</Text>
            <Badge variant="light">by {byName}</Badge>
            <Badge variant="light" color="blue">confidence {formatConfidence(cq.predicted_confidence)}</Badge>
            {cq.rationale && <Text size="sm" c="dimmed">{cq.rationale}</Text>}
          </Stack>
        ),
        raw: JSON.stringify(cq, null, 2),
      };
    }
    case 'aligned': {
      const wg = findWGWhere(view, (w) =>
        (w.aligned_questions ?? []).some((a) => a.aligned_id === leaf.id)
      );
      const aq = wg?.aligned_questions.find((a) => a.aligned_id === leaf.id);
      if (!aq) return null;
      return {
        title: `Aligned: ${aq.aligned_id}`,
        body: (
          <Stack gap="xs">
            <Text>{String(aq.question ?? '')}</Text>
            <Badge variant="light">{aq.origin}</Badge>
          </Stack>
        ),
        raw: JSON.stringify(aq, null, 2),
      };
    }
    case 'report': {
      const wg = findWGWhere(view, (w) =>
        (w.researcher_reports ?? []).some((r) => r.report_id === leaf.id)
      );
      if (!wg) return null;
      const rr = (wg.researcher_reports ?? []).find((r) => r.report_id === leaf.id);
      if (!rr) return null;
      return {
        title: `Report: ${rr.report_id}`,
        body: <ResearcherPanel wg={wg} />,
        raw: JSON.stringify(rr, null, 2),
      };
    }
    case 'finding': {
      // Findings live inside ResearcherReport.findings across all WGs.
      let foundFinding: import('../../inspect/types').Finding | undefined;
      let foundReport: import('../../inspect/types').ResearcherReport | undefined;
      for (const w of Object.values(view.working_groups ?? {})) {
        for (const rr of w.researcher_reports ?? []) {
          const f = rr.findings.find((x) => x.finding_id === leaf.id);
          if (f) { foundFinding = f; foundReport = rr; break; }
        }
        if (foundFinding) break;
      }
      if (!foundFinding) return null;
      const f = foundFinding;
      return {
        title: `Finding: ${f.nickname ? `${f.nickname} · ${f.finding_id}` : f.finding_id}`,
        body: (
          <Stack gap="xs">
            <Text>{String(f.content ?? '')}</Text>
            {f.source_url ? (
              <Text size="sm">
                source:{' '}
                <a href={f.source_url} target="_blank" rel="noopener noreferrer">
                  {f.source_title ?? f.source_url}
                </a>
              </Text>
            ) : null}
            {f.quality ? (
              <Badge variant="light">{f.quality}</Badge>
            ) : null}
            {foundReport ? (
              <Text size="xs" c="dimmed">from report {foundReport.report_id}</Text>
            ) : null}
          </Stack>
        ),
        raw: JSON.stringify(f, null, 2),
      };
    }
    case 'observation': {
      const wg = findWGWhere(view, (w) =>
        (w.observations ?? []).some((o) => o.observation_id === leaf.id)
      );
      const obs = wg?.observations?.find((o) => o.observation_id === leaf.id);
      if (!obs) return null;
      const cited = obs.cited_finding_ids ?? [];
      // Resolve finding nicknames so the citation list reads as
      // "cites: friction-cliff (f_xxx), cold-start-tax (f_yyy)" instead of
      // raw IDs.
      const findingNickById = new Map<string, string>();
      for (const rr of wg?.researcher_reports ?? []) {
        for (const f of rr.findings ?? []) {
          if (f.nickname) findingNickById.set(f.finding_id, f.nickname);
        }
      }
      const citedLabels = cited.map((id) => {
        const nick = findingNickById.get(id);
        return nick ? `${nick} (${id})` : id;
      });
      return {
        title: `Observation: ${obs.nickname ? `${obs.nickname} · ${obs.observation_id}` : obs.observation_id}`,
        body: (
          <Stack gap="xs">
            <Text>{String(obs.content ?? '')}</Text>
            {citedLabels.length > 0 && (
              <Text size="sm" c="dimmed">
                cites: {citedLabels.join(', ')}
              </Text>
            )}
          </Stack>
        ),
        raw: JSON.stringify(obs, null, 2),
      };
    }
    case 'move': {
      const wg = findWGWhere(view, (w) =>
        (w.moves ?? []).some((m) => m.move_id === leaf.id)
      );
      const move = wg?.moves?.find((m) => m.move_id === leaf.id);
      if (!move || !wg) {
        if (overlay && overlay.inProgressWg.size > 0) {
          return {
            title: 'Debate move',
            body: <Skeleton height={120} radius="sm" />,
          };
        }
        return null;
      }

      // Alignment moves live in the same wg.moves array but use a different
      // schema (no evidence_refs/confidence, candidate_id / merged_candidate_ids
      // instead). Render an alignment-specific card; MoveCard + EvidencePanel
      // are only meaningful for debate moves.
      if (isAlignmentMove(move)) {
        const candidateIds: string[] = move.merged_candidate_ids?.length
          ? move.merged_candidate_ids
          : move.candidate_id
            ? [move.candidate_id]
            : [];
        return {
          title: `${move.type} by ${personaName(move.by_persona_id)}`,
          body: (
            <Stack gap="xs">
              <Group gap="xs" wrap="wrap">
                <Badge variant="light">{move.type}</Badge>
                <Text size="xs" c="dimmed">{move.move_id}</Text>
              </Group>
              <Text>{move.content}</Text>
              {move.rationale ? (
                <Text size="sm" c="dimmed">rationale: {move.rationale}</Text>
              ) : null}
              {candidateIds.length > 0 ? (
                <Text size="sm" c="dimmed">
                  candidate{candidateIds.length === 1 ? '' : 's'}: {candidateIds.join(', ')}
                </Text>
              ) : null}
            </Stack>
          ),
          raw: JSON.stringify(move, null, 2),
        };
      }

      // From here on, `move` is narrowed to a debate Move. EvidencePanel
      // expects Move[], so we strip any alignment moves out of wg.moves at the
      // call site.
      const survivingIds = new Set((wg.surviving_claims ?? []).map((c) => c.originating_move_id));
      const findings = (wg.researcher_reports ?? []).flatMap((r) => r.findings);
      const debateMoves = (wg.moves ?? []).filter((m): m is Move => !isAlignmentMove(m));
      return {
        title: `${move.type} by ${personaName(move.by_persona_id)}`,
        body: (
          <Stack gap="md">
            <MoveCard
              move={move}
              personaName={personaName}
              isSurviving={survivingIds.has(move.move_id)}
            />
            <EvidencePanel
              selectedMoveId={move.move_id}
              moves={debateMoves}
              observations={wg.observations ?? []}
              findings={findings}
            />
          </Stack>
        ),
        raw: JSON.stringify(move, null, 2),
      };
    }
    case 'claim': {
      const wg = findWGWhere(view, (w) =>
        (w.surviving_claims ?? []).some((c) => c.claim_id === leaf.id)
      );
      const claim = wg?.surviving_claims?.find((c) => c.claim_id === leaf.id);
      if (!claim) return null;
      return {
        title: `Claim: ${claim.nickname ? `${claim.nickname} · ${claim.claim_id}` : claim.claim_id}`,
        body: (
          <Stack gap="xs">
            <Text>{String(claim.content ?? '')}</Text>
            <Badge variant="light">confidence {formatConfidence(claim.confidence_after_debate)}</Badge>
            {claim.concession_status && (
              <Badge color="orange" variant="light">{claim.concession_status}</Badge>
            )}
          </Stack>
        ),
        raw: JSON.stringify(claim, null, 2),
      };
    }
    case 'node': {
      const n = view.forum.nodes.find((x) => x.node_id === leaf.id);
      if (!n) return null;
      const contradictions = view.forum.contradiction_edges.filter(
        (e) => e.from_node_id === leaf.id || e.to_node_id === leaf.id
      );
      return {
        title: `Forum node ${n.nickname ? `${n.nickname} · ${n.node_id}` : n.node_id}`,
        body: (
          <Stack gap="xs">
            <Text>{String(n.content ?? '')}</Text>
            <Badge variant="light">confidence {formatConfidence(n.aggregate_confidence)}</Badge>
            {n.has_open_question && <Badge color="yellow">open question</Badge>}
            {contradictions.map((c, i) => (
              <Text key={i} size="sm">
                contradicts {c.from_node_id === leaf.id ? c.to_node_id : c.from_node_id}:{' '}
                {c.reason}
              </Text>
            ))}
          </Stack>
        ),
        raw: JSON.stringify({ node: n, contradictions }, null, 2),
      };
    }
    case 'synthesis': {
      const s = view.synthesis;
      if (!s) return null;

      const hasStructured = Array.isArray(s.sections) && s.sections.length > 0;

      const body = hasStructured ? (
        <Stack gap="xl">
          {s.sections!.map((section, i) => (
            <Stack key={i} gap="xs">
              <Text fw={700} size="lg">{section.area_title}</Text>
              <Text c="dimmed" size="sm">{section.area_summary}</Text>
              <Stack gap={4}>
                {section.key_findings.map((f, j) => (
                  <Group key={j} gap="xs" align="flex-start">
                    <Badge
                      size="xs"
                      color={f.confidence === 'high' ? 'green' : f.confidence === 'medium' ? 'yellow' : 'gray'}
                      variant="light"
                    >
                      {f.confidence}
                    </Badge>
                    <Text size="sm" style={{ flex: 1 }}>
                      <Markdown>{f.content}</Markdown>
                    </Text>
                  </Group>
                ))}
              </Stack>
            </Stack>
          ))}

          {Array.isArray(s.tension_points) && s.tension_points.length > 0 && (
            <Stack gap="xs">
              <Text fw={700} size="md">Tension points</Text>
              {s.tension_points.map((tp, i) => (
                <Stack key={i} gap={4} p="sm" style={{ borderLeft: '3px solid var(--mantine-color-orange-5)' }}>
                  <Text fw={600} size="sm">{tp.title}</Text>
                  <Text size="sm">{tp.description}</Text>
                  {tp.sides.map((side, j) => (
                    <Text key={j} size="xs" c="dimmed">
                      <strong>{side.label}:</strong> {side.position}
                    </Text>
                  ))}
                  {tp.resolution && (
                    <Text size="xs" c="teal">Resolved: {tp.resolution}</Text>
                  )}
                </Stack>
              ))}
            </Stack>
          )}

          {Array.isArray(s.key_references) && s.key_references.length > 0 && (
            <Stack gap="xs">
              <Text fw={700} size="md">Most relevant references</Text>
              {s.key_references.map((ref, i) => (
                <Paper key={i} p="sm" radius="sm" withBorder>
                  <Stack gap={2}>
                    <Anchor href={safeUrl(ref.url)} target="_blank" rel="noopener noreferrer" size="sm" fw={600}>
                      {i + 1}. {ref.title}
                    </Anchor>
                    <Text size="sm">{ref.summary}</Text>
                    <Stack gap={2} mt={4}>
                      {ref.key_observations.map((obs, j) => (
                        <Text key={j} size="xs" c="dimmed">· {obs}</Text>
                      ))}
                    </Stack>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}

          {Array.isArray(s.next_pass_proposals) && s.next_pass_proposals.length > 0 && (
            <Stack gap="xs">
              <Text fw={700} size="md">Dig deeper — next pass proposals</Text>
              <Text size="xs" c="dimmed">Topics worth exploring in a follow-up investigation.</Text>
              <Stack gap={4}>
                {s.next_pass_proposals.map((p, i) => (
                  <Stack key={i} gap={2}>
                    <Text size="sm"><strong>{i + 1}. {p.topic}</strong></Text>
                    <Text size="xs" c="dimmed">{p.rationale}</Text>
                  </Stack>
                ))}
              </Stack>
            </Stack>
          )}

          {s.dead_end_summary && (
            <Stack gap={2}>
              <Text fw={600} size="sm">Dead ends</Text>
              <Text size="sm" c="dimmed">{s.dead_end_summary}</Text>
            </Stack>
          )}
        </Stack>
      ) : (
        <Stack gap="sm">
          <Markdown>{s.report}</Markdown>
          {s.headline_findings.length > 0 && (
            <Stack gap={2}>
              <Text fw={600}>Headline findings</Text>
              {s.headline_findings.map((f, i) => (
                <Text key={i}>· {f}</Text>
              ))}
            </Stack>
          )}
          {s.question_landscape && (
            <Stack gap={2}>
              <Text fw={600}>Question landscape</Text>
              {s.question_landscape.map((q, i) => (
                <Text key={i} size="sm">
                  {q.territory_name}: {q.questions.length} questions
                </Text>
              ))}
            </Stack>
          )}
          {s.dead_end_summary && (
            <Stack gap={2}>
              <Text fw={600}>Dead-end summary</Text>
              <Text size="sm">{s.dead_end_summary}</Text>
            </Stack>
          )}
        </Stack>
      );

      return { title: 'Synthesis', body, raw: synthesisToMarkdown(s) };
    }
    case 'wgPanel': {
      const territoryId = context?.territoryId;
      const wg = territoryId ? view.working_groups?.[territoryId] : undefined;
      if (!wg) {
        if (overlay && territoryId && overlay.inProgressWg.has(territoryId)) {
          return {
            title: `WG panel · ${leaf.substage}`,
            body: <Skeleton height={120} radius="sm" />,
          };
        }
        return null;
      }
      const survivingIds = new Set((wg.surviving_claims ?? []).map((c) => c.originating_move_id));
      let body: ReactNode;
      switch (leaf.substage as WorkingGroupSubstage) {
        case 'ideation':
          body = <IdeationPanel wg={wg} personaName={personaName} />;
          break;
        case 'adversarial':
          body = <AdversarialPanel wg={wg} personaName={personaName} />;
          break;
        case 'alignment':
          body = <AlignmentPanel wg={wg} personaName={personaName} />;
          break;
        case 'researcher':
          body = <ResearcherPanel wg={wg} />;
          break;
        case 'observation':
          body = <ObservationPanel wg={wg} personaName={personaName} />;
          break;
        case 'debate':
          body = <DebatePanel wg={wg} personaName={personaName} survivingIds={survivingIds} />;
          break;
        case 'conclusions':
          body = <ConclusionsPanel wg={wg} personaName={personaName} />;
          break;
        // 'wg-map' is no longer a substage that opens a drawer — it's a
        // top-level tab in WorkingGroupCanvas. This case is reachable only via
        // an old deep-link URL of the form `leaf=wgPanel:wg-map` (URL
        // backward-compat only).
        case 'wg-map':
          body = <WgMapPanel wg={wg} />;
          break;
        default:
          body = null;
      }
      return {
        title: `WG: ${wg.territory?.name ?? territoryId} · ${leaf.substage}`,
        body,
        raw: JSON.stringify(wg, null, 2),
      };
    }
  }
}
