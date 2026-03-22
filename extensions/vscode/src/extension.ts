import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import {
  type ActionPermissionMode,
  type CodexPatchProposal,
  CodexPatchProposalSchema,
  type EncryptedPayload,
  createKeyPair,
  decryptPayload,
  deriveSharedKey,
  encryptPayload,
  generatePairingSecret,
  generateSessionId,
  type PermissionPolicy,
  RelayOutgoingSchema,
  type WorkspaceSnapshot,
  sha256Hex
} from "@remote-codex/protocol";
import QRCode from "qrcode";
import * as vscode from "vscode";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const MAX_PREVIEW_CHARS = 1200;
const MAX_FILE_CHARS = 24_000;
const DANGEROUS_COMMAND_PATTERN = /[|&;<>()$`\\]/;

type PermissionAction = keyof PermissionPolicy;

interface ActiveSession {
  sessionId: string;
  pairingSecret: string;
  keyPair: ReturnType<typeof createKeyPair>;
  permissions: PermissionPolicy;
  webSocket: WebSocket;
  relayUrl: string;
  pairingLink: string;
  sharedKey: Uint8Array | undefined;
}

interface PatchReviewRequest {
  proposal: CodexPatchProposal;
  requestId: string;
}

class RemoteCodexController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly snapshotEmitter = new Debouncer(600);
  private session: ActiveSession | undefined;
  private latestProposal: CodexPatchProposal | undefined;
  private pairingPanel: vscode.WebviewPanel | undefined;
  private patchPanel: vscode.WebviewPanel | undefined;
  private pendingPatchReview: PatchReviewRequest | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.commands.registerCommand("remoteCodex.startSession", () => this.startSession()),
      vscode.commands.registerCommand("remoteCodex.stopSession", () => this.stopSession()),
      vscode.commands.registerCommand("remoteCodex.copyPairingLink", () => this.copyPairingLink()),
      vscode.commands.registerCommand("remoteCodex.reviewLatestPatch", () => this.reviewLatestPatch()),
      vscode.workspace.onDidChangeTextDocument(() => this.queueSnapshotPush()),
      vscode.window.onDidChangeTextEditorSelection(() => this.queueSnapshotPush()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.queueSnapshotPush()),
      vscode.languages.onDidChangeDiagnostics(() => this.queueSnapshotPush())
    );
  }

  dispose(): void {
    this.stopSession();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async startSession(): Promise<void> {
    if (this.session) {
      const restart = await vscode.window.showWarningMessage(
        "A Remote Codex session is already running.",
        "Restart",
        "Cancel"
      );
      if (restart !== "Restart") {
        return;
      }

      this.stopSession();
    }

    const relayUrl = this.getRelayUrl();
    const sessionId = generateSessionId();
    const pairingSecret = generatePairingSecret();
    const keyPair = createKeyPair();
    const permissions = this.getPermissions();
    const pairingLink = this.buildPairingLink({
      relayUrl,
      sessionId,
      pairingSecret
    });
    const pairingSecretHash = await sha256Hex(pairingSecret);

    const webSocket = new WebSocket(relayUrl);
    const session: ActiveSession = {
      sessionId,
      pairingSecret,
      keyPair,
      permissions,
      webSocket,
      relayUrl,
      pairingLink,
      sharedKey: undefined
    };
    this.session = session;

    webSocket.on("open", () => {
      this.sendRelayMessage({
        type: "registerDesktop",
        sessionId,
        pairingSecretHash,
        desktopPublicKey: keyPair.publicKey,
        permissions
      });
    });

    webSocket.on("message", async (raw) => {
      const parsed = RelayOutgoingSchema.safeParse(JSON.parse(raw.toString("utf8")));
      if (!parsed.success) {
        vscode.window.showWarningMessage("Remote Codex received an invalid relay response.");
        return;
      }

      await this.handleRelayMessage(parsed.data);
    });

    webSocket.on("close", () => {
      if (this.session?.webSocket === webSocket) {
        this.session = undefined;
        this.latestProposal = undefined;
        this.pendingPatchReview = undefined;
      }
    });

    webSocket.on("error", (error) => {
      vscode.window.showErrorMessage(`Remote Codex relay error: ${error.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for relay registration.")), 10_000);
      const onMessage = (raw: WebSocket.RawData) => {
        const parsed = RelayOutgoingSchema.safeParse(JSON.parse(raw.toString("utf8")));
        if (parsed.success && parsed.data.type === "registered" && parsed.data.sessionId === sessionId) {
          clearTimeout(timeout);
          webSocket.off("message", onMessage);
          resolve();
        }
      };

      webSocket.on("message", onMessage);
      webSocket.on("error", reject);
    }).catch((error) => {
      this.stopSession();
      throw error;
    });

    await this.showPairingPanel(session);
    vscode.window.showInformationMessage(`Remote Codex session ${sessionId} is ready for pairing.`);
  }

  private stopSession(): void {
    this.session?.webSocket.close();
    this.session = undefined;
    this.latestProposal = undefined;
    this.pendingPatchReview = undefined;
    this.pairingPanel?.dispose();
    this.pairingPanel = undefined;
  }

  private async copyPairingLink(): Promise<void> {
    if (!this.session) {
      vscode.window.showInformationMessage("Start a Remote Codex session first.");
      return;
    }

    await vscode.env.clipboard.writeText(this.session.pairingLink);
    vscode.window.showInformationMessage("Remote Codex pairing link copied to the clipboard.");
  }

  private async reviewLatestPatch(): Promise<void> {
    if (!this.latestProposal) {
      vscode.window.showInformationMessage("There is no patch proposal to review yet.");
      return;
    }

    await this.openPatchReviewPanel(this.latestProposal, this.pendingPatchReview?.requestId);
  }

  private async handleRelayMessage(message: ReturnType<typeof RelayOutgoingSchema.parse>): Promise<void> {
    if (!this.session) {
      return;
    }

    switch (message.type) {
      case "registered":
        return;
      case "joined":
        return;
      case "peerOnline":
        this.session.sharedKey = deriveSharedKey(message.mobilePublicKey, this.session.keyPair.secretKey);
        vscode.window.showInformationMessage("Remote Codex phone connected.");
        await this.pushSnapshot();
        this.sendEncrypted({
          type: "commandList",
          commands: this.getAllowlistedCommands()
        });
        return;
      case "peerOffline":
        this.session.sharedKey = undefined;
        vscode.window.showWarningMessage("Remote Codex phone disconnected.");
        return;
      case "error":
        vscode.window.showErrorMessage(`Remote Codex relay error: ${message.message}`);
        return;
      case "envelope": {
        if (!this.session.sharedKey) {
          return;
        }

        try {
          const payload = decryptPayload(this.session.sharedKey, message.nonce, message.ciphertext);
          await this.handleEncryptedPayload(payload);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unable to decrypt remote payload.";
          vscode.window.showErrorMessage(errorMessage);
        }
      }
    }
  }

  private async handleEncryptedPayload(payload: EncryptedPayload): Promise<void> {
    switch (payload.type) {
      case "requestSnapshot": {
        if (await this.requestPermission("readWorkspace", "Share the current workspace snapshot with the phone?")) {
          await this.pushSnapshot();
        }
        return;
      }
      case "requestFile": {
        if (!(await this.requestPermission("readWorkspace", `Share ${payload.path} with the phone?`))) {
          return;
        }

        const content = await this.readWorkspaceFile(payload.path);
        this.sendEncrypted({
          type: "fileContent",
          path: payload.path,
          content
        });
        return;
      }
      case "requestGitDiff": {
        if (!(await this.requestPermission("readWorkspace", "Share a git diff with the phone?"))) {
          return;
        }

        const diff = await this.runGit(payload.path ? ["diff", "--no-ext-diff", "--", payload.path] : ["diff", "--no-ext-diff"]);
        this.sendEncrypted({
          type: "gitDiff",
          path: payload.path ?? null,
          diff
        });
        return;
      }
      case "runCommand":
        await this.runInspectionCommand(payload.command);
        return;
      case "codexRunRequest":
        await this.runCodexRequest(payload.requestId, payload.prompt);
        return;
      case "applyPatchRequest":
        await this.requestPatchReview(payload.requestId);
        return;
      case "snapshot":
      case "fileContent":
      case "gitDiff":
      case "commandList":
      case "commandEvent":
      case "codexRunEvent":
      case "patchProposal":
      case "applyPatchDecision":
      case "notification":
        return;
    }
  }

  private async runInspectionCommand(command: string): Promise<void> {
    if (!(await this.requestPermission("runInspectionCommands", `Run "${command}" on the desktop?`))) {
      return;
    }

    if (!this.getAllowlistedCommands().includes(command)) {
      this.sendEncrypted({
        type: "commandEvent",
        command,
        status: "error",
        content: "That command is not in the allowlist."
      });
      return;
    }

    if (DANGEROUS_COMMAND_PATTERN.test(command)) {
      this.sendEncrypted({
        type: "commandEvent",
        command,
        status: "error",
        content: "Commands with shell control characters are not allowed."
      });
      return;
    }

    const [file, ...args] = command.trim().split(/\s+/).filter(Boolean);
    if (!file) {
      return;
    }

    this.sendEncrypted({
      type: "commandEvent",
      command,
      status: "started",
      content: ""
    });

    const child = spawn(file, args, {
      cwd: this.getWorkspaceRoot(),
      env: process.env
    });

    child.stdout.on("data", (chunk) => {
      this.sendEncrypted({
        type: "commandEvent",
        command,
        status: "stdout",
        content: chunk.toString("utf8")
      });
    });

    child.stderr.on("data", (chunk) => {
      this.sendEncrypted({
        type: "commandEvent",
        command,
        status: "stderr",
        content: chunk.toString("utf8")
      });
    });

    child.on("close", (code) => {
      this.sendEncrypted({
        type: "commandEvent",
        command,
        status: code === 0 ? "finished" : "error",
        content: code === 0 ? "Command finished successfully." : `Command exited with code ${code ?? "unknown"}.`
      });
    });
  }

  private async runCodexRequest(requestId: string, prompt: string): Promise<void> {
    if (!(await this.requestPermission("runCodex", "Run Codex locally in read-only mode for this remote prompt?"))) {
      this.sendEncrypted({
        type: "codexRunEvent",
        requestId,
        status: "error",
        content: "The desktop denied this Codex request."
      });
      return;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      this.sendEncrypted({
        type: "codexRunEvent",
        requestId,
        status: "error",
        content: "Open a workspace folder before running Codex remotely."
      });
      return;
    }

    this.sendEncrypted({
      type: "codexRunEvent",
      requestId,
      status: "started",
      content: ""
    });

    const tempDir = await mkdtemp(join(tmpdir(), "remote-codex-"));
    const outputPath = join(tempDir, "codex-result.json");
    const schemaPath = this.context.asAbsolutePath("media/codex-output-schema.json");
    const args = [
      "exec",
      "--json",
      "-s",
      "read-only",
      "-C",
      workspaceRoot,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      ...this.getConfiguredCodexArgs(),
      this.buildCodexPrompt(requestId, prompt, await this.buildSnapshot())
    ];

    const child = spawn("codex", args, {
      cwd: workspaceRoot,
      env: process.env
    });

    let progressBuffer = "";
    child.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split("\n");
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        this.sendEncrypted({
          type: "codexRunEvent",
          requestId,
          status: "progress",
          content: line
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      this.sendEncrypted({
        type: "codexRunEvent",
        requestId,
        status: "progress",
        content: chunk.toString("utf8")
      });
    });

    child.on("close", async (code) => {
      try {
        if (code !== 0) {
          this.sendEncrypted({
            type: "codexRunEvent",
            requestId,
            status: "error",
            content: `Codex exited with code ${code ?? "unknown"}.`
          });
          return;
        }

        const raw = await readFile(outputPath, "utf8");
        const proposal = CodexPatchProposalSchema.parse(JSON.parse(raw));
        if (proposal.requestId !== requestId) {
          throw new Error("Codex returned a mismatched request ID.");
        }
        this.latestProposal = proposal;
        this.sendEncrypted({
          type: "patchProposal",
          proposal
        });
        this.sendEncrypted({
          type: "codexRunEvent",
          requestId,
          status: "finished",
          content: proposal.summary
        });
        vscode.window.showInformationMessage("Remote Codex produced a patch proposal.");
      } catch (error) {
        this.sendEncrypted({
          type: "codexRunEvent",
          requestId,
          status: "error",
          content: error instanceof Error ? error.message : "Unable to read the Codex result."
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  }

  private async requestPatchReview(requestId: string): Promise<void> {
    if (!this.latestProposal || this.latestProposal.requestId !== requestId) {
      this.sendEncrypted({
        type: "applyPatchDecision",
        requestId,
        status: "error",
        message: "No matching patch proposal is available on the desktop."
      });
      return;
    }

    if (!(await this.requestPermission("applyPatch", "Open a local patch review panel for the phone's patch request?"))) {
      this.sendEncrypted({
        type: "applyPatchDecision",
        requestId,
        status: "rejected",
        message: "The desktop denied the patch review request."
      });
      return;
    }

    this.pendingPatchReview = {
      proposal: this.latestProposal,
      requestId
    };
    await this.openPatchReviewPanel(this.latestProposal, requestId);
  }

  private async openPatchReviewPanel(proposal: CodexPatchProposal, requestId?: string): Promise<void> {
    this.patchPanel?.dispose();
    const panel = vscode.window.createWebviewPanel("remoteCodexPatch", "Remote Codex Patch Review", vscode.ViewColumn.Beside, {
      enableScripts: true
    });
    this.patchPanel = panel;
    panel.webview.html = renderPatchPanelHtml(proposal);
    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "reject") {
        if (requestId) {
          this.sendEncrypted({
            type: "applyPatchDecision",
            requestId,
            status: "rejected",
            message: "The desktop user rejected the patch."
          });
        }
        panel.dispose();
        return;
      }

      if (message.type !== "apply") {
        return;
      }

      try {
        await this.applyPatch(proposal.patch);
        if (requestId) {
          this.sendEncrypted({
            type: "applyPatchDecision",
            requestId,
            status: "approved",
            message: "Patch applied locally."
          });
        }
        vscode.window.showInformationMessage("Remote Codex patch applied.");
        panel.dispose();
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unable to apply patch.";
        if (requestId) {
          this.sendEncrypted({
            type: "applyPatchDecision",
            requestId,
            status: "error",
            message: detail
          });
        }
        vscode.window.showErrorMessage(detail);
      }
    });
  }

  private async applyPatch(patch: string): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("Open a workspace folder before applying a patch.");
    }

    const tempDir = await mkdtemp(join(tmpdir(), "remote-codex-patch-"));
    const patchPath = join(tempDir, "proposal.diff");

    try {
      await writeFile(patchPath, patch, "utf8");
      await execFileAsync("git", ["-C", workspaceRoot, "apply", "--check", patchPath]);
      await execFileAsync("git", ["-C", workspaceRoot, "apply", patchPath]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async pushSnapshot(): Promise<void> {
    if (!this.session?.sharedKey) {
      return;
    }

    this.sendEncrypted({
      type: "snapshot",
      snapshot: await this.buildSnapshot()
    });
  }

  private queueSnapshotPush(): void {
    if (!this.session?.sharedKey) {
      return;
    }

    this.snapshotEmitter.run(() => this.pushSnapshot().catch((error) => console.error(error)));
  }

  private async buildSnapshot(): Promise<WorkspaceSnapshot> {
    const visibleFiles = vscode.window.visibleTextEditors.map((editor) => {
      const document = editor.document;
      const selection = document.getText(editor.selection).trim();
      const contentPreview = selection || document.getText().slice(0, MAX_PREVIEW_CHARS);
      const visibleRange = editor.visibleRanges[0];
      return {
        path: this.asWorkspacePath(document.uri),
        languageId: document.languageId,
        selection: selection.slice(0, 800),
        contentPreview: contentPreview.slice(0, MAX_PREVIEW_CHARS),
        isDirty: document.isDirty,
        visibleRangeStart: visibleRange?.start.line ?? 0,
        visibleRangeEnd: visibleRange?.end.line ?? 0
      };
    });

    const diagnostics = new Map<string, { errors: number; warnings: number }>();
    for (const [uri, entries] of vscode.languages.getDiagnostics()) {
      const path = this.asWorkspacePath(uri);
      const current = diagnostics.get(path) ?? { errors: 0, warnings: 0 };
      for (const entry of entries) {
        if (entry.severity === vscode.DiagnosticSeverity.Error) {
          current.errors += 1;
        } else if (entry.severity === vscode.DiagnosticSeverity.Warning) {
          current.warnings += 1;
        }
      }
      diagnostics.set(path, current);
    }

    let gitStatus = "";
    let gitDiffStat = "";
    try {
      gitStatus = await this.runGit(["status", "--short"]);
      gitDiffStat = await this.runGit(["diff", "--stat"]);
    } catch {
      gitStatus = "Git status unavailable.";
      gitDiffStat = "Git diff stat unavailable.";
    }

    return {
      capturedAt: new Date().toISOString(),
      workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.name) ?? [],
      activeFile: vscode.window.activeTextEditor ? this.asWorkspacePath(vscode.window.activeTextEditor.document.uri) : null,
      visibleFiles,
      diagnostics: Array.from(diagnostics.entries()).map(([path, value]) => ({
        path,
        errors: value.errors,
        warnings: value.warnings
      })),
      gitStatus,
      gitDiffStat
    };
  }

  private async readWorkspaceFile(path: string): Promise<string> {
    const uri = await this.resolveWorkspaceFile(path);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8").slice(0, MAX_FILE_CHARS);
  }

  private async resolveWorkspaceFile(path: string): Promise<vscode.Uri> {
    const targetPath = path.replace(/^[/\\]+/, "");
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const candidate = vscode.Uri.joinPath(folder.uri, targetPath);
      if (existsSync(candidate.fsPath)) {
        return candidate;
      }
    }

    throw new Error(`The file ${path} is not inside the current workspace.`);
  }

  private async requestPermission(action: PermissionAction, prompt: string): Promise<boolean> {
    const mode = this.getPermissions()[action] as ActionPermissionMode;
    if (mode === "allow") {
      return true;
    }

    if (mode === "deny") {
      return false;
    }

    const answer = await vscode.window.showWarningMessage(prompt, { modal: true }, "Allow", "Deny");
    return answer === "Allow";
  }

  private getPermissions(): PermissionPolicy {
    const config = vscode.workspace.getConfiguration("remoteCodex");
    return {
      readWorkspace: config.get<ActionPermissionMode>("permissions.readWorkspace", "allow"),
      runCodex: config.get<ActionPermissionMode>("permissions.runCodex", "ask"),
      runInspectionCommands: config.get<ActionPermissionMode>("permissions.runInspectionCommands", "ask"),
      applyPatch: config.get<ActionPermissionMode>("permissions.applyPatch", "ask")
    };
  }

  private getAllowlistedCommands(): string[] {
    return vscode.workspace.getConfiguration("remoteCodex").get<string[]>("commandAllowlist", []);
  }

  private getConfiguredCodexArgs(): string[] {
    const config = vscode.workspace.getConfiguration("remoteCodex");
    const extraArgs = config.get<string[]>("codex.extraArgs", []);
    const model = config.get<string>("codex.model", "");
    return model ? ["--model", model, ...extraArgs] : extraArgs;
  }

  private getRelayUrl(): string {
    return vscode.workspace.getConfiguration("remoteCodex").get<string>("relayUrl", "ws://127.0.0.1:8787");
  }

  private getMobileUrl(): string {
    return vscode.workspace.getConfiguration("remoteCodex").get<string>("mobileUrl", "http://127.0.0.1:4173");
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private buildPairingLink(values: { relayUrl: string; sessionId: string; pairingSecret: string }): string {
    const url = new URL(this.getMobileUrl());
    url.hash = new URLSearchParams(values).toString();
    return url.toString();
  }

  private async showPairingPanel(session: ActiveSession): Promise<void> {
    this.pairingPanel?.dispose();
    const panel = vscode.window.createWebviewPanel("remoteCodexPairing", "Remote Codex Pairing", vscode.ViewColumn.One, {
      enableScripts: true
    });
    this.pairingPanel = panel;
    const qrCode = await QRCode.toDataURL(session.pairingLink, { margin: 1, width: 220 });
    panel.webview.html = renderPairingPanelHtml({
      sessionId: session.sessionId,
      pairingSecret: session.pairingSecret,
      pairingLink: session.pairingLink,
      qrCode
    });
    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "copyLink") {
        await vscode.env.clipboard.writeText(session.pairingLink);
        vscode.window.showInformationMessage("Remote Codex pairing link copied to the clipboard.");
      }
    });
  }

  private sendRelayMessage(payload: unknown): void {
    if (!this.session || this.session.webSocket.readyState !== this.session.webSocket.OPEN) {
      return;
    }

    this.session.webSocket.send(JSON.stringify(payload));
  }

  private sendEncrypted(payload: EncryptedPayload): void {
    if (!this.session?.sharedKey) {
      return;
    }

    const envelope = encryptPayload(this.session.sharedKey, payload);
    this.sendRelayMessage({
      type: "envelope",
      sessionId: this.session.sessionId,
      ...envelope
    });
  }

  private asWorkspacePath(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return uri.fsPath;
    }
    const value = relative(folder.uri.fsPath, uri.fsPath);
    return value || uri.fsPath;
  }

  private buildCodexPrompt(requestId: string, prompt: string, snapshot: WorkspaceSnapshot): string {
    return [
      "You are generating a read-only patch proposal for a mobile relay to a local VS Code session.",
      "You must not edit files or execute write operations.",
      "Return JSON matching the provided schema.",
      `Use requestId exactly as provided: ${requestId}.`,
      "If changes are needed, put a valid unified diff in the patch field and list touched relative file paths in files.",
      "If no changes are needed, set patch to an empty string and explain why in notes.",
      "",
      "Workspace snapshot:",
      JSON.stringify(snapshot, null, 2),
      "",
      "User request:",
      prompt
    ].join("\n");
  }

  private async runGit(args: string[]): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return "";
    }

    const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, ...args]);
    return stdout.trim();
  }
}

class Debouncer {
  private handle: NodeJS.Timeout | undefined;

  constructor(private readonly delayMs: number) {}

  run(callback: () => void): void {
    if (this.handle) {
      clearTimeout(this.handle);
    }

    this.handle = setTimeout(() => {
      this.handle = undefined;
      callback();
    }, this.delayMs);
  }
}

function renderPairingPanelHtml(values: { sessionId: string; pairingSecret: string; pairingLink: string; qrCode: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        padding: 24px;
        color: #f5f7ff;
        background: radial-gradient(circle at top, #263a62, #111827 60%);
      }
      .card {
        max-width: 520px;
        margin: 0 auto;
        background: rgba(15, 23, 42, 0.82);
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 20px;
        padding: 24px;
      }
      img {
        display: block;
        margin: 16px auto;
        border-radius: 16px;
        background: white;
        padding: 12px;
      }
      code {
        display: block;
        white-space: pre-wrap;
        word-break: break-word;
        padding: 12px;
        background: rgba(15, 23, 42, 0.7);
        border-radius: 12px;
      }
      button {
        margin-top: 16px;
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        font-weight: 700;
        background: #8dd3ff;
        color: #08111f;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Remote Codex Pairing</h1>
      <p>Scan this QR code from the phone client. The session stays read-first and every patch still needs a local apply click.</p>
      <img src="${values.qrCode}" alt="Pairing QR code" />
      <p><strong>Session</strong><br />${values.sessionId}</p>
      <p><strong>Secret</strong><br />${values.pairingSecret}</p>
      <p><strong>Pairing link</strong></p>
      <code>${values.pairingLink}</code>
      <button id="copy">Copy Link</button>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      document.getElementById("copy")?.addEventListener("click", () => {
        vscode.postMessage({ type: "copyLink" });
      });
    </script>
  </body>
</html>`;
}

function renderPatchPanelHtml(proposal: CodexPatchProposal): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        padding: 24px;
        color: #e2e8f0;
        background: linear-gradient(180deg, #0f172a, #020617);
      }
      .actions {
        display: flex;
        gap: 12px;
        margin-bottom: 16px;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        font-weight: 700;
      }
      #apply {
        background: #84f3cb;
        color: #06261c;
      }
      #reject {
        background: #fecaca;
        color: #3f0a0a;
      }
      pre {
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        padding: 16px;
        border-radius: 16px;
        background: rgba(15, 23, 42, 0.86);
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(proposal.summary)}</h1>
              <p>${proposal.files.map((file: string) => `<code>${escapeHtml(file)}</code>`).join(" ")}</p>
    <div class="actions">
      <button id="apply">Apply Patch</button>
      <button id="reject">Reject</button>
    </div>
    <pre>${escapeHtml(proposal.patch || "No patch generated.")}</pre>
    <script>
      const vscode = acquireVsCodeApi();
      document.getElementById("apply")?.addEventListener("click", () => vscode.postMessage({ type: "apply" }));
      document.getElementById("reject")?.addEventListener("click", () => vscode.postMessage({ type: "reject" }));
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new RemoteCodexController(context);
  context.subscriptions.push(controller);
}

export function deactivate(): void {}
