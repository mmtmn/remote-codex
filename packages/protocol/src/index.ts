import nacl from "tweetnacl";
import * as naclUtil from "tweetnacl-util";
import { z } from "zod";

export const ACTION_PERMISSION_MODES = ["allow", "ask", "deny"] as const;
export type ActionPermissionMode = (typeof ACTION_PERMISSION_MODES)[number];

export const PermissionPolicySchema = z.object({
  readWorkspace: z.enum(ACTION_PERMISSION_MODES).default("allow"),
  runCodex: z.enum(ACTION_PERMISSION_MODES).default("ask"),
  runInspectionCommands: z.enum(ACTION_PERMISSION_MODES).default("ask"),
  codexUi: z.enum(ACTION_PERMISSION_MODES).default("ask"),
  applyPatch: z.enum(ACTION_PERMISSION_MODES).default("ask")
});

export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

export const WorkspaceFilePreviewSchema = z.object({
  path: z.string(),
  languageId: z.string(),
  selection: z.string(),
  contentPreview: z.string(),
  isDirty: z.boolean(),
  visibleRangeStart: z.number().int().nonnegative(),
  visibleRangeEnd: z.number().int().nonnegative()
});

export type WorkspaceFilePreview = z.infer<typeof WorkspaceFilePreviewSchema>;

export const DiagnosticSummarySchema = z.object({
  path: z.string(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative()
});

export type DiagnosticSummary = z.infer<typeof DiagnosticSummarySchema>;

export const WorkspaceSnapshotSchema = z.object({
  capturedAt: z.string(),
  workspaceFolders: z.array(z.string()),
  activeFile: z.string().nullable(),
  visibleFiles: z.array(WorkspaceFilePreviewSchema),
  diagnostics: z.array(DiagnosticSummarySchema),
  gitStatus: z.string(),
  gitDiffStat: z.string()
});

export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export const CodexPatchProposalSchema = z.object({
  requestId: z.string(),
  summary: z.string(),
  files: z.array(z.string()),
  patch: z.string(),
  notes: z.array(z.string()).default([])
});

export type CodexPatchProposal = z.infer<typeof CodexPatchProposalSchema>;

export const RelayRegisterDesktopSchema = z.object({
  type: z.literal("registerDesktop"),
  sessionId: z.string(),
  pairingSecretHash: z.string(),
  desktopPublicKey: z.string(),
  permissions: PermissionPolicySchema
});

export const RelayJoinMobileSchema = z.object({
  type: z.literal("joinMobile"),
  sessionId: z.string(),
  pairingSecret: z.string(),
  mobilePublicKey: z.string()
});

export const RelayEnvelopeSchema = z.object({
  type: z.literal("envelope"),
  sessionId: z.string(),
  nonce: z.string(),
  ciphertext: z.string()
});

export const RelayRegisteredSchema = z.object({
  type: z.literal("registered"),
  sessionId: z.string(),
  expiresAt: z.string()
});

export const RelayJoinedSchema = z.object({
  type: z.literal("joined"),
  sessionId: z.string(),
  desktopPublicKey: z.string(),
  permissions: PermissionPolicySchema
});

export const RelayPeerOnlineSchema = z.object({
  type: z.literal("peerOnline"),
  sessionId: z.string(),
  mobilePublicKey: z.string()
});

export const RelayPeerOfflineSchema = z.object({
  type: z.literal("peerOffline"),
  sessionId: z.string()
});

export const RelayErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string()
});

export const RelayIncomingSchema = z.discriminatedUnion("type", [
  RelayRegisterDesktopSchema,
  RelayJoinMobileSchema,
  RelayEnvelopeSchema
]);

export const RelayOutgoingSchema = z.discriminatedUnion("type", [
  RelayRegisteredSchema,
  RelayJoinedSchema,
  RelayPeerOnlineSchema,
  RelayPeerOfflineSchema,
  RelayEnvelopeSchema,
  RelayErrorSchema
]);

export type RelayIncomingMessage = z.infer<typeof RelayIncomingSchema>;
export type RelayOutgoingMessage = z.infer<typeof RelayOutgoingSchema>;

export const RequestSnapshotPayloadSchema = z.object({
  type: z.literal("requestSnapshot")
});

export const SnapshotPayloadSchema = z.object({
  type: z.literal("snapshot"),
  snapshot: WorkspaceSnapshotSchema
});

export const RequestFilePayloadSchema = z.object({
  type: z.literal("requestFile"),
  path: z.string()
});

export const FileContentPayloadSchema = z.object({
  type: z.literal("fileContent"),
  path: z.string(),
  content: z.string()
});

export const RequestGitDiffPayloadSchema = z.object({
  type: z.literal("requestGitDiff"),
  path: z.string().optional()
});

export const GitDiffPayloadSchema = z.object({
  type: z.literal("gitDiff"),
  path: z.string().nullable(),
  diff: z.string()
});

export const CommandListPayloadSchema = z.object({
  type: z.literal("commandList"),
  commands: z.array(z.string())
});

export const RunCommandPayloadSchema = z.object({
  type: z.literal("runCommand"),
  command: z.string()
});

export const CommandEventPayloadSchema = z.object({
  type: z.literal("commandEvent"),
  command: z.string(),
  status: z.enum(["started", "stdout", "stderr", "finished", "error"]),
  content: z.string()
});

export const CodexUiActionSchema = z.enum(["openSidebar", "newThread", "addSelection", "addFile"]);

export type CodexUiAction = z.infer<typeof CodexUiActionSchema>;

export const CodexUiRequestPayloadSchema = z.object({
  type: z.literal("codexUiRequest"),
  action: CodexUiActionSchema
});

export const CodexUiEventPayloadSchema = z.object({
  type: z.literal("codexUiEvent"),
  action: CodexUiActionSchema,
  status: z.enum(["started", "finished", "error"]),
  content: z.string()
});

export const CodexRunRequestPayloadSchema = z.object({
  type: z.literal("codexRunRequest"),
  requestId: z.string(),
  prompt: z.string()
});

export const CodexRunEventPayloadSchema = z.object({
  type: z.literal("codexRunEvent"),
  requestId: z.string(),
  status: z.enum(["started", "progress", "finished", "error"]),
  content: z.string()
});

export const PatchProposalPayloadSchema = z.object({
  type: z.literal("patchProposal"),
  proposal: CodexPatchProposalSchema
});

export const ApplyPatchRequestPayloadSchema = z.object({
  type: z.literal("applyPatchRequest"),
  requestId: z.string()
});

export const ApplyPatchDecisionPayloadSchema = z.object({
  type: z.literal("applyPatchDecision"),
  requestId: z.string(),
  status: z.enum(["approved", "rejected", "error"]),
  message: z.string()
});

export const NotificationPayloadSchema = z.object({
  type: z.literal("notification"),
  level: z.enum(["info", "warn", "error"]),
  message: z.string()
});

export const EncryptedPayloadSchema = z.discriminatedUnion("type", [
  RequestSnapshotPayloadSchema,
  SnapshotPayloadSchema,
  RequestFilePayloadSchema,
  FileContentPayloadSchema,
  RequestGitDiffPayloadSchema,
  GitDiffPayloadSchema,
  CommandListPayloadSchema,
  RunCommandPayloadSchema,
  CommandEventPayloadSchema,
  CodexUiRequestPayloadSchema,
  CodexUiEventPayloadSchema,
  CodexRunRequestPayloadSchema,
  CodexRunEventPayloadSchema,
  PatchProposalPayloadSchema,
  ApplyPatchRequestPayloadSchema,
  ApplyPatchDecisionPayloadSchema,
  NotificationPayloadSchema
]);

export type EncryptedPayload = z.infer<typeof EncryptedPayloadSchema>;

export interface KeyPair {
  publicKey: string;
  secretKey: string;
}

export function generateSessionId(): string {
  return randomToken(12);
}

export function generatePairingSecret(): string {
  return randomToken(24);
}

export function createKeyPair(): KeyPair {
  const pair = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(pair.publicKey),
    secretKey: encodeBase64(pair.secretKey)
  };
}

export function deriveSharedKey(theirPublicKey: string, secretKey: string): Uint8Array {
  return nacl.box.before(decodeBase64(theirPublicKey), decodeBase64(secretKey));
}

export function encryptPayload(sharedKey: Uint8Array, payload: EncryptedPayload): { nonce: string; ciphertext: string } {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const message = naclUtil.decodeUTF8(JSON.stringify(payload));
  const boxed = nacl.secretbox(message, nonce, sharedKey);
  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(boxed)
  };
}

export function decryptPayload(sharedKey: Uint8Array, nonce: string, ciphertext: string): EncryptedPayload {
  const message = nacl.secretbox.open(decodeBase64(ciphertext), decodeBase64(nonce), sharedKey);
  if (!message) {
    throw new Error("Unable to decrypt payload.");
  }

  const parsed = JSON.parse(naclUtil.encodeUTF8(message));
  return EncryptedPayloadSchema.parse(parsed);
}

export function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  return globalThis.crypto.subtle.digest("SHA-256", bytes).then((hash) =>
    Array.from(new Uint8Array(hash))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")
  );
}

export function encodeBase64(input: Uint8Array): string {
  return naclUtil.encodeBase64(input);
}

export function decodeBase64(input: string): Uint8Array {
  return naclUtil.decodeBase64(input);
}

function randomToken(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = nacl.randomBytes(length);
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[bytes[index]! % alphabet.length];
  }
  return value;
}
