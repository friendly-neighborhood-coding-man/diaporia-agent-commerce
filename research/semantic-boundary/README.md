# Semantic boundary diagnosis (diagnostic prototypes only)

This branch asks why the Haiku 5.5 hybrid parser (`b917bff`, `hybrid-adapter-v1.0.0`) produced only a small end-to-end
purchasing gain. It is a diagnosis, not a candidate build.

- **Nothing here is wired into any default path.**
- The baseline engine, evidence, checkout and payment policies are unchanged.
- The only runtime edit is an optional diagnostic `merge` hook on the hybrid interpreter, in
  `CommerceGateway.interpretIntent`. When the hook is absent, behaviour is the frozen b917bff behaviour.

All results were measured on an already-seen holdout. They are in-sample evidence only and are never a fresh result.
The case-level records are kept outside the public repository.

## What is here

- **`ts-contract.v0.1.0.json`** lists the expressions the TypeScript parser and evidence engine genuinely support. Each
  form gives one of two things:
  - a text form, which the real parser must turn into the expected key, or
  - a typed-only key, which the engine evaluates but no request text produces.

  Each form also gives evidence probes that the real `clauseStatement` must answer. It then lists unsupported
  capabilities, which are never approximated. `verify-contract.mts` checks every example.
- **`PROMPT_CONTRACT_V1.txt`** is the contract-aware interpreter prompt (arm B). Its assembler is
  `src/intent/hybrid/contract/ContractIntent.ts`:
  - each restated phrase is verified with the real parser;
  - anything unverified or unsupported keeps the parser's own reading, so it fails closed;
  - money and condition come only from the parser.
- **`src/intent/hybrid/typed/TypedSemanticIntent.ts`** is the typed adapter prototype (arm C). It runs the v1 adapter
  first, then replaces what v1 produced for a span, using the interpreter's typed fields (numeric op, value and unit,
  subject, product-type span). Each replacement is independently validated:
  - the span is verbatim;
  - the number is written in the span;
  - the key words come from the span;
  - nothing loosens a parser MUST;
  - "=" stays fail-closed.

## Findings (aggregate)

These cover the 75 failed legitimate purchases of the current hybrid on the seen holdout. Each failure is counted
once, at its first responsible boundary:

| First responsible boundary | Failures |
|---|---|
| Adapter | 33 |
| Downstream evidence or identity engine | 22 |
| Representation | 15 |
| Interpreter error | 5 |

Injecting the correct requirement, in its best supported form, recovers 43 of the 75 on the unchanged engine.

| Arm | Legitimate checkouts (of 140) | Unsafe outcome vs. the current hybrid |
|---|---|---|
| Current hybrid | 65 | — |
| Typed adapter | 82 | no new unsafe outcome |
| Contract-aware interpreter | 74 | one new unsafe outcome, from an existing engine weakness it exposed |

The causes are spread across boundaries. A text contract alone cannot reach the typed forms. The engine bounds the rest.
