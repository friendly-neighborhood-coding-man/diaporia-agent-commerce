# Public release audit (2026-11-09)

Nothing has been pushed. This audit records what was checked before a possible first public push.

## Tracked files

- All tracked files were written for this repository. Nothing was copied from the private DIAPORIA Buy codebase. Merchants and brands in the fixtures are fictional `.example` domains, except Sony WH-CH720N, which is used with a manufacturer page citation that is labelled as a fixture.
- Searched for local paths (`D:\`, `C:\Users`), user names, email addresses, private folder names and `.env.local` references: none found.
- `npm run scan:secrets` reports no findings. CI also runs gitleaks.
- `.env.example` contains placeholders only. `.data/`, `.env` and `.env.*` are gitignored.

## Public mode cannot touch payments

- Payment execution is enabled only with `dev` auth on a loopback host and a loopback base URL. Otherwise:
  - `prepare_checkout` is not listed.
  - Checkouts created through internal calls go to `HOLD / PUBLIC_PAYMENT_DISABLED`.
  - `/owner/*`, `/authorize/*`, `/paypal/*` and `/mock-paypal/*` all return 403.
  - These cases are covered by tests.
- `public-readonly-demo` exposes research, compare, status and receipt only, and needs no token.
  - **Limitation:** all anonymous callers share one demo identity. Anyone who has a session id can read that research session. Sessions contain only the request text and fixture results.
- MCP tools are listed only when the token carries their scope.

## Mock, Sandbox and live are distinguishable

- Every research, compare, prepare, status and receipt result carries:
  - `paymentEnvironment` (`MOCK` or `PAYPAL_SANDBOX`)
  - `liveMerchantCheckout: false`
  - `dataSource.mockData`
- Mock ids start with `MOCK`, and the mock approval page is labelled "MOCK PayPal — not real, not Sandbox".
- Live PayPal is refused by construction.
- PayPal Agent Ready and Store Sync appear only as interfaces in `src/roadmap/`, with status `NOT_INTEGRATED_ACCESS_DEPENDENT`. They are described in the README roadmap as future, access-dependent integrations.

## License

- MIT is proposed in `LICENSE`. It is not in effect.
- Production dependencies: 95 packages, licensed MIT (85), ISC (7), BSD-3-Clause (2) and BSD-2-Clause (1). None is copyleft or unknown.
- Ownership: the code was authored for the owner in this project. The owner must confirm the copyright holder before MIT is adopted.

## Stranger run

A fresh `git clone` into an empty temp folder was tested with no PayPal or catalog variables set: `npm ci`, `npm test`, `npm run typecheck`, `npm run build` and `npm run demo:e2e`. The results are in TEST_REPORT.md.

## Blockers before a public push

1. Owner approval to create and push the GitHub repository.
2. Owner decision on the license and copyright holder.
3. Optional: the first genuine Sandbox E2E result, so that TEST_REPORT can show live Sandbox evidence.


## Release-candidate audit (2026-11-09, after owner decisions)

- **License.** MIT is active in `LICENSE` (Copyright (c) 2026 Eric Lee Kim). `THIRD_PARTY_NOTICES.md` lists 92 production dependencies: MIT 82, ISC 7, BSD-3 2, BSD-2 1. No copyleft.
- **Ownership.** All source, tests and docs were written for this repository. The Channel3 request/normalization and the Tavily request shape follow the owner's own DIAPORIA Buy V7 integration. No third-party source is vendored. Merchant fixtures are fictional; "Sony WH-CH720N" appears only as a product name and citation.
- **Complete-history secret audit** (all commits, all refs):
  - No `.env*` (except `.env.example`), `.data/`, database or key files were ever committed.
  - Exact-value search across every commit for the local PayPal client id and secret, Channel3, KERNEL and Tavily keys, the Sandbox payee merchant id and email, dev tokens, the owner's email and local profile paths: **none found**.
  - Pattern search (PayPal tokens, private keys, sk-/tvly- keys, generated dev credentials, Windows paths): **none**.
  - The value that triggered the scanner in `d308097` (`tests/service-plane.test.ts`) is a **fake test constant**, renamed in `0f4899d`.
- **Personal data.** Commit metadata carries the owner's personal email as author. Publishing the existing history would expose it; see the push plan.
- **Sandbox evidence.** Docs contain PayPal Sandbox order and capture ids, which are not secrets. They contain no client id or secret, payee merchant id, or buyer or business email.

- **Published history.** Before publication, author and committer emails in every commit were rewritten to the owner's GitHub noreply address. File contents are unchanged. Commit hashes cited in these docs refer to the published history.
