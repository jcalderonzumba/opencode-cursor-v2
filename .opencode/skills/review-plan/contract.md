# The project contract

Five checks for a public OpenCode V2 plugin that proxies Cursor's agent API. `plan-reviewer` applies them to a plan, `phase-reviewer` to a branch's diff. Each check names its trigger, the paths or words that fire it. Two rules override any skill's advice:

- **Decisions win.** A decision in the approved spec, and a rulings file the brief names, override a skill's generic advice. A finding that contradicts one is noted as overridden and dropped.
- **Every check runs.** See the last section.

## Check 1: Spec conformance

**Trigger:** every plan and every diff.

The plan or diff matches the approved spec, when one exists, or states its amendment and justifies it. In a diff, an amendment updates the spec's text in the same change.

**Severities:**
- **Must Fix:** a deviation from the approved spec that is neither stated nor justified.
- **Should Fix:** an amendment is stated but not justified.

## Check 2: Credentials and exposure

**Trigger:** `src/proxy.ts`, `src/auth.ts`, `src/native-tools.ts`, `src/h2-bridge.mjs`, `src/v2.ts`, or any text mentioning token, credential, listen, bind, fs read or fs write.

Look for:
- Cursor access and refresh tokens that are logged, persisted, put in a URL or put in an error message.
- A local proxy bound to anything but loopback, a new listener, or an unauthenticated endpoint.
- A read or write of the user's files on Cursor's behalf that bypasses OpenCode's tool path and is not called out.

**Severities:**
- **Must Fix:** any of the above present and unaddressed.
- **Should Fix:** a file read or write through OpenCode's tool path that the plan or PR text does not call out.
- **Consider:** a log line near a credential path that is safe today but easy to break.

## Check 3: Default-path stability

**Trigger:** `src/proxy.ts`, `src/models.ts`, `src/h2-bridge.mjs`.

The HTTP/2 path is the default. Code shared by both transports (request building, exec handling, parsing) is called out when changed, and a test decodes the real request or response, not a mock.

**Severities:**
- **Must Fix:** a change to shared code that the default path runs, with no test that decodes a real request or response.
- **Should Fix:** the change is not called out in the plan or the PR text.
- **Consider:** a shared helper that the default path could stop depending on.

## Check 4: Outside facts

**Trigger:** any claim about the OpenCode V2 plugin API, the OpenCode host, or Cursor's protocol.

Each such claim rests on a primary source the plan or PR text cites: package types under `node_modules/@opencode/*`, the V2 docs at `opencode.ai/v2/docs`, or a captured request. The verified host version is stated (OpenCode 2.1.4 at the time of writing), and surfaces not verified are listed as unverified. The reviewers never research; the revision does.

**Severities:**
- **Must Fix:** a decision rests on an unbacked claim, or the plan hands the fact to the builder to find out.
- **Should Fix:** the host version is not stated, or unverified surfaces are not listed.
- **Consider:** an unbacked claim that appears only in a comment or README line.

## Check 5: Test evidence

**Trigger:** every plan and every diff.

Each behaviour change has a test that was watched to fail first: the builder's report names the test and its failing line. Tests assert real behaviour, and no wait is unbounded. Agent and skill prose and pure config are exempt from "fail first"; their first real use checks them.

The three repo checks must pass:

```text
npx tsc -p tsconfig.json --noEmit
bun test/smoke.ts
npm run build
```

Reviewers run none of them. The controlling session runs them and puts the results in the brief; a result missing from the brief is listed as skipped, with that reason. A plan is checked for the same evidence: each behaviour task states its failing test first, and the three checks gate each commit.

**Severities:**
- **Must Fix:** new behaviour with no red evidence; a failing check; a test that asserts a mock instead of behaviour; an unbounded wait.
- **Should Fix:** a test that passes without the change; a check result absent from the brief.
- **Consider:** a test that could be shorter or clearer.

## Every check runs

A Must Fix blocks approval, and every later check still runs, so one round reports every finding and one revision fixes them all. A check that does not apply to the work under review is listed as skipped, with its reason. The report's header keeps its `Same vendor:` line, so an owner-supplied cross-vendor `--model` is visible.
