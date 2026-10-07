// PRIVATE REVIEW ARTIFACT. Uploaded only to the newly created canary after
// two OTHER reviews and an explicit execution handoff; never run by this task.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const repository = "Melbourneandrew/agentscope-release-controls-canary-rk86-20261007-a81d3f29";
const phase = process.env.CANARY_PHASE;
const sha = process.env.GITHUB_SHA;
if (process.env.GITHUB_REPOSITORY !== repository || !/^[a-f0-9]{40}$/.test(sha ?? "") || !["baseline", "denial"].includes(phase)) throw new Error("canary.identity");
const cutoff = Number(process.env.CANARY_CUTOFF_EPOCH_MS);
const otherSha = process.env.CANARY_OTHER_SHA;
if (!Number.isSafeInteger(cutoff) || cutoff <= Date.now() || cutoff - Date.now() > 600000 || !/^[a-f0-9]{40}$/.test(otherSha ?? "") || sha === otherSha) throw new Error("canary.bound");
const deadline = performance.now() + Math.max(0, cutoff - Date.now());
const outcomes = [];
let baselineFacts = null;
let count = 0;
async function api(method, path, body, expected, upload = false) {
  if (++count > (phase === "baseline" ? 12 : 7) || performance.now() >= deadline) throw new Error("canary.bound");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline - performance.now());
  try {
    const response = await fetch(`https://${upload ? 'uploads' : 'api'}.github.com/repos/${repository}${path}`, { method, redirect: "error", signal: controller.signal, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json", "X-GitHub-Api-Version": "2026-03-10" }, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
    const reader = response.body?.getReader();
    let length = 0;
    const chunks = [];
    try {
      while (reader) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 1_048_576 || performance.now() >= deadline) throw new Error("canary.bound"); chunks.push(Buffer.from(next.value)); }
    } finally { if (reader) { await reader.cancel(); reader.releaseLock(); } }
    outcomes.push({ ordinal: outcomes.length + 1, status: response.status });
    if (!expected.includes(response.status)) throw new Error("canary.status");
    return length ? JSON.parse(Buffer.concat(chunks, length).toString("utf8")) : null;
  } finally { controller.abort(); clearTimeout(timer); }
}
if (phase === "baseline") {
  await api("POST", "/git/refs", { ref: "refs/tags/canary-bot", sha }, [201]);
  const createdRefSha = (await api("GET", "/git/ref/tags/canary-bot", undefined, [200])).object?.sha;
  if (createdRefSha !== sha) throw new Error("canary.ref");
  await api("PATCH", "/git/refs/tags/canary-bot", { sha: process.env.CANARY_OTHER_SHA, force: true }, [200]);
  const updatedRefSha = (await api("GET", "/git/ref/tags/canary-bot", undefined, [200])).object?.sha;
  if (updatedRefSha !== otherSha) throw new Error("canary.ref");
  await api("DELETE", "/git/refs/tags/canary-bot", undefined, [204]);
  await api("GET", "/git/ref/tags/canary-bot", undefined, [404]);
  const release = await api("POST", "/releases", { tag_name: "canary-bot-release", target_commitish: sha, name: "Bot permission baseline", draft: true, prerelease: true, make_latest: "false" }, [201]);
  if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error("canary.release");
  const bytes = Buffer.from("canary-bytes-v1!");
  const asset = await api("POST", `/releases/${release.id}/assets?name=canary.bin`, bytes, [201], true);
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error("canary.asset");
  const observed = await api("GET", `/releases/assets/${asset.id}`, undefined, [200]);
  if (observed.id !== asset.id || observed.name !== "canary.bin" || observed.size !== 16 || observed.digest !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`) throw new Error("canary.asset");
  baselineFacts = {
    refSequence: [{ ordinal: 2, sha: createdRefSha }, { ordinal: 4, sha: updatedRefSha }, { ordinal: 6, absent: true }],
    asset: { releaseId: release.id, id: observed.id, name: observed.name, size: observed.size, digest: observed.digest },
  };
  await api("DELETE", `/releases/assets/${asset.id}`, undefined, [204]);
  await api("DELETE", `/releases/${release.id}`, undefined, [204]);
} else {
  await api("POST", "/git/refs", { ref: "refs/tags/v0.0.0-canary.2", sha }, [403, 422]);
  await api("GET", "/git/ref/tags/v0.0.0-canary.2", undefined, [404]);
  await api("PATCH", "/git/refs/tags/v0.0.0-canary.1", { sha: process.env.CANARY_OTHER_SHA, force: true }, [403, 422]);
  if ((await api("GET", "/git/ref/tags/v0.0.0-canary.1", undefined, [200])).object?.sha !== sha) throw new Error("canary.ref");
  await api("DELETE", "/git/refs/tags/v0.0.0-canary.1", undefined, [403, 422]);
  if ((await api("GET", "/git/ref/tags/v0.0.0-canary.1", undefined, [200])).object?.sha !== sha) throw new Error("canary.ref");
}
// Retain the closed checked baseline facts before deletion makes reread impossible.
// The owner validates these against the fixed source and ordered status vector.
const receipt = { version: 1, phase, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, sha, otherSha, baselineFacts, outcomes: [...outcomes] };
await api("PUT", `/contents/.canary/${phase}-receipt.json`, { message: "Fixed canary semantic receipt", branch: "canary-receipts", content: Buffer.from(JSON.stringify(receipt)).toString("base64") }, [201]);
writeFileSync(process.env.GITHUB_OUTPUT, `request_count=${count}\n`, { flag: "a" });
console.log(JSON.stringify({ version: 1, phase, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, outcomes }));
