// Read-only post-deployment checks. Secrets come only from environment variables.
const base = process.env.AZRAIL_URL;
const token = process.env.AZRAIL_TOKEN;
const projectId = process.env.AZRAIL_PROJECT_ID || "";

if (!base || !token) throw Error("Set AZRAIL_URL and AZRAIL_TOKEN in your shell.");

const url = new URL(base);
if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw Error("HTTPS is required.");
}

const checks = [
  { path: "/pulse.html", authenticated: false, expected: 200 },
  { path: "/api/azrail/me", authenticated: false, expected: 401 },
  { path: "/api/azrail/me", authenticated: true, expected: 200 },
  { path: "/health", authenticated: true, expected: 200 },
  { path: "/api/azrail/agents", authenticated: true, expected: 200 },
  { path: "/api/azrail/projects", authenticated: true, expected: 200 },
  { path: "/api/azrail/routing-settings", authenticated: true, expected: 200 },
];

if (projectId) {
  checks.push({
    path: "/api/azrail/metrics?projectId=" + encodeURIComponent(projectId),
    authenticated: true,
    expected: 200,
  });
}

let failed = 0;
for (const check of checks) {
  try {
    const response = await fetch(new URL(check.path, url), {
      headers: check.authenticated ? { Authorization: "Bearer " + token } : {},
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });

    const ok = response.status === check.expected;
    console.log(
      (ok ? "PASS" : "FAIL") +
        " " +
        check.path +
        ": " +
        response.status +
        ", expected " +
        check.expected,
    );
    if (!ok) failed++;
    await response.body?.cancel();
  } catch {
    failed++;
    console.log("FAIL " + check.path + ": connection or redirect error");
  }
}

if (!projectId) {
  console.log("SKIP project metrics: set AZRAIL_PROJECT_ID to enable the ownership-protected metrics check.");
}

process.exitCode = failed ? 1 : 0;
