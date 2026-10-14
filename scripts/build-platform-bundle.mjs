import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";

const [version, outputArg, ...options] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !outputArg) {
  throw new Error("usage: node scripts/build-platform-bundle.mjs <exact-version> <output-directory> [--tarball <local-candidate.tgz>] [--single-file] [--omit-licenses] [--bundle-directory <relative-path>]");
}

let singleFile = false;
let includeLicenses = true;
let bundleDirectory = "vendor/itpay-cli";
let candidateTarball;
for (let index = 0; index < options.length; index += 1) {
  if (options[index] === "--single-file") {
    singleFile = true;
  } else if (options[index] === "--omit-licenses") {
    includeLicenses = false;
  } else if (options[index] === "--bundle-directory" && options[index + 1]) {
    bundleDirectory = validateBundleDirectory(options[++index]);
  } else if (options[index] === "--tarball" && options[index + 1]) {
    candidateTarball = resolve(options[++index]);
  } else {
    throw new Error(`unknown option: ${options[index]}`);
  }
}

const requestedOutput = resolve(outputArg);
// Existing plugin launchers resolve the runtime inside skills/itpay.
const output = existsSync(join(requestedOutput, "skills", "itpay", "scripts", "itpay.mjs"))
  ? join(requestedOutput, "skills", "itpay") : requestedOutput;
const vendor = join(output, bundleDirectory);
const scratch = mkdtempSync(join(tmpdir(), "itpay-platform-bundle-"));

try {
  const metadata = candidateTarball ? {
    version,
    "dist.integrity": `sha512-${createHash("sha512").update(readFileSync(candidateTarball)).digest("base64")}`,
  } : JSON.parse(execFileSync("npm", [
    "view", `@itpay/cli@${version}`, "version", "dist.integrity", "gitHead", "engines", "--json",
  ], { encoding: "utf8" }));
  if (metadata.version !== version || !metadata["dist.integrity"] || (!candidateTarball && !metadata.gitHead)) {
    throw new Error(`incomplete npm metadata for @itpay/cli@${version}`);
  }

  // Inspect the exact tarball before choosing the historical or Buyer layout.
  const inspected=join(scratch,"inspected");mkdirSync(inspected);
  let tarball=candidateTarball;
  if(!tarball){
    const packed=JSON.parse(execFileSync("npm",["pack",`@itpay/cli@${version}`,"--ignore-scripts","--json","--pack-destination",scratch],{encoding:"utf8"}));
    tarball=join(scratch,packed[0].filename);
    const integrity=`sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    if(integrity!==metadata["dist.integrity"])throw new Error("registry tarball integrity mismatch");
  }
  const names=execFileSync("tar",["-tzf",tarball],{encoding:"utf8"}).trim().split("\n");
  if(names.some(name=>!name.startsWith("package/")||name.split("/").includes("..")))throw new Error("unsafe package path");
  execFileSync("tar",["-xzf",tarball,"-C",inspected]);
  const candidateRoot=join(inspected,"package");
  const candidatePackage=JSON.parse(readFileSync(join(candidateRoot,"package.json"),"utf8"));
  if(candidatePackage.version!==version)throw new Error("candidate version mismatch");
  if(candidatePackage.itpayBundleFormat==="buyer-esm-v1"){
    if(!includeLicenses)throw new Error("Buyer package licenses cannot be omitted");
    for(const field of ["dependencies","optionalDependencies","peerDependencies","bundleDependencies"])if(candidatePackage[field]&&Object.keys(candidatePackage[field]).length)throw new Error("Buyer runtime dependencies are forbidden");
    rmSync(vendor,{recursive:true,force:true});mkdirSync(vendor,{recursive:true});
    cpSync(candidateRoot,join(vendor,"package"),{recursive:true});
    writeFileSync(join(vendor,"itpay-cli.bundle.mjs"),'import "./package/dist/src/main.js";\n');
    // Keep the host launcher and its Agent Type; relocate only published resources.
    const launcherPath = join(output, "scripts", "itpay.mjs");
    if (existsSync(launcherPath)) {
      let launcher = readFileSync(launcherPath, "utf8");
      const docsPath = `${bundleDirectory}/package/docs/agent/buyer`;
      const skillsPath = `${bundleDirectory}/package/skills`;
      launcher = launcher.replace(/ITPAY_CLI_DOCS_DIR:\s*resolve\(skillRoot,\s*"[^"]+"\)/g,
        `ITPAY_CLI_DOCS_DIR: resolve(skillRoot, "${docsPath}")`);
      launcher = launcher.replace(/ITPAY_CLI_SKILLS_DIR:\s*(?:dirname\(skillRoot\)|skillRoot|resolve\(skillRoot,\s*"[^"]+"\))/g,
        `ITPAY_CLI_SKILLS_DIR: resolve(skillRoot, "${skillsPath}")`);
      writeFileSync(launcherPath, launcher);
    }
    const publishedSkill = readFileSync(join(candidateRoot, "skills/itpay/SKILL.md"), "utf8");
    const outerSkillPath = join(output, "SKILL.md");
    if (existsSync(outerSkillPath)) {
      const existingSkill = readFileSync(outerSkillPath, "utf8");
      const boundary = existingSkill.indexOf("## Local CLI business rules");
      if (boundary < 0) throw new Error("host Skill has no explicit business boundary");
      // Host lanes remain before this boundary; replace the outdated Buyer recipe.
      const host = existingSkill.slice(0, boundary)
        .replace(/^### (?:WorkBuddy Checkout|OpenClaw) handoff\n[\s\S]*?(?=^## |$(?![\s\S]))/gm, "")
        .replace(/continuation\. If compatibility fails,[\s\S]*?\nNever (?:install|switch)[\s\S]*?\.\n/g, "continuation. Preserve the launcher, Backend and identity; follow the current setup response.\n")
        .replace(/^- If compatibility fails,[\s\S]*?Device\.\n/gm, "")
        .replace(/; never attempt legacy workflow tools\./g, ".")
        .replaceAll("readyz --json", "setup --json").trimEnd()+"\n";
      const handoff = host.includes("## WorkBuddy Runtime")
        ? "\n### WorkBuddy Checkout handoff\n\nFor a verified official entry, execute `handoff.agent_action` exactly once when present. Its `present_files` action uses the complete official `handoff.url` as its only `files` element. Never use `present_files` for a local file or QR PNG. If unsupported, show the original verified URL.\n"
        : host.includes("## OpenClaw Runtime")
          ? "\n### OpenClaw handoff\n\nUse the returned `handoff.agent_action` only for the actual supported channel and target; otherwise show the original verified official URL.\n"
          : "";
      const body = publishedSkill.slice(publishedSkill.indexOf("# ItPay") + "# ItPay".length).trim();
      const runtimeFiles = existingSkill.includes("HERMES_SKILL_DIR")
        ? "\n## Bundled runtime files\n\n" + ["scripts/itpay.mjs", `${bundleDirectory}/itpay-cli.bundle.mjs`, ...filesIn(join(vendor,"package")).map(path => `${bundleDirectory}/package/${path}`)].map(path => `- \`${path}\``).join("\n") + "\n"
        : "";
      writeFileSync(outerSkillPath, host + handoff + "\n## Local CLI business rules\n\n" + body + "\n" + runtimeFiles);
    }
    const coreSha256=createHash("sha256").update(readFileSync(join(candidateRoot,"dist/src/main.js"))).digest("hex");
    writeFileSync(join(output,"bundle.lock.json"),JSON.stringify({schemaVersion:1,package:"@itpay/cli",version,format:"buyer-esm-v1",npmIntegrity:metadata["dist.integrity"],...(metadata.gitHead?{sourceGitSha:metadata.gitHead}:{}),candidateTarballSha256:createHash("sha256").update(readFileSync(tarball)).digest("hex"),coreSha256,node:candidatePackage.engines?.node ?? ">=18",bundleDirectory},null,2)+"\n");
    const actual=execFileSync(process.execPath,[join(vendor,"itpay-cli.bundle.mjs"),"--version"],{encoding:"utf8"}).trim();
    if(actual!==version)throw new Error("Buyer core version mismatch");
    process.stdout.write(`built shared Buyer core @itpay/cli@${version} in ${output}\n`);
  } else {
  writeFileSync(join(scratch, "package.json"), JSON.stringify({
    name: "itpay-platform-bundle",
    private: true,
    dependencies: { "@itpay/cli": candidateTarball ?? version },
  }, null, 2) + "\n");
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: scratch,
    stdio: "inherit",
  });

  const installed = join(scratch, "node_modules", "@itpay", "cli");
  const installedPackage = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (installedPackage.version !== version) throw new Error(`installed ${installedPackage.version}, expected ${version}`);

  const declaredEntry = typeof installedPackage.bin === "string" ? installedPackage.bin : installedPackage.bin?.itpay;
  if (!declaredEntry || isAbsolute(declaredEntry) || declaredEntry.split(/[\\/]/).includes("..")) {
    throw new Error("package has no safe declared itpay executable");
  }
  const installedEntry = join(installed, declaredEntry);
  if (!existsSync(installedEntry)) throw new Error("declared itpay executable is missing");

  rmSync(vendor, { recursive: true, force: true });
  mkdirSync(vendor, { recursive: true });
  if (singleFile) {
    const { buildSync } = await import("esbuild");
    buildSync({
      entryPoints: [installedEntry],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      outfile: join(vendor, "itpay-cli.bundle.mjs"),
      banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
    });
    cpSync(join(installed, "skills", "itpay"), join(vendor, "skills", "itpay"), { recursive: true });
    cpSync(join(installed, "docs", "agent", "buyer"), join(vendor, "docs", "agent", "buyer"), { recursive: true });
    if (includeLicenses) copyLicenseFiles(join(scratch, "node_modules"), join(vendor, "licenses"));
  } else {
    mkdirSync(join(vendor, "package"), { recursive: true });
    cpSync(installed, join(vendor, "package"), { recursive: true });
  }
  // The CLI is relocated to vendor/package; its npm shims would point at the removed scope.
  for (const alias of ["itp", "itpay", "itpay_cli"]) rmSync(join(scratch, "node_modules", ".bin", alias), { force: true });
  rmSync(installed, { recursive: true, force: true });
  const scope = dirname(installed);
  if (existsSync(scope)) rmSync(scope, { recursive: true, force: true });
  if (singleFile) rmSync(join(scratch, "node_modules"), { recursive: true, force: true });
  else renameSync(join(scratch, "node_modules"), join(vendor, "node_modules"));
  cpSync(join(scratch, "package-lock.json"), join(vendor, "package-lock.json"));

  const dependencyLock = readFileSync(join(vendor, "package-lock.json"));
  const lock = {
    schemaVersion: 1,
    package: "@itpay/cli",
    version,
    format: singleFile ? "single-file-esm" : "npm-tree",
    npmIntegrity: metadata["dist.integrity"],
    ...(metadata.gitHead ? { sourceGitSha: metadata.gitHead } : {}),
    ...(candidateTarball ? { candidateTarballSha256: createHash("sha256").update(readFileSync(candidateTarball)).digest("hex") } : {}),
    generatedAt: new Date().toISOString(),
    node: metadata.engines?.node ?? ">=18",
    bundleDirectory,
    dependencyLockSha256: createHash("sha256").update(dependencyLock).digest("hex"),
  };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "bundle.lock.json"), JSON.stringify(lock, null, 2) + "\n");

  const entry = singleFile ? join(vendor, "itpay-cli.bundle.mjs") : join(vendor, "package", declaredEntry);
  const actual = execFileSync(process.execPath, [entry, "--version"], { encoding: "utf8" }).trim();
  if (actual !== version) throw new Error(`bundle reported ${actual}, expected ${version}`);
  process.stdout.write(`built @itpay/cli@${version} in ${output}\n`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function copyLicenseFiles(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const child = join(source, entry.name);
    if (entry.isDirectory()) {
      copyLicenseFiles(child, join(destination, entry.name === "node_modules" ? "nested" : entry.name));
    } else if (/^licen[cs]e(?:[._-].*)?$/i.test(entry.name)) {
      mkdirSync(destination, { recursive: true });
      cpSync(child, join(destination, entry.name));
    }
  }
}

function validateBundleDirectory(value) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || isAbsolute(normalized) || win32.isAbsolute(value) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("bundle directory must be a relative path inside the Skill");
  }
  return normalized;
}

function filesIn(root, prefix = "") {
  return readdirSync(root, {withFileTypes:true}).flatMap(entry => entry.isDirectory()
    ? filesIn(join(root,entry.name), prefix + entry.name + "/") : [prefix + entry.name]).sort();
}
