#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function printHelp() {
  console.log(`Remote Codex CLI

Usage:
  remote-codex start [--watch] [--host <host>] [--port <port>]
  remote-codex stream [--watch] [--host <host>] [--port <port>] [--vnc-host <host>] [--vnc-port <port>] [--token <token>]
  remote-codex relay [--watch] [--host <host>] [--port <port>]
  remote-codex mobile [--watch]

Commands:
  start    Start the relay server and browser control surface.
  stream   Start the relay, browser viewer, and VNC proxy for the real desktop stream.
  relay    Start only the relay server.
  mobile   Start only the mobile web client.

Options:
  --watch              Use file-watch mode for the selected service.
  --host <host>        Relay bind host. Defaults to 0.0.0.0.
  --port <port>        Relay port. Defaults to 8787.
  --mobile-host <host> Host printed into the phone URL. Defaults to detected LAN IP.
  --vnc-host <host>    TCP host for the desktop VNC server. Defaults to 127.0.0.1.
  --vnc-port <port>    TCP port for the desktop VNC server. Defaults to 5900.
  --token <token>      Shared token for the VNC proxy URL. Defaults to a random value.
  --no-x11vnc          Do not auto-start x11vnc, even when it is available.

Notes:
  - Inside this repo, use "pnpm start", "node ./scripts/remote-codex.mjs start", or "node ./scripts/remote-codex.mjs stream".
  - After "npm link", the terminal command is remote-codex.
  - The VS Code command palette command is "Remote Codex: Start Session".
`);
}

function parseOptions(argv) {
  const options = {
    host: "0.0.0.0",
    port: "8787",
    watch: false,
    mobileHost: "",
    token: randomBytes(18).toString("hex"),
    vncHost: "127.0.0.1",
    vncPort: "5900",
    spawnX11Vnc: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--watch") {
      options.watch = true;
      continue;
    }

    if (arg === "--no-x11vnc") {
      options.spawnX11Vnc = false;
      continue;
    }

    const hostValue = readOptionValue(argv, arg, index, "--host");
    if (hostValue) {
      options.host = hostValue.value;
      index += hostValue.consumed;
      continue;
    }

    const portValue = readOptionValue(argv, arg, index, "--port");
    if (portValue) {
      options.port = portValue.value;
      index += portValue.consumed;
      continue;
    }

    const mobileHostValue = readOptionValue(argv, arg, index, "--mobile-host");
    if (mobileHostValue) {
      options.mobileHost = mobileHostValue.value;
      index += mobileHostValue.consumed;
      continue;
    }

    const vncHostValue = readOptionValue(argv, arg, index, "--vnc-host");
    if (vncHostValue) {
      options.vncHost = vncHostValue.value;
      index += vncHostValue.consumed;
      continue;
    }

    const vncPortValue = readOptionValue(argv, arg, index, "--vnc-port");
    if (vncPortValue) {
      options.vncPort = vncPortValue.value;
      index += vncPortValue.consumed;
      continue;
    }

    const tokenValue = readOptionValue(argv, arg, index, "--token");
    if (tokenValue) {
      options.token = tokenValue.value;
      index += tokenValue.consumed;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readOptionValue(argv, arg, index, name) {
  if (arg === name) {
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${name}.`);
    }

    return { value, consumed: 1 };
  }

  if (arg.startsWith(`${name}=`)) {
    return { value: arg.slice(name.length + 1), consumed: 0 };
  }

  return null;
}

function pipeOutput(stream, label, writer) {
  if (!stream) {
    return;
  }

  const lineReader = readline.createInterface({ input: stream });
  lineReader.on("line", (line) => {
    writer(`[${label}] ${line}\n`);
  });
}

function spawnProcess(command, args, label, env = process.env, cwd = rootDir) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["inherit", "pipe", "pipe"]
  });

  pipeOutput(child.stdout, label, (line) => process.stdout.write(line));
  pipeOutput(child.stderr, label, (line) => process.stderr.write(line));

  child.on("error", (error) => {
    process.stderr.write(`[${label}] Failed to launch: ${error.message}\n`);
  });

  return child;
}

function spawnPnpm(args, label, env = process.env) {
  return spawnProcess(pnpmCommand, args, label, env, rootDir);
}

function runSingleService(name, args, env) {
  const child = spawnPnpm(args, name, env);
  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

function startServices(options, mode) {
  const relayArgs = ["--filter", "@remote-codex/relay-server", options.watch ? "dev:watch" : "dev"];
  const mobileArgs = ["--filter", "@remote-codex/mobile", options.watch ? "dev:watch" : "dev"];
  const relayEnv = {
    ...process.env,
    HOST: options.host,
    PORT: options.port
  };

  if (mode === "stream") {
    relayEnv.VNC_PROXY_ENABLED = "1";
    relayEnv.VNC_PROXY_TOKEN = options.token;
    relayEnv.VNC_TARGET_HOST = options.vncHost;
    relayEnv.VNC_TARGET_PORT = options.vncPort;
  }

  console.log(mode === "stream" ? "Starting Remote Codex stream services..." : "Starting Remote Codex services...");
  console.log(`Relay: ws://${options.host}:${options.port}`);
  console.log("Mobile: http://0.0.0.0:4173");

  if (mode === "stream") {
    const phoneUrl = buildStreamUrl(options);
    const candidateUrls = buildCandidateStreamUrls(options);

    console.log(`VNC target: ${options.vncHost}:${options.vncPort}`);
    console.log(`Phone stream URL: ${phoneUrl}`);

    if (candidateUrls.length > 1) {
      console.log("Detected multiple local network addresses. If the primary URL does not load on the phone, try one of these:");
      for (const candidate of candidateUrls) {
        const hotspotHint = isWirelessInterface(candidate.name) ? " (wireless/hotspot candidate)" : "";
        console.log(`- ${candidate.name} ${candidate.address}${hotspotHint}: ${candidate.url}`);
      }
    }

    console.log("Warning: do not open the stream URL inside the same desktop session you are capturing.");
    console.log("That creates recursive screen capture and can spike CPU/GPU usage or freeze the desktop.");
  } else {
    console.log('When both are running, open VS Code and run "Remote Codex: Start Session" from the Command Palette.');
  }

  const children = [
    { child: spawnPnpm(relayArgs, "relay", relayEnv), required: true },
    { child: spawnPnpm(mobileArgs, "mobile"), required: true }
  ];

  if (mode === "stream") {
    const vncChild = maybeSpawnX11Vnc(options);
    if (vncChild) {
      children.push({ child: vncChild, required: false });
    } else {
      console.log(`x11vnc was not started automatically. Ensure a VNC server is listening on ${options.vncHost}:${options.vncPort}.`);
    }
  }

  monitorChildren(children);
}

function maybeSpawnX11Vnc(options) {
  if (!options.spawnX11Vnc) {
    return null;
  }

  if (process.env.XDG_SESSION_TYPE && process.env.XDG_SESSION_TYPE !== "x11") {
    console.log(`Auto-start only supports x11vnc on X11. Current session type: ${process.env.XDG_SESSION_TYPE}.`);
    return null;
  }

  if (!process.env.DISPLAY) {
    console.log("DISPLAY is not set, so x11vnc cannot be auto-started.");
    return null;
  }

  const check = spawnSync("bash", ["-lc", "command -v x11vnc"], {
    cwd: rootDir,
    env: process.env,
    stdio: "pipe",
    encoding: "utf8"
  });

  if (check.status !== 0) {
    return null;
  }

  console.log(`Auto-starting x11vnc on display ${process.env.DISPLAY} via 127.0.0.1:${options.vncPort}.`);
  return spawnProcess(
    "x11vnc",
    [
      "-localhost",
      "-shared",
      "-forever",
      "-nopw",
      "-noxdamage",
      "-nowf",
      "-noscr",
      "-wait",
      "25",
      "-defer",
      "25",
      "-display",
      process.env.DISPLAY,
      "-rfbport",
      options.vncPort
    ],
    "x11vnc"
  );
}

function monitorChildren(children) {
  let shuttingDown = false;
  let remaining = children.length;
  let exitCode = 0;

  const closeChildren = (signal) => {
    shuttingDown = true;
    for (const entry of children) {
      const child = entry.child;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
  };

  for (const entry of children) {
    entry.child.on("exit", (code, signal) => {
      remaining -= 1;

      if (!shuttingDown && entry.required) {
        exitCode = code ?? (signal ? 1 : 0);
        closeChildren("SIGTERM");
      }

      if (!shuttingDown && !entry.required) {
        process.stderr.write("[x11vnc] Stopped. The stream will only work if another VNC server is still available.\n");
      }

      if (remaining === 0) {
        process.exit(exitCode);
      }
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      closeChildren(signal);
    });
  }
}

function listCandidateHosts() {
  const interfaces = networkInterfaces();
  const candidates = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        candidates.push({ name, address: entry.address });
      }
    }
  }

  return candidates;
}

function isWirelessInterface(name) {
  return /^wl/i.test(name) || /^wifi/i.test(name) || /^wlan/i.test(name);
}

function detectLanHost() {
  const candidates = listCandidateHosts();
  for (const candidate of candidates) {
    if (isWirelessInterface(candidate.name)) {
      return candidate.address;
    }
  }

  for (const candidate of candidates) {
    return candidate.address;
  }

  return "127.0.0.1";
}

function resolvePublicHost(host, mobileHost) {
  if (mobileHost) {
    return mobileHost;
  }

  if (host === "0.0.0.0" || host === "127.0.0.1" || host === "localhost") {
    return detectLanHost();
  }

  return host;
}

function buildStreamUrl(options) {
  const publicHost = resolvePublicHost(options.host, options.mobileHost);
  return buildStreamUrlForHost(options, publicHost);
}

function buildStreamUrlForHost(options, publicHost) {
  const vncUrl = `ws://${publicHost}:${options.port}/vnc?token=${encodeURIComponent(options.token)}`;
  const query = new URLSearchParams({
    mode: "stream",
    title: "VS Code / Codex",
    vncUrl
  });
  return `http://${publicHost}:4173/?${query.toString()}`;
}

function buildCandidateStreamUrls(options) {
  const genericHost = options.host === "0.0.0.0" || options.host === "127.0.0.1" || options.host === "localhost";
  if (options.mobileHost || !genericHost) {
    return [];
  }

  return listCandidateHosts().map((candidate) => ({
    ...candidate,
    url: buildStreamUrlForHost(options, candidate.address)
  }));
}

const [command, ...rest] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (rest.includes("--help") || rest.includes("-h")) {
  printHelp();
  process.exit(0);
}

try {
  const options = parseOptions(rest);

  if (command === "start") {
    startServices(options, "relay");
  } else if (command === "stream") {
    startServices(options, "stream");
  } else if (command === "relay") {
    runSingleService(
      "relay",
      ["--filter", "@remote-codex/relay-server", options.watch ? "dev:watch" : "dev"],
      { ...process.env, HOST: options.host, PORT: options.port }
    );
  } else if (command === "mobile") {
    runSingleService("mobile", ["--filter", "@remote-codex/mobile", options.watch ? "dev:watch" : "dev"]);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
  printHelp();
  process.exit(1);
}
