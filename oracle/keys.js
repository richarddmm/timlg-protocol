// oracle/keys.js
const fs = require("fs");
const path = require("path");
const { Keypair } = require("@solana/web3.js");

function expandTilde(p) {
  if (!p) return p;
  if (p.startsWith("~")) return path.join(process.env.HOME || "", p.slice(1));
  return p;
}

function defaultOracleKeypairPath() {
  // standard location OUTSIDE repo
  return path.join(process.env.HOME || "", ".config", "timlg", "oracle", "id.json");
}

function isInsideRepo(resolvedPath) {
  // assume scripts executed from repo root; protect even if executed elsewhere
  const repoRoot = path.resolve(process.cwd());
  const target = path.resolve(resolvedPath);
  return target.startsWith(repoRoot + path.sep);
}

function assertNotInRepo(resolvedPath, envAllow = "ALLOW_IN_REPO_KEYPAIR") {
  if (isInsideRepo(resolvedPath) && process.env[envAllow] !== "1") {
    throw new Error(
      [
        `Refusing to load keypair from inside the repository:`,
        `  ${resolvedPath}`,
        ``,
        `Move it outside the repo (recommended: ${defaultOracleKeypairPath()})`,
        `If you REALLY know what you're doing, set ${envAllow}=1 (not recommended).`,
      ].join("\n")
    );
  }
}

function assertFilePermissions(resolvedPath) {
  // best-effort warning (works on linux/mac)
  try {
    const st = fs.statSync(resolvedPath);
    const mode = st.mode & 0o777;
    // warn if group/other have any read bits
    if ((mode & 0o044) !== 0) {
      console.warn(
        `WARNING: keypair file permissions look too open (${mode.toString(
          8
        )}). Recommended: chmod 600 ${resolvedPath}`
      );
    }
  } catch (_) {
    // ignore
  }
}

function loadKeypairSafe(filePath, { allowInRepo = false } = {}) {
  const p0 = filePath || defaultOracleKeypairPath();
  const p = expandTilde(p0);
  const resolved = path.resolve(p);

  if (!allowInRepo) assertNotInRepo(resolved);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      [
        `Keypair not found: ${resolved}`,
        ``,
        `Create one with:`,
        `  mkdir -p ~/.config/timlg/oracle`,
        `  solana-keygen new --outfile ~/.config/timlg/oracle/id.json`,
      ].join("\n")
    );
  }

  assertFilePermissions(resolved);

  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

module.exports = {
  defaultOracleKeypairPath,
  loadKeypairSafe,
  expandTilde,
};
