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

- MIT is proposed in `LICENSE.MIT.proposed`. It is not in effect.
- Production dependencies: 95 packages, licensed MIT (85), ISC (7), BSD-3-Clause (2) and BSD-2-Clause (1). None is copyleft or unknown.
- Ownership: the code was authored for the owner in this project. The owner must confirm the copyright holder before MIT is adopted.

## Stranger run

A fresh `git clone` into an empty temp folder was tested with no PayPal or catalog variables set: `npm ci`, `npm test`, `npm run typecheck`, `npm run build` and `npm run demo:e2e`. The results are in TEST_REPORT.md.

## Blockers before a public push

1. Owner approval to create and push the GitHub repository.
2. Owner decision on the license and copyright holder.
3. Optional: the first genuine Sandbox E2E result, so that TEST_REPORT can show live Sandbox evidence.
