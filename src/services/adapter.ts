import type { BackendClient } from "../client/backend.js";
import type { ServiceExecutionReadModel, ServiceCapabilityInvoked, ServiceCapability } from "../client/types.js";
import type { CommandEnvelope } from "./shared/envelope.js";
import type { ServicesCommandOptions } from "./shared/platform.js";
export type ResultReadOptions = ServicesCommandOptions & { jsonOutput?: boolean; snapshot?: string; journey?: string; offset?: number; limit?: number; all?: boolean };
export interface ServiceAdapter {
  supported: boolean;
  inputTemplate(schema: Record<string, unknown>, known?: Record<string, unknown>): Record<string, unknown>;
  inputInstruction: string;
  entryInstruction: string;
  guidance(serviceID: string, schema?: Record<string, unknown>): {input_example: Record<string, unknown>} | undefined;
  requiresGuidance(serviceID: string): boolean;
  overviewInstruction(topic: string): string;
  locationInstruction(schema?: Record<string, unknown>): string;
  invocation(response: ServiceCapabilityInvoked, capability: ServiceCapability, input: Record<string, unknown>, count: number): {early?: {value: CommandEnvelope; plainResult: string[]}; catalog?: unknown; instruction?: string; suffix?: string} | undefined;
  shouldWait(model: ServiceExecutionReadModel): boolean | undefined;
  pollAfter(model: ServiceExecutionReadModel): number;
  preservesTerminalRecovery(model: ServiceExecutionReadModel): boolean;
  projectState(model: ServiceExecutionReadModel): CommandEnvelope | null;
  workflow(model: ServiceExecutionReadModel): CommandEnvelope | null | undefined;
  savedResult(model: ServiceExecutionReadModel): CommandEnvelope | null;
  deliveryGuidance(model: ServiceExecutionReadModel): {instruction: string; recovery: CommandEnvelope["recovery"]} | null;
  extraFacts(model: ServiceExecutionReadModel): Record<string, unknown>;
  runError(error: unknown, serviceID: string, executionID?: string): void;
  actionError(error: unknown, executionID: string, action: string): void;
  readResult(backend: BackendClient, model: ServiceExecutionReadModel, id: string, options: ResultReadOptions): Promise<"handled" | "state" | undefined>;
  renderPage(response: Awaited<ReturnType<BackendClient["getServiceExecutionResultItemPage"]>>, id: string, item: string, offset: number, limit: number, options: ResultReadOptions): boolean;
  checkout(backend: BackendClient, model: ServiceExecutionReadModel, id: string, token: string): Promise<{itinerary?: Record<string, unknown>; itineraryTitle?: string}>;
}
