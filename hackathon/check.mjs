import Nimble from "@nimble-way/nimble-js";

const results = [];
const ok = (name, detail) => results.push(`✅ ${name}: ${detail}`);
const fail = (name, detail) => results.push(`❌ ${name}: ${detail}`);

async function checkNimble() {
  const key = process.env.NIMBLE_API_KEY;
  if (!key) return fail("Nimble", "NIMBLE_API_KEY not set");
  try {
    const nimble = new Nimble({ apiKey: key });
    const r = await nimble.search({ query: "tinybird rawtree", max_results: 1 });
    ok("Nimble", `search returned ${r.results?.length ?? 0} result(s)`);
  } catch (e) {
    fail("Nimble", e.message);
  }
}

async function checkBFL() {
  const key = process.env.BFL_API_KEY;
  if (!key) return fail("BFL", "BFL_API_KEY not set");
  try {
    // /v1/credits 500s on a zero balance, so probe a cheap generation endpoint instead:
    // 402 = key valid but no credits, 200 = key valid and funded, anything else = bad key.
    const r = await fetch("https://api.bfl.ai/v1/flux-2-klein-4b", {
      method: "POST",
      headers: { "x-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a red cube", width: 512, height: 512 }),
    });
    if (r.status === 402) return fail("BFL", "key valid but $0 credits — add credits at dashboard.bfl.ai");
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    ok("BFL", `key valid, credits funded (job ${j.id})`);
  } catch (e) {
    fail("BFL", e.message);
  }
}

async function checkLiquid() {
  const model = process.env.LIQUID_MODEL ?? "hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M";
  try {
    const r = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: LIQUID OK" }], stream: false }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    ok("Liquid", `${model} → "${j.message.content.trim()}"`);
  } catch (e) {
    fail("Liquid", `${e.message} (is Ollama running? model pulled?)`);
  }
}

await Promise.all([checkNimble(), checkBFL(), checkLiquid()]);
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0);
