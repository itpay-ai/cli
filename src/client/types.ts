// V3 API DTO types — keep in sync with services/backend/internal/presenter/*.go
// Only fields the CLI needs to read. Adding optional fields is fine; removing
// fields must be coordinated with the backend.

export interface Money {
  amount_minor: number;
  currency: string;
}

export interface LineItem {
  line_item_id?: string;
  order_item_id?: string;
  cart_item_id?: string;
  checkout_item_id?: string;
  catalog_item_id?: string;
  catalog_variant_id?: string;
  offer_id?: string;
  service_execution_id?: string;
  service_quote_lock_id?: string;
  service_capability_id?: string;
  next_action?: string;
  checkout_required?: boolean;
  agent_identity_required?: boolean;
  selected_candidate_hash?: string;
  title: string;
  quantity: number;
  amount_minor: number;
  currency: string;
  input?: Record<string, unknown>;
}

export interface Cart {
  cart_id: string;
  order_code?: string;
  status: string;
  amount_minor: number;
  currency: string;
  items: LineItem[];
}

export interface CartRequestItem {
  service_quote_lock_id?: string;
  catalog_item_id?: string;
  catalog_variant_id?: string;
  offer_id?: string;
  quantity?: number;
  input?: Record<string, unknown>;
}

export interface AddCartItemRequest extends CartRequestItem {
  client_context?: Record<string, unknown>;
}

export interface CreateCartRequest {
  currency: string;
  client_context?: Record<string, unknown>;
  items: CartRequestItem[];
}

export interface Checkout {
  checkout_id: string;
  order_code?: string;
  status: string;
  next_action: string;
  amount_minor: number;
  currency: string;
  delivery_contact?: Record<string, unknown>;
}

export interface CreateCheckoutRequest {
  cart_id: string;
  client_reference_id?: string;
  delivery_contact?: Record<string, unknown>;
}

export interface CheckoutCreated {
  checkout: Checkout;
  checkout_url: string;
  display_token: string;
  qr_payload: string;
  qr_png_url?: string;
  card_url?: string;
  card_png_url?: string;
}

export interface RailSeatPreference {
  passenger_index: number;
  preference: string;
}

export interface RailQuoteLegSummary {
  train_code: string;
  travel_date: string;
  from: string;
  to: string;
  departure: string;
  arrival: string;
  seat_name?: string;
  unit_fare_minor: number;
  fare_minor: number;
  service_fee_minor: number;
  seat_options?: string[];
  seat_preferences?: RailSeatPreference[];
  /** Planned supplier request before any order exists; never a submitted fact. */
  seat_request_planned?: "choose_seats" | "choose_beds" | "auto";
  /** Why the leg falls back to automatic assignment. */
  auto_reason?: "partial_preferences" | "unencodable" | "none";
}

export interface RailQuoteSummary {
  amount_minor: number;
  currency: string;
  expires_at: string;
  passengers: number;
  legs: RailQuoteLegSummary[];
}

export interface CheckoutPresentation {
  checkout: Checkout;
  items: LineItem[];
  payment_intents: PaymentIntent[];
  buyer_session: { state: string };
  completed_order_id?: string;
  checkout_details?: string;
  rail_passengers_confirmed?: boolean;
  rail_quote?: RailQuoteSummary;
  qr_png_url?: string;
  card_url?: string;
  card_png_url?: string;
}

export interface PaymentAction {
  qr_image_url?: string;
  mobile_wallet_url?: string;
}

export interface PaymentIntent {
  payment_intent_id: string;
  checkout_id: string;
  status: string;
  payment_method_type: string;
  amount_minor: number;
  currency: string;
  action?: PaymentAction;
}

export interface CreatePaymentIntentRequest {
  payment_method_type: "alipay" | "wechatpay";
  display_token: string;
  refresh_action?: boolean;
}

export interface Order {
  order_id: string;
  order_code?: string;
  checkout_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  created_at: string;
  paid_at?: string;
  payment_deadline_at?: string;
  items: LineItem[];
  delivery_artifacts: DeliveryArtifact[];
}

export interface DeliveryArtifact {
  delivery_artifact_id: string;
  order_id: string;
  order_item_id?: string;
  service_execution_id?: string;
  vault_artifact_id?: string;
  vault_status?: string;
  vault_payload_state?: "deferred" | "redeemed" | string;
  reveal_status?: string;
  notification_status?: string;
  status: string;
  artifact_type: string;
  public_preview?: string;
  sensitive_content_redacted: boolean;
}

export interface ListOrdersResponse {
  orders: Order[];
}

export interface SubmitServiceFeedbackRequest {
  order_item_id: string;
  rating?: number;
  note?: string;
}

export interface ServiceFeedback {
  rating?: number;
  status: "new" | "acknowledged" | "resolved" | "dismissed";
}

export interface ServiceFeedbackOptions {
  order_code?: string;
  status: string;
  items: Array<{ order_item_id: string; title: string; subject?: string; agent_feedback_submitted?: boolean }>;
}

export interface SubmitServiceFeedbackResponse {
  feedback: ServiceFeedback;
}

export interface BuyerOrderSummary {
  order_code: string;
  service_title: string;
  subject_label?: string;
  amount_minor: number;
  currency: string;
  paid_at?: string;
  order_status: string;
  vault_artifact_count: number;
}

export interface BuyerOrderSummaryList {
  items: BuyerOrderSummary[];
  next_cursor?: string;
}

export interface OrderDeliveryAccess {
  order_id: string;
  service_execution_id?: string;
  delivery_artifact_id?: string;
  vault_artifact_id?: string;
  status: string;
  delivery_mode: "agent_visible_result" | "vault_artifact";
  delivery_url?: string;
}

export interface VaultAccountStatus {
  caller_authenticated: boolean;
  buyer_bound: boolean;
  window_active: boolean;
  window_request_id?: string;
  window_expires_at?: string;
  next_action: "connect_and_authorize" | "authorize_account_window" | "list_vault";
}

export interface BuyerVaultArtifactSummary {
  artifact_ref: string;
  service_title: string;
  subject_label?: string;
  order_code: string;
  amount_minor: number;
  currency: string;
  order_status: string;
  purchased_at: string;
  artifact_status: string;
  access_status: string;
  created_at: string;
  available_sections?: string[];
}

export interface BuyerVaultArtifactList {
  items: BuyerVaultArtifactSummary[];
  next_cursor?: string;
}

export interface VaultAccessRequest {
  request_id: string;
  purpose: "account_window" | "artifact_reveal";
  artifact_ref?: string;
  requester_label: string;
  status: string;
  request_expires_at: string;
  access_expires_at?: string;
  authorization_url?: string;
  qr_png_url?: string;
}

export interface BuyerVaultRead {
  status: "result_ready" | "result_preparing" | "result_unavailable";
  artifact_ref: string;
  grant_expires_at?: string;
  result?: Record<string, unknown>;
}

export interface RefundRequest {
  refund_request_id: string;
  order_id: string;
  order_item_id?: string;
  status: string;
  amount_minor: number;
  currency: string;
  reason?: string;
	decision_mode: "automatic" | "manual";
	consumption_state: "unconsumed" | "consumed" | "unknown";
	failure_class?: "known_no_effect" | "retryable" | "outcome_unknown" | "permanent";
	access_locked: boolean;
	can_cancel: boolean;
	created_at: string;
}

export interface ListRefundsResponse { refunds: RefundRequest[]; }

export interface CreateRefundRequest {
  reason: string;
  order_item_id?: string;
}

export interface ReadyResponse {
  status: string;
  version: string;
}

export interface PlatformCompatibility {
  platform_revision: string;
  schema_revision: string;
  bootstrap_revision: string;
  api_contract_revision: string;
  active_catalog_manifest_version?: string;
  minimum_cli_version: string;
  maximum_cli_major: number;
}

export interface ErrorResponse {
  code: string;
  message: string;
  minimum_cli_version?: string;
  maximum_cli_major?: number;
  platform_revision?: string;
  api_contract_revision?: string;
  upgrade_command?: string;
  service_execution_id?: string;
  provider_called?: boolean;
  effective_quota?: EffectiveQuota;
}

export interface EffectiveQuota {
  bucket: string;
  subject_type: string;
  limit: number;
  remaining: number;
  exhausted: boolean;
  replenishment: string;
}

// --- Catalog types (from GET /v1/catalog/manifest) ---

export interface CatalogVariant {
  catalog_variant_id: string;
  offer_id: string;
  title: string;
  amount_minor: number;
  currency: string;
}

export interface CatalogPaidContinuation {
  capability_id: string;
  description: string;
  amount_minor: number;
  currency: string;
  delivery_email_required: boolean;
}

export interface CatalogServiceFlow {
  discovery: {
    role: string;
    title: string;
    description: string;
    capability_id: string;
    free_quota_limit?: number;
    quota_subject?: string;
    paid_continuation?: CatalogPaidContinuation;
  };
  primary_service: {
    capability_id: string;
    title: string;
    description: string;
    amount_minor: number;
    currency: string;
    delivery_email_required: boolean;
    delivery_description?: string;
  };
}

export interface CatalogItem {
  catalog_item_id: string;
  slug: string;
  title: string;
  provider: string;
  service_type: string;
  category: string;
  service_id?: string;
  description?: string;
  service_flow?: CatalogServiceFlow;
  variants: CatalogVariant[];
}

export interface CatalogManifest {
  version: string;
  status: string;
  item_count: number;
  snapshot_id?: string;
  manifest: { items: CatalogItem[] };
  published_at?: string;
}

// --- Service Execution types ---

export interface ServiceCapability {
  capability_id: string;
  phase: string;
  agent_visible: boolean;
  requires_payment: boolean;
  requires_human_action: boolean;
  vault_required: boolean;
  delivery_email_required: boolean;
  delivery_email_purpose?: "receipt" | "claim" | "receipt_and_claim" | "delivery";
  price_amount_minor?: number;
  pricing_method?: "rail_fare_plus_fee";
  price_currency?: string;
  free_quota_limit?: number;
  quota_subject?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export interface ServiceExecution {
  service_execution_id: string;
  service_id: string;
  service_contract_version_id: string;
  buyer_id?: string;
  agent_device_id?: string;
  status: string;
  phase: string;
  current_capability_id?: string;
  checkout_required: boolean;
  next_action: string;
  client_context?: Record<string, unknown>;
  started_at: string;
  completed_at?: string;
  failed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface StartServiceExecutionRequest {
  service_id: string;
  client_context?: Record<string, unknown>;
  /** Optional intended workflow input. The server only consumes this for
   * first-party booking selections so a repeated selection restores the
   * same purchase execution instead of duplicating it. */
  input?: Record<string, unknown>;
}

export interface ServiceExecutionStarted {
  workflow_entry?: { capability_id: string; input_schema: Record<string, unknown> };
  workflow?: { status: string; current_step: string; revision: number; steps: Record<string,string>; error_code?: string; human_action?: { action_type: string; input_schema: Record<string, unknown>; context: Record<string, unknown> } };

  execution: ServiceExecution;
  capabilities: ServiceCapability[];
  /** True when the server restored an existing execution (booking selection dedupe). */
  restored?: boolean;
}

export interface InvokeServiceCapabilityRequest {
  idempotency_key?: string;
  redacted_summary?: Record<string, unknown>;
}

export interface ServiceCapabilityInvocation {
  service_capability_invocation_id: string;
  service_execution_id: string;
  capability_id: string;
  provider_key?: string;
  idempotency_key_id?: string;
  status: string;
  safe_result_preview?: Record<string, unknown>;
  response_hash?: string;
  response_ref?: string;
  error_code?: string;
  error_message?: string;
  created_at: string;
}

export interface ServiceCapabilityResultItem {
  service_capability_result_item_id: string;
  service_capability_invocation_id?: string;
  service_execution_id: string;
  capability_id: string;
  rank: number;
  display_title: string;
  safe_payload: Record<string, unknown>;
  created_at: string;
}

export interface ServiceResultItemPage {
  service_capability_result_item_id?: string;
  service_execution_id: string;
  /** rail.progressive.v2 snapshot pages key the snapshot id instead of a
   * materialized result item. */
  snapshot_id?: string;
  plan_id?: string;
  query_revision?: number;
  capability_id?: string;
  /** Projected page: candidates slice plus saved summary aggregates and
   * catalog_page {offset, limit, total, count, next_offset}. */
  page: Record<string, unknown>;
}

export interface ServiceCapabilityInvoked {
  execution_request_id?: string;
  execution: ServiceExecution;
  invocation?: ServiceCapabilityInvocation;
  result_items: ServiceCapabilityResultItem[];
  provider_called: boolean;
  effective_quota?: EffectiveQuota;
  next_actions?: Array<{
    kind: string;
    capability_id?: string;
    requires_human: boolean;
  }>;
}

export interface RecordServiceExecutionActionRequest {
  action_type: string;
  actor_type?: string;
  actor_id?: string;
  status?: string;
  input_snapshot?: Record<string, unknown>;
  result_snapshot?: Record<string, unknown>;
  result_item_id?: string;
  required_before?: string;
}

export interface ServiceExecutionAction {
  service_execution_action_id: string;
  service_execution_id: string;
  action_type: string;
  status: string;
  actor_type: string;
  actor_id?: string;
  input_snapshot?: Record<string, unknown>;
  result_snapshot?: Record<string, unknown>;
  result_item_id?: string;
  required_before?: string;
}

export interface CreateServiceExecutionCheckoutRequest {
  capability_id?: string;
  delivery_contact?: Record<string, unknown>;
  locked_input?: Record<string, unknown>;
  resume?: boolean;
}

export interface ServiceCheckoutBinding {
  service_checkout_binding_id: string;
  service_execution_id: string;
  service_quote_lock_id: string;
  checkout_id: string;
  status: string;
}

export interface ServiceExecutionCheckoutCreated {
  service_quote_lock_id: string;
  capability_id: string;
  locked_input: Record<string, unknown>;
  cart: Cart;
  checkout: CheckoutCreated;
  binding: ServiceCheckoutBinding;
  handoff_reissued: boolean;
}

export interface ServiceQuotePrepared {
  service_quote_lock_id: string;
  service_execution_id: string;
  capability_id: string;
  amount_minor: number;
  currency: string;
  expires_at: string;
}

export interface ExecutionRequest {
  execution_request_id: string;
  execution_kind: string;
  aggregate_type: string;
  aggregate_id: string;
  status: string;
  external_execution_id?: string;
  external_run_id?: string;
  last_error?: string;
	operation: "start" | "signal" | string;
	signal_name?: string;
	dedupe_key?: string;
	available_at?: string;
	dispatch_attempts: number;
}

export interface ServiceExecutionEvent {
  service_execution_event_id: string;
  service_execution_id: string;
  sequence: number;
  type: string;
  status: string;
  phase: string;
  capability_id?: string;
  redacted_summary?: Record<string, unknown>;
  occurred_at: string;
}

export interface ServiceExecutionEvents {
  events: ServiceExecutionEvent[];
}

export interface ServiceDeliveryBinding {
  service_delivery_binding_id: string;
  service_execution_id: string;
  capability_id?: string;
  order_id: string;
  order_item_id?: string;
  delivery_artifact_id?: string;
  claim_link_id?: string;
  vault_artifact_id?: string;
  agent_read_grant_id?: string;
  status: string;
  vault_status?: string;
  vault_payload_state?: string;
  reveal_status?: string;
  grant_status?: string;
  grant_expires_at?: string;
  redacted_summary?: Record<string, unknown>;
  preparation?: {
    status: "pending" | "running" | "completed" | "partial" | "failed";
    total_nodes: number;
    completed_nodes: number;
    succeeded_nodes: number;
    failed_nodes: number;
  };
}

export interface RailSeatObservation {
  passenger_index: number;
  seat_type_name?: string;
  seat_label?: string;
  coach_no?: string;
  seat_no?: string;
  seat_source?: string;
  confirmed: boolean;
}

export interface RailBookingLegStatus {
  leg_index: number;
  state: string;
  issued: boolean;
  details_pending?: boolean;
  seat_request?: string;
  supplier_state?: string;
  train_code?: string;
  travel_date?: string;
  from?: string;
  to?: string;
  departure?: string;
  arrival?: string;
  seat_name?: string;
  seat_options?: string[];
  seat_preferences?: RailSeatPreference[];
  seats?: RailSeatObservation[];
}

export interface RailBookingStatus {
  state: "pending" | "issued" | "manual_review" | string;
  message: string;
  issued_legs: number;
  legs: RailBookingLegStatus[];
}

export interface RailPlanningProjection {
  schema_version?: string;
  plan_id?: string;
  service_execution_id?: string;
  query_revision?: number;
  snapshot_id?: string;
  /** The committed catalog snapshot detail/catalog reads resolve against —
   * distinct from snapshot_id, which tracks the newest committed snapshot. */
  catalog_snapshot_id?: string;
  snapshot_version?: number;
  readiness?: "pending" | "ready" | "expired" | string;
  first_ready_at?: string;
  result_item_id?: string;
  search?: {
    expansion_status?: "queued" | "running" | "paused" | "complete" | "cancelled" | "failed" | "expired" | string;
    phase?: string;
    transfer_status?: "disabled" | "not_needed" | "pending" | "in_progress" | "complete" | string;
    transition_reason?: string;
    authorization?: "auto" | "manual" | string;
    expansion_target?: "resume_current" | "more_direct_and_one_transfer" | "two_transfer" | "auto" | string;
    decision_source?: string;
    model_outcome?: string;
    reason?: string;
    poll_after_ms?: number;
    new_results_guaranteed?: boolean;
    counts?: {
      pairs_checked?: number;
      pairs_total?: number;
      pairs_failed?: number;
      journeys_total?: number;
      journeys_direct?: number;
      journeys_one_transfer?: number;
      journeys_multi_transfer?: number;
    };
  };
  coverage?: Record<string, unknown>;
  budgets?: Record<string, number>;
  notices?: Array<Record<string, unknown>>;
  recommendation?: RailJourneyCard;
  alternatives?: RailJourneyCard[];
  available_actions?: Array<{ type: string; command: string; provider_effect: string; when?: string; input_example?: Record<string, unknown> }>;
  result_not_updated?: boolean;
}

export interface RailJourneyCard {
  decision_role?: string;
  explanation?: string[];
  reason_codes?: string[];
  tradeoff_codes?: string[];
  profile_ref?: string;
  recommended_profile?: Record<string, unknown>;
  journey_id: string;
  route_family_id: string;
  route?: string[];
  route_names?: string[];
  route_text?: string;
  rides?: Array<Record<string, unknown>>;
  availability?: string;
  passengers?: number;
  transfer_count?: number;
  transfer_wait_minutes?: number[];
  seat_offers?: Array<Record<string, unknown>[]>;
  ticket_plans?: Array<Record<string, unknown>>;
  // §2.4 default-recommendation layer: "main" cards are the planner's primary
  // choice; "backup" cards carry backup_reason explaining why they were
  // demoted (longer wait, worse connection, duplicate group member).
  default_layer?: "main" | "backup" | string;
  backup_reason?: string;
  choice_group_representative?: string | null;
  representative_offer?: {
    offer_id: string;
    fare_minor: number;
    service_fee_minor: number;
    rail_payable_minor: number;
    currency: string;
    ticket_offers?: Array<Record<string, unknown>>;
  } | null;
  ground_summary?: Record<string, unknown>;
  risk_notes?: string[];
  observed_at?: string;
  booking_support?: "single_leg" | "separate_legs_only" | "none" | string;
  // Server-issued purchase handle: present only on single_leg cards. The token
  // is opaque — submit it verbatim to itpay-rail-booking, never decode it.
  booking_offer?: { service_id: string; selection_token: string };
  candidate_ids?: string[];
}

export interface RailJourneyDetail {
  service_execution_id: string;
  plan_id: string;
  snapshot_id: string;
  query_revision: number;
  journey: RailJourneyCard;
}

export interface RailPlanningCatalog {
  service_execution_id: string;
  plan_id: string;
  snapshot_id: string;
  query_revision: number;
  catalog: Record<string, unknown>;
}

export interface ServiceExecutionReadModel {
  rail_booking?: RailBookingStatus;
  rail_planning?: RailPlanningProjection;
  workflow_entry?: { capability_id: string; input_schema: Record<string, unknown> };
  workflow?: { status: string; current_step: string; revision: number; steps: Record<string,string>; error_code?: string; human_action?: { action_type: string; input_schema: Record<string, unknown>; context: Record<string, unknown> } };

  execution: ServiceExecution;
  capabilities: ServiceCapability[];
  events: ServiceExecutionEvent[];
  result_items: ServiceCapabilityResultItem[];
  actions: ServiceExecutionAction[];
  checkout_bindings: ServiceCheckoutBinding[];
  payment_bindings: Array<Record<string, unknown>>;
  execution_requests: ExecutionRequest[];
  provider_invocations: Array<Record<string, unknown>>;
  delivery_bindings: ServiceDeliveryBinding[];
  current_delivery?: ServiceDeliveryBinding;
  refunds: RefundRequest[];
  current_result_items?: ServiceCapabilityResultItem[];
  allowed_actions?: ServiceExecutionAllowedAction[];
  quota?: ServiceExecutionQuotaView;
}

export interface ServiceExecutionQuotaView {
  bucket: string;
  subject_type: string;
  limit: number;
  remaining: number;
  paused: boolean;
  pause_code?: string;
}

export interface ServiceExecutionAllowedAction {
  type: "invoke_capability" | "select_candidate" | "prepare_quote" | "resume_checkout" | "wait" | "view_delivery" | string;
  capability_id?: string;
  source_capability_id?: string;
  requires_human: boolean;
}

export interface ListServiceExecutionsResponse {
  executions: ServiceExecutionReadModel[];
}

export interface GrantedServiceResult {
  service_execution_id: string;
  vault_artifact_id: string;
  agent_read_grant_id: string;
  grant_status: string;
  expires_at?: string;
  result: Record<string, unknown>;
}

// --- SSE event types ---

export interface SSEEvent {
  aggregateType: string;
  aggregateId: string;
  type: string;
  sequence: number;
  payload: Record<string, unknown>;
}
