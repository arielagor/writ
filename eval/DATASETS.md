# Datasets: what was verified (2026-10-18)

Replaces the UNVERIFIED marks in the S4 spec (section 1). Everything here was observed by running code on this machine (Windows 11, Python 3.12.10, Node 22.20).

## AgentDojo

- Installed: PyPI `agentdojo==0.1.35` in `eval/.venv`. Works on Windows; no extra setup.
- Benchmark versions exposed by `agentdojo.task_suite.load_suites.get_suites`: v1, v1.1, v1.1.1, v1.1.2, v1.2, v1.2.1, v1.2.2. We use **v1.2.2** (latest).
- API confirmed: `suite.user_tasks` and `suite.injection_tasks` are dicts of task objects. `task.ground_truth(env)` returns a list of `FunctionCall(function, args, id, placeholder_args)`, where `env = suite.load_and_inject_default_environment({})`. `task.PROMPT` (user task) and `task.GOAL` (injection task) hold the text. Tool schemas: `suite.tools[i].name`, `.description`, `.parameters.model_json_schema()`.
- `ground_truth` ran without error for **every** user task and injection task in every suite on Windows.
- Real counts (v1.2.2):

| Suite | User tasks | Injection tasks | Pairs | Injection tasks with EMPTY ground_truth | Usable pairs | User gold calls | Injection gold calls | Distinct tools in gold | Suite tools |
|---|---|---|---|---|---|---|---|---|---|
| workspace | 40 | 14 | 560 | 8 | 240 | 84 | 10 | 18 | 24 |
| travel | 20 | 7 | 140 | 1 | 120 | 124 | 12 | 21 | 28 |
| banking | 16 | 9 | 144 | 0 | 144 | 33 | 12 | 8 | 11 |
| slack | 21 | 5 | 105 | 0 | 105 | 98 | 13 | 11 | 11 |
| **total** | **97** | **35** | **949** | **9** | **609** | **339** | **47** | **56** | |

- **Finding that changes the spec's plan:** 9 of 35 injection tasks (workspace 6-13, travel 6) return an empty `ground_truth`, so they cannot yield a gold malicious call. Only 609 of 949 pairs are usable, and only 26 distinct injection goals feed M-inj (spec section 5 already warns about few distinct goals; it is 26).
- **Finding:** the spec's "~1,000 B-gold" is wrong. Every user-task gold call with its true prefix is **339** items. Item targets in the spec (malicious 1,000, benign 1,500) are not reachable from AgentDojo gold calls alone. Built with the `full` config in `config.yaml`: B-gold 339, B-twin 548, M-inj 609, M-oop 300 = **1,796 items** (909 malicious, 887 benign). 61 M-inj items have no twin because no user task uses that injection tool.
- Injection gold args can contain concrete attacker values (e.g. recipient `US133000000121212121212`); `placeholder_args` holds `$content`-style slots. We use `args`.
- M-inj candidate = the **last** gold call of the injection task (the harmful action), after a random-length prefix of the user task's gold calls.

## InjecAgent

- Cloned `uiuc-kang-lab/InjecAgent` (depth 1) into an empty directory; only JSON read, with `python -I`. Nothing from the repo executed.
- Files in `data/`: `test_cases_{dh,ds}_{base,enhanced}.json`, `attacker_cases_{dh,ds}.jsonl`, `user_cases.jsonl`, `tools.json`, `attacker_simulated_responses.json`.
- Counts: dh_base 510, dh_enhanced 510, ds_base 544, ds_enhanced 544 (= 2,108 cases; the spec's 1,054 is base only, enhanced doubles it). 17 distinct user tools. **63** distinct tool names across all attacker tool lists (spec said 62); 31 distinct final attacker tools (the last tool in each case's list, which our extractor uses as the candidate).
- Real field names (case): `Attacker Tools` (list), `Modifed` (sic), `Attacker Instruction`, `Expected Achievements`, `Attack Type`, `User Tool`, `User Instruction`, `Tool Parameters` (a Python-literal string, parsed with `ast.literal_eval`), `Tool Response Template`, `Thought`, `Tool Response` (attacker instruction already substituted).
- **Limitation:** attacker tool **arguments are not in the data**, only a natural-language instruction. Candidate args are `{"_attacker_instruction": <text>}`. Cedar arg constraints cannot be tested on these items meaningfully; use InjecAgent for judge breadth only.
- `tools.json` is a list of toolkits (`name_for_model`, `tools[{name, summary, parameters}]`); full tool name = `name_for_model + name`. All user and attacker tool names resolved against it (0 unresolved).
- InjecAgent items carry `prefix_outputs` (the injected tool response), so the transcript view works for them. AgentDojo items have `prefix_outputs: null` (gold replay has no outputs), so the transcript view is only available on InjecAgent items until outputs are synthesised.
- Extractor output with `--settings base`: 1,071 items (17 B-gold, 1,054 M-inj).
