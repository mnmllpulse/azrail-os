/**
 * DARK MNMLL PULSE OS ↔ AZRAIL canonical mission protocol.
 *
 * Этот файл — стабильная граница между UI/Pulse Shell и AZRAIL Core.
 * UI не должен знать внутренние классы агентов, Durable Objects или модельный
 * роутинг. Core, в свою очередь, не должен зависеть от структуры экранов.
 */

export type MissionStatus =
  | "queued"
  | "planning"
  | "executing"
  | "verifying"
  | "repairing"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type MissionIntent =
  | "answer"
  | "analyze"
  | "build"
  | "review"
  | "design"
  | "research"
  | "media"
  | "deploy"
  | "operate"
  | "unknown";

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export interface MissionArtifact {
  id: string;
  kind: "file" | "report" | "image" | "audio" | "video" | "deployment" | "other";
  name: string;
  mimeType?: string;
  url?: string;
  r2Key?: string;
  size?: number;
}

export interface MissionAgentRun {
  id: string;
  agent: string;
  capability: string;
  status: AgentRunStatus;
  model?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
}

export interface MissionUsage {
  modelCalls: number;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export interface Mission {
  id: string;
  projectId: string;
  conversationId?: string;
  status: MissionStatus;
  intent: MissionIntent;
  title?: string;
  request: string;
  agents: MissionAgentRun[];
  artifacts: MissionArtifact[];
  usage: MissionUsage;
  progress?: number;
  currentStep?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface CreateMissionRequest {
  projectId: string;
  conversationId?: string;
  message: string;
  attachmentIds?: string[];
  preferredMode?: "auto" | "fast" | "balanced" | "deep" | "creative" | "code";
  preferredModel?: string;
  maxIterations?: number;
}

export interface CreateMissionResponse {
  mission: Mission;
  deduplicated?: boolean;
}

export interface MissionEvent {
  id: string;
  missionId: string;
  type:
    | "status"
    | "agent_started"
    | "agent_finished"
    | "tool_started"
    | "tool_finished"
    | "artifact"
    | "verification"
    | "message"
    | "error";
  createdAt: string;
  data: Record<string, unknown>;
}

export interface AzrailService {
  createMission(input: CreateMissionRequest, idempotencyKey?: string): Promise<CreateMissionResponse>;
  getMission(missionId: string): Promise<Mission>;
  cancelMission(missionId: string): Promise<Mission>;
  sendHint(missionId: string, message: string): Promise<Mission>;
  listMissionEvents(missionId: string): Promise<MissionEvent[]>;
}
