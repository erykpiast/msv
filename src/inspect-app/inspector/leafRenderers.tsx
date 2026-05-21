import type { ReactNode } from 'react';
import { Badge, Skeleton, Stack, Text } from '@mantine/core';
import type { InvestigationView, WorkingGroupView } from '../../inspect/types';
import type { ProgressOverlay } from '../hooks/useLiveProgress';
import type { LeafRef, WorkingGroupSubstage } from '../hooks/useHashRoute';
import { PersonaCard } from '../components/Discovery/PersonaCard';
import { SubQuestionCard } from '../components/Coordinator/SubQuestionCard';
import { MoveCard } from '../components/Debate/MoveCard';
import { Markdown } from '../components/Synthesis/Markdown';
import { IdeationPanel } from '../components/WorkingGroup/IdeationPanel';
import { AdversarialPanel } from '../components/WorkingGroup/AdversarialPanel';
import { AlignmentPanel } from '../components/WorkingGroup/AlignmentPanel';
import { ResearcherPanel } from '../components/WorkingGroup/ResearcherPanel';
import { ObservationPanel } from '../components/WorkingGroup/ObservationPanel';
import { DebatePanel } from '../components/WorkingGroup/DebatePanel';
import { WgMapPanel } from '../components/WorkingGroup/WgMapPanel';

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
      const survivingIds = new Set((wg.surviving_claims ?? []).map((c) => c.originating_move_id));
      return {
        title: `${move.type} by ${personaName(move.by_persona_id)}`,
        body: (
          <MoveCard
            move={move}
            personaName={personaName}
            isSurviving={survivingIds.has(move.move_id)}
          />
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
      return {
        title: 'Synthesis',
        body: (
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
        ),
        raw: s.report,
      };
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
