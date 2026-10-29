import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const TOOL_NAME = "poll_sequencer_events";
const ACTOR_ID = "S6s8Rjd61tGdrMRk4";
// The live actor types these as text and parses them itself (build 0.1.6 and
// later refuse a value that does not parse with one free row). A number or a
// boolean here is rejected by the platform with HTTP 400 before the run starts.
const TEXT_FIELDS = ['since_hours', 'only_new', 'max_pages_per_query', 'max_events'];
const ARGS = {"since_hours": "48", "only_new": "false", "max_pages_per_query": "5", "max_events": "250"};

// Speak MCP over stdio: tools/list when args is null, else tools/call. The
// fetch mock writes the run start body to MOCK_BODY.
function rpc(args) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-text-"));
  const body = join(dir, "body.json");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(join(here, "mock-fetch.mjs")).href, join(repo, "build", "index.js")],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, APIFY_TOKEN: "test-token", MOCK_LOG: join(dir, "requests.log"), MOCK_BODY: body, MOCK_MODE: "ok" } },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stderr: ${err}`));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({ msg, body: existsSync(body) ? JSON.parse(readFileSync(body, "utf8")) : null });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wrapper-test", version: "0.0.0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const req = args
      ? { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOOL_NAME, arguments: args } }
      : { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    child.stdin.write(JSON.stringify(req) + "\n");
  });
}

test("every number and yes or no option is typed text in the tool schema", async () => {
  const { msg } = await rpc(null);
  const props = msg.result.tools[0].inputSchema.properties;
  for (const f of TEXT_FIELDS) {
    assert.equal(props[f]?.type, "string", `${f} is not typed string`);
  }
  for (const [name, p] of Object.entries(props)) {
    assert.ok(!["number", "integer", "boolean"].includes(p.type), `${name} is typed ${p.type}`);
  }
});

test("text values reach the actor run unchanged", async () => {
  const { msg, body } = await rpc(ARGS);
  assert.ok(!msg.result.isError, msg.result.content?.[0]?.text);
  for (const f of TEXT_FIELDS) {
    assert.equal(typeof body[f], "string", `${f} was not sent as text`);
    assert.equal(body[f], ARGS[f]);
  }
});

test("a yes or no option outside true and false is refused before any run", async () => {
  const yesNo = TEXT_FIELDS.find((f) => ["only_new", "open_company_pages"].includes(f));
  const { msg, body } = await rpc({ [yesNo]: "maybe" });
  assert.ok(msg, "no answer");
  const failed = msg.error || msg.result?.isError;
  assert.ok(failed, "a value other than true or false was accepted");
  assert.equal(body, null, "a run was started for an invalid value");
});

test("source pins the immutable actor id", () => {
  assert.ok(readFileSync(join(repo, "src", "index.ts"), "utf8").includes(`"${ACTOR_ID}"`));
});
