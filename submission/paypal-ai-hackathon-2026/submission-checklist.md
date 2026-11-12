# Submission checklist (PayPal AI Hackathon, Devpost)

Deadline: **Thursday 2026-11-12, 12:00 PT = 20:00 UTC = Friday 2026-11-13, 05:00 KST.** Rules: https://paypalaihackathon.devpost.com/rules (read 2026-11-12).

## Official requirements

| Requirement (from the rules) | Status | Evidence |
|---|---|---|
| Integrates the PayPal developer platform (free Sandbox) with an AI tool | Done | PayPal Orders v2 Sandbox adapter, two recorded Sandbox runs (docs/TEST_REPORT.md); AI hosts call DIAPORIA over MCP |
| Newly created or significantly updated during the Submission Period | Done | Repository created 2026-11-09 |
| Text description of features and functionality | Ready | `devpost-description.md` |
| Functional demo judges can run: complete setup and run instructions in the repo | Done | README quick start, `docs/SETUP.md`, testing instructions in `devpost-fields.md`; no credentials needed (MOCK) |
| Public repository on GitHub with an open-source license visible in the About section | Done | Public; MIT detected by GitHub (`license.spdx_id: MIT`) |
| Repository has all source, assets and instructions | Done | `npm ci && npm test && npm run demo:full` on a clean checkout |
| Demo video under 3 minutes | Done | 2:52.7 |
| Video shows the project functioning on its platform | Done | live take of build `be03b52` |
| Video uploaded to YouTube, **public**, link on the form | **To do (Eric)** | upload `demo-final.mp4` |
| No third-party copyrighted music or material without permission | Done | no audio track content; only the project's own UI, Claude Code's terminal UI and the project's docs |
| English materials | Done | all English |
| Testing access free of charge until judging ends | Done | public repository, MIT |

## Submission build and documentation

| Item | Status |
|---|---|
| Frozen engine `4bc7dcc` preserved (PR #14 untouched) | Done |
| PR #15 updated with a history-preserving merge of `4bc7dcc`: `be03b52` | Done, pushed |
| Typecheck, build, secret scan, 1045 tests, `demo:full` 18/18 on `be03b52` | Done (local) |
| CI on `be03b52` (Node 22, Node 24, gitleaks) | Green |
| README states the Buy panel, the submission build and how to run it | Done (this commit) |
| `docs/SUBMISSION.md` test count and checklist current | Done (this commit) |
| MOCK vs Sandbox vs not-integrated stated everywhere | Done |
| Fresh vs seen evaluation language | Done: IW-20 first run is the fresh number; 0 unsafe on seen sets is labelled regression evidence |
| No claim of PayPal Agent Ready or Store Sync | Done |
| Video reviewed for secrets and accuracy | Done (`verification-report.md`) |
| `submission-manifest.json` with commits and checksums | Done |

## Remaining account-level steps (Eric, in your own browser)

1. **YouTube:** upload `demo-final.mp4` (project files, `diaporia-buy-submission/`). Use the title and description in `devpost-fields.md`. Set **Public**. Copy the link.
2. **Devpost:** open https://paypalaihackathon.devpost.com/, "Enter a Submission" (or edit your draft).
   - Name, elevator pitch, story, Built with, Try-it-out links, repository URL: paste from `devpost-fields.md` and `devpost-description.md`.
   - Video link: the YouTube URL.
   - Thumbnail: your separately prepared image.
   - Answer any extra questions with the prepared text in `devpost-fields.md`.
   - Accept the rules and click **Submit**, before 05:00 KST. A saved draft is not a submission.
3. Optional, after submitting: confirm the project page shows "Submitted" and that the YouTube video plays signed out.

## Not done on purpose

- No merge of PR #14 or PR #15 into `main`, no deploy, no real funds, no live Sandbox call for the video.
- No IW-21, no new features, no engine changes.
- The video does not show Claude Desktop (see `verification-report.md`, limitation 1).
