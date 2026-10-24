# Local reading agent with remote delegation

**Status: planned, after verification of existing functionality.** A small phone agent handles each question, using local tools or delegating to a stronger remote agent. A separate classifier is optional; the initial design does not require Jev or three independently selected routes.

## One agent and a delegation tool

Give the local agent the question, current passage, relevant conversation, document revision and preparation status within a bounded context. It can answer immediately, investigate locally, or call `delegate_to_strong_agent` when it needs broader evidence or stronger reasoning.

| Tool | Purpose |
| --- | --- |
| `search_paper`, `read_section` | Retrieve prepared text with citations and partial-reflow boundaries. |
| `calculate` | Evaluate bounded calculations. |
| Scratchpad read/write | Keep size-limited, resettable notes per paper in IndexedDB; source documents remain read-only. |
| `delegate_to_strong_agent` | Send the question, findings, unresolved points and source pointers to the existing strong Terminal session. |

Remote delegation reuses the paper workspace, file sharing or stock text-context fallback, authentication and reply notifications. Keep one user-facing conversation across local and remote work. Show the strong agent's answer directly, preserving its citations, and make it available to local follow-ups. The local agent need not rewrite it. See [current integration](ASK-ABOUT-THIS.md).

## Fast answers and verification

Retain background checks for quick local answers. Display them immediately as **Quick answer · verification pending**, then **checking** after a separate strong checker accepts the job. The checker investigates the paper and returns **supported**, **correction**, **inconclusive**, or **failed**, with citations. Corrections append a linked message and **Correction ready** notification without interrupting reading. Checking every quick answer may improve latency without reducing total cost.

Persist question/tool-call IDs, document revision, position, context, answer and remote job status. Keep checker sessions separate from foreground delegation. Recover without duplicate submissions and carry corrections into follow-ups. Queue unsent checks durably; accepted desktop jobs run independently. Phone work checkpoints when possible and resumes after suspension; notifications appear when Pageborne runs again.

## Execution limits

Use WebGPU for the planned quantized phone agent. Keep initial speech recognition on CPU/WebAssembly SIMD; optional Small WebGPU corrections run separately. The standalone browser-stt project owns that pipeline and the experimental audio-input LLM replacement target. Coordinate memory with speech and PDF preparation; benchmark agent cold/warm latency, battery and suspension on the phone. No local shell is required.

Bound iterations, context, time and memory. Repeated tool failures or exhausted budgets trigger remote delegation even if the small model fails to request it. Provide a user override to ask the strong agent. If local execution is unavailable, retain today's remote flow; if remote execution is unavailable, preserve work and report the limitation. Select the strong model through the existing desktop configuration.

## Learning when to delegate

Keep an opt-in evaluation corpus of questions, tool/delegation decisions, outcomes, timings and feedback, separate from diagnostics. Distinguish user labels from fallible checker judgments. Compare local and remote results on held-out papers; a strong answer alone cannot establish local failure. Use feedback to improve the agent's delegation policy. Evaluate Jev or a trained local classifier only if it measurably improves latency or escalation accuracy. [Jev capabilities](https://openrouter.ai/docs/guides/community/jev).

## Verification and sequence

1. Verify current library persistence/import/delete, reading modes and shared positions, PDF reflow/figures/footnotes/partial loads/cache/cancellation, phone and glasses controls, Ask streaming/session recovery/files/stock compatibility, and local speech. Existing automated results are a baseline; physical phone/glasses checks remain outstanding.
2. Prototype the phone agent, scratchpad and delegation tool behind an experimental setting; measure against the existing remote flow.
3. Add durable background checking and feedback. Test corrections, disconnections, reloads, document switching and runaway tool loops before enabling defaults.
