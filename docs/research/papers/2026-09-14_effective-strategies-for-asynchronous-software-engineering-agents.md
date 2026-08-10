# Study Report on *Effective Strategies for Asynchronous Software Engineering Agents*

## Report Scope

- **Paper:** Jiayi Geng and Graham Neubig, *Effective Strategies for Asynchronous Software Engineering Agents*.
- **Versions reviewed:** [arXiv:2603.21489v1](https://arxiv.org/html/2603.21489v1), submitted on 2026-03-23, and [arXiv:2603.21489v2](https://arxiv.org/html/2603.21489v2), revised on 2026-07-08.
- **Research date:** 2026-09-14.
- **Code version:** Commit `f364d9e95727c2e2ba3dbf23f2d6de52c5f3d5fa` from [JiayiGeng/CAID](https://github.com/JiayiGeng/CAID).
- **Version boundary:** The discussion of mechanisms and conclusions primarily follows the latest v2, with a line-by-line audit of numerical corrections from v1 to v2.

This report reviews the main text, figures, per-task results, one-sided paired t-tests, and failed high-parallelism cases in both v1 and v2.

It also examines the authors’ public code and prompts to distinguish the paper’s claims, observable implementation behavior, and this report’s inferences.

## One-Sentence Conclusion

CAID’s most valuable insight is not that adding more agents automatically improves results, but that collaborative work on one repository should be turned into a version-control problem with a dependency graph, explicit ownership, isolated worktrees, serialized integration, and executable verification.

Experiments in both versions support two conclusions: physical workspace isolation is better than relying only on prompts to prevent conflicts, and excessive parallelism harms outcomes.

However, CAID uses roughly 2.2 to 3.8 times as many actual iterations, usually incurs higher API costs, and is slower than a single agent in every primary configuration.

It therefore demonstrates a quality-and-reliability tradeoff rather than a general advantage under equal compute or an end-to-end speedup.

Version 2 corrects several abstract, cost, and figure values from v1, but it does not correct the 20 per-paper PaperBench MiniMax 2.5 scores.

As a result, the latest version’s headline `+25.6` gain still cannot be reproduced from its published table.

## Evidence Labels

- **Direct evidence from the paper:** Information explicitly stated in the text, tables, figures, or appendices of v1 or v2.
- **Direct evidence from the code:** Behavior directly observable in the public CAID repository at the commit listed above.
- **Inference in this report:** An interpretation based on the experimental design, numerical checks, or system mechanisms rather than a fact demonstrated by the authors.

## 1. What Problem Does the Paper Address?

Long-running software engineering tasks involve more than writing a large amount of code.

The real difficulty is that multiple dependent subtasks must be completed incrementally in the same repository, and any local change can alter the assumptions underlying other work.

If two agents edit a shared directory concurrently, one might rename a function while the other still depends on the old name.

Both changes may look reasonable in isolation, but the integrated program can fail.

The paper divides these failures into three core problems.

1. Concurrent modifications can overwrite one another or create conflicts.
2. Dependencies between subtasks are difficult to synchronize.
3. Locally correct results do not necessarily form a globally correct system.

The authors’ key shift is to stop relying only on natural-language instructions telling agents to cooperate and instead use collaboration infrastructure already established in human software teams.

This infrastructure includes dependency graphs, Git branches, Git worktrees, commits, merges, conflict resolution, and tests.

## 2. CAID’s Core Design

CAID stands for **Centralized Asynchronous Isolated Delegation**.

It consists of one central Manager and multiple Engineer agents.

Centralization gives one role a global view of the task and integration authority instead of asking equal peers to coordinate through unrestricted conversation.

Asynchrony allows independent work to proceed concurrently, with the first agent to finish integrated and assigned new work immediately.

Isolation gives every Engineer a separate Git worktree so that incomplete changes do not directly contaminate another Engineer’s workspace.

### 2.1 Dependency Graph

The Manager first represents repository work as a directed graph `G = (V, E)`.

Each node is a unit of work, and an edge `(v_i, v_j)` means that `v_j` depends on `v_i`.

If `C_t` is the set of nodes completed and merged into the main branch by round `t`, work can be delegated only when all its predecessors are in `C_t`.

Formally:

```text
Ready_t(v_j) ⇔ for every (v_i, v_j) ∈ E, v_i ∈ C_t
```

This condition turns “can this be done now?” from an agent’s situational guess into scheduling state that can be updated and checked.

For Commit0, the Manager estimates file or function dependencies from imports, test collection results, and test-to-file relationships.

PaperBench has no explicit test-to-file mapping, so the Manager must read the paper and derive the dependency order for reproduction work.

The latter setting is more open-ended and depends more heavily on the Manager’s planning ability.

### 2.2 Delegation Principles

The Manager creates at most `N` primary work groups, where `N` is the maximum number of Engineers that can work concurrently.

It does not have to start every Engineer merely to fill all available slots.

Highly coupled, cyclically dependent work, or work likely to modify the same file, should be placed in one group and assigned to one Engineer.

Priority tends to favor upstream dependencies, work that enables earlier testing, or work that can expose evaluation signals sooner.

The best unit of decomposition is therefore not the smallest possible unit.

It must be independent enough for parallel execution while preserving one agent’s complete ownership of a cohesive local module.

### 2.3 Worktree Isolation and Main-Branch Integration

Each Engineer receives an independent branch and Git worktree created from a consistent main-branch state.

Shared files such as `__init__.py` can be marked as restricted to reduce common conflicts.

An Engineer implements changes, runs tests, and creates commits in its own worktree.

The Manager is the integration hub that merges completed branches back into the main branch, which serves as the sole source of integrated truth.

A normal merge conflict is returned to the original Engineer, which pulls the latest main branch into its worktree, resolves the conflict, and commits again.

The public Commit0 implementation also has a recovery mechanism that can collect uncommitted changes from an Engineer without a commit and then attempt integration with `git merge -X theirs`.

A code comment describes this forced strategy as appropriate when the Engineer has no rounds remaining, but the actual call site does not check the remaining rounds.

Actual CAID behavior therefore includes a Manager fallback for rescuing incomplete work rather than relying solely on a clean commit-based signaling protocol.

### 2.4 Structured Communication and Event Loop

The Manager uses JSON to assign Engineers, tasks, files, functions, requirements, and dependencies instead of relying on free-form agent conversation.

Each Engineer runs model calls, file changes, and verification commands in an independent coroutine.

The event loop waits for the first task to complete.

When an Engineer finishes, the Manager collects and merges the result, updates dependency state, and then decides whether to reassign, idle, or stop that Engineer.

The public code shows that the Commit0 Manager also performs background exploration while Engineers work, but cancels this exploration and returns to integration when the first Engineer finishes.

The Manager compresses its conversation history with `LLMSummarizingCondenser` while retaining structured state such as the dependency graph, completed tasks, and unresolved errors.

### 2.5 Verification and Termination

Before committing, an Engineer must run tests related to the modified files or at least execute the repository’s default tests and a minimal runnable entry point.

The process terminates when all dependency nodes have been completed and merged or when the round and iteration limits are exhausted.

The paper treats the task as incomplete if limits are exhausted while unfinished nodes remain.

The paper repeatedly describes the process as “test-gated integration,” but Section 2.5 primarily requires Engineers to perform local verification before merging.

The public implementation’s normal `collect_and_merge` path does not rerun the full integration test suite after every merge and instead performs overall evaluation only at the end.

A more precise description is therefore “pre-commit local verification, explicit merging, and final testing,” not a CI gate protecting every main-branch merge.

## 3. Experimental Design

### 3.1 Benchmarks

**Commit0-Lite** asks an agent to implement a Python library from a repository skeleton, and the complete tables in both versions contain 16 libraries.

The tables use the percentage of tests passed for each repository, which produces partial scores such as `1.5`, `53.1`, and `92.1`.

This differs from the text’s binary statement that success requires all tests to pass.

The headline score should therefore be understood as the average test pass rate rather than the percentage of repositories completed.

**PaperBench Code-Dev** asks an agent to reproduce the primary code and results of a research paper, and the complete tables in both versions contain 20 papers.

Because full PaperBench was too expensive, the authors use the Code-Dev protocol and GPT-5-mini as an LLM judge.

The PaperBench score is therefore an LLM-assessed functional completeness score rather than a result produced entirely by reproduced experiments or deterministic tests.

### 3.2 Models and Agent Substrate

CAID is built on OpenHands Agent SDK v1.11.0.

The authors evaluate Claude Sonnet 4.5, GLM 4.7, and MiniMax 2.5.

The single-agent and CAID configurations use the same underlying model and OpenHands substrate, making the comparison more credible than directly comparing leaderboard results from different frameworks.

The single agent has a `max_iterations` limit of 100.

CAID allows 50 Manager iterations, 80 iterations for each Engineer, and two rounds of work assignment.

PaperBench uses 2 Engineers, while Commit0 uses 4 Engineers.

### 3.3 This Is Not an Equal-Compute Comparison

The Table 2 caption claims that configurations use the same model and iteration budget, but the full table shows different actual total iteration counts.

CAID uses approximately 2.2 to 3.8 times the average total iterations of a single agent.

For example, Claude Commit0 rises from 84.5 to 313.3 iterations, while MiniMax PaperBench rises from 58.3 to 180.6.

The experiment therefore controls the underlying model and agent framework, not total model calls, total tokens, total dollar cost, or total iterations.

CAID’s quality gains may come from a combination of better coordination, more sampling, and more computation, and the primary experiment cannot fully separate those factors.

## 4. Main Results

The following values faithfully reproduce the single-agent and direct CAID results in the latest v2 Table 2.

Section 6 compares corrections between versions and the remaining conflict.

### 4.1 PaperBench

| Model | Single-agent score | CAID score | Score difference | Single-agent time | CAID time | Single-agent cost | CAID cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Sonnet 4.5 | 57.2 | 63.3 | +6.1 | 1803.5s | 2080.4s | $3.3 | $6.5 |
| MiniMax 2.5 | 10.5 | 36.1 | +25.6 | 2525.3s | 3042.4s | $1.1 | $2.6 |
| GLM 4.7 | 38.0 | 45.4 | +7.4 | 1177.6s | 1449.4s | $2.8 | $4.7 |

All three models appear to improve, but every CAID configuration is slower and more expensive.

MiniMax’s `+25.6` is the most striking value and also the result with the most serious data conflict between versions.

### 4.2 Commit0-Lite

| Model | Single-agent score | CAID score | Score difference | Single-agent time | CAID time | Single-agent cost | CAID cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Sonnet 4.5 | 53.1 | 59.1 | +6.0 | 692.6s | 1583.2s | $1.9 | $8.1 |
| MiniMax 2.5 | 42.3 | 57.0 | +14.7 | 752.1s | 1908.7s | $1.6 | $4.5 |
| GLM 4.7 | 42.9 | 46.5 | +3.6 | 871.0s | 1387.8s | $2.5 | $7.3 |

Commit0 shows a consistent direction of quality improvement, but CAID takes approximately 1.6 to 2.5 times as long and costs approximately 2.8 to 4.3 times as much as a single agent.

This creates tension with the paper’s original motivation of timely completion.

### 4.3 Running a Single Agent First and CAID After Failure

The authors also evaluate `Single-Agent + CAID`, which simulates trying a single agent first and using CAID as a fallback.

Its time and cost are close to the sum of two runs, while its score is generally only close to direct CAID.

This supports a limited but practical conclusion.

If a task is known to be long-running, dependent, and centered on a shared artifact, it is better to choose a coordinated mode from the start than to spend a complete single-agent budget first.

It does not imply that every task should default to multiple agents because the paper does not establish a classifier that identifies suitable tasks before execution.

## 5. Ablations and Case Studies

### 5.1 Effect of Worktree Isolation

Table 3 compares physical worktree isolation with soft isolation, where all Engineers share one directory and rely only on prompts to avoid conflicts.

PaperBench scores are `57.2` for a single agent, `55.5` for soft isolation, and `63.3` for worktree isolation.

Commit0 scores are `53.1` for a single agent, `56.1` for soft isolation, and `59.1` for worktree isolation.

This is the paper’s most convincing evidence for CAID’s core mechanism because the difference between soft isolation and worktree isolation directly targets interference in a shared workspace.

However, the table’s values match only the primary Claude Sonnet 4.5 results, the caption does not identify the model explicitly, and the ablation is not repeated for the other two models.

The reasonable conclusion is therefore that physical isolation helps in this apparently Claude-based configuration, not that every model and task has proven worktrees necessary.

### 5.2 Letting a Single Agent Run Longer

Figure 2 compares single-agent limits of 100 and 200 iterations.

In v2 Figure 2, the PaperBench score changes are Claude `-3.0`, GLM `+1.5`, and MiniMax `+2.8`, while the plotted CAID gains over the 100-iteration baseline are `+6.1`, `+7.4`, and `+25.6`.

In v2 Figure 2, the Commit0 score changes are Claude `+5.8`, GLM `+0.5`, and MiniMax `-1.2`, while the plotted CAID gains are `+6.0`, `+3.6`, and `+14.7`.

This shows that simply raising the iteration limit does not guarantee that an agent will use the additional budget effectively.

However, CAID still uses more actual total iterations, so this is not a strict equal-compute control.

### 5.3 More Parallelism Is Not Always Better

Figure 3 shows that Commit0 improves when the number of Engineers rises from 2 to 4, but its score falls and cost increases at 8 Engineers.

PaperBench gains almost no additional score from increasing the number of Engineers from 2 to 4 or 8, while time and cost continue to rise.

The SimPy case in Appendix D is more concrete.

With 4 Engineers, the Manager gives different people ownership of separate files such as `events.py`, `core.py`, `container.py`, and `resource.py`, producing a score of `92.1%`.

With 8 Engineers, multiple people receive different functions in the same `events.py` file, fragmenting responsibility too finely and reducing the score to `44.3%`.

The true capacity limit is not the number of agents but the task’s divisibility and the Manager’s ability to maintain coherent ownership boundaries.

### 5.4 Critical Dependencies Matter More Than Work Volume

In the Minitorch case, two CAID runs both start multiple Engineers but score only `8.7%` and `34.3%`, respectively.

The better run gives a dedicated Engineer continuing responsibility for the critical upstream file `autodiff.py`, while the worse run never delegates that file at all.

This shows that “everyone is busy” is not a useful progress metric.

What matters is whether critical dependencies have been unblocked.

### 5.5 Tradeoff Between Verification Strength and Efficiency

On a Commit0 subset, Manager review after every round scores `60.2%` but takes `3689.1s`.

Engineer self-verification scores `55.1%` and takes `2243.9s`.

An explicit efficiency-first instruction scores `54.0%` and takes `1908.6s`.

This supports a quality-cost frontier in which stronger verification is generally more reliable but slower, rather than a free option that is simultaneously faster, cheaper, and more accurate.

Version 1 incorrectly described nine repositories and misspelled `simpy` as `simply`.

Version 2 corrects these to eight repositories and the proper name.

## 6. Statistical Evidence and Cross-Version Consistency Audit

### 6.1 Statistical Tests Reported by the Authors

Appendix C performs a one-sided paired t-test for each benchmark and model under the hypothesis that CAID scores higher than a single agent.

| Benchmark | Model | Mean difference | t | p | v2 conclusion |
| --- | --- | ---: | ---: | ---: | --- |
| Commit0 | Claude 4.5 | +6.0 | 2.87 | 0.006 | Significant |
| Commit0 | GLM 4.7 | +3.6 | 1.37 | 0.095 | Not significant |
| Commit0 | MiniMax 2.5 | +14.7 | 2.81 | 0.007 | Significant |
| PaperBench | Claude 4.5 | +6.1 | 1.78 | 0.046 | Significant |
| PaperBench | GLM 4.7 | +7.4 | 1.93 | 0.034 | Significant |
| PaperBench | MiniMax 2.5 | +25.6 | 5.27 | `<0.0001` | Significant, but conflicts with the per-paper table |

Five of the six v2 comparisons are significant at an uncorrected `p < 0.05` threshold.

A conservative Bonferroni correction would set the threshold near `0.0083`, apparently retaining Commit0 Claude, Commit0 MiniMax, and PaperBench MiniMax.

However, the final result cannot be reproduced from v2’s per-paper data.

Neither version reports repeated runs across random seeds, confidence intervals, or run-level variance.

The paired tests therefore primarily measure the average difference across this set of tasks and do not capture stochastic variation between agent runs.

### 6.2 Major Cross-Version Conflict in MiniMax PaperBench

Version 2 makes the abstract, Table 2, Figure 2, the Table 9 AVERAGE row, and Table 10 consistently claim a gain of approximately `+25.6`.

However, the 20 per-paper values in Table 9 are unchanged from v1 and still average to a gain of only `+0.825`.

| Source | v1 | v2 |
| --- | ---: | ---: |
| Abstract difference | +26.7 | +25.6 |
| Table 2 | 10.4 → 36.7, +26.3 | 10.5 → 36.1, +25.6 |
| Figure 2 difference | +26.6 | +25.6 |
| Displayed AVERAGE in Table 9 | 10.5 → 36.1, +25.6 | 10.5 → 36.1, +25.6 |
| Recomputed average of the 20 visible per-paper values in Table 9 | 8.125 → 8.95, +0.825 | 8.125 → 8.95, +0.825 |
| Paired t-test in Table 10 | +0.8, `t = 0.23`, `p = 0.408` | +25.6, `t = 5.27`, `p < 0.0001` |

Version 1’s statistical test agrees with the visible per-paper data but not with its headline aggregate.

Version 2 rewrites the statistical test and headline aggregate without replacing the per-paper scores that are supposed to support them.

The per-paper `Single+CAID` values in Table 9 average to `27.4` in both versions, not the displayed `36.7`.

This may mean the appendix’s per-paper scores are stale or that the abstract and aggregate values come from another unpublished set of results, but the current versions do not reveal which side is correct.

Until the authors publish a corrected per-paper table or reproducible raw outputs, the MiniMax PaperBench result should be marked unverified rather than accepted merely because v2’s summaries agree with one another.

### 6.3 Other Issues Corrected in v2

Version 2 changes the largest PaperBench and Commit0 gains in the abstract to `25.6` and `14.7`, aligning them with the revised Table 2 aggregates.

It changes Claude PaperBench CAID and `Single+CAID` costs from `$9.3` and `$12.6` to `$6.5` and `$9.7`, matching Appendix Table 7.

Version 2 also corrects GLM Commit0’s `42.8`/`42.9`, several Figure 2 deltas, minor runtime and cost rounding, and the names and count of the eight repositories.

Most importantly, the Table 2 caption changes from “same iteration budget” to “fixed per-configuration iteration budgets,” acknowledging that the configurations do not use equal total iterations.

These corrections improve the consistency of v2’s main text but do not resolve the underlying per-paper evidence conflict for MiniMax PaperBench.

## 7. Strengths of the Paper

### 7.1 Treating the Shared Artifact as System State

CAID does not reduce collaboration to agents exchanging text.

It requires all progress to be integrated through versioned artifacts.

Git can therefore expose conflicts explicitly, and every result has a traceable source, branch, and commit.

### 7.2 Clear Position on Ownership and Dependencies

The paper correctly argues that work decomposition must consider both the dependency graph and write boundaries.

The SimPy and Minitorch cases connect this claim to concrete failure trajectories rather than only final average scores.

### 7.3 Comparison on a Fixed Substrate

The single-agent and CAID configurations use the same models and OpenHands SDK, avoiding the most severe cross-framework confounding.

This at least demonstrates that changing the execution architecture can change outcomes within the same substrate.

### 7.4 Publicly Available Runnable Code Skeleton

The public repository provides a dependency lockfile, task modules for both benchmarks, prompts, execution scripts, event logs, cost output, and evaluation interfaces.

This is more valuable for research than describing a concept without publishing an implementation.

## 8. Main Limitations

### 8.1 CAID Is a Bundled Intervention That Cannot Be Attributed Only to Branch-and-Merge

The primary comparison simultaneously adds Manager planning, multi-agent sampling, structured prompts, more total iterations, worktrees, merging, reassignment, history compression, and final review.

The worktree-versus-soft-isolation ablation is useful, but it covers only one apparently Claude-based configuration and does not separate the individual contributions of dependency planning, dynamic reassignment, extra compute, and the merge protocol.

“The complete CAID system performs better” is therefore more consistent with the evidence than “branch-and-merge is the sole cause of the gain.”

### 8.2 No Strong Equal-Cost or Equal-Token Single-Agent Baseline

Increasing the single-agent limit from 100 to 200 is a useful supplement, but it still does not match actual tokens, dollars, wall-clock time, or sample count to CAID.

A stronger control would give a single agent the same total cost for multiple independent attempts, best-of-N selection, sequential correction, or test-guided search.

### 8.3 Asynchrony Does Not Produce End-to-End Speedup

Every CAID configuration in Table 2 is slower than its single-agent counterpart.

Contributors include the Manager’s initial exploration, serialized merges, conflict resolution, repeated testing, and final review.

CAID’s value is therefore that it converts more compute into quality in a more organized way, not that it currently completes work sooner.

### 8.4 The Manager Is a Single Point of Failure

If the Manager misses a critical dependency such as `autodiff.py`, all local Engineer effort may lose its value.

As the number of Engineers grows, the Manager must also track more state, ownership, completion events, and conflicts, amplifying coordination errors.

Centralization reduces peer-to-peer confusion but concentrates correctness pressure in one planner.

### 8.5 Test Gates Remain Incomplete

Passing local tests on an Engineer’s branch does not prove that the merged main branch remains correct.

If affected integration tests are not rerun after every merge, cross-branch interface inconsistencies can accumulate until the final evaluation.

The paper’s design principle is worth retaining, but the implementation needs a true post-merge CI gate to fulfill it completely.

### 8.6 Limited Benchmark Generalization

Commit0 builds Python libraries from skeletons, which does not represent maintaining existing behavior in mature, multilingual, continuously changing production repositories.

PaperBench Code-Dev is an open-ended reproduction task evaluated by an LLM judge rather than the complete PaperBench pipeline.

The paper does not test long-term branch drift, many contributors editing hot files, large CI systems, nondeterministic tests, security permissions, or real pull-request review.

### 8.7 Reproducibility Gaps

The public code contains only a small number of commits, has no release tag, and does not include the outputs, run-level traces, or cost files used in the paper’s tables.

The latest code commit is dated 2026-04-01, before v2 on 2026-07-08, and neither paper version identifies its corresponding artifact revision.

The repository has no automated tests of its own, and the README’s clone command still uses the `<your-org>/async-swe-agents.git` placeholder.

Commit0 and PaperBench data and the PaperBench judge must also be installed from external sources.

The code architecture can therefore be inspected, but the experimental results cannot be reproduced or audited directly from the repository alone.

## 9. Practical Implications for Coding-Agent Systems

### 9.1 When a CAID-Like Design Is Appropriate

Suitable tasks generally have identifiable module boundaries, dependencies that can be represented, writable scopes that can be isolated, and executable verification methods.

Unsuitable tasks include work concentrated in one highly coupled file, unclear requirements, missing reliable tests, or situations where the Manager cannot identify the critical path.

### 9.2 Recommended Minimum Safe Protocol

1. The Manager should first produce a machine-verifiable task DAG, file ownership map, allowed write paths, and acceptance commands.
2. Every worker should use an independent branch and worktree and must not write directly to the main workspace.
3. A file should preferably have only one owner at a time unless a provably non-overlapping generation process exists.
4. A worker should run local tests before committing, and the Manager should run affected integration tests after merging.
5. After every `await` or worker completion event, the Manager must reread the main-branch HEAD, dependency state, and current ownership instead of reusing stale assumptions.
6. Conflicts should return to the original worker for resolution, while `-X theirs` should be only a documented and reverified last resort.
7. Parallelism should start small and adjust dynamically based on ready-queue width, conflict rate, idle time, and Manager load.
8. Evaluation should jointly report quality, total tokens, total cost, wall-clock time, actual iterations, conflict rate, failed merges, and post-merge test results.

### 9.3 Benefits Directly Applicable to `pi-subagents`

CAID’s greatest value for `pi-subagents` is not proof that it should add more workers, but repository-level positive evidence for its existing conservative coordination mechanisms.

| CAID mechanism | Benefit for `pi-subagents` | Relationship to the current implementation |
| --- | --- | --- |
| Central Manager and dependency graph | Starting only work whose dependencies are complete prevents workers from guessing or repeating work before prerequisite artifacts exist. | `WorkItemLedger` and `AdaptiveScheduler` already support a dependency-ready queue, critical-path priority, and artifact versions. |
| One Engineer owns strongly coupled work | File-level or cohesive-scope ownership reduces parallel edits to the same file and subsequent merge rework. | The scheduler already checks read/write scopes and `ownershipKeys` conflicts, and CAID supports retaining “one mutating owner per file at a time” as the conservative default. |
| Structured JSON delegation | Explicitly transmitting goals, dependencies, allowed paths, acceptance criteria, and artifacts is easier to validate, persist, and replay than free-form conversation. | `pi-subagents` already has a versioned delegation contract, `ExecutionPlan`, typed artifacts, and `structured-v2` results that can directly capture this benefit. |
| Physical worktree isolation | Intermediate worker changes cannot overwrite another worker’s state, while branches, commits, and patch digests preserve provenance. | Detached agents can already use disposable worktrees, but blocking workflow worktree execution in `subagent_auto` still fails closed, making this the highest-value gap for a matched experiment. |
| First-completed asynchronous loop | A worker that finishes early can immediately release its slot, submit artifacts, and trigger the next ready task without waiting for the slowest worker in the batch. | Detached lifecycles, completion delivery, and the ready queue provide a foundation for event-driven workflows that reduce idle time. |
| Single integration controller | Giving only the Manager permission to update the canonical branch centralizes handling of stale bases, dependency versions, scopes, patch digests, and merge order. | `integration-controller.ts` can already validate candidate results with fail-closed behavior, but Manager-owned patch application remains incomplete, and CAID supports treating it as an explicit integration boundary. |
| Post-merge verification | Self-verification on a worker branch cannot prove that the integrated tree is correct, while a fresh verifier can catch cross-branch API or import inconsistencies. | The existing workflow verifier already requires a fresh context and the exact integrated tree and should remain the acceptance gate for mutating workflows. |
| Small, dynamic parallelism | Treating concurrency as a ceiling rather than a target avoids the overly fine decomposition, conflicts, and uncontrolled costs seen with eight Engineers. | Existing autonomous workflows permit at most two concurrent mutating workers, which fits the paper’s negative scaling evidence better than copying CAID configurations with 4 or 8 workers. |
| Joint quality, cost, and time observability | Recording scores, iterations, cost, runtime, and conflicts together reveals whether an additional worker is worthwhile. | `orchestration-metrics` and execution usage provide a foundation, but any default change should first pass matched-budget, repeated-seed evaluation. |

The benefits that `pi-subagents` can preserve immediately are dependency-ready scheduling, cohesive ownership, typed handoffs, a small mutating concurrency width, and fresh verification.

The most valuable combination to test next is explicit workflow worktree execution, a unique integration owner, stale-result rejection, and post-merge tests because it most closely matches the worktree isolation supported by CAID’s direct ablation evidence.

The paper does not support making multi-agent execution the default because CAID lacks an equal-compute comparison, provides no end-to-end speedup, and still has inconsistent per-paper MiniMax PaperBench evidence.

### 9.4 Most Important Design Principle

Isolation eliminates the problem of agents concurrently corrupting one another’s workspace, but it creates the problem that they cannot see one another’s latest state.

A worktree is therefore not a complete answer by itself and must be combined with clear handoffs, main-branch synchronization, dependency revalidation, and post-merge testing.

## 10. Final Assessment

The paper presents an engineering direction that is both reasonable and easy to understand: constrain multiple agents with mature software engineering primitives instead of expecting natural-language cooperation to become reliable by itself.

For system design, its most credible findings are that worktree isolation outperforms soft isolation, file ownership is more stable than excessively fine function-level decomposition, critical dependencies matter more than an even distribution of work, and too many Engineers create a coordination tax.

For effect size, both versions show that CAID can exchange more computation for higher average quality on some long-running shared-artifact tasks, but they do not demonstrate an equal-cost advantage or shorter wall-clock time.

For research credibility, v2 corrects Claude costs and several aggregate values, but the MiniMax PaperBench per-paper table conflict and the absence of repeated runs remain major cautions.

CAID should therefore be treated as a coordination architecture worth implementing and evaluating further, not as conclusive evidence that asynchronous multi-agent systems generally outperform single agents.

## References

- [arXiv v1 HTML](https://arxiv.org/html/2603.21489v1).
- [arXiv v2 HTML](https://arxiv.org/html/2603.21489v2).
- [arXiv metadata and version history](https://arxiv.org/abs/2603.21489v2).
- [Public CAID code](https://github.com/JiayiGeng/CAID).
- [CAID artifact commit `f364d9e`](https://github.com/JiayiGeng/CAID/commit/f364d9e95727c2e2ba3dbf23f2d6de52c5f3d5fa).
