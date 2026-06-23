# ItPay Ops Admin CLI

Internal operators can use these commands for refund and reconciliation checks.
Do not store ops tokens in this file, examples, shell history, or tickets.

Set the target API and ops token in your shell:

```bash
export ITPAY_CORE_API_BASE="https://dev.api.itpay.ai"
export ITPAY_SANDBOX_OPS_TOKEN="<from secure password manager>"
```

Refund review:

```bash
itp ops sandbox refund show <refund_id> --json
itp ops sandbox refund approve <refund_id> --reason approved_by_ops --json
itp ops sandbox refund reject <refund_id> --reason not_eligible --json
itp ops sandbox refund execute <refund_id> --json
```

Ledger and reconciliation checks:

```bash
itp ops sandbox ledger entries --refund <refund_id> --json
itp ops sandbox ledger entries --order <order_id> --json
itp ops sandbox reconciliation run --json
itp ops sandbox reconciliation show <run_id> --json
itp ops sandbox settlement show <settlement_batch_id> --json
```

Rules:

- Never approve or execute a refund without checking the order, refund amount,
  buyer identity, and current refund status.
- Execute live refunds only for small verified test orders or approved support
  cases.
- If a command fails after provider submission, query the refund before retrying;
  do not blindly create another refund.
