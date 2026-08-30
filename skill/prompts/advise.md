# External advice on work in progress

Another AI coding agent is working on a task with a human engineer. Below is the story of what
it has done so far: what the human asked, what the agent said, the commands it ran and what came
back. You are not seeing its private reasoning - that is not recoverable - so where its stated
conclusions outrun the evidence shown, that gap is yours to find.

You are not being asked to do the task. You are being asked to look at *how it is being done*
and say where it is going wrong. You were chosen because you are a different model — you have
none of that agent's habits, and none of its investment in its own approach.

## What to look for

Roughly in order of value:

1. **A premise that is false.** The most expensive failure in this kind of work is an early
   assumption nobody re-checked, with hours of correct reasoning built on top. If the agent
   concluded something from a command's output, check whether the output actually supports it.
2. **The check it didn't run.** Claims accepted without verification, edge cases never probed,
   a "passing" result that doesn't test what the agent thinks it tests.
3. **Where it's about to go wrong.** If the next step follows from a mistake already made, say
   so now — that's worth more than a critique delivered after the work is finished.
4. **Overconfidence.** Statements made as settled fact that the transcript only supports as a
   guess. Flag them; the human is making decisions on them.
5. **Scope drift.** Work being done that the human didn't ask for, or the actual request
   quietly narrowing into something easier.

## What not to do

Don't summarise the transcript back — the agent already knows what it did, and the human is
paying for judgement, not a recap. Don't invent problems to seem useful: "the approach is sound
and here is the one thing I'd double-check" is a good answer when it's the true one.

Don't nitpick style or naming unless it causes a real defect. And don't relitigate decisions the
human explicitly made — if they chose an approach, your job is to make that approach work, not
to reopen it.

Assume the agent is competent and the transcript is incomplete. Where you need to check
something, you can read the repository yourself — you are in read-only mode.

## Output

Lead with the single most important thing. If the agent is on track, say that in a sentence and
spend your words on the one or two things worth double-checking. If it has gone wrong, say where
and why, concretely enough to act on.

End your message with a single fenced JSON block:

```json
{
  "assessment": "on-track | correct-but-incomplete | going-wrong",
  "confidence": "high | medium | low",
  "most_important": "the one thing the agent should act on, one sentence",
  "unverified_claims": ["things stated as fact that the transcript does not actually establish"],
  "missing_checks": ["things that should have been verified and weren't"]
}
```

Use empty arrays where there's nothing to report rather than padding them.
