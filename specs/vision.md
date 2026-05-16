# msv — Vision

> A great-question machine. Diverse personas exist to surface the questions you wouldn't have asked yourself. Search agents answer them. A synthesizer reports back. The unique value is in *what gets asked* — not just *what gets concluded*.

This is a living doc. It captures *why* msv exists and *what bet* I'm making. The architecture and the pipeline live in `architecture.md`; this file is for remembering the point.

## What this is, in one paragraph

msv reads a half-formed idea and runs a small society of LLM personas over it. The personas come from real intellectual traditions discovered per-topic. They are paired and pushed through a structured debate, but the *output* of that debate isn't a position — it's a set of research questions that survived contact with deliberately diverse viewpoints. Search agents go answer those questions. The synthesizer reads the answers and writes back. What lands on the user's screen is "here are the questions the system asked, here's what it found, here's what nobody could find evidence for." The promise is "I wouldn't have thought to ask half of these."

## How this reframe happened

Earlier versions of this doc framed msv as a multi-agent *debate* tool whose value was structured disagreement. That framing wasn't wrong — the debate mechanics are still here — but it was incomplete in a way that prototype runs made obvious.

Watching actual investigations, two things were clear:

1. The debates looked close-minded. Personas mostly defended their priors. The "disagreement" was real but not the artifact of value.
2. The questions the personas raised on the way to those defenses were *much* more interesting than the conclusions. They pointed at angles I would not have thought to investigate.

A deeper observation falls out of this. A background-researcher is only worth running autonomously if it can do two things a human can't easily do for themselves:

- **Save time on active research.** I don't want to read intermediate answers, formulate follow-ups, wait, repeat. I want to come back to something already chewed on.
- **Surface quality questions I wouldn't think to ask.** This is the unique payoff. Anyone can read sources. Few people, working alone, can credibly populate a question set across intellectual traditions they don't already inhabit.

The reframe: msv is for the second payoff, and uses the first to deliver it. The debate apparatus is preserved as a *filter* — it refines and tests the questions before search agents spend tokens on them. But the debate is no longer the centerpiece. The questions are.

## The hypothesis, sharpened

> A structured multi-agent system, with persona-anchored interrogative ideation and minority-protected alignment, produces a research question set that a thoughtful human, given the same topic, would describe as "I wouldn't have thought to ask half of these" — and the answers to those questions leave them meaningfully further along than reading a single-agent synthesis would.

Several words are doing real work.

**Persona-anchored interrogative ideation.** Personas are interrogative engines, not advocates. Their primary job is to ask questions their tradition would ask, not to argue positions their tradition would defend. They're still grounded in real intellectual lineages discovered per-investigation (see `architecture.md` §5.1), because cold-generated personas ask homogeneous questions. The shift from "what do you argue?" to "what do you ask?" is enforced at the prompt level — personas open with interrogative posture, not advocacy posture.

**Minority-protected alignment.** When a pair of personas works through a sub-topic, each persona contributes at least one question that survives to the research stage, regardless of whether the pair "aligned" on it. Both members must engage with each other's minority questions — they can't be quietly discarded by the dominant voice. This is load-bearing. Without it, the more confident persona's worldview wins, and the system collapses back into a homogeneous interrogator with extra steps.

**A research question set, not a position.** The first-class artifact is the questions, plural, with provenance — which persona raised it, which pair carried it through, which ones found evidence and which didn't. The synthesis reports back across this set. The reader sees "here are X questions the system asked across Y territories" and that alone has standalone value, before the answers are even considered.

## What the debate apparatus is for now

The Claim / Support / Rebut / Question / Concede protocol is still here. It still runs. Confidence is still attached to every move. The difference is purpose: the debate's job is to *filter and refine the questions* before they go to search, not to produce positions for the user.

Concretely:

- A pair stage surfaces questions through the act of arguing.
- The minority-protection rule guarantees the question set isn't pruned by debate dynamics.
- Surviving questions go to per-question search sub-agents that try to actually answer them.
- The synthesizer reads questions + answers + dead ends and writes the report.

This is a downgrade of the debate from "the value" to "the question-filter," not a deletion. The mechanism that made the original bet defensible (real disagreement between deliberately diverse agents) is the same mechanism that makes the question set non-homogeneous. The structured-disagreement bet hasn't been displaced; it's been put in service of question-generation.

## Dead ends matter

A question the system asked, researched, and found no evidence for is not noise to discard. It's signal. It tells the reader: "this angle was considered, and either the evidence isn't out there or we couldn't find it." That's information the reader couldn't get from a single-agent synthesis, which would silently never have asked.

The synthesis preserves dead-end questions explicitly. They appear in the output, flagged as such. Treating them as failures of the pipeline rather than artifacts of the pipeline would discard most of the interrogative value.

## What success looks like

Success is still qualitative and still subjective.

After 5–10 real runs on real ideas, I should be able to say two things about a typical run:

1. *"I wouldn't have thought to ask half of these questions on my own."* The question set surfaces angles outside my own habits of thought.
2. *"The answers leave me meaningfully further along than a single-agent synthesis would."* The combination of unexpected questions and credible answers does work that I couldn't have done by asking one model the same topic.

If either half is missing — if the questions are pedestrian, or if the answers are thin even when the questions are good — the bet is falsified. **Negative result is a valid outcome.** The prototype's job is to find out whether the loop works, not to prove it does.

Validation surface: 5–10 real runs on real ideas. Not benchmarks. Ideas I actually have. Judgment is mine and is subjective on purpose, because "did this ask me a question I wouldn't have asked?" is inherently subjective.

Stability signal: two weeks of normal use without restructuring the schema. If the data model has to change every few days, the architecture isn't stable enough to test the hypothesis.

## What this is NOT

- **Not a production tool.** No daemon, no scheduler, no auth, no multi-user surface. Local JSON in `~/.msv/ideas/`. One developer, one machine.
- **Not a neutral encyclopedia.** STORM-style summarizers produce balanced coverage; that's their goal and they do it well. msv is asking different questions, in service of a different deliverable, in a voice that takes the questions seriously rather than sanding them flat.
- **Not a chat.** No mid-investigation steering. One steering surface: the topic pitch. After that, the system runs to completion. The bet on background long-running investigation is itself part of the hypothesis.
- **Not a roadmap to a startup.** There is no v2, no growth plan. If the loop produces real insight after a month of use, *then* productization is worth thinking about. Not before.
- **Not a benchmark project.** Success is measured against my own felt sense on real ideas. Lower-prestige than "we beat SOTA," and the only claim worth making here.

## What changed in non-goals

The earlier framing made two commitments the new framing relaxes.

**Model heterogeneity is now in scope.** Pair stages run on a 1M-context Sonnet because they consume large evidence pools from the per-question search sub-agents. The synthesizer can run on a smaller, cheaper model — it reads structured claims and questions, not raw evidence. This isn't a roadmap to multi-model orchestration; it's pragmatic acceptance that different stages have different context needs.

**Cost ceiling rises.** Per-question research sub-agents make a run noticeably more expensive. Realistic range: ~$5–10 per run, up from the earlier $1–3 estimate. The honest framing: msv is not a tool for shower thoughts. It's a tool for ideas worth spending an hour and a few dollars on. If a run costs the same as a decent lunch and saves an evening of poking at a topic, that's the trade. If it doesn't, the hypothesis was wrong.

## What stays the same

- Single-developer prototype, evening project.
- Local JSON storage in `~/.msv/ideas/`.
- Three commands: `msv add`, `msv run`, `msv review`.
- Definition of done is subjective: 5–10 real runs and a felt sense of whether the questions and findings are valuable. Negative result is valid.
- Most "Out of scope" items still apply (no production tool, no multi-user, no roadmap).

## Closing

The original framing called msv a structured-disagreement tool. That was a real bet and the mechanism still works. What changed is what the mechanism is *for*. The valuable artifact, the thing that makes a tool like this worth building when single-agent chat already exists, is the question set the system asks on the user's behalf — questions a thoughtful person, working alone on the same topic, would not have arrived at.

Diverse personas as question-engines. Pair debates as question-filters. Search agents as answerers. Synthesizer as reporter. Dead ends preserved. Minority questions protected. The bet is that this configuration produces something a single agent — no matter how smart — structurally cannot.

If after a month of real use the question sets are pedestrian, or the answers are thin, or the synthesis collapses back to "on the one hand, on the other hand" prose, the bet was wrong. That's an acceptable outcome. The point of the prototype is to find out.
