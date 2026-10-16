/* Diagnostico contra TU backend desplegado (no simula nada; usa tus claves en Railway).
   Uso:  node scripts/diagnostico.js https://TU-BACKEND.up.railway.app "secador de pelo" 15
   Imprime, por prueba: estado HTTP, latencia, fuentes consultadas (con evidencia), resultados y fotos. */
const base = (process.argv[2] || "").replace(/\/+$/, "");
const q = process.argv[3] || "secador de pelo";
const priceMax = Number(process.argv[4] || 15);
if (!base) { console.log("Falta la URL del backend."); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) {
  const t0 = Date.now();
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ms: Date.now() - t0, j };
}
(async () => {
  const h = await (await fetch(base + "/health")).json();
  console.log("== health: version", h.version, "| apify", h.sources.apify, "| keepa", h.sources.keepa, "| explorar", h.sources.explorar);
  console.log("   consumo Apify desde el arranque:", JSON.stringify(h.apifyUsage || "(backend antiguo)"));

  for (const [label, action, body] of [["Descubrir SIN palabra clave", "browse", { max: 24, seed: Date.now(), fresh: true }], ["Descubrir CON '" + q + "'", "search", { query: q, max: 24, fresh: true }]]) {
    const r = await post("/sourcing/explorar/" + action, body);
    const d = (r.j && r.j.data) || {};
    const items = d.items || [];
    console.log("\n== " + label + " -> HTTP", r.status, r.ms + " ms", "| ok:", r.j && r.j.ok, "| motivo:", r.j && r.j.reason, (r.j && r.j.detail) || "");
    console.log("   consultas ejecutadas:", JSON.stringify(d.queries || []), "| evidencia:", JSON.stringify(d.evidence || null));
    console.log("   productos:", items.length, "| tiendas distintas:", new Set(items.map((i) => i.supplier)).size, "| con foto:", items.filter((i) => /^https?:/.test(i.image)).length);
    items.slice(0, 5).forEach((i) => console.log("    -", String(i.name).slice(0, 55), "|", i.price, "|", i.supplier, "|", i.image ? "foto" : "SIN FOTO"));
  }

  const s = await post("/suppliers/start", { name: q, priceMax, max: 12, market: "amazon.es" });
  console.log("\n== Buscar proveedores: start -> HTTP", s.status, s.ms + " ms", JSON.stringify(s.j));
  if (!s.j || !s.j.jobId) return;
  const t0 = Date.now(); let job = null;
  for (let i = 0; i < 70; i++) {
    await sleep(2000);
    const r = await (await fetch(base + "/suppliers/status/" + s.j.jobId)).json();
    job = r.job; if (!job) break;
    console.log("   t=" + Math.round((Date.now() - t0) / 1000) + "s", job.state, "terminadas:", job.searched.length, "en curso:", job.running.map((x) => x.source).join(",") || "-", "parciales:", (job.partial || []).length);
    if (job.state !== "running") break;
  }
  if (job && job.result) {
    const m = job.result.matches || [];
    console.log("   FIN:", job.state, "en", Math.round(job.elapsedMs / 1000), "s | ofertas:", m.length, "| con foto:", m.filter((x) => x.imageOk).length, "| más barata verificada:", job.result.cheapestVerified ? job.result.cheapestVerified.price + " (" + job.result.cheapestVerified.sourceLabel + ")" : "ninguna");
    console.log("   fuentes:"); job.searched.forEach((x) => console.log("     ", x.source, x.ok ? "OK(" + x.count + ")" : x.reason + (x.detail ? " [" + x.detail + "]" : ""), (x.ms || 0) + " ms"));
  }
})().catch((e) => console.log("Error:", e.message));