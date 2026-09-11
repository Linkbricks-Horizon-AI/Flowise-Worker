# Direct tool output streaming

When a planner selected an HWP `returnDirect` tool followed by a retrieval tool,
the executor continued to a final model answer. The model could include the HWP
card in that answer. Agent nodes then appended the earlier raw HWP result again,
producing two cards from one HWP invocation.

The executor now marks results only when it actually terminates through its
existing `returnDirect` branch. ToolAgent, ConversationalAgent, XMLAgent, and the
cached-chain callback share an invocation-local emission receipt. Model-completed
answers therefore have no extra raw tool output appended; a direct completion is
forwarded once. Child chatflows that already streamed remain excluded from bulk
emission.

## Compatibility boundaries

-   Tool selection, execution order, invocation counts, arguments, error handling,
    quota signals, and the existing direct-return termination rule are unchanged.
-   Distinct actual tool invocations remain distinct, even for identical output.
    There is no content-based deduplication or cross-request cache.
-   `usedTools`, source documents, artifacts, and saved final answers retain their
    existing values. The receipt is a private Symbol and adds no JSON fields.
-   Prediction routes, authentication, request fields, response fields, SSE event
    names, follow-up prompt encoding, IDs, and metadata-before-end ordering retain
    their existing contract. Empty strings and legacy object token payloads are
    forwarded without normalization.
-   No migration, environment setting, workflow edit, or subscriber change is
    required. The HWP CustomTool and VORA application do not need modification for
    this duplicate-output fix.

## Regression coverage

-   Real agent executor/node/callback path: HWP alone, HWP then retrieval,
    retrieval then HWP, cached planner callbacks, different model answers,
    iteration limits, quota exhaustion, tool errors, child streams, concurrent
    requests, repeated actual tool calls, and streaming/non-streaming agents.
-   Real Web SSE and Worker publisher/subscriber path: JSON serialization,
    used-tool/source/artifact events, follow-up generation inputs and encoding,
    metadata, and one final `[DONE]` event.
-   The Worker repository also uses the existing Web subscriber's
    `relayExecutionId ?? chatId` routing rule. This preserves the legacy route and
    isolates concurrent requests without changing client-facing IDs or payloads.

Run component and server Jest suites under the repository's Node 20 runtime,
then build `flowise-components` followed by `packages/server`. Whole-repository
lint may report existing unrelated failures; changed-file lint must pass.
