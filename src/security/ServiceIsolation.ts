/**
 * V2.2 WP-2 (H-2): the OS-principal boundary between the DIAPORIA service and the AI host.
 *
 * The independent reviewer showed that an AI host running as the same OS user as the server can open the SQLite file
 * and write an owner-confirmed resolution (or simply delete the open requirements). No check inside the application
 * can stop a principal that can rewrite the application's own database and code. So payment-facing operations are
 * enabled only when the service runs under its OWN OS account and the AI host's account(s), declared by the operator
 * in DIAPORIA_AI_HOST_UIDS, can neither write nor replace anything the service trusts:
 *
 *  - the service does not run as root, and its uid is not one of the AI host uids;
 *  - the data directory and every database file (main, WAL, SHM, service ledger, dev credentials) are owned by the
 *    service uid and have no group or other permission bits (the AI host can neither read nor write them);
 *  - every file and directory of the code the service executes (src, node_modules, package.json, tsconfig, dist, .env
 *    files, the Node binary) is not owned by an AI host uid and is not group- or world-writable, following symbolic
 *    links to their targets;
 *  - no directory above the data directory, the code or the Node binary is owned by an AI host uid or writable by
 *    others (sticky directories excepted), so nothing can be renamed and replaced;
 *  - the owner registry boundary is established (OwnerConfirmation.ts also refuses a registry an AI host uid owns).
 *
 * When any check fails the result is NOT established with every reason, and src/main.ts starts with payment execution
 * disabled (research stays available). Deterministic, read-only, no network.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface IsolationInput {
  /** The service's uid (process.getuid()); null when the platform cannot report it. */
  uid: number | null;
  /** DIAPORIA_AI_HOST_UIDS: comma-separated numeric uids or user names of the AI host account(s). */
  aiHostUids: string | undefined;
  dataDir: string;
  /** Database and credential files the service trusts (checked when they exist). */
  dataFiles: string[];
  /** Root of the code the service runs (the folder with package.json). */
  codeRoot: string;
  /** The Node binary (process.execPath). */
  execPath: string;
  registryEstablished: boolean;
  registryReason: string;
  stat?: (p: string) => Stats;
  lstat?: (p: string) => Stats;
  readdir?: (p: string) => string[];
  realpath?: (p: string) => string;
  passwd?: () => string;
  group?: () => string;
  /** Upper bound on code entries inspected (fail closed beyond it). */
  maxEntries?: number;
}
export interface IsolationStatus { established: boolean; reason: string; failures: string[]; warnings: string[]; serviceUid: number | null; aiHostUids: number[]; inspected: number }

const CODE_ENTRIES = ["src", "node_modules", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "dist"];

/** Parses DIAPORIA_AI_HOST_UIDS (numbers or names from /etc/passwd). */
export function parseAiHostUids(v: string | undefined, passwd: () => string): { uids: number[]; errors: string[] } {
  const uids: number[] = []; const errors: string[] = [];
  for (const raw of (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (/^\d+$/.test(raw)) { uids.push(Number(raw)); continue; }
    let line: string | undefined;
    try { line = passwd().split("\n").find((l) => l.split(":")[0] === raw); } catch { /* unreadable */ }
    const uid = line ? Number(line.split(":")[2]) : NaN;
    if (Number.isInteger(uid)) uids.push(uid); else errors.push(`unknown AI host account "${raw}"`);
  }
  return { uids: [...new Set(uids)], errors };
}

export function checkServiceIsolation(o: IsolationInput): IsolationStatus {
  const stat = o.stat ?? statSync; const lstat = o.lstat ?? lstatSync; const readdir = o.readdir ?? ((p: string) => readdirSync(p));
  const realpath = o.realpath ?? realpathSync.native; const passwd = o.passwd ?? (() => readFileSync("/etc/passwd", "utf8")); const group = o.group ?? (() => readFileSync("/etc/group", "utf8"));
  const failures: string[] = []; const warnings: string[] = []; let inspected = 0;
  const fail = (s: string) => { if (failures.length < 40) failures.push(s); };
  const done = (): IsolationStatus => ({ established: failures.length === 0, reason: failures.length ? failures.slice(0, 3).join("; ") + (failures.length > 3 ? `; and ${failures.length - 3} more` : "") : `service uid ${o.uid} is separate from AI host uid(s) ${ai.join(",")}`,
    failures, warnings, serviceUid: o.uid, aiHostUids: ai, inspected });

  const { uids: ai, errors } = parseAiHostUids(o.aiHostUids, passwd);
  if (o.uid === null) { fail("this platform cannot report the service's OS user, so the OS-principal boundary cannot be checked"); return done(); }
  if (o.uid === 0) fail("the service runs as root; run it under its own unprivileged OS account (docs/SETUP.md, \"Service account\")");
  for (const e of errors) fail(e);
  if (!ai.length && !errors.length) fail("DIAPORIA_AI_HOST_UIDS is not set: declare the OS account(s) your AI host runs as, so the service can check that they cannot modify it");
  if (ai.includes(o.uid)) fail(`the service runs as the same OS user as the AI host (uid ${o.uid}): the AI host could rewrite its database and code`);
  if (ai.includes(0)) fail("an AI host that runs as root can modify anything; the boundary cannot hold");
  if (!o.registryEstablished) fail(`owner confirmation boundary not established: ${o.registryReason}`);
  // Advisory: an AI host account that can become another user without the human (sudo, docker, lxd groups).
  try {
    const names = new Set(passwd().split("\n").filter((l) => ai.includes(Number(l.split(":")[2]))).map((l) => l.split(":")[0]!));
    const gids = new Set(passwd().split("\n").filter((l) => ai.includes(Number(l.split(":")[2]))).map((l) => l.split(":")[3]!));
    for (const l of group().split("\n")) {
      const [g, , gid, members] = l.split(":");
      if (!g || !/^(?:sudo|wheel|admin|docker|lxd|root)$/.test(g)) continue;
      if (gids.has(gid!) || (members ?? "").split(",").some((m) => names.has(m))) warnings.push(`an AI host account is in the "${g}" group; make sure it cannot act as the service account or root without you (sudo password, no docker/lxd access)`);
    }
  } catch { /* advisory only */ }

  const mode = (s: Stats) => s.mode & 0o7777;
  const checkedDirs = new Set<string>();
  const ancestors = (p: string, what: string) => {
    for (let d = dirname(resolve(p)); ; d = dirname(d)) {
      if (checkedDirs.has(d)) { if (dirname(d) === d) break; continue; }
      checkedDirs.add(d);
      let s: Stats;
      try { s = stat(d); } catch { fail(`cannot inspect ${d} (above the ${what})`); break; }
      if (ai.includes(s.uid)) fail(`${d} (above the ${what}) is owned by an AI host account, which could rename and replace what is below it`);
      if ((mode(s) & 0o022) !== 0 && (mode(s) & 0o1000) === 0) fail(`${d} (above the ${what}) is group- or world-writable`);
      if (dirname(d) === d) break;
    }
  };

  // ---- data
  let ds: Stats | null = null;
  try { ds = lstat(o.dataDir); } catch { fail(`the data directory ${o.dataDir} does not exist`); }
  if (ds) {
    if (!ds.isDirectory()) fail(`the data directory ${o.dataDir} must be a real directory (not a symbolic link)`);
    if (ds.uid !== o.uid) fail(`the data directory ${o.dataDir} is not owned by the service account (uid ${o.uid})`);
    if ((mode(ds) & 0o077) !== 0) fail(`the data directory ${o.dataDir} gives group or other access (mode ${mode(ds).toString(8)}); it must be 700`);
    ancestors(o.dataDir + "/x", "data directory");
  }
  for (const f of o.dataFiles) {
    let s: Stats;
    try { s = lstat(f); } catch { continue; } // created later by the service with umask 077
    if (!s.isFile()) { fail(`${f} must be a regular file (not a symbolic link)`); continue; }
    if (s.uid !== o.uid) fail(`${f} is not owned by the service account (uid ${o.uid})`);
    if ((mode(s) & 0o077) !== 0) fail(`${f} gives group or other access (mode ${mode(s).toString(8)}); it must be 600`);
  }

  // ---- code and runtime
  const max = o.maxEntries ?? 300_000;
  let codeFailures = 0;
  const codeFail = (s: string) => { if (++codeFailures <= 5) fail(s); else if (codeFailures === 6) fail("more code entries fail the same checks (not listed)"); };
  const codeOk = (p: string, s: Stats, via?: string) => {
    if (ai.includes(s.uid)) codeFail(`${via ?? p} is owned by an AI host account (the AI host could change the service's code or configuration)`);
    else if ((mode(s) & 0o022) !== 0 && !(s.isDirectory() && (mode(s) & 0o1000) !== 0)) codeFail(`${via ?? p} is group- or world-writable`);
  };
  const walk = (p: string, depthGuard: number) => {
    if (failures.length >= 40) return;
    if (++inspected > max) { if (inspected === max + 1) fail(`more than ${max} code entries; the code tree could not be fully checked`); return; }
    let s: Stats;
    try { s = lstat(p); } catch { return; }
    if (s.isSymbolicLink()) {
      let target: string; let ts: Stats;
      try { target = realpath(p); ts = stat(target); } catch { fail(`${p} is a broken or unreadable symbolic link`); return; }
      codeOk(target, ts, `${p} -> ${target}`);
      ancestors(target, "code");
      if (ts.isDirectory() && depthGuard < 40) for (const e of safeReaddir(target)) walk(join(target, e), depthGuard + 1);
      return;
    }
    codeOk(p, s);
    if (s.isDirectory() && depthGuard < 40) for (const e of safeReaddir(p)) walk(join(p, e), depthGuard + 1);
  };
  const safeReaddir = (p: string) => { try { return readdir(p); } catch { fail(`cannot list ${p}`); return []; } };
  let rs: Stats | null = null;
  try { rs = stat(o.codeRoot); } catch { fail(`the code folder ${o.codeRoot} cannot be inspected`); }
  if (rs) {
    codeOk(o.codeRoot, rs);
    ancestors(o.codeRoot + "/x", "code");
    const top = safeReaddir(o.codeRoot);
    for (const e of top) if (CODE_ENTRIES.includes(e) || /^\.env/.test(e)) walk(join(o.codeRoot, e), 0);
  }
  try { const real = realpath(o.execPath); codeOk(real, stat(real), `the Node binary ${real}`); ancestors(real, "Node binary"); }
  catch { fail(`cannot inspect the Node binary ${o.execPath}`); }
  return done();
}
