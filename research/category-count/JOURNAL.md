# Category-count experiment journal (SEEN development only)

## Round 1: prompt v1.0 (commit 735e5d7), 2026-11-12 19:28–20:05Z
- Haiku: 2,958 trial-1 calls (6 arms x 493 requests) plus 2 x 480 repeat calls on the 80 gold requests. 100% schema-valid; every call reports `claude-haiku-5-5`.
- Phase 2 (443 seen cases), fully correct: A0 254, C2 288, K3 287, K4 289, K5 288, K6 291, K7 290, K3F 283. Unsafe: A0 3, C2 3, K arms 5–7.
- All K-vs-C2 differences are within ±1.2pp, with McNemar p ≥ 0.44.
- **Safety screen (SELECTION-RULE §1): every K arm fails.** The new unsafe cases are 23:a13, 23:a14, 25:a14 and 25:a27. They all have one mechanism, which affects every arm: a post-posed part noun ("가람 GR-3 철판", "소래 DS-24 수저통", "Karino MG-8S grinding plate set") is read as STANDALONE or UNKNOWN, with the host's brand and model as the item.
  - The v0.2 kind check then passes, because both readings say standalone (preregistered risk U2). The host is locked and recommended.
  - The K documents lose the ACCESSORY reading on 15–19 requests where the C2 fixture had it.
  - Cause: the shared prompt. Its only Korean example is a brand + model + post-posed product noun that is STANDALONE, and no example shows a post-posed accessory. This is not a category-count effect.
- Phase 1 (80 gold requests x 3 trials): parse-correct per trial ranges from 48–57/80 in every arm. Run-to-run spread within an arm (up to ±4) is as large as the spread between arms. Kind errors dominate.
- Artifacts: /mnt/project-files/agent-commerce-research-v2/category-count/round1-prompt-v1.0/.

## Prompt v1.1 (shared, arm-symmetric fix chosen after reading the round-1 seen failures: disclosed tuning)
- One rule paragraph on accessory identity: a post-posed part means ACCESSORY with a host, and a part named "set" or "kit" is still the accessory.
- One new example, "Varnell Okta 3 footprint", inserted identically into every arm.
- Schema fields unchanged. The version label is bumped to v1.1.0 to mark the prompt change.
- Every arm reruns all trials under v1.1. Round-1 numbers stay as recorded above.

## Round 2: prompt v1.1, 2026-11-12 20:10–20:35Z
- Downstream (trial 1): K3 280, K4 284, K5 281, K6 282, K7 283, K3F 282. Unsafe: 3, 4, 3, 3, 4, 3. The selection rule gives K3 (selected), K3F (best) and K7 (largest) as finalists. Frozen at a929a44, IW-29 preregistered.
- Phase 1 kind errors rose under v1.1, because brand+model requests with no product noun are now read as UNKNOWN. Tolerant scoring is reported alongside, defined after seeing outputs.
- Repeat trial (second generation, finalists only, scored after the freeze): K3 282 / 3 unsafe, K3F 278 / 4 (a27), K7 281 / 3. A one-case unsafe difference is within generation noise.
- IW-29 evaluator requested via coordinator, about 20:50Z.

## IW-29 (fresh, independent evaluator), scored 2026-11-12 ~21:00Z
- Fully correct: A0 82, C2 86, K3 81, K3F 83, K7 78 of 132. Unsafe: 2 / 1 / 1 / 1 / 1. Bypass: 1 / 0 / 0 / 0 / 0.
- Recommended K is K3. The category schema adds no value over v1.1. Predictions: 3 hit (one vacuous), 5 miss. See IW29-SCORING.md. IW-29 is SEEN.
