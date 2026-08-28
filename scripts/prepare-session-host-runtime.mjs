import {
  cp,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(projectRoot, "build", "session-host-runtime");
const hostEntryPath = join(
  projectRoot,
  "dist",
  "main",
  "main",
  "session-host",
  "process.js",
);

async function requireFile(candidatePath, label) {
  try {
    const details = await stat(candidatePath);
    if (!details.isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new Error(`${label} is missing: ${candidatePath}`);
  }
}

async function findNodeLicense() {
  const configured = process.env.CLAUDE_WORKSPACE_NODE_LICENSE_PATH;
  const candidates = [
    configured,
    join(dirname(process.execPath), "LICENSE"),
    join(dirname(process.execPath), "LICENSE.txt"),
    join(dirname(dirname(process.execPath)), "LICENSE"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Continue through known Node distribution layouts.
    }
  }
  throw new Error(
    "Cannot locate the Node.js distribution LICENSE. Set " +
      "CLAUDE_WORKSPACE_NODE_LICENSE_PATH to the LICENSE bundled with this exact Node.js runtime.",
  );
}

if (process.platform !== "win32") {
  throw new Error(
    "The Windows Session Host runtime must be prepared on Windows so node.exe and node-pty match the target platform.",
  );
}
if (process.versions.electron) {
  throw new Error("Prepare the Session Host runtime with Node.js, not Electron.");
}

await requireFile(hostEntryPath, "Compiled Session Host entry");
await requireFile(process.execPath, "Node.js executable");
await requireFile(
  join(projectRoot, "node_modules", "node-pty", "package.json"),
  "node-pty package",
);
const nodeLicensePath = await findNodeLicense();
const require = createRequire(import.meta.url);
const {
  SESSION_HOST_EXECUTABLE_FILENAME,
  SESSION_HOST_RUNTIME_VERSION,
} = require(
  join(projectRoot, "dist", "main", "main", "session-host", "protocol.js"),
);

await rm(outputPath, { recursive: true, force: true });
await mkdir(join(outputPath, "node_modules"), { recursive: true });
await copyFile(
  process.execPath,
  join(outputPath, SESSION_HOST_EXECUTABLE_FILENAME),
);
await copyFile(nodeLicensePath, join(outputPath, "NODE-LICENSE"));
await cp(join(projectRoot, "dist", "main"), join(outputPath, "dist", "main"), {
  recursive: true,
});
await cp(
  join(projectRoot, "node_modules", "node-pty"),
  join(outputPath, "node_modules", "node-pty"),
  { recursive: true },
);
await writeFile(
  join(outputPath, "runtime.json"),
  `${JSON.stringify(
    {
      runtimeVersion: SESSION_HOST_RUNTIME_VERSION,
      nodeVersion: process.versions.node,
      nodePtyVersion: JSON.parse(
        await readFile(
          join(projectRoot, "node_modules", "node-pty", "package.json"),
          "utf8",
        ),
      ).version,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
