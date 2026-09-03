# `@sable/workflow-core`

Deterministic workflow orchestration shared by the Web SDK and compatibility
tests. The executor has no DOM, Node, Playwright, transport, telemetry backend,
or product-specific implementation. All effects are injected through
`ActionDriver`, `WorkflowPolicyGate`, `ApprovalGate`, and `WorkflowTelemetry`.

The executor fails closed on unsupported compatibility classes, missing
approval handlers, invalid input templates, stale observations, aborts, and
execution-budget exhaustion.
