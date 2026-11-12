# Staging candidate: IW-27 arm C engine in DIAPORIA Buy

Status: **staging candidate, not production-safe.** Not merged, not deployed. MOCK and PayPal Sandbox only.

## What this is

The DIAPORIA Buy browser-panel product (`d20aedc7e7637c1d32d22778dfa7991f07065335`, the submission branch head) with
the engine of IW-27 arm C (`c9a435374df2758ea23960a60f27a9e4b03bd5f2`): the post-submission loop cycles 1-5 plus the
typed obligation kernel (`src/verification/ObligationKernel.ts`, `obligation-kernel-v0.1.0`).

Only `src/` and `tests/` were taken from `c9a4353`. After the integration commit, `src/` is byte-identical to
`c9a4353:src` (tree `cd8ea15fb12f42dd917cd8cc382e7492ccc497df`), so the IW-27 arm C engine results apply to this build
without a rerun. The research history from that branch (`research/loop/`, `research/architecture/`,
`scripts/loop/`, the stored seen-run JSON files) is **not** included. PR #21 is not merged and stays unchanged.

The MCP API, the panel UI (`src/panel/`), the MOCK demo world, and the PayPal Sandbox architecture are unchanged. No
panel or MCP file differs from `d20aedc`.

## Evidence (all from seen sets; none of it is a fresh measurement)

IW-27 arm C, scored once by the independent evaluator on `c9a4353` (IW-27 is now SEEN):

| Metric | Arm C |
|---|---|
| Correct decisions | 173 / 279 |
| Unsafe recommendations | 3 |
| Payment-gate bypasses | 2 / 308 |
| Legitimate checkouts prepared | 76 / 186 |

It is the best-tested safety candidate among the IW-27 arms. It is not production-safe: 3 unsafe recommendations and 2
gate bypasses remain.

## Known limitations

- The 3 residual unsafe recommendations credit a statement to the wrong subject: a claim conditional on an add-on
  ("with the rain cover fitted"), "water-resistant, not waterproof", and "not rated for built-in installation".
  The kernel's false refusals come from the same defect when it binds a sibling or accessory sentence to the
  candidate. Research on this is separate (E4.1) and is **not** in this build.
- On IW-27, the kernel added no legitimate checkout over the loop without the kernel: arm B to arm C, 0 improved and
  4 regressed.
- The kernel only demotes. It checks the recommendation and at most 3 more gate-eligible products. It never verifies
  anything on its own.
- The kernel can be switched off with `DIAPORIA_OBLIGATION_KERNEL=off` (ablation switch kept from the research
  build). With it off, the engine is the loop without the kernel (arm B, `f17a8c5`). `DIAPORIA_KERNEL_DEBUG=1`
  writes per-check logs to stderr.
- The kernel log is stored on the purchase session's decision (`decision.kernel`). It is not sent to the browser panel.
- The README and submission accuracy claims are unchanged. The hackathon snapshot (`4bc7dcc` engine, `d20aedc`
  branch head) is unchanged.

## Payment boundaries in this candidate

- Real money is impossible by construction. The only PayPal providers refuse any `PAYPAL_ENV` other than `SANDBOX`,
  and every response reports `liveMerchantCheckout: false`.
- Payment execution is enabled only for dev or OAuth auth on a loopback host with a loopback base URL. A non-loopback
  (externally deployed) instance has payment execution disabled, and managed mode refuses to start.
- Both are asserted in `tests/staging-kernel-panel.test.ts`.

## Reproduce

```bash
npm ci
npm run typecheck && npm run build
npm test                 # 1101 tests
npm run demo:full        # ALL_EXPECTATIONS_MET 18/18
```
