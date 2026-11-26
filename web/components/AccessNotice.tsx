export interface AccessPrompt {
  state: "guest" | "checking" | "inactive" | "activating" | "unavailable";
  title: string;
  detail: string;
  action?: { label: string; run: () => void };
  error?: string;
}

export function AccessNotice({ prompt, onViewVault }: { prompt: AccessPrompt; onViewVault?: () => void }) {
  const action = onViewVault && prompt.state === "inactive"
    ? { label: "Go to your vault", run: onViewVault }
    : prompt.action;
  return <section className="access-notice">
    <h3>{prompt.title}</h3>
    <p>{prompt.detail}</p>
    {action && <button type="button" className="btn" onClick={() => action.run()}>{action.label}</button>}
    {!onViewVault && prompt.error && <p className="kill-error" role="alert">{prompt.error}</p>}
  </section>;
}
