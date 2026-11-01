/**
 * Lattice — project profile detection (host half).
 *
 * Reads the workspace's own metadata files (never runs build tools) and
 * returns the dimension map `dims` the library uses for filtering:
 *   game / mcver / loader / loaderVersion / platform / runtime / sdk / product / branch
 *
 * The preset is a convenience label only; dims are what retrieval ranks on.
 * New ecosystems are a handful of lines here, not a schema change.
 */
import fs from "node:fs";
import path from "node:path";

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    return null;
  }
}

function readJsonObject(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch (err) {
    return null;
  }
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch (err) {
    return false;
  }
}

/** Read `key=value` / `key: value` from a gradle.properties-style file. */
function propertyValue(text, key) {
  if (!text) return null;
  const pattern = new RegExp(`^\\s*${key}\\s*[=:]\\s*(.+)$`, "m");
  const match = pattern.exec(text);
  if (!match) return null;
  const value = match[1].trim();
  return value === "" ? null : value;
}

function gitBranch(root) {
  const head = readText(path.join(root, ".git", "HEAD"));
  if (!head) return null;
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  return ref ? ref[1].trim() : null;
}

/** First existing file among the candidates (relative paths). */
function firstExisting(root, candidates) {
  for (const candidate of candidates) {
    const file = path.join(root, candidate);
    if (exists(file)) return candidate;
  }
  return null;
}

/**
 * Detect the calling workspace's profile.
 * @param {string} [workspace] folder to inspect (defaults to the host process cwd)
 * @returns {{workspace: string, preset: string, dims: Record<string, string>, signals: string[]}}
 */
export function detectProject(workspace = process.cwd()) {
  const root = path.resolve(workspace);
  const dims = {};
  const signals = [];

  // ── JVM / Minecraft family ────────────────────────────────────────────
  const gradleProps = readText(path.join(root, "gradle.properties"));
  if (gradleProps !== null) {
    signals.push("gradle.properties");
    const minecraft = propertyValue(gradleProps, "minecraft_version") ?? propertyValue(gradleProps, "minecraftVersion");
    if (minecraft) {
      dims.game = "minecraft";
      dims.mcver = minecraft;
    }
    const forge = propertyValue(gradleProps, "forge_version") ?? propertyValue(gradleProps, "forgeVersion");
    if (forge) {
      dims.loader = dims.loader ?? "forge";
      dims.loaderVersion = forge;
    }
    const neoforge = propertyValue(gradleProps, "neoforge_version") ?? propertyValue(gradleProps, "neoforgeVersion");
    if (neoforge) {
      dims.loader = "neoforge";
      dims.loaderVersion = neoforge;
    }
    const fabricLoader = propertyValue(gradleProps, "fabric_loader_version");
    if (fabricLoader) {
      dims.loader = "fabric";
      dims.loaderVersion = fabricLoader;
    }
    const fabricApi = propertyValue(gradleProps, "fabric_api_version");
    if (fabricApi) dims.apiVersion = fabricApi;
    const yarn = propertyValue(gradleProps, "yarn_mappings");
    if (yarn) dims.mappings = yarn;
  }

  if (exists(path.join(root, "fabric.mod.json")) || exists(path.join(root, "src", "main", "resources", "fabric.mod.json"))) {
    signals.push("fabric.mod.json");
    dims.loader = "fabric";
  }
  if (exists(path.join(root, "quilt.mod.json"))) {
    signals.push("quilt.mod.json");
    dims.loader = "quilt";
  }
  if (exists(path.join(root, "neoforge.mods.toml")) || exists(path.join(root, "src", "main", "resources", "META-INF", "neoforge.mods.toml"))) {
    signals.push("neoforge.mods.toml");
    dims.loader = "neoforge";
  }
  if (exists(path.join(root, "mods.toml")) || exists(path.join(root, "src", "main", "resources", "META-INF", "mods.toml"))) {
    signals.push("mods.toml");
    dims.loader = dims.loader ?? "forge";
  }
  const buildGradle = firstExisting(root, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]);
  if (buildGradle) {
    signals.push(buildGradle);
    const buildText = readText(path.join(root, buildGradle)) ?? "";
    if (/fabric-loom/.test(buildText)) dims.loader = dims.loader ?? "fabric";
    if (/net\.neoforged\.gradle|neogradle/.test(buildText)) dims.loader = dims.loader ?? "neoforge";
    if (/net\.minecraftforge\.gradle|forgeGradle/.test(buildText)) dims.loader = dims.loader ?? "forge";
    if (/com\.android\.application/.test(buildText)) {
      dims.platform = "android";
      dims.sdk = dims.sdk ?? "android";
    } else if (dims.platform === undefined && dims.game === undefined) {
      dims.platform = "jvm";
      dims.runtime = "jvm";
    }
  }

  // ── Node / Python / Rust / Android ─────────────────────────────────────
  const packageJson = readJsonObject(path.join(root, "package.json"));
  if (packageJson) {
    signals.push("package.json");
    dims.platform = "node";
    dims.runtime = "node";
    if (typeof packageJson.name === "string" && packageJson.name.trim() !== "") dims.product = packageJson.name.trim();
    const engine = packageJson.engines && typeof packageJson.engines === "object" ? packageJson.engines.node : undefined;
    if (typeof engine === "string" && engine.trim() !== "") dims.nodeEngine = engine.trim();
  }
  if (exists(path.join(root, "pyproject.toml")) || exists(path.join(root, "requirements.txt"))) {
    signals.push(exists(path.join(root, "pyproject.toml")) ? "pyproject.toml" : "requirements.txt");
    dims.platform = "python";
    dims.runtime = "python";
  }
  if (exists(path.join(root, "Cargo.toml"))) {
    signals.push("Cargo.toml");
    dims.platform = "rust";
    dims.runtime = "rust";
  }
  if (exists(path.join(root, "AndroidManifest.xml")) || exists(path.join(root, "app", "src", "main", "AndroidManifest.xml"))) {
    signals.push("AndroidManifest.xml");
    dims.platform = "android";
    dims.sdk = dims.sdk ?? "android";
  }

  const branch = gitBranch(root);
  if (branch) dims.branch = branch;

  let preset = "generic";
  if (dims.game === "minecraft") preset = "minecraft-mod";
  else if (dims.platform === "node") preset = "node-package";
  else if (dims.platform === "python") preset = "python";
  else if (dims.platform === "rust") preset = "rust";
  else if (dims.platform === "android") preset = "android";
  else if (dims.runtime === "jvm") preset = "gradle-jvm";

  return { workspace: root, preset, dims, signals };
}
