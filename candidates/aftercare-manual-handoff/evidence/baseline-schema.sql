-- Generated from db/v3/schema/[0-9][0-9]_*.sql. Do not edit directly.

-- ============================================================
-- Source: db/v3/schema/00_extensions.sql
-- ============================================================

-- Shared PostgreSQL helpers for the V3 draft schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION itpay_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION itpay_touch_updated_at(table_name regclass)
RETURNS void AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %s', table_name);
  EXECUTE format(
    'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION itpay_set_updated_at()',
    table_name
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Source: db/v3/schema/10_identity.sql
-- ============================================================

-- Identity and account access.

CREATE TABLE IF NOT EXISTS buyer_accounts (
  buyer_account_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted', 'merged')),
  primary_email text,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  onboarding_completed_at timestamptz,
  merged_into_buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  primary_phone text,
  display_name text,
  avatar_url text,
  delivery_contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE buyer_accounts ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE buyer_accounts ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE buyer_accounts ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
ALTER TABLE buyer_accounts ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;
ALTER TABLE buyer_accounts ADD COLUMN IF NOT EXISTS merged_into_buyer_account_id text REFERENCES buyer_accounts(buyer_account_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_accounts_verified_email
  ON buyer_accounts(lower(primary_email))
  WHERE email_verified_at IS NOT NULL AND status <> 'merged';
CREATE INDEX IF NOT EXISTS idx_buyer_accounts_merged_into
  ON buyer_accounts(merged_into_buyer_account_id)
  WHERE merged_into_buyer_account_id IS NOT NULL;

SELECT itpay_touch_updated_at('buyer_accounts');

CREATE TABLE IF NOT EXISTS provider_identities (
  provider_identity_id text PRIMARY KEY,
  buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  provider text NOT NULL CHECK (provider IN ('alipay', 'wechat', 'email', 'phone')),
  provider_subject text NOT NULL,
  display_name text,
  email text,
  phone text,
  avatar_url text,
  raw_profile_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

ALTER TABLE provider_identities ADD COLUMN IF NOT EXISTS avatar_url text;

SELECT itpay_touch_updated_at('provider_identities');

CREATE TABLE IF NOT EXISTS agent_devices (
  agent_device_id text PRIMARY KEY,
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  quota_lineage_id text NOT NULL UNIQUE DEFAULT ('qln_' || replace(gen_random_uuid()::text, '-', '')),
  host text NOT NULL,
  target text,
  display_name text,
  fingerprint_hash text NOT NULL,
  trust_status text NOT NULL DEFAULT 'legacy_unverified'
    CHECK (trust_status IN ('legacy_unverified', 'enrolled', 'attested', 'blocked')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  enrolled_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host, target, fingerprint_hash)
);

SELECT itpay_touch_updated_at('agent_devices');

CREATE TABLE IF NOT EXISTS agent_device_enrollments (
  agent_device_enrollment_id text PRIMARY KEY,
  public_key bytea NOT NULL,
  key_algorithm text NOT NULL CHECK (key_algorithm IN ('ed25519')),
  challenge_hash text NOT NULL UNIQUE,
  requested_agent_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'expired', 'failed')),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('agent_device_enrollments');

CREATE TABLE IF NOT EXISTS agent_device_keys (
  agent_device_key_id text PRIMARY KEY,
  agent_device_id text NOT NULL REFERENCES agent_devices(agent_device_id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  key_algorithm text NOT NULL CHECK (key_algorithm IN ('ed25519')),
  key_thumbprint text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotated', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_device_keys_active
  ON agent_device_keys(agent_device_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS agent_instances (
  agent_instance_id text PRIMARY KEY,
  agent_device_id text NOT NULL REFERENCES agent_devices(agent_device_id) ON DELETE CASCADE,
  agent_type text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_device_id, agent_type),
  UNIQUE (agent_instance_id, agent_device_id)
);

SELECT itpay_touch_updated_at('agent_instances');

CREATE TABLE IF NOT EXISTS agent_device_session_challenges (
  agent_device_session_challenge_id text PRIMARY KEY,
  agent_device_id text NOT NULL REFERENCES agent_devices(agent_device_id) ON DELETE CASCADE,
  agent_instance_id text NOT NULL REFERENCES agent_instances(agent_instance_id) ON DELETE CASCADE,
  challenge_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'expired', 'failed')),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('agent_device_session_challenges');

CREATE TABLE IF NOT EXISTS agent_device_sessions (
  agent_device_session_id text PRIMARY KEY,
  agent_device_id text NOT NULL REFERENCES agent_devices(agent_device_id) ON DELETE CASCADE,
  agent_instance_id text NOT NULL REFERENCES agent_instances(agent_instance_id) ON DELETE CASCADE,
  session_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('agent_device_sessions');
CREATE INDEX IF NOT EXISTS idx_agent_device_sessions_device
  ON agent_device_sessions(agent_device_id, status, expires_at);

CREATE TABLE IF NOT EXISTS agent_device_account_bindings (
  agent_device_account_binding_id text PRIMARY KEY,
  agent_device_id text NOT NULL REFERENCES agent_devices(agent_device_id) ON DELETE CASCADE,
  buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  source_order_id text,
  source_payment_proof_id text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  bound_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_device_account_bindings_active
  ON agent_device_account_bindings(agent_device_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS buyer_sessions (
  buyer_session_id text PRIMARY KEY,
  buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  agent_device_id text REFERENCES agent_devices(agent_device_id),
  session_hash text NOT NULL UNIQUE,
  scope text NOT NULL DEFAULT 'account'
    CHECK (scope IN ('account', 'order', 'checkout')),
  scoped_order_id text,
  scoped_checkout_id text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyer_sessions_scope_target_check CHECK (
    (scope = 'account' AND scoped_order_id IS NULL AND scoped_checkout_id IS NULL) OR
    (scope = 'order' AND scoped_order_id IS NOT NULL AND scoped_checkout_id IS NULL) OR
    (scope = 'checkout' AND scoped_order_id IS NULL AND scoped_checkout_id IS NOT NULL)
  )
);

SELECT itpay_touch_updated_at('buyer_sessions');

CREATE INDEX IF NOT EXISTS idx_buyer_sessions_buyer ON buyer_sessions(buyer_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_buyer_sessions_scoped_order
  ON buyer_sessions(scoped_order_id)
  WHERE scope = 'order';
CREATE INDEX IF NOT EXISTS idx_buyer_sessions_scoped_checkout
  ON buyer_sessions(scoped_checkout_id)
  WHERE scope = 'checkout';

CREATE TABLE IF NOT EXISTS mcp_connections (
  mcp_connection_id text PRIMARY KEY,
  buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  oauth_issuer text NOT NULL,
  oauth_client_id text NOT NULL,
  oauth_grant_reference text NOT NULL,
  platform_hint text,
  granted_scopes text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (oauth_issuer, oauth_client_id, oauth_grant_reference),
  CONSTRAINT mcp_connections_revocation_check CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status <> 'revoked' AND revoked_at IS NULL)
  )
);

SELECT itpay_touch_updated_at('mcp_connections');

CREATE INDEX IF NOT EXISTS idx_mcp_connections_buyer
  ON mcp_connections(buyer_account_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_connections_active_client
  ON mcp_connections(buyer_account_id, oauth_issuer, oauth_client_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS mcp_workload_request_proofs (
  jti_hash text PRIMARY KEY,
  workload_id text NOT NULL,
  request_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_workload_request_proofs_expiry
  ON mcp_workload_request_proofs(expires_at);

CREATE TABLE IF NOT EXISTS dashboard_auth_sessions (
  dashboard_auth_session_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'waiting_provider', 'email_verification_required', 'merge_confirmation_required', 'completed', 'expired', 'failed')),
  purpose text NOT NULL DEFAULT 'login'
    CHECK (purpose IN ('login', 'provider_link')),
  provider text CHECK (provider IN ('alipay', 'wechat', 'phone', 'email')),
  poll_token_hash text NOT NULL,
  start_token_hash text NOT NULL,
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  buyer_session_id text REFERENCES buyer_sessions(buyer_session_id),
	account_merge_request_id text,
  redirect_url text,
  error_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('dashboard_auth_sessions');

CREATE TABLE IF NOT EXISTS email_auth_challenges (
  email_auth_challenge_id text PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('sign_in', 'dashboard_wallet', 'email_change')),
  normalized_email text NOT NULL,
  email_identity_subject text NOT NULL,
  otp_mac text NOT NULL,
  continuation_token_hash text NOT NULL UNIQUE,
  source_ip_hash text NOT NULL,
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  dashboard_auth_session_id text REFERENCES dashboard_auth_sessions(dashboard_auth_session_id),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  send_count integer NOT NULL DEFAULT 1 CHECK (send_count > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'consumed', 'expired', 'failed')),
  expires_at timestamptz NOT NULL,
  resend_available_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('email_auth_challenges');
CREATE INDEX IF NOT EXISTS idx_email_auth_challenges_rate_email
  ON email_auth_challenges(email_identity_subject, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_auth_challenges_rate_ip
  ON email_auth_challenges(source_ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS phone_auth_challenges (
  phone_auth_challenge_id text PRIMARY KEY,
  -- order_contact challenges verify a checkout-scoped notification recipient;
  -- consuming one never creates or merges a login identity.
  purpose text NOT NULL CHECK (purpose IN ('sign_in', 'order_contact')),
  normalized_phone text NOT NULL,
  phone_identity_subject text NOT NULL,
  otp_mac text NOT NULL,
  continuation_token_hash text NOT NULL UNIQUE,
  source_ip_hash text NOT NULL,
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  dashboard_auth_session_id text REFERENCES dashboard_auth_sessions(dashboard_auth_session_id),
  -- checkout_id scopes an order_contact challenge to one checkout.
  checkout_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  send_count integer NOT NULL DEFAULT 1 CHECK (send_count > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'consumed', 'expired', 'failed')),
  -- Provider-side send classification, written after the network call:
  -- accepted (provider took it), rejected (permanent), unknown (ambiguous).
  send_outcome text CHECK (send_outcome IN ('accepted', 'rejected', 'unknown')),
  provider_message_id text,
  expires_at timestamptz NOT NULL,
  resend_available_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('phone_auth_challenges');
CREATE INDEX IF NOT EXISTS idx_phone_auth_challenges_rate_phone
  ON phone_auth_challenges(phone_identity_subject, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_auth_challenges_rate_ip
  ON phone_auth_challenges(source_ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS account_merge_requests (
  account_merge_request_id text PRIMARY KEY,
  source_buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  target_buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  reason text NOT NULL CHECK (reason IN ('provider_link', 'wallet_email', 'email_change')),
  email_auth_challenge_id text REFERENCES email_auth_challenges(email_auth_challenge_id),
  dashboard_auth_session_id text REFERENCES dashboard_auth_sessions(dashboard_auth_session_id),
  confirmation_token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled', 'expired', 'failed')),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_buyer_account_id <> target_buyer_account_id)
);

SELECT itpay_touch_updated_at('account_merge_requests');
CREATE INDEX IF NOT EXISTS idx_account_merge_requests_source
  ON account_merge_requests(source_buyer_account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_merge_requests_target
  ON account_merge_requests(target_buyer_account_id, status, created_at DESC);

-- ============================================================
-- Source: db/v3/schema/15_merchant_policy.sql
-- ============================================================

-- Merchant, KYB, and policy/risk anchors.

CREATE TABLE IF NOT EXISTS merchant_accounts (
  merchant_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
  legal_name text NOT NULL,
  display_name text,
  personal_owner_buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  country text,
  default_currency text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('merchant_accounts');

ALTER TABLE merchant_accounts ADD COLUMN IF NOT EXISTS personal_owner_buyer_account_id text REFERENCES buyer_accounts(buyer_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_accounts_personal_owner
  ON merchant_accounts(personal_owner_buyer_account_id)
  WHERE personal_owner_buyer_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS merchant_account_members (
  merchant_account_member_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id) ON DELETE CASCADE,
  buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner'
    CHECK (role IN ('owner', 'admin', 'finance', 'viewer')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, buyer_account_id)
);

SELECT itpay_touch_updated_at('merchant_account_members');

CREATE INDEX IF NOT EXISTS idx_merchant_account_members_buyer
  ON merchant_account_members(buyer_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS merchant_kyb_cases (
  kyb_case_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'expired')),
  risk_level text CHECK (risk_level IN ('low', 'medium', 'high')),
  submitted_at timestamptz,
  decided_at timestamptz,
  decision_reason text,
  evidence_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE merchant_kyb_cases ADD COLUMN IF NOT EXISTS application_json jsonb;

SELECT itpay_touch_updated_at('merchant_kyb_cases');

CREATE INDEX IF NOT EXISTS idx_merchant_kyb_cases_merchant ON merchant_kyb_cases(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_decisions (
  policy_decision_id text PRIMARY KEY,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow', 'deny', 'review')),
  policy_name text NOT NULL,
  policy_version text NOT NULL,
  reason_code text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_by text NOT NULL DEFAULT 'system',
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policy_decisions_subject ON policy_decisions(subject_type, subject_id, decided_at DESC);

-- ============================================================
-- Source: db/v3/schema/16_merchant_commerce.sql
-- ============================================================

-- Private KYB evidence and versioned payout destinations.
CREATE TABLE IF NOT EXISTS merchant_private_assets (
 asset_id text PRIMARY KEY,
 merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
 content_type text NOT NULL CHECK(content_type IN ('image/jpeg','image/png','application/pdf')),
 file_name text NOT NULL,
 encrypted_content bytea NOT NULL,
 created_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS merchant_payout_accounts (
 account_id text PRIMARY KEY,
 merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
 provider text NOT NULL CHECK(provider IN ('alipay','wechatpay')),
 subject_type text NOT NULL CHECK(subject_type IN ('individual','company')),
 account_name text NOT NULL,
 masked_account text NOT NULL,
 encrypted_details bytea NOT NULL,
 status text NOT NULL CHECK(status IN ('configured','pending_opening','superseded')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_payout_current ON merchant_payout_accounts(merchant_id,provider) WHERE status<>'superseded';

-- ============================================================
-- Source: db/v3/schema/20_catalog_cart.sql
-- ============================================================

-- Catalog and cart.

CREATE TABLE IF NOT EXISTS catalog_items (
  catalog_item_id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  provider text NOT NULL,
  service_type text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('catalog_items');

CREATE TABLE IF NOT EXISTS catalog_variants (
  catalog_variant_id text PRIMARY KEY,
  catalog_item_id text NOT NULL REFERENCES catalog_items(catalog_item_id),
  offer_id text NOT NULL,
  title text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  required_contact_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (catalog_item_id, offer_id)
);

SELECT itpay_touch_updated_at('catalog_variants');

CREATE TABLE IF NOT EXISTS carts (
  cart_id text PRIMARY KEY,
  order_code text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'locked', 'abandoned', 'expired')),
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency text NOT NULL,
  client_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_agent_device_id text REFERENCES agent_devices(agent_device_id),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('carts');

CREATE TABLE IF NOT EXISTS cart_items (
  cart_item_id text PRIMARY KEY,
  cart_id text NOT NULL REFERENCES carts(cart_id) ON DELETE CASCADE,
  catalog_item_id text NOT NULL REFERENCES catalog_items(catalog_item_id),
  catalog_variant_id text NOT NULL REFERENCES catalog_variants(catalog_variant_id),
  offer_id text NOT NULL,
  title text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  service_execution_id text,
  service_quote_lock_id text,
  service_capability_id text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed')),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_active
  ON cart_items(cart_id, created_at)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_order_code
  ON carts(order_code)
  WHERE order_code IS NOT NULL;

-- ============================================================
-- Source: db/v3/schema/25_catalog_publication.sql
-- ============================================================

-- Catalog publication and protocol compatibility read models.

CREATE TABLE IF NOT EXISTS catalog_manifests (
  catalog_manifest_id text PRIMARY KEY,
  version text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'superseded')),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  snapshot_id text,
  manifest_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('catalog_manifests');

CREATE TABLE IF NOT EXISTS catalog_snapshots (
  catalog_snapshot_id text PRIMARY KEY,
  manifest_version text NOT NULL,
  snapshot_version text NOT NULL UNIQUE,
  content_hash text NOT NULL,
  snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalog_snapshots_manifest ON catalog_snapshots(manifest_version, created_at DESC);

CREATE TABLE IF NOT EXISTS catalog_deltas (
  catalog_delta_id text PRIMARY KEY,
  from_snapshot_version text NOT NULL,
  to_snapshot_version text NOT NULL,
  delta_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_snapshot_version, to_snapshot_version)
);

CREATE TABLE IF NOT EXISTS protocol_profiles (
  protocol_profile_id text PRIMARY KEY,
  protocol text NOT NULL CHECK (protocol IN ('ucp', 'itpay')),
  version text NOT NULL,
  profile_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deprecated', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (protocol, version)
);

SELECT itpay_touch_updated_at('protocol_profiles');


-- ============================================================
-- Source: db/v3/schema/26_service_contract.sql
-- ============================================================

-- Service contracts, declared capabilities, and immutable Arazzo workflows.

CREATE TABLE IF NOT EXISTS service_contracts (
  service_contract_id text PRIMARY KEY,
  service_id text NOT NULL UNIQUE,
  owner_kind text NOT NULL DEFAULT 'itpay'
    CHECK (owner_kind IN ('itpay', 'merchant')),
  owner_ref text,
  public_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'certified', 'canary', 'published', 'paused', 'deprecated', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('service_contracts');

CREATE TABLE IF NOT EXISTS service_contract_versions (
  service_contract_version_id text PRIMARY KEY,
  service_contract_id text NOT NULL REFERENCES service_contracts(service_contract_id) ON DELETE CASCADE,
  version text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'linted', 'certified', 'canary', 'published', 'paused', 'deprecated', 'archived')),
  published_catalog_item_id text REFERENCES catalog_items(catalog_item_id),
  contract_hash text NOT NULL,
  contract_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  arazzo_version text NOT NULL DEFAULT '1.1.0' CHECK (arazzo_version = '1.1.0'),
  arazzo_document_yaml text NOT NULL,
  arazzo_document_hash text NOT NULL,
  artifact_assembler_key text,
  public_projection jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  certified_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_contract_id, version),
  UNIQUE (service_contract_version_id, arazzo_document_hash)
);

SELECT itpay_touch_updated_at('service_contract_versions');

-- Content hashes identify content, not a unique publication occurrence.
CREATE INDEX IF NOT EXISTS idx_service_contract_versions_content_hash
  ON service_contract_versions(contract_hash);
CREATE INDEX IF NOT EXISTS idx_service_contract_versions_document_hash
  ON service_contract_versions(arazzo_document_hash);

CREATE INDEX IF NOT EXISTS idx_service_contract_versions_contract
  ON service_contract_versions(service_contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_contract_versions_status
  ON service_contract_versions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS service_capabilities (
  service_capability_id text PRIMARY KEY,
  service_contract_version_id text NOT NULL REFERENCES service_contract_versions(service_contract_version_id) ON DELETE CASCADE,
  capability_id text NOT NULL,
  phase text NOT NULL
    CHECK (phase IN ('pre_purchase', 'paid_fulfillment', 'post_purchase')),
  agent_visible boolean NOT NULL DEFAULT true,
  requires_payment boolean NOT NULL DEFAULT false,
  requires_human_action boolean NOT NULL DEFAULT false,
  vault_required boolean NOT NULL DEFAULT false,
  price_amount_minor bigint CHECK (price_amount_minor >= 0),
  price_currency text,
  free_quota_limit integer CHECK (free_quota_limit IS NULL OR free_quota_limit >= 0),
  quota_subject text
    CHECK (quota_subject IS NULL OR quota_subject IN ('service_execution', 'agent_device', 'buyer_account')),
  invocation_scope text
    CHECK (invocation_scope IS NULL OR invocation_scope IN ('public', 'workflow_only')),
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_contract_version_id, capability_id),
  UNIQUE (service_capability_id, service_contract_version_id),
  CONSTRAINT service_capabilities_price_pair_check CHECK (
    (price_amount_minor IS NULL AND price_currency IS NULL) OR
    (price_amount_minor IS NOT NULL AND price_currency IS NOT NULL)
  )
);

SELECT itpay_touch_updated_at('service_capabilities');

CREATE INDEX IF NOT EXISTS idx_service_capabilities_version
  ON service_capabilities(service_contract_version_id, phase, capability_id);

CREATE TABLE IF NOT EXISTS service_contract_publications (
  service_contract_publication_id text PRIMARY KEY,
  publication_revision text NOT NULL UNIQUE,
  service_contract_id text NOT NULL REFERENCES service_contracts(service_contract_id),
  service_contract_version_id text NOT NULL UNIQUE REFERENCES service_contract_versions(service_contract_version_id),
  catalog_item_id text REFERENCES catalog_items(catalog_item_id),
  catalog_manifest_id text REFERENCES catalog_manifests(catalog_manifest_id),
  dependency_lock jsonb NOT NULL DEFAULT '{}'::jsonb,
  dependency_lock_hash text NOT NULL,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'active', 'retired', 'failed')),
  published_by text NOT NULL,
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_contract_publications_active
  ON service_contract_publications(service_contract_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_service_contract_publications_catalog
  ON service_contract_publications(catalog_item_id, status);

-- Append-only operator audit. Publication/Catalog tables remain the current
-- operational truth; this table records who requested each state change.
CREATE TABLE IF NOT EXISTS service_publication_admin_actions (
  service_publication_admin_action_id text PRIMARY KEY,
  service_contract_id text NOT NULL REFERENCES service_contracts(service_contract_id),
  service_contract_publication_id text NOT NULL
    REFERENCES service_contract_publications(service_contract_publication_id),
  action text NOT NULL CHECK (action IN ('take_down')),
  expected_publication_status text NOT NULL CHECK (expected_publication_status IN ('active')),
  reason_code text NOT NULL,
  note text NOT NULL DEFAULT '',
  decided_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_publication_admin_actions_contract
  ON service_publication_admin_actions(service_contract_id, decided_at DESC);

-- ============================================================
-- Source: db/v3/schema/27_seller_authoring.sql
-- ============================================================

-- Seller-owned service authoring, immutable review submissions, and canary facts.

CREATE TABLE IF NOT EXISTS seller_api_intakes (
  seller_api_intake_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  provider_key text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('upload', 'https_url', 'api_docs_url')),
  source_url text,
  media_type text NOT NULL,
  original_hash text NOT NULL,
  source_document bytea NOT NULL DEFAULT ''::bytea,
  normalized_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'failed')),
  arazzo_version text NOT NULL DEFAULT '1.1.0',
  arazzo_document_yaml text NOT NULL,
  arazzo_document_hash text NOT NULL,
  issues_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (merchant_id, normalized_hash)
);

CREATE INDEX IF NOT EXISTS idx_seller_api_intakes_merchant
  ON seller_api_intakes(merchant_id, created_at DESC);

-- Immutable service artwork. Drafts may select a newer asset while editable,
-- while review submissions retain the exact approved asset reference.
CREATE TABLE IF NOT EXISTS seller_service_icon_assets (
  seller_service_icon_asset_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 2048),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 2048),
  content bytea NOT NULL CHECK (octet_length(content) = byte_size),
  created_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, content_hash)
);

CREATE TABLE IF NOT EXISTS seller_service_drafts (
  seller_service_draft_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('itpay', 'merchant')),
  service_id text NOT NULL,
  public_name text NOT NULL,
  service_icon_asset_id text REFERENCES seller_service_icon_assets(seller_service_icon_asset_id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'validating', 'validation_failed', 'ready_to_submit',
      'submitted', 'changes_requested', 'rejected', 'approved',
      'canary', 'canary_failed', 'published', 'archived'
    )),
  semantic_version text NOT NULL DEFAULT 'itpay-arazzo-artifact.v1',
  semantic_revision bigint NOT NULL DEFAULT 1 CHECK (semantic_revision > 0),
  semantic_hash text NOT NULL,
  arazzo_version text NOT NULL DEFAULT '1.1.0',
  arazzo_document_yaml text NOT NULL,
  arazzo_document_hash text NOT NULL,
  pricing_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  updated_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, service_id)
);

SELECT itpay_touch_updated_at('seller_service_drafts');

CREATE INDEX IF NOT EXISTS idx_seller_service_drafts_merchant
  ON seller_service_drafts(merchant_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS seller_orchestration_runs (
  seller_orchestration_run_id text PRIMARY KEY,
  seller_service_draft_id text NOT NULL
    REFERENCES seller_service_drafts(seller_service_draft_id) ON DELETE CASCADE,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  base_semantic_revision bigint NOT NULL CHECK (base_semantic_revision > 0),
  instruction text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'stale', 'applied')),
  model text NOT NULL DEFAULT 'deepseek-v4-flash',
  prompt_version text NOT NULL DEFAULT 'seller-commerce-planner.v1',
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_arazzo_version text,
  candidate_arazzo_document_yaml text,
  candidate_arazzo_document_hash text,
  validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  e2e_validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  fixture_evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  sandbox_evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_hash text,
  risk_hash text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  failure_code text,
  failure_message text,
  created_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  confirmed_at timestamptz,
  completed_at timestamptz,
  applied_revision bigint,
  applied_at timestamptz
);

ALTER TABLE seller_orchestration_runs
  ADD COLUMN IF NOT EXISTS e2e_validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS fixture_evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sandbox_evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS candidate_arazzo_version text,
  ADD COLUMN IF NOT EXISTS candidate_arazzo_document_yaml text,
  ADD COLUMN IF NOT EXISTS candidate_arazzo_document_hash text,
  ADD COLUMN IF NOT EXISTS risk_hash text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  DROP COLUMN IF EXISTS candidate_nodes_json,
  DROP COLUMN IF EXISTS candidate_edges_json;

ALTER TABLE seller_orchestration_runs DROP CONSTRAINT IF EXISTS seller_orchestration_runs_status_check;
ALTER TABLE seller_orchestration_runs ADD CONSTRAINT seller_orchestration_runs_status_check
  CHECK (status IN ('queued', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'stale', 'applied'));

CREATE INDEX IF NOT EXISTS idx_seller_orchestration_runs_draft
  ON seller_orchestration_runs(seller_service_draft_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seller_service_editor_layouts (
  seller_service_draft_id text PRIMARY KEY
    REFERENCES seller_service_drafts(seller_service_draft_id) ON DELETE CASCADE,
  layout_version text NOT NULL DEFAULT 'arazzo-editor-layout.v1',
  node_positions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  viewport_json jsonb NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}'::jsonb,
  direction text NOT NULL DEFAULT 'TB' CHECK (direction IN ('TB', 'LR')),
  layout_hash text NOT NULL,
  updated_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seller_arazzo_validation_runs (
  seller_arazzo_validation_run_id text PRIMARY KEY,
  seller_service_draft_id text NOT NULL
    REFERENCES seller_service_drafts(seller_service_draft_id) ON DELETE CASCADE,
  semantic_revision bigint NOT NULL,
  semantic_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('valid', 'invalid')),
  issues_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  arazzo_document_hash text NOT NULL,
  validator_version text NOT NULL,
  created_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_arazzo_validation_runs_draft
  ON seller_arazzo_validation_runs(seller_service_draft_id, created_at DESC);

CREATE TABLE IF NOT EXISTS seller_service_fixture_sets (
  seller_service_draft_id text PRIMARY KEY
    REFERENCES seller_service_drafts(seller_service_draft_id) ON DELETE CASCADE,
  fixture_revision bigint NOT NULL CHECK (fixture_revision > 0),
  fixture_hash text NOT NULL,
  fixtures_json jsonb NOT NULL,
  updated_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seller_service_evidence_runs (
  seller_service_evidence_run_id text PRIMARY KEY,
  seller_service_draft_id text NOT NULL
    REFERENCES seller_service_drafts(seller_service_draft_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('fixture', 'sandbox')),
  semantic_revision bigint NOT NULL,
  semantic_hash text NOT NULL,
  fixture_hash text NOT NULL,
  dependency_lock_hash text,
  status text NOT NULL CHECK (status IN ('passed', 'failed')),
  execution_count integer NOT NULL DEFAULT 0 CHECK (execution_count >= 0),
  provider_cost_minor bigint NOT NULL DEFAULT 0 CHECK (provider_cost_minor >= 0),
  issues_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  results_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_hash text NOT NULL,
  created_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seller_service_evidence_runs_lookup
  ON seller_service_evidence_runs(
    seller_service_draft_id, kind, semantic_hash, fixture_hash, created_at DESC
  );

CREATE TABLE IF NOT EXISTS seller_service_validation_runs (
  seller_service_validation_run_id text PRIMARY KEY,
  seller_service_draft_id text NOT NULL
    REFERENCES seller_service_drafts(seller_service_draft_id) ON DELETE CASCADE,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  semantic_revision bigint NOT NULL CHECK (semantic_revision > 0),
  semantic_hash text NOT NULL,
  fixture_revision bigint NOT NULL CHECK (fixture_revision > 0),
  fixture_hash text NOT NULL,
  dependency_lock_hash text NOT NULL,
  credential_lock_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'preflight', 'awaiting_confirmation', 'running', 'passed', 'failed'
  )),
  risk_hash text,
  api_recognitions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  side_effect_operations_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  fixture_runs_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  benchmark_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  issues_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  fixture_evidence_run_id text REFERENCES seller_service_evidence_runs(seller_service_evidence_run_id),
  sandbox_evidence_run_id text REFERENCES seller_service_evidence_runs(seller_service_evidence_run_id),
  evidence_hash text,
  created_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  confirmed_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_seller_service_validation_runs_draft
  ON seller_service_validation_runs(seller_service_draft_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_service_validation_runs_active
  ON seller_service_validation_runs(seller_service_draft_id)
  WHERE status IN ('queued', 'preflight', 'awaiting_confirmation', 'running');

CREATE TABLE IF NOT EXISTS service_review_submissions (
  service_review_submission_id text PRIMARY KEY,
  seller_service_draft_id text NOT NULL
    REFERENCES seller_service_drafts(seller_service_draft_id),
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  submission_revision bigint NOT NULL CHECK (submission_revision > 0),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN (
      'submitted', 'under_review', 'changes_requested', 'rejected',
      'approved', 'canary', 'canary_failed', 'published', 'withdrawn'
    )),
  semantic_hash text NOT NULL,
  layout_hash text NOT NULL,
  submission_hash text NOT NULL UNIQUE,
  arazzo_version text NOT NULL DEFAULT '1.1.0',
  arazzo_document_yaml text NOT NULL,
  arazzo_document_hash text NOT NULL,
  editor_layout_json jsonb NOT NULL,
  pricing_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  service_icon_asset_id text REFERENCES seller_service_icon_assets(seller_service_icon_asset_id),
  validation_report_json jsonb NOT NULL,
  merchant_status text NOT NULL,
  kyb_case_id text REFERENCES merchant_kyb_cases(kyb_case_id),
  kyb_status text,
  policy_decision_id text REFERENCES policy_decisions(policy_decision_id),
  policy_decision text,
  policy_version text,
  admission_owner_kind text NOT NULL CHECK (admission_owner_kind IN ('itpay', 'merchant')),
  admission_hash text NOT NULL,
  fixture_evidence_run_id text NOT NULL REFERENCES seller_service_evidence_runs(seller_service_evidence_run_id),
  fixture_evidence_hash text NOT NULL,
  sandbox_evidence_run_id text NOT NULL REFERENCES seller_service_evidence_runs(seller_service_evidence_run_id),
  sandbox_evidence_hash text NOT NULL,
  submission_evidence_hash text NOT NULL,
  submitted_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_service_draft_id, submission_revision)
);

SELECT itpay_touch_updated_at('service_review_submissions');

CREATE INDEX IF NOT EXISTS idx_service_review_submissions_queue
  ON service_review_submissions(status, submitted_at ASC);

CREATE TABLE IF NOT EXISTS seller_service_publication_candidates (
  seller_service_publication_candidate_id text PRIMARY KEY,
  service_review_submission_id text NOT NULL UNIQUE
    REFERENCES service_review_submissions(service_review_submission_id) ON DELETE CASCADE,
  service_contract_id text NOT NULL,
  service_contract_version_id text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_variant_id text NOT NULL,
  catalog_manifest_id text,
  service_contract_publication_id text NOT NULL,
  publication_revision text NOT NULL UNIQUE,
  create_contract boolean NOT NULL,
  dependency_lock_json jsonb NOT NULL,
  dependency_lock_hash text NOT NULL,
  candidate_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'frozen'
    CHECK (status IN ('frozen', 'canary', 'ready_to_publish', 'published', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('seller_service_publication_candidates');

CREATE TABLE IF NOT EXISTS service_review_decisions (
  service_review_decision_id text PRIMARY KEY,
  service_review_submission_id text NOT NULL
    REFERENCES service_review_submissions(service_review_submission_id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('approve', 'request_changes', 'reject')),
  expected_submission_hash text NOT NULL,
  reason_code text NOT NULL,
  comments_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_mode text NOT NULL DEFAULT 'independent'
    CHECK (review_mode IN ('independent', 'self_approved_itpay')),
  decided_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_review_decisions_submission
  ON service_review_decisions(service_review_submission_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS service_canary_runs (
  service_canary_run_id text PRIMARY KEY,
  service_review_submission_id text NOT NULL
    REFERENCES service_review_submissions(service_review_submission_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
  audience text NOT NULL DEFAULT 'platform_test_identities',
  maximum_executions integer NOT NULL DEFAULT 20 CHECK (maximum_executions > 0),
  maximum_provider_cost_minor bigint NOT NULL DEFAULT 5000
    CHECK (maximum_provider_cost_minor >= 0),
  timeout_seconds integer NOT NULL DEFAULT 3600 CHECK (timeout_seconds > 0),
  execution_count integer NOT NULL DEFAULT 0 CHECK (execution_count >= 0),
  provider_cost_minor bigint NOT NULL DEFAULT 0 CHECK (provider_cost_minor >= 0),
  rollback_on_json jsonb NOT NULL DEFAULT '["mandatory_fixture_failed","unknown_provider_outcome","secret_leakage","delivery_failure","callback_verification_failure"]'::jsonb,
  failure_codes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (service_review_submission_id)
);

-- ============================================================
-- Source: db/v3/schema/28_seller_run_steps.sql
-- ============================================================

-- Durable, encrypted API results for Builder Run continuation. Never exposed directly.
CREATE TABLE IF NOT EXISTS seller_validation_step_results (
  run_id text NOT NULL REFERENCES seller_service_validation_runs(seller_service_validation_run_id) ON DELETE CASCADE,
  fixture_id text NOT NULL,
  node_id text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('invoking','complete','pending','accepted','skipped','failed')),
  encrypted_result bytea,
  error_message text NOT NULL DEFAULT '',
  decided_by text REFERENCES buyer_accounts(buyer_account_id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, fixture_id, node_id)
);

-- ============================================================
-- Source: db/v3/schema/28_seller_workflow_versions.sql
-- ============================================================

-- Immutable, named YAML snapshots. Saving a snapshot does not publish or run it.
CREATE TABLE IF NOT EXISTS seller_workflow_versions (
  seller_workflow_version_id text PRIMARY KEY,
  seller_service_draft_id text NOT NULL REFERENCES seller_service_drafts(seller_service_draft_id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  source text NOT NULL CHECK (source IN ('original', 'current')),
  base_semantic_revision bigint NOT NULL CHECK (base_semantic_revision > 0),
  arazzo_document_yaml text NOT NULL,
  arazzo_document_hash text NOT NULL,
  created_by text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seller_workflow_versions_draft ON seller_workflow_versions(seller_service_draft_id, created_at DESC, seller_workflow_version_id);

ALTER TABLE seller_workflow_versions ADD COLUMN IF NOT EXISTS semantic_hash text NOT NULL DEFAULT '';
ALTER TABLE seller_workflow_versions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- ============================================================
-- Source: db/v3/schema/29_api_library.sql
-- ============================================================

-- Searchable, knowledge-only API Library artifacts imported from public catalogs.

CREATE TABLE IF NOT EXISTS api_library_import_runs (
  api_library_import_run_id text PRIMARY KEY,
  source text NOT NULL,
  target_ref text NOT NULL,
  source_commit text,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  manifest_count integer NOT NULL DEFAULT 0,
  active_count integer NOT NULL DEFAULT 0,
  invalid_count integer NOT NULL DEFAULT 0,
  retired_count integer NOT NULL DEFAULT 0,
  operation_count integer NOT NULL DEFAULT 0,
  embedding_count integer NOT NULL DEFAULT 0,
  checkpoint_path text,
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_api_library_import_runs_source
  ON api_library_import_runs(source, started_at DESC);

CREATE TABLE IF NOT EXISTS api_library_apis (
  api_library_api_id text PRIMARY KEY,
  source text NOT NULL,
  source_path text NOT NULL,
  vendor text NOT NULL,
  api_name text NOT NULL,
  version text NOT NULL,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  openapi_version text NOT NULL DEFAULT '',
  license_spdx text NOT NULL DEFAULT 'CC0-1.0',
  source_commit text NOT NULL,
  content_hash text NOT NULL,
  raw_document bytea NOT NULL,
  normalized_document jsonb,
  status text NOT NULL CHECK (status IN ('active', 'invalid', 'retired')),
  parse_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_path)
);

SELECT itpay_touch_updated_at('api_library_apis');

CREATE INDEX IF NOT EXISTS idx_api_library_apis_active_browse
  ON api_library_apis(vendor, title, api_library_api_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_api_library_apis_content_hash
  ON api_library_apis(content_hash);

CREATE TABLE IF NOT EXISTS api_library_scorecards (
  api_library_api_id text PRIMARY KEY REFERENCES api_library_apis(api_library_api_id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  score numeric(5,2),
  grade text,
  level text,
  dimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  engine_name text,
  engine_version text,
  scorer_version text,
  scored_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('api_library_scorecards');

CREATE INDEX IF NOT EXISTS idx_api_library_scorecards_status
  ON api_library_scorecards(status, updated_at);

CREATE TABLE IF NOT EXISTS api_library_operations (
  api_library_operation_id text PRIMARY KEY,
  api_library_api_id text NOT NULL REFERENCES api_library_apis(api_library_api_id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  operation_id text NOT NULL DEFAULT '',
  method text NOT NULL,
  path text NOT NULL,
  summary text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  operation_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_library_api_id, operation_key)
);

SELECT itpay_touch_updated_at('api_library_operations');

CREATE INDEX IF NOT EXISTS idx_api_library_operations_api
  ON api_library_operations(api_library_api_id, operation_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_api_library_operations_hash
  ON api_library_operations(operation_hash);

CREATE TABLE IF NOT EXISTS api_library_search_documents (
  api_library_search_document_id text PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('api', 'operation')),
  entity_id text NOT NULL,
  api_library_api_id text NOT NULL REFERENCES api_library_apis(api_library_api_id) ON DELETE CASCADE,
  search_text text NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  content_hash text NOT NULL,
  embedding_model text,
  embedding_dimensions integer,
  embedding vector(1536),
  index_status text NOT NULL DEFAULT 'pending' CHECK (index_status IN ('pending', 'ready', 'failed')),
  index_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id)
);

SELECT itpay_touch_updated_at('api_library_search_documents');

CREATE INDEX IF NOT EXISTS idx_api_library_search_documents_tsv
  ON api_library_search_documents USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS idx_api_library_search_documents_embedding
  ON api_library_search_documents USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND index_status = 'ready';
CREATE INDEX IF NOT EXISTS idx_api_library_search_documents_pending
  ON api_library_search_documents(index_status, updated_at);

-- ============================================================
-- Source: db/v3/schema/29_seller_publication_confirmation.sql
-- ============================================================

-- Server-generated link: price-only revisions retain the actual execution proof.
CREATE TABLE IF NOT EXISTS seller_pricing_execution_basis (
 seller_service_draft_id text NOT NULL REFERENCES seller_service_drafts(seller_service_draft_id),
 semantic_revision bigint NOT NULL,
 semantic_hash text NOT NULL,
 seller_service_validation_run_id text NOT NULL REFERENCES seller_service_validation_runs(seller_service_validation_run_id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(seller_service_draft_id, semantic_revision)
);
CREATE TABLE IF NOT EXISTS seller_submission_confirmations (
 service_review_submission_id text PRIMARY KEY REFERENCES service_review_submissions(service_review_submission_id),
 buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
 terms_version text NOT NULL,
 confirmations_json jsonb NOT NULL,
 submission_hash text NOT NULL,
 confirmed_at timestamptz NOT NULL
);

-- ============================================================
-- Source: db/v3/schema/30_checkout.sql
-- ============================================================

-- Checkout and checkout display handoff.

CREATE TABLE IF NOT EXISTS checkouts (
  checkout_id text PRIMARY KEY,
  cart_id text NOT NULL REFERENCES carts(cart_id),
  order_code text,
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  agent_device_id text REFERENCES agent_devices(agent_device_id),
  client_reference_id text,
  creation_idempotency_key_id text,
  status text NOT NULL DEFAULT 'quote_bound'
    CHECK (status IN (
      'draft',
      'quote_bound',
      'auth_required',
      'payment_required',
      'payment_pending',
      'payment_succeeded',
      'completed',
      'failed',
      'expired',
      'refunded'
    )),
  next_action text NOT NULL DEFAULT 'open_checkout'
    CHECK (next_action IN (
      'open_checkout',
      'authorize_buyer',
      'create_payment_intent',
      'wait_for_payment',
      'check_email',
      'none',
      'contact_support'
    )),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  delivery_contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('checkouts');

CREATE INDEX IF NOT EXISTS idx_checkouts_buyer ON checkouts(buyer_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkouts_cart ON checkouts(cart_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkouts_creation_idempotency
  ON checkouts (
    COALESCE(agent_device_id, ''),
    COALESCE(buyer_account_id, ''),
    creation_idempotency_key_id
  )
  WHERE creation_idempotency_key_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_checkouts_order_code
  ON checkouts(order_code)
  WHERE order_code IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'buyer_sessions_scoped_checkout_fk'
  ) THEN
    ALTER TABLE buyer_sessions
      ADD CONSTRAINT buyer_sessions_scoped_checkout_fk
      FOREIGN KEY (scoped_checkout_id) REFERENCES checkouts(checkout_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS checkout_items (
  checkout_item_id text PRIMARY KEY,
  checkout_id text NOT NULL REFERENCES checkouts(checkout_id) ON DELETE CASCADE,
  cart_item_id text NOT NULL REFERENCES cart_items(cart_item_id),
  catalog_item_id text NOT NULL,
  catalog_variant_id text NOT NULL,
  offer_id text NOT NULL,
  title text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  service_execution_id text,
  service_quote_lock_id text,
  service_capability_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkout_items_checkout ON checkout_items(checkout_id);

CREATE TABLE IF NOT EXISTS checkout_display_tokens (
  checkout_display_token_id text PRIMARY KEY,
  checkout_id text NOT NULL REFERENCES checkouts(checkout_id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'checkout_entry'
    CHECK (purpose IN ('checkout_entry', 'payment_entry', 'complete_exchange', 'receipt_exchange')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  created_by text NOT NULL DEFAULT 'checkout_create',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  client_binding_hash text,
  bound_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_display_tokens_receipt_binding_check CHECK (
    purpose <> 'receipt_exchange'
    OR status <> 'used'
    OR (client_binding_hash IS NOT NULL AND bound_at IS NOT NULL)
  )
);

SELECT itpay_touch_updated_at('checkout_display_tokens');

CREATE INDEX IF NOT EXISTS idx_checkout_display_tokens_checkout ON checkout_display_tokens(checkout_id);

CREATE TABLE IF NOT EXISTS buyer_auth_sessions (
  buyer_auth_session_id text PRIMARY KEY,
  checkout_id text NOT NULL REFERENCES checkouts(checkout_id) ON DELETE CASCADE,
  checkout_display_token_id text NOT NULL REFERENCES checkout_display_tokens(checkout_display_token_id),
  dashboard_auth_session_id text REFERENCES dashboard_auth_sessions(dashboard_auth_session_id),
  provider text NOT NULL CHECK (provider IN ('alipay', 'wechat')),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'waiting_provider', 'completed', 'expired', 'failed')),
  provider_state_hash text NOT NULL,
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  provider_identity_id text REFERENCES provider_identities(provider_identity_id),
  error_code text,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('buyer_auth_sessions');

CREATE INDEX IF NOT EXISTS idx_buyer_auth_sessions_checkout ON buyer_auth_sessions(checkout_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_auth_sessions_active_checkout
  ON buyer_auth_sessions(checkout_id)
  WHERE status IN ('created', 'waiting_provider');

-- order_contacts is the protected, checkout-scoped notification-contact
-- record: which channel the buyer chose for this order, the normalized
-- recipient, and the verified-value evidence (an order_contact challenge) when
-- the channel requires proof of control. Agent projections expose only
-- recipient_masked.
CREATE TABLE IF NOT EXISTS order_contacts (
  order_contact_id text PRIMARY KEY,
  checkout_id text NOT NULL REFERENCES checkouts(checkout_id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  recipient text NOT NULL,
  recipient_masked text NOT NULL,
  verified_challenge_id text REFERENCES phone_auth_challenges(phone_auth_challenge_id),
  -- verified_account_ref records which account-side verified identity a
  -- reused account phone came from; OTP-verified rows keep it NULL and use
  -- verified_challenge_id instead. A row always carries exactly one proof.
  verified_account_ref text,
  consented_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkout_id, channel)
);

ALTER TABLE order_contacts ADD COLUMN IF NOT EXISTS verified_account_ref text;

SELECT itpay_touch_updated_at('order_contacts');

CREATE INDEX IF NOT EXISTS idx_order_contacts_checkout ON order_contacts(checkout_id);

-- ============================================================
-- Source: db/v3/schema/30_seller_version_runs.sql
-- ============================================================

-- Explicit execution ownership. New executions belong to exactly one saved version.
-- Legacy executions can be shared when their old revision/hash matched multiple snapshots.
CREATE TABLE IF NOT EXISTS seller_workflow_version_runs (
  version_id text NOT NULL REFERENCES seller_workflow_versions(seller_workflow_version_id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES seller_service_validation_runs(seller_service_validation_run_id) ON DELETE CASCADE,
  PRIMARY KEY(version_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_seller_version_runs_run ON seller_workflow_version_runs(run_id);

-- ============================================================
-- Source: db/v3/schema/35_service_execution.sql
-- ============================================================

-- Service Execution business facts. execution_requests remains the engine handoff.

CREATE TABLE IF NOT EXISTS service_executions (
  service_execution_id text PRIMARY KEY,
  service_id text NOT NULL,
  service_contract_version_id text NOT NULL REFERENCES service_contract_versions(service_contract_version_id),
  arazzo_document_hash text NOT NULL,
  catalog_item_id text REFERENCES catalog_items(catalog_item_id),
  catalog_variant_id text REFERENCES catalog_variants(catalog_variant_id),
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  agent_device_id text REFERENCES agent_devices(agent_device_id),
  agent_instance_id text,
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN (
      'started',
      'capability_invoked',
      'quota_checked',
      'human_action_required',
      'human_action_approved',
      'quote_locked',
      'checkout_pending',
      'payment_verified',
      'provider_running',
      'provider_completed',
      'delivery_issued',
      'grant_available',
      'completed',
      'quota_exhausted',
      'failed',
      'refund_requested',
      'refunded',
      'cancelled'
    )),
  phase text NOT NULL DEFAULT 'pre_purchase'
    CHECK (phase IN ('pre_purchase', 'checkout', 'payment', 'fulfillment', 'delivery', 'completed', 'failed')),
  current_capability_id text,
  checkout_required boolean NOT NULL DEFAULT false,
  next_action text NOT NULL DEFAULT 'invoke_capability'
    CHECK (next_action IN (
      'invoke_capability',
      'select_candidate',
      'create_checkout',
      'pay_checkout',
      'wait',
      'view_delivery',
      'request_refund',
      'none',
      'contact_support'
    )),
  event_sequence bigint NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  client_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  origin_type text NOT NULL DEFAULT 'local_agent'
    CHECK (origin_type IN ('local_agent', 'mcp_connection')),
  mcp_connection_id text REFERENCES mcp_connections(mcp_connection_id),
  dedupe_key text,
  CONSTRAINT service_executions_checkout_required_check CHECK (
    checkout_required = false OR status IN ('quota_exhausted', 'quote_locked', 'checkout_pending')
  ),
  CONSTRAINT service_executions_agent_instance_device_fk FOREIGN KEY (agent_instance_id, agent_device_id)
    REFERENCES agent_instances(agent_instance_id, agent_device_id),
  CONSTRAINT service_executions_origin_check CHECK (
    (
      origin_type = 'local_agent'
      AND agent_device_id IS NOT NULL
      AND agent_instance_id IS NOT NULL
      AND mcp_connection_id IS NULL
    ) OR (
      origin_type = 'mcp_connection'
      AND agent_device_id IS NULL
      AND agent_instance_id IS NULL
      AND mcp_connection_id IS NOT NULL
      AND buyer_account_id IS NOT NULL
    )
  ),
  UNIQUE (service_execution_id, arazzo_document_hash),
  FOREIGN KEY (service_contract_version_id, arazzo_document_hash)
    REFERENCES service_contract_versions(service_contract_version_id, arazzo_document_hash)
);

SELECT itpay_touch_updated_at('service_executions');

CREATE INDEX IF NOT EXISTS idx_service_executions_buyer
  ON service_executions(buyer_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_executions_agent
  ON service_executions(agent_device_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_executions_dedupe_key
  ON service_executions(service_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_executions_agent_instance
  ON service_executions(agent_instance_id)
  WHERE agent_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_executions_mcp_connection
  ON service_executions(mcp_connection_id, created_at DESC)
  WHERE mcp_connection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_executions_contract
  ON service_executions(service_contract_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_executions_status
  ON service_executions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_executions_cart_entry_active
  ON service_executions(agent_device_id, service_contract_version_id, catalog_item_id, catalog_variant_id, created_at DESC)
  WHERE status NOT IN ('completed', 'failed', 'refund_requested', 'refunded', 'cancelled');

CREATE TABLE IF NOT EXISTS service_execution_events (
  service_execution_event_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  status text NOT NULL,
  phase text NOT NULL,
  capability_id text,
  redacted_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_ref text,
  payload_hash text,
  correlation_id text,
  causation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_execution_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_service_execution_events_execution
  ON service_execution_events(service_execution_id, sequence);
CREATE INDEX IF NOT EXISTS idx_service_execution_events_created
  ON service_execution_events(created_at DESC);

CREATE TABLE IF NOT EXISTS service_capability_invocations (
  service_capability_invocation_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  capability_id text NOT NULL,
  provider_key text,
  idempotency_key_id text,
  status text NOT NULL DEFAULT 'succeeded'
    CHECK (status IN ('running', 'succeeded', 'failed', 'quota_exhausted')),
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  safe_result_preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_hash text,
  response_ref text,
  error_code text,
  error_message text,
  error_temporary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_capability_invocations_execution
  ON service_capability_invocations(service_execution_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_capability_invocations_idempotency
  ON service_capability_invocations(service_execution_id, capability_id, idempotency_key_id)
  WHERE idempotency_key_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_capability_result_items (
  service_capability_result_item_id text PRIMARY KEY,
  service_capability_invocation_id text NOT NULL REFERENCES service_capability_invocations(service_capability_invocation_id) ON DELETE CASCADE,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  capability_id text NOT NULL,
  stable_hash text NOT NULL,
  rank integer NOT NULL CHECK (rank > 0),
  display_title text NOT NULL,
  safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_capability_invocation_id, rank)
);

CREATE INDEX IF NOT EXISTS idx_service_capability_result_items_execution
  ON service_capability_result_items(service_execution_id, capability_id, created_at DESC);

-- Durable per-operation facts for the immutable Arazzo workflow. Temporal
-- history is orchestration state and must not replace these business facts.
CREATE TABLE IF NOT EXISTS arazzo_operation_runs (
  arazzo_operation_run_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  arazzo_document_hash text NOT NULL,
  step_id text NOT NULL,
  logical_attempt integer NOT NULL DEFAULT 1 CHECK (logical_attempt > 0),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'empty', 'failed', 'outcome_unknown', 'skipped', 'cancelled')),
  input_hash text NOT NULL,
  output_ref text,
  output_hash text,
  safe_output_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_execution_id, step_id, logical_attempt),
  UNIQUE (arazzo_operation_run_id, service_execution_id),
  FOREIGN KEY (service_execution_id, arazzo_document_hash)
    REFERENCES service_executions(service_execution_id, arazzo_document_hash)
);

SELECT itpay_touch_updated_at('arazzo_operation_runs');

CREATE INDEX IF NOT EXISTS idx_arazzo_operation_runs_execution
  ON arazzo_operation_runs(service_execution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_arazzo_operation_runs_status
  ON arazzo_operation_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS service_execution_actions (
  service_execution_action_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  action_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  actor_type text NOT NULL
    CHECK (actor_type IN ('human', 'agent', 'system', 'admin')),
  actor_id text,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  service_capability_result_item_id text REFERENCES service_capability_result_items(service_capability_result_item_id),
  source_service_capability_invocation_id text
    REFERENCES service_capability_invocations(service_capability_invocation_id),
  selected_candidate_hash text,
  required_before text
    CHECK (required_before IS NULL OR required_before IN ('quote_lock', 'checkout', 'payment', 'provider_invocation', 'delivery')),
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('service_execution_actions');

CREATE INDEX IF NOT EXISTS idx_service_execution_actions_execution
  ON service_execution_actions(service_execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_execution_actions_status
  ON service_execution_actions(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_execution_actions_approved_source_invocation
  ON service_execution_actions(service_execution_id, action_type, source_service_capability_invocation_id)
  WHERE status = 'approved' AND source_service_capability_invocation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_quota_ledger (
  service_quota_ledger_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  service_contract_version_id text NOT NULL REFERENCES service_contract_versions(service_contract_version_id),
  capability_id text NOT NULL,
  subject_type text NOT NULL
    CHECK (subject_type IN ('service_execution', 'agent_device', 'device_lineage', 'buyer_account')),
  subject_id text NOT NULL,
  usage_kind text NOT NULL
    CHECK (usage_kind IN ('free', 'paid', 'blocked')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  limit_quantity integer CHECK (limit_quantity IS NULL OR limit_quantity >= 0),
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency text,
  service_id text,
  quota_bucket text,
  entry_kind text CHECK (entry_kind IN ('initial_credit', 'reservation', 'commit', 'release', 'replenish_to_target', 'adjustment')),
  delta_quantity integer,
  reservation_key text,
  related_reservation_key text,
  source_order_item_id text,
  policy_revision text,
  idempotency_key_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_quota_ledger_price_pair_check CHECK (
    (amount_minor IS NULL AND currency IS NULL) OR
    (amount_minor IS NOT NULL AND currency IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS service_quota_balances (
  service_quota_balance_id text PRIMARY KEY,
  service_id text NOT NULL,
  quota_bucket text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('device_lineage', 'buyer_account')),
  subject_id text NOT NULL,
  balance integer NOT NULL CHECK (balance >= 0),
  policy_revision text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, quota_bucket, subject_type, subject_id)
);

SELECT itpay_touch_updated_at('service_quota_balances');
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_quota_ledger_reservation
  ON service_quota_ledger(reservation_key)
  WHERE reservation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_quota_ledger_resolution
  ON service_quota_ledger(related_reservation_key, entry_kind)
  WHERE related_reservation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_quota_ledger_replenish
  ON service_quota_ledger(service_id, quota_bucket, subject_type, subject_id, source_order_item_id, entry_kind)
  WHERE source_order_item_id IS NOT NULL AND entry_kind = 'replenish_to_target';

CREATE INDEX IF NOT EXISTS idx_service_quota_ledger_execution
  ON service_quota_ledger(service_execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_quota_ledger_subject
  ON service_quota_ledger(service_contract_version_id, capability_id, subject_type, subject_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_quota_ledger_idempotency
  ON service_quota_ledger(service_execution_id, capability_id, idempotency_key_id)
  WHERE idempotency_key_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_quote_locks (
  service_quote_lock_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  service_contract_version_id text NOT NULL REFERENCES service_contract_versions(service_contract_version_id),
  capability_id text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  locked_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivery_contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked_input_hash text NOT NULL,
  source_service_capability_invocation_id text
    REFERENCES service_capability_invocations(service_capability_invocation_id),
  selected_candidate_hash text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('service_quote_locks');

CREATE INDEX IF NOT EXISTS idx_service_quote_locks_execution
  ON service_quote_locks(service_execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_quote_locks_source_invocation
  ON service_quote_locks(source_service_capability_invocation_id)
  WHERE source_service_capability_invocation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_quote_locks_active_execution
  ON service_quote_locks(service_execution_id, capability_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS service_checkout_bindings (
  service_checkout_binding_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  service_quote_lock_id text NOT NULL REFERENCES service_quote_locks(service_quote_lock_id),
  checkout_id text NOT NULL REFERENCES checkouts(checkout_id),
  status text NOT NULL DEFAULT 'checkout_pending'
    CHECK (status IN ('checkout_pending', 'payment_pending', 'payment_verified', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_execution_id, service_quote_lock_id)
);

SELECT itpay_touch_updated_at('service_checkout_bindings');

CREATE INDEX IF NOT EXISTS idx_service_checkout_bindings_checkout
  ON service_checkout_bindings(checkout_id);
CREATE INDEX IF NOT EXISTS idx_service_checkout_bindings_execution
  ON service_checkout_bindings(service_execution_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cart_items_service_execution_fk') THEN
    ALTER TABLE cart_items
      ADD CONSTRAINT cart_items_service_execution_fk
      FOREIGN KEY (service_execution_id) REFERENCES service_executions(service_execution_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cart_items_service_quote_lock_fk') THEN
    ALTER TABLE cart_items
      ADD CONSTRAINT cart_items_service_quote_lock_fk
      FOREIGN KEY (service_quote_lock_id) REFERENCES service_quote_locks(service_quote_lock_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cart_items_service_capability_fk') THEN
    ALTER TABLE cart_items
      ADD CONSTRAINT cart_items_service_capability_fk
      FOREIGN KEY (service_capability_id) REFERENCES service_capabilities(service_capability_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_items_service_execution_fk') THEN
    ALTER TABLE checkout_items
      ADD CONSTRAINT checkout_items_service_execution_fk
      FOREIGN KEY (service_execution_id) REFERENCES service_executions(service_execution_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_items_service_quote_lock_fk') THEN
    ALTER TABLE checkout_items
      ADD CONSTRAINT checkout_items_service_quote_lock_fk
      FOREIGN KEY (service_quote_lock_id) REFERENCES service_quote_locks(service_quote_lock_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_items_service_capability_fk') THEN
    ALTER TABLE checkout_items
      ADD CONSTRAINT checkout_items_service_capability_fk
      FOREIGN KEY (service_capability_id) REFERENCES service_capabilities(service_capability_id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_cart_items_service_execution
  ON cart_items(service_execution_id)
  WHERE service_execution_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_items_service_quote_lock
  ON cart_items(cart_id, service_quote_lock_id)
  WHERE service_quote_lock_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checkout_items_service_execution
  ON checkout_items(service_execution_id)
  WHERE service_execution_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_items_service_quote_lock
  ON checkout_items(checkout_id, service_quote_lock_id)
  WHERE service_quote_lock_id IS NOT NULL;

-- Payment-window upgrade path: checkouts.expires_at is the single payable
-- deadline D = LEAST(created_at + 15 minutes, earliest bound quote-lock
-- expiry, any earlier deadline already persisted). The 15-minute payment
-- window is a hard cap: a long quote expiry or a stale later deadline never
-- stretches it. Only payable (non-terminal, unpaid) checkouts are rewritten.
-- Pending orders of the same checkout share the same D; their sync lives in
-- 50_order_delivery.sql because orders.payment_deadline_at only exists there.
DO $$
BEGIN
  UPDATE checkouts c
  SET expires_at = LEAST(
    c.created_at + interval '15 minutes',
    COALESCE(
      (SELECT min(ql.expires_at)
       FROM service_quote_locks ql
       JOIN service_checkout_bindings b
         ON b.service_quote_lock_id = ql.service_quote_lock_id
       WHERE b.checkout_id = c.checkout_id),
      'infinity'::timestamptz),
    COALESCE(c.expires_at, 'infinity'::timestamptz))
  WHERE c.status IN ('quote_bound', 'auth_required', 'payment_required', 'payment_pending')
    AND c.expires_at IS DISTINCT FROM LEAST(
      c.created_at + interval '15 minutes',
      COALESCE(
        (SELECT min(ql.expires_at)
         FROM service_quote_locks ql
         JOIN service_checkout_bindings b
           ON b.service_quote_lock_id = ql.service_quote_lock_id
         WHERE b.checkout_id = c.checkout_id),
        'infinity'::timestamptz),
      COALESCE(c.expires_at, 'infinity'::timestamptz));
END $$;

-- ============================================================
-- Source: db/v3/schema/36_public_workflow.sql
-- ============================================================

-- Public buyer execution state. YAML remains in the pinned contract version.
CREATE TABLE IF NOT EXISTS service_workflow_runs (
 service_execution_id text PRIMARY KEY REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
 document_hash text NOT NULL,
 revision bigint NOT NULL DEFAULT 1,
 status text NOT NULL CHECK(status IN ('queued','running','payment','delivery','completed','failed','recovery_required','human_action','quota_paused')),
 current_step text NOT NULL DEFAULT '',
 input_hash text NOT NULL,
 input_key text NOT NULL,
 encrypted_context bytea NOT NULL,
 encryption_key_ref text NOT NULL,
 completed_steps jsonb NOT NULL DEFAULT '{}'::jsonb,
 error_code text NOT NULL DEFAULT '',
 lease_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(service_execution_id,document_hash) REFERENCES service_executions(service_execution_id,arazzo_document_hash)
);

-- ============================================================
-- Source: db/v3/schema/37_rail_booking.sql
-- ============================================================

-- Railway identity owner: plaintext names, ID cards and phones never enter agent results.
CREATE TABLE IF NOT EXISTS rail_passengers (
 passenger_id text PRIMARY KEY,
 buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
 source_checkout_id text REFERENCES checkouts(checkout_id),
 encrypted_identity bytea NOT NULL,
 encryption_key_ref text NOT NULL,
 phone_verified boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rail_passengers_owner ON rail_passengers(buyer_account_id);

CREATE TABLE IF NOT EXISTS rail_checkout_details (
 checkout_id text PRIMARY KEY REFERENCES checkouts(checkout_id),
 buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
 input_hash text NOT NULL,
 encrypted_payload bytea NOT NULL,
 encryption_key_ref text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rail_booking_runs (
 service_execution_id text PRIMARY KEY REFERENCES service_executions(service_execution_id),
 checkout_id text NOT NULL UNIQUE REFERENCES rail_checkout_details(checkout_id),
 confirmation_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','issued','manual_review')),
 error_code text NOT NULL DEFAULT '',
 encrypted_state bytea NOT NULL,
 encryption_key_ref text NOT NULL,
 revision bigint NOT NULL DEFAULT 1,
 next_poll_at timestamptz NOT NULL,
 deadline timestamptz NOT NULL,
 lease_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Source: db/v3/schema/38_rail_planning.sql
-- ============================================================

-- Rail planning owners: progressive bounded planning state for itpay-rail-smart v2.
-- Plans own the supplier send budget; snapshots are immutable committed stages;
-- actions carry user intent with dedupe-key idempotency. No payment or passenger
-- data ever lives here — quote/checkout stay with the existing owners.

CREATE TABLE IF NOT EXISTS rail_planning_plans (
 plan_id text PRIMARY KEY,
 service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
 -- Anonymous device-owned executions have no Buyer until account login.
 -- Authorization remains on service_executions and its Device/MCP principal.
 buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
 schema_version text NOT NULL,
 status text NOT NULL CHECK(status IN
   ('queued','resolving','cataloging','ready','awaiting_user','expanding','complete','failed','cancelled','expired')),
 query_revision bigint NOT NULL DEFAULT 1,
 request_json jsonb NOT NULL,
 current_snapshot_id text,
 send_count integer NOT NULL DEFAULT 0,
 model_calls integer NOT NULL DEFAULT 0,
 stage_cursor text NOT NULL DEFAULT '',
 expand_handle text NOT NULL DEFAULT '',
 failure_code text NOT NULL DEFAULT '',
 deadline timestamptz NOT NULL,
 lease_until timestamptz,
 revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rail_planning_plans_execution ON rail_planning_plans(service_execution_id);
CREATE INDEX IF NOT EXISTS idx_rail_planning_plans_status ON rail_planning_plans(status) WHERE status NOT IN ('complete','failed','cancelled','expired');

CREATE TABLE IF NOT EXISTS rail_planning_snapshots (
 snapshot_id text PRIMARY KEY,
 plan_id text NOT NULL REFERENCES rail_planning_plans(plan_id) ON DELETE CASCADE,
 version bigint NOT NULL,
 query_revision bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('geo','catalog','expand','recommend','rerank')),
 payload jsonb NOT NULL,
 send_ledger jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(plan_id, version)
);
CREATE INDEX IF NOT EXISTS idx_rail_planning_snapshots_plan ON rail_planning_snapshots(plan_id, version DESC);

CREATE TABLE IF NOT EXISTS rail_planning_actions (
 action_id text PRIMARY KEY,
 plan_id text NOT NULL REFERENCES rail_planning_plans(plan_id) ON DELETE CASCADE,
 dedupe_key text NOT NULL,
 action_type text NOT NULL CHECK(action_type IN
   ('workflow:expand_search','workflow:refine_preferences','workflow:stop_search','select_candidate','prepare_quote')),
 state text NOT NULL CHECK(state IN ('pending','applied','superseded','rejected')),
 payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 applied_at timestamptz,
 UNIQUE(plan_id, dedupe_key)
);

-- rail_planning_selections: server-issued opaque handles (rsel_) binding one
-- purchasable single-leg journey inside one committed snapshot. The booking
-- service redeems the handle against the pinned evidence — never a client-
-- assembled legs payload. Expiry follows the plan deadline.
CREATE TABLE IF NOT EXISTS rail_planning_selections (
 selection_id text PRIMARY KEY,
 plan_id text NOT NULL REFERENCES rail_planning_plans(plan_id) ON DELETE CASCADE,
 service_execution_id text NOT NULL,
 query_revision bigint NOT NULL,
 snapshot_id text NOT NULL REFERENCES rail_planning_snapshots(snapshot_id) ON DELETE CASCADE,
 journey_id text NOT NULL,
 offer_id text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(snapshot_id, journey_id, offer_id)
);
CREATE INDEX IF NOT EXISTS idx_rail_planning_selections_plan ON rail_planning_selections(plan_id);

-- ============================================================
-- Source: db/v3/schema/40_payment.sql
-- ============================================================

-- Payment intents, provider attempts, and payment facts.

CREATE TABLE IF NOT EXISTS payment_intents (
  payment_intent_id text PRIMARY KEY,
  checkout_id text NOT NULL REFERENCES checkouts(checkout_id),
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  status text NOT NULL DEFAULT 'requires_action'
    CHECK (status IN (
      'requires_action',
      'waiting_user_payment',
      'verified',
      'failed',
      'expired',
      'partially_refunded',
      'refunded'
    )),
  payment_method_type text NOT NULL CHECK (payment_method_type IN ('alipay', 'wechatpay', 'fake_qr')),
  preferred_provider text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  expires_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkout_id, payment_method_type)
);

SELECT itpay_touch_updated_at('payment_intents');

CREATE INDEX IF NOT EXISTS idx_payment_intents_checkout ON payment_intents(checkout_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_attempts (
  payment_attempt_id text PRIMARY KEY,
  payment_intent_id text NOT NULL REFERENCES payment_intents(payment_intent_id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_order_id text,
  provider_trade_no text,
  provider_status text NOT NULL DEFAULT 'created',
  qr_image_url text,
  mobile_wallet_url text,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('payment_attempts');

CREATE INDEX IF NOT EXISTS idx_payment_attempts_intent ON payment_attempts(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_provider_order ON payment_attempts(provider, provider_order_id);

CREATE TABLE IF NOT EXISTS payment_events (
  payment_event_id text PRIMARY KEY,
  payment_intent_id text NOT NULL REFERENCES payment_intents(payment_intent_id) ON DELETE CASCADE,
  payment_attempt_id text REFERENCES payment_attempts(payment_attempt_id),
  event_type text NOT NULL,
  event_status text NOT NULL,
  provider text,
  occurred_at timestamptz NOT NULL,
  payload_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_intent ON payment_events(payment_intent_id, occurred_at);

CREATE TABLE IF NOT EXISTS payment_evidence (
  payment_evidence_id text PRIMARY KEY,
  payment_intent_id text NOT NULL REFERENCES payment_intents(payment_intent_id) ON DELETE CASCADE,
  payment_attempt_id text REFERENCES payment_attempts(payment_attempt_id),
  provider text NOT NULL,
  evidence_type text NOT NULL,
  evidence_hash text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  provider_trade_no text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, evidence_hash)
);

CREATE INDEX IF NOT EXISTS idx_payment_evidence_intent ON payment_evidence(payment_intent_id);

CREATE TABLE IF NOT EXISTS payment_proofs (
  payment_proof_id text PRIMARY KEY,
  payment_intent_id text NOT NULL REFERENCES payment_intents(payment_intent_id) ON DELETE CASCADE,
  payment_evidence_id text NOT NULL REFERENCES payment_evidence(payment_evidence_id),
  checkout_id text NOT NULL REFERENCES checkouts(checkout_id),
  order_id text NOT NULL,
  proof_status text NOT NULL DEFAULT 'accepted'
    CHECK (proof_status IN ('accepted', 'rejected', 'revoked')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_intent_id, payment_evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_proofs_checkout ON payment_proofs(checkout_id);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_order ON payment_proofs(order_id);

-- ============================================================
-- Source: db/v3/schema/45_service_provider.sql
-- ============================================================

-- Service provider credentials, invocation facts, and payment binding.

CREATE TABLE IF NOT EXISTS service_provider_credential_profiles (
  service_provider_credential_profile_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  provider_key text NOT NULL,
  profile_key text NOT NULL,
  display_name text NOT NULL,
  environment text NOT NULL DEFAULT 'live' CHECK (environment IN ('sandbox', 'live')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  created_by text REFERENCES buyer_accounts(buyer_account_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, provider_key, profile_key),
  UNIQUE (service_provider_credential_profile_id, merchant_id)
);

SELECT itpay_touch_updated_at('service_provider_credential_profiles');

CREATE TABLE IF NOT EXISTS service_provider_credentials (
  service_provider_credential_id text PRIMARY KEY,
  service_provider_credential_profile_id text NOT NULL
    REFERENCES service_provider_credential_profiles(service_provider_credential_profile_id),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  provider_key text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'rotated', 'revoked')),
  encrypted_secret_blob bytea NOT NULL,
  encryption_key_ref text NOT NULL,
  secret_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_provider_credential_profile_id, credential_version)
);

SELECT itpay_touch_updated_at('service_provider_credentials');

CREATE INDEX IF NOT EXISTS idx_service_provider_credentials_provider
  ON service_provider_credentials(provider_key, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_provider_credentials_active
  ON service_provider_credentials(service_provider_credential_profile_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS provider_operations (
  provider_operation_id text PRIMARY KEY,
  merchant_id text REFERENCES merchant_accounts(merchant_id),
  provider_key text NOT NULL,
  operation_key text NOT NULL,
  protocol text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'disabled', 'deprecated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, provider_key, operation_key)
);

SELECT itpay_touch_updated_at('provider_operations');

CREATE TABLE IF NOT EXISTS provider_operation_versions (
  provider_operation_version_id text PRIMARY KEY,
  provider_operation_id text NOT NULL REFERENCES provider_operations(provider_operation_id) ON DELETE CASCADE,
  version text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
  operation_hash text NOT NULL,
  operation_json jsonb NOT NULL,
  request_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_operation_id, version),
  UNIQUE (provider_operation_id, operation_hash)
);

CREATE TABLE IF NOT EXISTS seller_api_intake_operation_bindings (
  seller_api_intake_id text NOT NULL
    REFERENCES seller_api_intakes(seller_api_intake_id) ON DELETE CASCADE,
  provider_operation_version_id text NOT NULL
    REFERENCES provider_operation_versions(provider_operation_version_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_api_intake_id, provider_operation_version_id)
);

-- Relational integrity index for immutable provider operations referenced by
-- a published Arazzo workflow. Runtime mappings remain canonical in Arazzo.
CREATE TABLE IF NOT EXISTS service_operation_bindings (
  service_operation_binding_id text PRIMARY KEY,
  service_contract_version_id text NOT NULL REFERENCES service_contract_versions(service_contract_version_id) ON DELETE CASCADE,
  capability_id text NOT NULL,
  service_capability_id text NOT NULL REFERENCES service_capabilities(service_capability_id) ON DELETE CASCADE,
  provider_operation_version_id text NOT NULL REFERENCES provider_operation_versions(provider_operation_version_id),
  credential_profile text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_contract_version_id, capability_id),
  FOREIGN KEY (service_capability_id, service_contract_version_id)
    REFERENCES service_capabilities(service_capability_id, service_contract_version_id)
);

CREATE TABLE IF NOT EXISTS service_payment_bindings (
  service_payment_binding_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  service_quote_lock_id text NOT NULL REFERENCES service_quote_locks(service_quote_lock_id),
  order_item_id text NOT NULL,
  payment_intent_id text NOT NULL REFERENCES payment_intents(payment_intent_id),
  payment_proof_id text REFERENCES payment_proofs(payment_proof_id),
  status text NOT NULL DEFAULT 'payment_pending'
    CHECK (status IN ('payment_pending', 'payment_verified', 'payment_failed', 'refunded')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_intent_id, service_quote_lock_id)
);

SELECT itpay_touch_updated_at('service_payment_bindings');

CREATE INDEX IF NOT EXISTS idx_service_payment_bindings_execution
  ON service_payment_bindings(service_execution_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_invocations (
  provider_invocation_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  capability_id text NOT NULL,
  arazzo_operation_run_id text REFERENCES arazzo_operation_runs(arazzo_operation_run_id) ON DELETE CASCADE,
  provider_operation_version_id text REFERENCES provider_operation_versions(provider_operation_version_id),
  operation_stage text CHECK (operation_stage IS NULL OR operation_stage IN ('execute', 'submit', 'poll', 'fetch', 'cancel')),
  stage_sequence integer CHECK (stage_sequence IS NULL OR stage_sequence >= 0),
  provider_key text NOT NULL,
  service_provider_credential_id text REFERENCES service_provider_credentials(service_provider_credential_id),
  idempotency_key_id text,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'failed_known_no_effect', 'outcome_unknown', 'cancelled')),
  request_hash text NOT NULL,
  request_ref text,
  response_hash text,
  response_ref text,
  safe_result_preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_invocation_id, service_execution_id, capability_id),
  FOREIGN KEY (arazzo_operation_run_id, service_execution_id)
    REFERENCES arazzo_operation_runs(arazzo_operation_run_id, service_execution_id)
);

SELECT itpay_touch_updated_at('provider_invocations');

CREATE INDEX IF NOT EXISTS idx_provider_invocations_execution
  ON provider_invocations(service_execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_invocations_status
  ON provider_invocations(status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_invocations_capability_attempt
  ON provider_invocations(service_execution_id, capability_id, attempt)
  WHERE arazzo_operation_run_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_invocations_idempotency
  ON provider_invocations(service_execution_id, capability_id, idempotency_key_id)
  WHERE idempotency_key_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_invocations_operation_stage
  ON provider_invocations(arazzo_operation_run_id, operation_stage, stage_sequence)
  WHERE arazzo_operation_run_id IS NOT NULL AND operation_stage IS NOT NULL AND stage_sequence IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_payload_objects (
  provider_payload_object_id text PRIMARY KEY,
  provider_invocation_id text NOT NULL REFERENCES provider_invocations(provider_invocation_id) ON DELETE CASCADE,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  capability_id text NOT NULL,
  payload_hash text NOT NULL,
  encrypted_payload bytea NOT NULL,
  encryption_key_ref text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_invocation_id, payload_hash),
  FOREIGN KEY (provider_invocation_id, service_execution_id, capability_id)
    REFERENCES provider_invocations(provider_invocation_id, service_execution_id, capability_id)
);

SELECT itpay_touch_updated_at('provider_payload_objects');

CREATE INDEX IF NOT EXISTS idx_provider_payload_objects_execution
  ON provider_payload_objects(service_execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_payload_objects_provider
  ON provider_payload_objects(provider_key, capability_id, created_at DESC);

-- ============================================================
-- Source: db/v3/schema/50_order_delivery.sql
-- ============================================================

-- Orders, delivery, notifications, and human claim links.

CREATE TABLE IF NOT EXISTS orders (
  order_id text PRIMARY KEY,
  checkout_id text NOT NULL UNIQUE REFERENCES checkouts(checkout_id),
  order_code text NOT NULL,
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN (
      'pending_payment',
      'paid',
      'delivery_pending',
      'delivered',
      'failed',
      'partially_refunded',
      'refunded',
      'cancelled'
    )),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  -- payment_deadline_at ends the order's payable window: past it no new
  -- payment channel may open. The sweeper persists pending_payment →
  -- cancelled once every live payment intent is also dead; API reads
  -- project the deadline-passed state immediately.
  payment_deadline_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  paid_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('orders');

-- Upgrade path for databases created before payment_deadline_at existed:
-- the order shares its checkout's single payable window, so the backfill is
-- LEAST(checkout deadline, earliest bound quote-lock expiry, order
-- created_at + 15 minutes) — the order's later creation time can never mint
-- a fresh 15-minute window past the checkout's own deadline.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_deadline_at timestamptz;

DO $$
BEGIN
  UPDATE orders o
  SET payment_deadline_at = LEAST(
    COALESCE(
      (SELECT c.expires_at FROM checkouts c WHERE c.checkout_id = o.checkout_id),
      'infinity'::timestamptz),
    COALESCE(
      (SELECT min(ql.expires_at)
       FROM service_quote_locks ql
       JOIN service_checkout_bindings b
         ON b.service_quote_lock_id = ql.service_quote_lock_id
       WHERE b.checkout_id = o.checkout_id),
      'infinity'::timestamptz),
    o.created_at + interval '15 minutes')
  WHERE o.payment_deadline_at IS NULL
    OR (o.status = 'pending_payment'
        AND o.payment_deadline_at IS DISTINCT FROM LEAST(
          COALESCE(
            (SELECT c.expires_at FROM checkouts c WHERE c.checkout_id = o.checkout_id),
            'infinity'::timestamptz),
          COALESCE(
            (SELECT min(ql.expires_at)
             FROM service_quote_locks ql
             JOIN service_checkout_bindings b
               ON b.service_quote_lock_id = ql.service_quote_lock_id
             WHERE b.checkout_id = o.checkout_id),
            'infinity'::timestamptz),
          o.created_at + interval '15 minutes'));
END $$;

ALTER TABLE orders ALTER COLUMN payment_deadline_at SET NOT NULL;
ALTER TABLE orders ALTER COLUMN payment_deadline_at SET DEFAULT (now() + interval '15 minutes');

CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_payment_deadline
  ON orders(payment_deadline_at)
  WHERE status = 'pending_payment';

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_code
  ON orders(order_code)
  WHERE order_code IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'buyer_sessions_scoped_order_fk'
  ) THEN
    ALTER TABLE buyer_sessions
      ADD CONSTRAINT buyer_sessions_scoped_order_fk
      FOREIGN KEY (scoped_order_id) REFERENCES orders(order_id);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payment_proofs_order_fk'
  ) THEN
    ALTER TABLE payment_proofs
      ADD CONSTRAINT payment_proofs_order_fk
      FOREIGN KEY (order_id) REFERENCES orders(order_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS order_items (
  order_item_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  checkout_item_id text NOT NULL REFERENCES checkout_items(checkout_item_id),
  catalog_item_id text NOT NULL,
  catalog_variant_id text NOT NULL,
  service_execution_id text REFERENCES service_executions(service_execution_id),
  service_quote_lock_id text REFERENCES service_quote_locks(service_quote_lock_id),
  service_capability_id text REFERENCES service_capabilities(service_capability_id),
  title text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_service_execution
  ON order_items(service_execution_id)
  WHERE service_execution_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_service_quote_lock
  ON order_items(order_id, service_quote_lock_id)
  WHERE service_quote_lock_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_payment_bindings_order_item_fk') THEN
    ALTER TABLE service_payment_bindings
      ADD CONSTRAINT service_payment_bindings_order_item_fk
      FOREIGN KEY (order_item_id) REFERENCES order_items(order_item_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS order_item_finalizations (
  order_item_finalization_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  order_item_id text NOT NULL UNIQUE REFERENCES order_items(order_item_id) ON DELETE CASCADE,
  service_contract_publication_id text REFERENCES service_contract_publications(service_contract_publication_id),
  policy_revision text NOT NULL,
  finalization_reason text NOT NULL,
  source_fact_type text NOT NULL,
  source_fact_id text NOT NULL,
  finalized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_fact_type, source_fact_id)
);

CREATE INDEX IF NOT EXISTS idx_order_item_finalizations_order
  ON order_item_finalizations(order_id, finalized_at DESC);

CREATE TABLE IF NOT EXISTS delivery_artifacts (
  delivery_artifact_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  order_item_id text REFERENCES order_items(order_item_id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('not_required', 'pending', 'claimable', 'sent', 'claimed', 'failed', 'revoked')),
  artifact_type text NOT NULL,
  storage_ref text,
  public_preview text,
  sensitive_content_redacted boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('delivery_artifacts');

CREATE INDEX IF NOT EXISTS idx_delivery_artifacts_order ON delivery_artifacts(order_id);

CREATE TABLE IF NOT EXISTS claim_links (
  claim_link_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  delivery_artifact_id text REFERENCES delivery_artifacts(delivery_artifact_id),
  claim_token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'claimed', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claim_client_binding_hash text,
  claim_bound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_links_claim_binding_present CHECK (
    status <> 'claimed'
    OR (
      claimed_at IS NOT NULL
      AND claim_client_binding_hash IS NOT NULL
      AND claim_bound_at IS NOT NULL
    )
  )
);

SELECT itpay_touch_updated_at('claim_links');

CREATE INDEX IF NOT EXISTS idx_claim_links_order ON claim_links(order_id);

CREATE TABLE IF NOT EXISTS delivery_notifications (
  delivery_notification_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  delivery_artifact_id text REFERENCES delivery_artifacts(delivery_artifact_id),
  claim_link_id text REFERENCES claim_links(claim_link_id),
  checkout_display_token_id text REFERENCES checkout_display_tokens(checkout_display_token_id),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'webhook')),
  recipient_redacted text NOT NULL,
  -- 'sending' is the atomic claim state for a provider call in flight;
  -- 'send_unknown' records a possibly-accepted send awaiting read-only
  -- reconciliation. Neither may trigger a blind resend.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'send_unknown', 'sent', 'failed', 'suppressed')),
  template_key text NOT NULL DEFAULT 'delivery_claim_ready',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_error text,
  idempotency_key text,
  provider_message_id text,
  -- send_started_at marks when the exclusive send placeholder was claimed; it
  -- is the provider-side SendDate anchor for OutId-based reconciliation.
  send_started_at timestamptz,
  -- Safe template variables captured at enqueue time (train/date/stations/
  -- seat labels/order code) so the sender never needs the encrypted booking
  -- state. Must never carry passenger names or identity documents.
  template_params jsonb,
  -- Provider delivery receipt verification (e.g. Aliyun QuerySendDetails).
  provider_receipt_status text,
  provider_receipt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('delivery_notifications');

-- Upgrade path for databases created before the send-placeholder states
-- existed: widen the status check and add the claim timestamp column.
ALTER TABLE delivery_notifications ADD COLUMN IF NOT EXISTS send_started_at timestamptz;
ALTER TABLE delivery_notifications DROP CONSTRAINT IF EXISTS delivery_notifications_status_check;
ALTER TABLE delivery_notifications
  ADD CONSTRAINT delivery_notifications_status_check
  CHECK (status IN ('pending', 'sending', 'send_unknown', 'sent', 'failed', 'suppressed'));

CREATE INDEX IF NOT EXISTS idx_delivery_notifications_order ON delivery_notifications(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_notifications_display_token
  ON delivery_notifications(checkout_display_token_id)
  WHERE checkout_display_token_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_notifications_pending
  ON delivery_notifications(status, next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_notifications_idempotency
  ON delivery_notifications(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- Source: db/v3/schema/55_entitlement_vault.sql
-- ============================================================

-- Entitlements, vault artifacts, and scoped agent-readable grants.

CREATE TABLE IF NOT EXISTS entitlements (
  entitlement_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  order_item_id text REFERENCES order_items(order_item_id),
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'revoked', 'expired')),
  entitlement_type text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('entitlements');

CREATE INDEX IF NOT EXISTS idx_entitlements_order ON entitlements(order_id);

CREATE TABLE IF NOT EXISTS vault_artifacts (
  vault_artifact_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  delivery_artifact_id text REFERENCES delivery_artifacts(delivery_artifact_id),
  status text NOT NULL DEFAULT 'sealed'
    CHECK (status IN ('sealed', 'revealable', 'revealed', 'revoked')),
  storage_ref text NOT NULL,
  schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  redacted_preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('vault_artifacts');

CREATE INDEX IF NOT EXISTS idx_vault_artifacts_order ON vault_artifacts(order_id);

-- Vault-owned normalized payloads. Provider raw payloads remain in
-- provider_payload_objects; this table stores an encrypted structured artifact
-- assembled from one or more runtime results.
CREATE TABLE IF NOT EXISTS vault_payload_objects (
  vault_payload_object_id text PRIMARY KEY,
  vault_artifact_id text NOT NULL REFERENCES vault_artifacts(vault_artifact_id) ON DELETE CASCADE,
  schema_version text NOT NULL,
  payload_hash text NOT NULL,
  encrypted_payload bytea NOT NULL,
  encryption_key_ref text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_artifact_id, schema_version)
);

CREATE INDEX IF NOT EXISTS idx_vault_payload_objects_artifact
  ON vault_payload_objects(vault_artifact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_read_grants (
  agent_read_grant_id text PRIMARY KEY,
  vault_artifact_id text REFERENCES vault_artifacts(vault_artifact_id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  grant_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('agent_read_grants');

CREATE INDEX IF NOT EXISTS idx_agent_read_grants_artifact ON agent_read_grants(vault_artifact_id);
CREATE INDEX IF NOT EXISTS idx_agent_read_grants_buyer_order ON agent_read_grants(buyer_account_id, order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_read_grant_artifacts (
  agent_read_grant_id text NOT NULL REFERENCES agent_read_grants(agent_read_grant_id) ON DELETE CASCADE,
  vault_artifact_id text NOT NULL REFERENCES vault_artifacts(vault_artifact_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_read_grant_id, vault_artifact_id)
);

CREATE TABLE IF NOT EXISTS agent_read_grant_fields (
  agent_read_grant_id text NOT NULL REFERENCES agent_read_grants(agent_read_grant_id) ON DELETE CASCADE,
  field_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_read_grant_id, field_path)
);

CREATE TABLE IF NOT EXISTS agent_read_grant_audiences (
  agent_read_grant_id text NOT NULL REFERENCES agent_read_grants(agent_read_grant_id) ON DELETE CASCADE,
  agent_instance_id text NOT NULL REFERENCES agent_instances(agent_instance_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_read_grant_id, agent_instance_id)
);

CREATE TABLE IF NOT EXISTS mcp_connection_read_grant_audiences (
  agent_read_grant_id text NOT NULL REFERENCES agent_read_grants(agent_read_grant_id) ON DELETE CASCADE,
  mcp_connection_id text NOT NULL REFERENCES mcp_connections(mcp_connection_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_read_grant_id, mcp_connection_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_connection_read_grant_audiences_connection
  ON mcp_connection_read_grant_audiences(mcp_connection_id, agent_read_grant_id);

-- Human authorization requests and bounded exact-audience access windows.
-- The row remains the durable authorization fact after approval; PostgreSQL
-- time is authoritative for access expiry.
CREATE TABLE IF NOT EXISTS vault_access_requests (
  vault_access_request_id text PRIMARY KEY,
  request_kind text NOT NULL
    CHECK (request_kind IN ('account_window', 'artifact_reveal')),
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  agent_device_id text,
  agent_instance_id text,
  mcp_connection_id text REFERENCES mcp_connections(mcp_connection_id) ON DELETE CASCADE,
  vault_artifact_id text REFERENCES vault_artifacts(vault_artifact_id) ON DELETE CASCADE,
  requested_scope_hash text NOT NULL,
  requester_label text NOT NULL,
  start_token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'revoked', 'failed')),
  request_expires_at timestamptz NOT NULL,
  approved_duration_seconds integer
    CHECK (approved_duration_seconds IN (900, 1800, 3600, 14400, 86400)),
  access_expires_at timestamptz,
  resulting_grant_id text REFERENCES agent_read_grants(agent_read_grant_id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vault_access_requests_audience_check CHECK (
    (agent_device_id IS NOT NULL AND agent_instance_id IS NOT NULL AND mcp_connection_id IS NULL)
    OR
    (agent_device_id IS NULL AND agent_instance_id IS NULL AND mcp_connection_id IS NOT NULL)
  ),
  CONSTRAINT vault_access_requests_local_instance_fk
    FOREIGN KEY (agent_instance_id, agent_device_id)
    REFERENCES agent_instances(agent_instance_id, agent_device_id) ON DELETE CASCADE,
  CONSTRAINT vault_access_requests_kind_check CHECK (
    (request_kind = 'account_window' AND vault_artifact_id IS NULL AND resulting_grant_id IS NULL)
    OR
    (request_kind = 'artifact_reveal' AND vault_artifact_id IS NOT NULL)
  ),
  CONSTRAINT vault_access_requests_pending_buyer_check CHECK (
    buyer_account_id IS NOT NULL
    OR (request_kind = 'account_window' AND agent_device_id IS NOT NULL
      AND status IN ('pending', 'denied', 'expired', 'failed'))
  ),
  CONSTRAINT vault_access_requests_state_check CHECK (
    (status = 'pending' AND decided_at IS NULL AND approved_duration_seconds IS NULL AND access_expires_at IS NULL)
    OR (status IN ('approved', 'revoked') AND buyer_account_id IS NOT NULL
      AND decided_at IS NOT NULL AND approved_duration_seconds IS NOT NULL AND access_expires_at IS NOT NULL)
    OR (status = 'expired' AND decided_at IS NOT NULL AND (
      (approved_duration_seconds IS NULL AND access_expires_at IS NULL)
      OR (buyer_account_id IS NOT NULL AND approved_duration_seconds IS NOT NULL AND access_expires_at IS NOT NULL)
    ))
    OR (status IN ('denied', 'failed') AND decided_at IS NOT NULL
      AND approved_duration_seconds IS NULL AND access_expires_at IS NULL)
  ),
  CONSTRAINT vault_access_requests_time_check CHECK (
    request_expires_at > created_at
    AND (access_expires_at IS NULL OR access_expires_at > decided_at)
  )
);

SELECT itpay_touch_updated_at('vault_access_requests');

CREATE INDEX IF NOT EXISTS idx_vault_access_requests_buyer
  ON vault_access_requests(buyer_account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_vault_access_requests_artifact
  ON vault_access_requests(vault_artifact_id, status, updated_at DESC)
  WHERE vault_artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vault_access_requests_local_window
  ON vault_access_requests(agent_device_id, agent_instance_id, status, access_expires_at DESC)
  WHERE request_kind = 'account_window' AND agent_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vault_access_requests_mcp_window
  ON vault_access_requests(mcp_connection_id, status, access_expires_at DESC)
  WHERE request_kind = 'account_window' AND mcp_connection_id IS NOT NULL;

-- ============================================================
-- Source: db/v3/schema/58_service_delivery_binding.sql
-- ============================================================

-- Service Execution links into delivery, claim, vault, and grant facts.

CREATE TABLE IF NOT EXISTS service_delivery_bindings (
  service_delivery_binding_id text PRIMARY KEY,
  service_execution_id text NOT NULL REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  order_item_id text REFERENCES order_items(order_item_id),
  delivery_artifact_id text REFERENCES delivery_artifacts(delivery_artifact_id),
  claim_link_id text REFERENCES claim_links(claim_link_id),
  vault_artifact_id text REFERENCES vault_artifacts(vault_artifact_id),
  agent_read_grant_id text REFERENCES agent_read_grants(agent_read_grant_id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivery_issued', 'vault_sealed', 'claimable', 'grant_available', 'completed', 'failed', 'revoked')),
  redacted_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_execution_id, order_id, order_item_id)
);

SELECT itpay_touch_updated_at('service_delivery_bindings');

CREATE INDEX IF NOT EXISTS idx_service_delivery_bindings_execution
  ON service_delivery_bindings(service_execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_delivery_bindings_order
  ON service_delivery_bindings(order_id, created_at DESC);

-- ============================================================
-- Source: db/v3/schema/60_refund.sql
-- ============================================================

-- Refund requests and refund facts.

CREATE TABLE IF NOT EXISTS refund_requests (
  refund_request_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id),
  order_item_id text REFERENCES order_items(order_item_id),
  payment_intent_id text REFERENCES payment_intents(payment_intent_id),
  buyer_account_id text REFERENCES buyer_accounts(buyer_account_id),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN (
      'requested',
      'policy_review_required',
      'accepted',
      'provider_pending',
      'succeeded',
      'failed',
      'cancelled',
      'rejected'
    )),
  decision_mode text NOT NULL DEFAULT 'automatic'
    CHECK (decision_mode IN ('automatic', 'manual')),
  consumption_state text NOT NULL DEFAULT 'unknown'
    CHECK (consumption_state IN ('unconsumed', 'consumed', 'unknown')),
  failure_class text
    CHECK (failure_class IS NULL OR failure_class IN ('known_no_effect', 'retryable', 'outcome_unknown', 'permanent')),
  reason text,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  decided_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('refund_requests');

CREATE INDEX IF NOT EXISTS idx_refund_requests_order ON refund_requests(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON refund_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS refund_confirmation_sessions (
  refund_confirmation_session_id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  mcp_connection_id text NOT NULL REFERENCES mcp_connections(mcp_connection_id),
  buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  order_id text NOT NULL REFERENCES orders(order_id),
  order_item_id text,
  reason text NOT NULL,
  idempotency_key_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT refund_confirmation_sessions_status_check
    CHECK (
      (status = 'pending' AND confirmed_at IS NULL)
      OR (status = 'confirmed' AND confirmed_at IS NOT NULL)
      OR (status = 'expired' AND confirmed_at IS NULL)
    )
);

SELECT itpay_touch_updated_at('refund_confirmation_sessions');

CREATE INDEX IF NOT EXISTS idx_refund_confirmation_sessions_buyer
  ON refund_confirmation_sessions(buyer_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refund_confirmation_sessions_expiry
  ON refund_confirmation_sessions(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_requests_active_order
  ON refund_requests(order_id)
  WHERE order_item_id IS NULL
    AND status IN ('requested', 'policy_review_required', 'accepted', 'provider_pending');

CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_requests_active_item
  ON refund_requests(order_id, order_item_id)
  WHERE order_item_id IS NOT NULL
    AND status IN ('requested', 'policy_review_required', 'accepted', 'provider_pending');

CREATE TABLE IF NOT EXISTS service_consumption_facts (
  service_consumption_fact_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  order_item_id text REFERENCES order_items(order_item_id) ON DELETE CASCADE,
  service_execution_id text REFERENCES service_executions(service_execution_id) ON DELETE CASCADE,
  capability_id text,
  source_type text NOT NULL CHECK (source_type IN ('provider_invocation', 'delivery', 'entitlement', 'manual')),
  source_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'committed', 'released', 'unknown')),
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, state)
);

CREATE INDEX IF NOT EXISTS idx_service_consumption_facts_order
  ON service_consumption_facts(order_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS refund_decisions (
  refund_decision_id text PRIMARY KEY,
  refund_request_id text NOT NULL REFERENCES refund_requests(refund_request_id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('auto_accept', 'review_required', 'approve', 'reject', 'cancel', 'retry')),
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'buyer', 'agent', 'admin')),
  actor_id text,
  reason text,
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refund_decisions_request
  ON refund_decisions(refund_request_id, created_at);

CREATE TABLE IF NOT EXISTS refund_case_notes (
  refund_case_note_id text PRIMARY KEY,
  refund_request_id text NOT NULL REFERENCES refund_requests(refund_request_id) ON DELETE CASCADE,
  author_buyer_account_id text NOT NULL REFERENCES buyer_accounts(buyer_account_id),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  visibility text NOT NULL DEFAULT 'admin' CHECK (visibility IN ('admin', 'buyer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refund_case_notes_request
  ON refund_case_notes(refund_request_id, created_at);

CREATE TABLE IF NOT EXISTS refund_attempts (
  refund_attempt_id text PRIMARY KEY,
  refund_request_id text NOT NULL REFERENCES refund_requests(refund_request_id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_refund_id text,
  provider_status text NOT NULL DEFAULT 'created',
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  failure_class text
    CHECK (failure_class IS NULL OR failure_class IN ('known_no_effect', 'retryable', 'outcome_unknown', 'permanent')),
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) <= 120),
  failure_message text CHECK (failure_message IS NULL OR length(failure_message) <= 500)
);

SELECT itpay_touch_updated_at('refund_attempts');

CREATE INDEX IF NOT EXISTS idx_refund_attempts_request ON refund_attempts(refund_request_id);

CREATE TABLE IF NOT EXISTS refund_events (
  refund_event_id text PRIMARY KEY,
  refund_request_id text NOT NULL REFERENCES refund_requests(refund_request_id) ON DELETE CASCADE,
  refund_attempt_id text REFERENCES refund_attempts(refund_attempt_id),
  event_type text NOT NULL,
  event_status text NOT NULL,
  provider text,
  payload_ref text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refund_events_request ON refund_events(refund_request_id, occurred_at);

CREATE TABLE IF NOT EXISTS refund_evidence (
  refund_evidence_id text PRIMARY KEY,
  refund_request_id text NOT NULL REFERENCES refund_requests(refund_request_id) ON DELETE CASCADE,
  refund_attempt_id text REFERENCES refund_attempts(refund_attempt_id),
  source_type text NOT NULL CHECK (source_type IN ('provider', 'admin', 'system')),
  provider text,
  evidence_type text NOT NULL,
  evidence_hash text NOT NULL,
  payload_ref text,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  provider_refund_id text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, evidence_hash)
);

CREATE INDEX IF NOT EXISTS idx_refund_evidence_request ON refund_evidence(refund_request_id, occurred_at);

CREATE TABLE IF NOT EXISTS refund_proofs (
  refund_proof_id text PRIMARY KEY,
  refund_request_id text NOT NULL REFERENCES refund_requests(refund_request_id) ON DELETE CASCADE,
  refund_evidence_id text NOT NULL REFERENCES refund_evidence(refund_evidence_id),
  order_id text NOT NULL REFERENCES orders(order_id),
  payment_intent_id text REFERENCES payment_intents(payment_intent_id),
  proof_status text NOT NULL DEFAULT 'accepted'
    CHECK (proof_status IN ('accepted', 'rejected', 'revoked')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (refund_request_id, refund_evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_refund_proofs_request ON refund_proofs(refund_request_id);
CREATE INDEX IF NOT EXISTS idx_refund_proofs_order ON refund_proofs(order_id);

-- ============================================================
-- Source: db/v3/schema/65_finance_settlement.sql
-- ============================================================

-- Ledger, provider statements, reconciliation, settlement, and merchant statements.

CREATE TABLE IF NOT EXISTS ledger_entries (
  ledger_entry_id text PRIMARY KEY,
  ledger_sequence bigserial,
  business_dedupe_key text,
  order_id text REFERENCES orders(order_id),
  payment_intent_id text REFERENCES payment_intents(payment_intent_id),
  refund_request_id text REFERENCES refund_requests(refund_request_id),
  merchant_id text REFERENCES merchant_accounts(merchant_id),
  account_type text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  occurred_at timestamptz NOT NULL,
  provider text,
  provider_trade_no text,
  provider_raw_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_business_dedupe_key
  ON ledger_entries(business_dedupe_key)
  WHERE business_dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_entries_order ON ledger_entries(order_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_merchant ON ledger_entries(merchant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_provider_trade ON ledger_entries(provider, provider_trade_no);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_sequence ON ledger_entries(ledger_sequence);

CREATE TABLE IF NOT EXISTS provider_statement_imports (
  provider_statement_import_id text PRIMARY KEY,
  provider text NOT NULL,
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'imported'
    CHECK (status IN ('imported', 'parsed', 'failed', 'reconciled')),
  line_count integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  imported_by text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, file_hash)
);

CREATE TABLE IF NOT EXISTS provider_statement_lines (
  provider_statement_line_id text PRIMARY KEY,
  provider_statement_import_id text NOT NULL REFERENCES provider_statement_imports(provider_statement_import_id) ON DELETE CASCADE,
  provider text NOT NULL,
  channel text,
  business_date date,
  provider_timezone text,
  provider_trade_no text,
  provider_refund_id text,
  provider_out_trade_no text,
  provider_out_request_no text,
  line_type text NOT NULL DEFAULT 'payment'
    CHECK (line_type IN ('payment', 'refund', 'fee', 'settlement', 'adjustment')),
  amount_minor bigint NOT NULL,
  fee_minor bigint,
  currency text NOT NULL,
  provider_status text,
  occurred_at timestamptz,
  raw_line_hash text NOT NULL,
  raw_line_ref text,
  normalized_payload_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_statement_import_id, raw_line_hash)
);

CREATE INDEX IF NOT EXISTS idx_provider_statement_lines_import ON provider_statement_lines(provider_statement_import_id);
CREATE INDEX IF NOT EXISTS idx_provider_statement_lines_trade ON provider_statement_lines(provider, provider_trade_no);
CREATE INDEX IF NOT EXISTS idx_provider_statement_lines_out_trade ON provider_statement_lines(provider, provider_out_trade_no);
CREATE INDEX IF NOT EXISTS idx_provider_statement_lines_business_date ON provider_statement_lines(provider, business_date);

CREATE TABLE IF NOT EXISTS provider_recovery_requests (
  provider_recovery_request_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('alipay', 'wechatpay')),
  target_type text NOT NULL CHECK (target_type IN ('payment_intent', 'refund_request', 'provider_trade')),
  target_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('query', 'repair', 'reconcile')),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'started', 'completed', 'failed')),
  reason text,
  result_ref text,
  result_hash text,
  summary text,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('provider_recovery_requests');

CREATE INDEX IF NOT EXISTS idx_provider_recovery_requests_target ON provider_recovery_requests(provider, target_type, target_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_recovery_requests_status ON provider_recovery_requests(status, requested_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  reconciliation_run_id text PRIMARY KEY,
  provider_statement_import_id text REFERENCES provider_statement_imports(provider_statement_import_id),
  provider text,
  channel text,
  business_date date,
  provider_timezone text,
  ledger_snapshot_sequence bigint,
  run_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  started_by text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('reconciliation_runs');

CREATE TABLE IF NOT EXISTS reconciliation_mismatches (
  reconciliation_mismatch_id text PRIMARY KEY,
  reconciliation_run_id text NOT NULL REFERENCES reconciliation_runs(reconciliation_run_id) ON DELETE CASCADE,
  mismatch_type text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'proposed', 'resolved', 'ignored')),
  provider_statement_line_id text REFERENCES provider_statement_lines(provider_statement_line_id),
  ledger_entry_id text REFERENCES ledger_entries(ledger_entry_id),
  amount_delta_minor bigint,
  currency text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('reconciliation_mismatches');

CREATE INDEX IF NOT EXISTS idx_reconciliation_mismatches_run ON reconciliation_mismatches(reconciliation_run_id, status);

CREATE TABLE IF NOT EXISTS reconciliation_matches (
  reconciliation_match_id text PRIMARY KEY,
  reconciliation_run_id text NOT NULL REFERENCES reconciliation_runs(reconciliation_run_id) ON DELETE CASCADE,
  provider_statement_line_id text NOT NULL REFERENCES provider_statement_lines(provider_statement_line_id),
  ledger_entry_id text NOT NULL REFERENCES ledger_entries(ledger_entry_id),
  match_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reconciliation_run_id, provider_statement_line_id, ledger_entry_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_matches_run_line_ledger
  ON reconciliation_matches(reconciliation_run_id, provider_statement_line_id, ledger_entry_id);

CREATE TABLE IF NOT EXISTS settlement_batches (
  settlement_batch_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'finalized', 'paid', 'cancelled')),
  currency text NOT NULL,
  total_amount_minor bigint NOT NULL DEFAULT 0,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('settlement_batches');

CREATE INDEX IF NOT EXISTS idx_settlement_batches_merchant ON settlement_batches(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settlement_batch_lines (
  settlement_batch_line_id text PRIMARY KEY,
  settlement_batch_id text NOT NULL REFERENCES settlement_batches(settlement_batch_id) ON DELETE CASCADE,
  ledger_entry_id text REFERENCES ledger_entries(ledger_entry_id),
  line_type text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlement_batch_lines_batch ON settlement_batch_lines(settlement_batch_id);

CREATE TABLE IF NOT EXISTS settlement_payouts (
  settlement_payout_id text PRIMARY KEY,
  settlement_batch_id text NOT NULL REFERENCES settlement_batches(settlement_batch_id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'submitted', 'paid', 'failed')),
  destination_ref text,
  payout_ref text,
  proof_ref text,
  proof_hash text,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('settlement_payouts');

CREATE INDEX IF NOT EXISTS idx_settlement_payouts_batch ON settlement_payouts(settlement_batch_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS settlement_adjustments (
  settlement_adjustment_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  settlement_batch_id text REFERENCES settlement_batches(settlement_batch_id),
  reason text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('settlement_adjustments');

CREATE TABLE IF NOT EXISTS merchant_statements (
  merchant_statement_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant_accounts(merchant_id),
  settlement_batch_id text REFERENCES settlement_batches(settlement_batch_id),
  status text NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'published', 'voided')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency text NOT NULL,
  total_amount_minor bigint NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT itpay_touch_updated_at('merchant_statements');

CREATE INDEX IF NOT EXISTS idx_merchant_statements_merchant ON merchant_statements(merchant_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS merchant_statement_lines (
  merchant_statement_line_id text PRIMARY KEY,
  merchant_statement_id text NOT NULL REFERENCES merchant_statements(merchant_statement_id) ON DELETE CASCADE,
  settlement_batch_line_id text REFERENCES settlement_batch_lines(settlement_batch_line_id),
  line_type text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_statement_lines_statement ON merchant_statement_lines(merchant_statement_id);

CREATE TABLE IF NOT EXISTS merchant_statement_exports (
  merchant_statement_export_id text PRIMARY KEY,
  merchant_statement_id text NOT NULL REFERENCES merchant_statements(merchant_statement_id) ON DELETE CASCADE,
  format text NOT NULL CHECK (format IN ('pdf', 'csv', 'json')),
  file_ref text NOT NULL,
  file_hash text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Source: db/v3/schema/70_platform.sql
-- ============================================================

-- Platform support tables. Backend owns command admission and reactive reads.
-- Execution is adapter-backed. Domain events connect DB truth to SSE consumers.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key_id text PRIMARY KEY,
  scope text NOT NULL,
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  locked_until timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, key_hash)
);

SELECT itpay_touch_updated_at('idempotency_keys');

CREATE TABLE IF NOT EXISTS platform_releases (
  platform_release_id text PRIMARY KEY,
  platform_revision text NOT NULL UNIQUE,
  schema_revision text NOT NULL,
  schema_epoch text,
  schema_head text,
  schema_set_hash text,
  bootstrap_revision text NOT NULL,
  publication_revision text,
  publication_checksum text,
  api_contract_revision text NOT NULL,
  minimum_cli_version text NOT NULL,
  maximum_cli_major integer NOT NULL CHECK (maximum_cli_major > 0),
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'active', 'superseded', 'failed')),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_releases_active
  ON platform_releases((status))
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS bootstrap_revisions (
  bootstrap_revision text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Production schema upgrades are not bootstrap facts. This ledger records the
-- exact externally approved and signed bundle that changed an existing
-- database. It contains audit references only; SQL, signatures, credentials,
-- and approval bodies remain outside PostgreSQL.
CREATE TABLE IF NOT EXISTS platform_schema_migrations (
  migration_id text PRIMARY KEY,
  schema_epoch text NOT NULL,
  from_schema_set_hash text NOT NULL CHECK (from_schema_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  to_schema_set_hash text NOT NULL CHECK (to_schema_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  sql_checksum text NOT NULL CHECK (sql_checksum ~ '^sha256:[0-9a-f]{64}$'),
  manifest_checksum text NOT NULL CHECK (manifest_checksum ~ '^sha256:[0-9a-f]{64}$'),
  approval_id text NOT NULL,
  approval_checksum text NOT NULL CHECK (approval_checksum ~ '^sha256:[0-9a-f]{64}$'),
  bundle_reference text NOT NULL,
  bundle_version text NOT NULL,
  signing_key_id text NOT NULL,
  signature_provider text NOT NULL,
  signature_algorithm text NOT NULL,
  signature_checksum text NOT NULL CHECK (signature_checksum ~ '^sha256:[0-9a-f]{64}$'),
  backup_reference text NOT NULL,
  backup_evidence_checksum text NOT NULL CHECK (backup_evidence_checksum ~ '^sha256:[0-9a-f]{64}$'),
  platform_revision text NOT NULL,
  runner_revision text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publication_revisions (
  publication_revision text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_events (
  domain_event_id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  visibility text NOT NULL DEFAULT 'account'
    CHECK (visibility IN ('public', 'checkout_display', 'order_scoped', 'account', 'admin')),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (aggregate_type, aggregate_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_domain_events_aggregate ON domain_events(aggregate_type, aggregate_id, sequence);
CREATE INDEX IF NOT EXISTS idx_domain_events_created ON domain_events(created_at DESC);

CREATE TABLE IF NOT EXISTS domain_event_sequences (
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate_type, aggregate_id)
);

CREATE TABLE IF NOT EXISTS execution_requests (
  execution_request_id text PRIMARY KEY,
  execution_kind text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  idempotency_key_id text REFERENCES idempotency_keys(idempotency_key_id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'started', 'completed', 'failed', 'cancelled')),
  external_execution_id text,
  external_run_id text,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  operation text NOT NULL DEFAULT 'start',
  signal_name text,
  dedupe_key text,
  available_at timestamptz NOT NULL DEFAULT now(),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_requests_operation_check CHECK (operation IN ('start', 'signal', 'resume')),
  CONSTRAINT execution_requests_signal_shape_check CHECK (
    (operation IN ('start', 'resume') AND signal_name IS NULL) OR
    (operation = 'signal' AND signal_name IS NOT NULL)
  ),
  CONSTRAINT execution_requests_service_run_dedupe_check CHECK (
    execution_kind <> 'service.execution.run'
    OR aggregate_type <> 'service_execution'
    OR dedupe_key IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_requests_dedupe
  ON execution_requests(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

SELECT itpay_touch_updated_at('execution_requests');

CREATE INDEX IF NOT EXISTS idx_execution_requests_aggregate ON execution_requests(aggregate_type, aggregate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_requests_status ON execution_requests(status, created_at DESC);
CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id text PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  ip_hash text,
  user_agent_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_aggregate ON audit_events(aggregate_type, aggregate_id, occurred_at DESC);

-- ============================================================
-- Source: db/v3/schema/72_journey_observations.sql
-- ============================================================

-- Supplemental request-boundary facts for Admin journey reconstruction.
-- Business state remains authoritative in the existing execution, payment,
-- order, delivery, feedback, and refund tables.

CREATE TABLE IF NOT EXISTS journey_observations (
  journey_observation_id text PRIMARY KEY,
  request_id text NOT NULL,
  event_type text NOT NULL DEFAULT 'http.request_completed'
    CHECK (event_type = 'http.request_completed'),
  stage text NOT NULL
    CHECK (stage IN ('service', 'checkout', 'order', 'refund', 'vault', 'auth')),
  outcome text NOT NULL
    CHECK (outcome IN ('succeeded', 'rejected', 'failed')),
  service_execution_id text,
  checkout_id text,
  order_id text,
  refund_request_id text,
  vault_artifact_ref text,
  vault_access_request_id text,
  dashboard_auth_session_id text,
  actor_type text NOT NULL
    CHECK (actor_type IN ('browser', 'agent', 'mcp')),
  buyer_account_id text,
  agent_device_id text,
  agent_instance_id text,
  mcp_connection_id text,
  http_method text NOT NULL
    CHECK (http_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  route_pattern text NOT NULL
    CHECK (length(route_pattern) BETWEEN 1 AND 200 AND position('?' IN route_pattern) = 0),
  http_status integer NOT NULL CHECK (http_status BETWEEN 100 AND 599),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 120),
  client_kind text CHECK (client_kind IS NULL OR length(client_kind) <= 40),
  agent_type text CHECK (agent_type IS NULL OR length(agent_type) <= 64),
  client_version text CHECK (client_version IS NULL OR length(client_version) <= 32),
  runtime_revision text CHECK (runtime_revision IS NULL OR length(runtime_revision) <= 80),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_metadata) = 'object' AND octet_length(safe_metadata::text) <= 2048),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_journey_observations_request
  ON journey_observations(request_id);
CREATE INDEX IF NOT EXISTS idx_journey_observations_execution
  ON journey_observations(service_execution_id, occurred_at)
  WHERE service_execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journey_observations_checkout
  ON journey_observations(checkout_id, occurred_at)
  WHERE checkout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journey_observations_order
  ON journey_observations(order_id, occurred_at)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journey_observations_refund
  ON journey_observations(refund_request_id, occurred_at)
  WHERE refund_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journey_observations_artifact
  ON journey_observations(vault_artifact_ref, occurred_at)
  WHERE vault_artifact_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journey_observations_vault_access_request
  ON journey_observations(vault_access_request_id, occurred_at)
  WHERE vault_access_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journey_observations_dashboard_auth_session
  ON journey_observations(dashboard_auth_session_id, occurred_at)
  WHERE dashboard_auth_session_id IS NOT NULL;

-- ============================================================
-- Source: db/v3/schema/72_seller_canary.sql
-- ============================================================

-- This relation depends on execution_requests and service_executions from
-- 70_platform.sql, so it must be assembled after the platform schema.
CREATE TABLE IF NOT EXISTS service_canary_execution_bindings (
  service_canary_execution_binding_id text PRIMARY KEY,
  service_canary_run_id text NOT NULL
    REFERENCES service_canary_runs(service_canary_run_id) ON DELETE CASCADE,
  execution_request_id text NOT NULL REFERENCES execution_requests(execution_request_id),
  service_execution_id text REFERENCES service_executions(service_execution_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_canary_run_id, execution_request_id)
);

-- ============================================================
-- Source: db/v3/schema/75_feedback.sql
-- ============================================================

-- Service feedback: a single (order_item, submitter) per record, append-replace via UNIQUE.
-- Admin can transition status: new -> acknowledged -> resolved | dismissed.

CREATE TABLE IF NOT EXISTS service_feedback (
  feedback_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id),
  order_item_id text NOT NULL REFERENCES order_items(order_item_id),
  submitter_kind text NOT NULL CHECK (submitter_kind IN ('buyer', 'agent')),
  submitter_account_id text REFERENCES buyer_accounts(buyer_account_id),
  agent_instance_id text REFERENCES agent_instances(agent_instance_id),
  rating smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  note text,
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'acknowledged', 'resolved', 'dismissed')),
  admin_note text,
  resolved_by_admin_id text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_feedback_submitter_present CHECK (
    (submitter_kind = 'buyer'
      AND submitter_account_id IS NOT NULL
      AND agent_instance_id IS NULL)
    OR
    (submitter_kind = 'agent'
      AND submitter_account_id IS NULL
      AND agent_instance_id IS NOT NULL)
  ),
  CONSTRAINT service_feedback_content_present CHECK (
    rating IS NOT NULL OR NULLIF(btrim(note), '') IS NOT NULL
  )
);

SELECT itpay_touch_updated_at('service_feedback');

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_feedback_item_submitter
  ON service_feedback(order_item_id, submitter_kind);

CREATE INDEX IF NOT EXISTS idx_service_feedback_order
  ON service_feedback(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_feedback_status
  ON service_feedback(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_feedback_submitter_account
  ON service_feedback(submitter_account_id, created_at DESC)
  WHERE submitter_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_service_feedback_agent_instance
  ON service_feedback(agent_instance_id, created_at DESC)
  WHERE agent_instance_id IS NOT NULL;
