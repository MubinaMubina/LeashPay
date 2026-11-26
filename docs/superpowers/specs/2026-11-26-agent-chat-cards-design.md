# LeashPay chat cards

A vault owner can ask a question, add someone or prepare a payment in the same conversation. Each answer opens a card styled like the existing payment card. The owner's message appears once above the card. The card starts with the answer or the form.

## The five requests

| Owner's message | What appears in the chat |
| --- | --- |
| “Hi” or “What can you do?” | A compact help card with four actions: check the vault balance, list recipients, add a recipient and prepare a payment. A click starts the selected flow. |
| “How much do I have?” | A balance card with the current USDT and USDC amounts held in the vault, each in its own unit. A separate line shows the USDT value in T-bills. Use the vault reader and token formatter already used by the dashboard. |
| “Who can I pay?” | A recipients card with the first three named contacts that the vault currently allows, in name order. Each row shows the name, short address and 30-day cap. “Next” and “Previous” page within the card. Show the range and count when there is more than one page. “View all recipients” opens and focuses the dashboard's full recipients list, including on mobile. |
| “Add Léa with a 200 USDT cap” | The existing add-recipient form opens directly inside a card, with the name and cap filled in. The owner can edit the fields, supply the address and review the full address and cap before signing. The dashboard and chat use the same form and submit handler. |
| “Pay Léa 25 USDT” | The existing payment plan card, including its wallet approval, progress, refusals and receipt links. “Pay Léa” followed by “25 USDT” reaches the same card. |

The preview lists named recipients verified as allowed. The full list also displays directory entries whose vault status is disabled or unknown. When a read fails, give the affected card a retry action. Distinguish a confirmed zero balance or empty directory from an unavailable read. A successful add updates the full list and allows an immediate follow-up payment by name.

Example of a preview with four eligible recipients (illustrative values):

```text
Who you can pay                                  1–3 of 4
Léa      0x12…34                            200 / 30 days
Linh     0x56…78                            500 / 30 days
Marco    0x9a…bc                            300 / 30 days
View all recipients                                  Next
```

## Approach

The current chat posts every message to the payment planner, whose output schema requires a payment plan. Broadening its prompt alone would still leave the UI expecting that schema. Buttons alone would give the owner quick access but miss requests typed into the conversation.

Use Claude to select from the supported tools and extract user-supplied fields. The application validates each result and chooses the React card. Balances, recipient authorization, transaction status and receipts come from the existing readers and execution flow. The capabilities card describes the tools actually available. Keep interface labels in English, and recognize the same requests and follow-ups in French or English.

A missing payment detail produces a short question in a card. For example, “Pay Léa” opens “How much, and in which token?” The next turn can supply both. If the recipient is ambiguous, ask the owner to select one. An address, amount or token required for a payment must come from an explicit choice or the existing planner's documented rules. A new request can supersede a draft. Keep conversational state scoped to the signed-in owner and current chat. On reload, reopen the latest payment plan through the existing plan ID.

## Wallet actions and data

The web proxy derives the owner from the Privy session. Tools use that owner's vault and directory. Opening a card, paging through recipients and editing fields are read-only. Clicking the add form's submit button invokes the existing wallet flow. Wait for the vault transaction to confirm, then save the name. The owner can cancel before signing.

If saving the name fails, keep the details in the open form and offer “Retry saving name”. After a reload, the owner can re-enter those details in either add form. In both cases, re-read the directory, the address's authorization and its cap. If the directory entry is missing and the vault already has the requested authorization and cap, offer to save the name directly. A conflicting name or a changed cap needs an explicit review. A second wallet signature is unnecessary when only the name is missing.

Preparing a payment creates a plan. Execution uses the existing approval and receipt checks. Refreshing a card or retrying a read must never submit a transaction. Preserve the existing payment demo prompts, plan recovery and signed approval boundaries.

## Acceptance checks

- A greeting produces the help card. A balance request reads the owner's vault and creates no plan.
- With zero, one, three and four allowed names, the recipients card shows the correct count and navigation. The full list is reachable by keyboard and on mobile.
- Adding from the chat and from the dashboard has the same validation and signing behavior. Cancellation leaves the directory unchanged. A retry after a confirmed transaction and failed directory save requests no second signature.
- “Pay Léa” followed by “25 USDT” yields one payment card. The existing payment checks and receipts still work. Switching owners clears the previous owner's chat and drafts.
- Verify that a failed balance or directory read offers a retry and that unverified recipients are never presented as authorized.

Recent-payment history and monthly reports are outside this first version.
