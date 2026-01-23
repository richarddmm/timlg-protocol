// oracle/nist.js
// Node >= 18 (fetch nativo). Si usas Node 16, instala node-fetch y adapta.

const NIST_BASE = "https://beacon.nist.gov/beacon/2.0";

/**
 * GET pulse JSON (NIST Beacon 2.0)
 * Endpoint: /chain/<chainIndex>/pulse/<pulseIndex>
 * Devuelve json.pulse.outputValue (hex 512 bits) -> Buffer(64)
 */
async function fetchNistPulseBytes(chainIndex, pulseIndex) {
  const url = `${NIST_BASE}/chain/${chainIndex}/pulse/${pulseIndex}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (res.status === 404) {
    const err = new Error(`NIST pulse not found yet (404): chain=${chainIndex} pulse=${pulseIndex}`);
    err.code = "NIST_404";
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NIST fetch failed ${res.status}: ${text || url}`);
  }

  const json = await res.json();
  const outputValue = json?.pulse?.outputValue;
  if (typeof outputValue !== "string") {
    throw new Error(`Unexpected NIST JSON: missing pulse.outputValue`);
  }

  // outputValue es hex de 512 bits => 64 bytes => 128 hex chars
  const pulse = Buffer.from(outputValue, "hex");
  if (pulse.length !== 64) {
    throw new Error(`Invalid outputValue length: got ${pulse.length} bytes (expected 64)`);
  }

  return pulse;
}

/**
 * Poll hasta que exista el pulse (maneja 404). Útil porque NIST devuelve 404 si aún no hay pulso.
 */
async function waitForNistPulseBytes(chainIndex, pulseIndex, opts = {}) {
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  const t0 = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fetchNistPulseBytes(chainIndex, pulseIndex);
    } catch (e) {
      if (e && e.code === "NIST_404") {
        if (Date.now() - t0 > timeoutMs) {
          throw new Error(`Timeout waiting NIST pulse chain=${chainIndex} pulse=${pulseIndex}`);
        }
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      throw e;
    }
  }
}

module.exports = {
  fetchNistPulseBytes,
  waitForNistPulseBytes,
};
