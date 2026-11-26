# Agent chat cards implementation plan

Implement the [approved design](../specs/2026-11-26-agent-chat-cards-design.md) on the chat feature branch. The reference screenshot sets the visual direction for the cards: white surfaces, thin neutral borders, dark type and controls, compact rows, green confirmed states. Scope styling to the new cards so the dashboard redesign can land separately.

1. Add an authenticated `POST /chat` intent route to the agent and web proxy. Validate bounded owner turns, choose a typed tool with Claude, and return a card decision. Use existing planner/execution endpoints for payments. Test tool validation, owner derivation, requests for missing details, superseded drafts, and preservation of demo messages.
2. Extract the dashboard's recipient readers and form into shared pieces. Refresh chain and directory before changing either; handle an already-confirmed authorization with an outstanding directory save. Test recovery, failed reads, denied signatures, conflicting names and caps.
3. Render help, balance, paginated recipients, questions and the shared form within chat. Keep the existing payment card and resume behavior. Test zero and unavailable data, page boundaries, follow-up turns and owner switching.
4. Integrate the chat and dashboard, then check the agent and web test suites, type checks, production builds and actual card rendering. Review the full branch and record which checks used fixtures, external services or real wallet signatures.
