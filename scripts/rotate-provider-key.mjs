import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ARK_KEYCHAIN_SERVICE = "com.mesy.xiaoshimei-studio.volcengine-ark";

export function validateArkApiKey(value) {
  const key = String(value || "").trim();
  if (!/^ark-[A-Za-z0-9_-]{24,512}$/.test(key)) throw new TypeError("ARK_API_KEY_FORMAT_INVALID");
  return key;
}

function runSecretCommand(command, args, { input = "", cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error("SECRET_COMMAND_START_FAILED")));
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`SECRET_COMMAND_FAILED:${code ?? "UNKNOWN"}`));
    });
    child.stdin.end(input);
  });
}

async function readKeychain({ account, run = runSecretCommand } = {}) {
  const value = await run("/usr/bin/security", ["find-generic-password", "-a", account, "-s", ARK_KEYCHAIN_SERVICE, "-w"]);
  return validateArkApiKey(value);
}

async function writeKeychain(value, { account, run = runSecretCommand } = {}) {
  // Placing -w last makes macOS Security read the password from stdin instead
  // of exposing it in argv or shell history.
  await run("/usr/bin/security", ["add-generic-password", "-a", account, "-s", ARK_KEYCHAIN_SERVICE, "-U", "-w"], { input: `${value}\n` });
}

async function updateVercelPreview(value, { cwd = process.cwd(), run = runSecretCommand } = {}) {
  await run("npx", ["--yes", "vercel@latest", "env", "update", "ARK_API_KEY", "preview", "--sensitive", "--yes", "--cwd", cwd], { input: `${value}\n`, cwd });
}

export async function rotatePreviewProviderKey(value, {
  account = process.env.USER || process.env.LOGNAME || "",
  platform = process.platform,
  cwd = process.cwd(),
  readCurrent = (options) => readKeychain(options),
  writeLocal = (next, options) => writeKeychain(next, options),
  writePreview = (next, options) => updateVercelPreview(next, options),
} = {}) {
  const next = validateArkApiKey(value);
  if (platform !== "darwin" || !account) throw new Error("KEYCHAIN_ACCOUNT_UNAVAILABLE");
  const previous = await readCurrent({ account });
  if (previous === next) throw new Error("ARK_API_KEY_UNCHANGED");

  await writeLocal(next, { account });
  try {
    await writePreview(next, { cwd });
  } catch (error) {
    let remoteRollback = null;
    try { await writePreview(previous, { cwd }); }
    catch (rollbackError) { remoteRollback = rollbackError; }
    await writeLocal(previous, { account });
    if (remoteRollback) throw new Error("PREVIEW_KEY_ROTATION_ROLLBACK_UNCERTAIN", { cause: error });
    throw new Error("PREVIEW_KEY_ROTATION_FAILED_ROLLED_BACK", { cause: error });
  }
  return { target: "preview", keychainUpdated: true, vercelUpdated: true, redeployRequired: true };
}

export function readHiddenLine({ input = process.stdin, output = process.stdout, prompt = "新的 Ark API Key：" } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") throw new Error("INTERACTIVE_TTY_REQUIRED");
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = Boolean(input.isRaw);
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("ROTATION_CANCELLED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " " && value.length < 640) value += character;
      }
    };
    output.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--preview") {
    console.error("用法：npm run provider:key:rotate -- --preview");
    process.exitCode = 64;
    return;
  }
  try {
    const key = await readHiddenLine();
    await rotatePreviewProviderKey(key);
    console.log("Preview Key 已同步到本机钥匙串和 Vercel Sensitive Environment Variable。请重新部署 Preview 后再验证；Production 未改变。");
  } catch (error) {
    console.error(`Preview Key 轮换失败：${String(error?.message || "UNKNOWN")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
