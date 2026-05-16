# msv — Vision

> A tool that puts you meaningfully further along on an idea by staging a structured argument between deliberately diverse perspectives — not a survey, not a chat, not a search.

This is a living doc. It captures *why* msv exists and *what bet* I'm making. The architecture and the pipeline live in `architecture.md`; this file is for remembering the point.

## The problem

Researching an idea — actually understanding its landscape, not just collecting facts about it — is hard in a specific way that current tools don't address.

When I have a half-formed thought, what I usually want is not "tell me what's true about this." I want to understand *what people who think seriously about this disagree about*, where the load-bearing assumptions are, and which positions are worth taking. That's a different deliverable from a summary.

What I usually do, and where it falls short:

- **Search and skim.** Five tabs in, I have a pile of facts and no position. The disagreements are implicit in the sources but I never assemble them.
- **Ask one chatbot.** I get a balanced, encyclopedic answer that's been carefully sanded down to offend nobody. Confidence is uniform and unearned. It tells me the shape of the consensus but not where the real seams are.
- **Talk to one person.** Best signal-to-noise, but it's one perspective. I get their seams, not the field's seams.

What existing tools do, and where they fall short for this specific task:

- **Search engines** return documents, not arguments. Synthesis is on me.
- **Single-agent chat** flattens. One model, one voice, one set of priors. Even with web search, it speaks with a unified voice and hedges where it should pick sides.
- **STORM-like summarizers** (the closest prior art) produce neutral, encyclopedic outlines. That's their explicit goal and they do it well. But neutrality is the wrong target when I want a *position*. I came for an opinion the evidence supports, not balanced coverage.

The gap: a tool that *takes positions where the evidence warrants and names the contradictions where it doesn't* — and that does so by making the disagreements actually happen, not by hand-waving "consider multiple perspectives."

## What we're betting on

The hypothesis, lifted from the spec:

> *Structured disagreement between deliberately diverse personas, with confidence-weighted aggregation, leaves the user meaningfully further along in understanding an idea's landscape than they were before.*

Three words in that sentence are doing real work. Each is a specific bet against a tempting alternative.

**Diverse.** Personas are discovered per-investigation by surveying the real intellectual traditions speaking about the topic — not invented from LLM priors, not pulled from a fixed cast. The reason: cold-generated personas sound plausible but are homogeneous; personas grounded in actual prior discourse disagree the way their fields actually disagree. Diversity is the prerequisite for everything downstream. Without it, the debate is theatre.

**Structured disagreement.** Not consensus. Pairs of personas are deliberately matched to maximize tension and run a constrained debate with five discourse moves (Claim, Support, Rebut, Question, Concede — defined inline so the system can enforce engagement). Concession is allowed and counted, but the system actively resists two collapse modes: personas calcifying into their roles, and debates devolving into vacuous mutual agreement. Disagreement is the product, not a phase to be resolved away.

**Confidence-weighted.** Every move carries a 0–10 confidence grounded in articulated evidence. The synthesis weights by confidence rather than averaging. A high-confidence claim with a low-confidence rebuttal doesn't get a "both sides" treatment; it gets stated, with the rebuttal flagged as a caveat. Contradictions across working groups are surfaced explicitly, not averaged. This is the bet against the most common LLM-synthesis failure: producing "on the one hand, on the other hand" prose that tells the reader nothing.

Why this combination, and not the obvious alternatives:

- **Why not majority vote?** Truth isn't a popularity contest among personas I made up.
- **Why not one big "consider all perspectives" prompt?** That's what single-agent chat already does, and it's why single-agent chat fails at this task. The disagreement has to actually happen — different contexts, different roles, different conversations — for the artifacts to carry independent signal.
- **Why not a hierarchy or a debate tree?** Co-STORM-style mind maps are richer but the hypothesis test doesn't need that richness yet. A flat ranked list of claims with explicit contradiction links is the minimum that lets the synthesizer do its job. If the loop works, hierarchy is a v0.2 question.

The prototype is the experiment. If structured disagreement + confidence-weighting doesn't produce noticeably better synthesis than a single agent could, the architecture is wrong and the hypothesis is falsified. That's a real possibility and a valid outcome.

## What success looks like

Success is qualitative and deliberately so. From the spec's Definition of Done (§9):

The synthesis makes me *feel meaningfully further along* in understanding the topic. Not "I learned facts" — I can get facts from anywhere. Further along means: I now know which assumptions are load-bearing, where serious people disagree and why, which position the evidence actually supports, and which tensions genuinely don't resolve. If I read the report and feel like I'd be embarrassed to defend a strong position before reading it but could defend one after — that's the bar.

Validation surface: **5–10 real runs on real ideas.** Not benchmarks, not synthetic topics. Ideas I actually have. The judgment is mine and it's subjective on purpose, because the thing being measured (am I further along?) is inherently subjective.

A **negative result is a valid outcome.** If after 5–10 runs the synthesis still feels balanced-and-empty, or if the personas calcify, or if confidence numbers turn out arbitrary in ways that break ranking, that's information. The prototype's job is to find out whether the loop works at all — not to prove it does.

Two weeks of normal use without needing to restructure the schema is the secondary signal. If the data model has to change every few days, the architecture isn't stable enough to test the real question.

## What this is NOT

To save future-me (and anyone else who reads this) from misreading the project:

- **Not a production tool.** No daemon, no scheduler, no auth, no multi-user surface. Local JSON in `~/.msv/ideas/`. One developer, one machine.
- **Not optimized for cost.** A run costs $1–3 in tokens and 1–3 minutes of wall time. That's on purpose. The whole point is that real disagreement between many agents is expensive, and the bet is that expense buys insight that cheaper approaches can't.
- **Not a neutral encyclopedia.** STORM does that, and does it well. msv exists because I want the *opposite* — opinionated synthesis that picks sides the evidence supports. If you want balanced coverage of a topic, use STORM.
- **Not a chat.** No mid-investigation steering, no turn-based iteration. The user has one steering surface: the topic pitch. After that, the agent society runs to completion and the user reads the output. The bet on background long-running investigation is itself part of the hypothesis.
- **Not a roadmap to a startup.** There is no v2, no growth plan, no thing-that-survives-contact-with-a-second-user. If the loop produces real insight after a month of use, *then* it's worth thinking about productization. Not before.
- **Not a benchmark project.** Success isn't measured against a dataset. It's measured against my own felt sense of whether the synthesis was useful on real ideas. That's a smaller, lower-prestige claim than "we beat SOTA on X" and it's the only claim worth making here.

If a feature request points at any of the above, the answer is no — at least for the prototype. The point of the prototype is to find out whether the core bet pays off. Everything else is a distraction until that question has an answer.
