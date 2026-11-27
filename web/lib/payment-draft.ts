import { formatUnits, parseUnits } from "viem";
import type { ListedRecipient } from "./recipients";

export type DraftToken = "auto" | "USDT" | "USDC";
export interface DraftFields { recipient: string; amount: string; token: DraftToken }

// Matches the 18-decimal tokens and per-payment input limit in agent/src/plan/build.ts.
const maximumAmount = parseUnits("1000000000", 18);

export function canonicalAmount(input: string): string | null {
  const value = input.trim();
  if (value.length > 40 || !/^(?:\d+(?:\.\d{1,18})?|\.\d{1,18})$/.test(value)) return null;
  const units = parseUnits(value, 18);
  return units > 0n && units <= maximumAmount ? formatUnits(units, 18) : null;
}

const nameKey = (value: string) => value.trim().normalize("NFC").toLowerCase();

/** Match whole reference phrases, as the chat router does. A numeral in a date or an amount is not a choice. */
function ambiguousReference(value: string): boolean {
  const words = nameKey(value).normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/^(?:i (?:choose|mean|want)|je (?:choisis|veux|prends)) /, "")
    .replace(/ (?:please|svp|stp|s il (?:vous|te) plait)$/, "");
  const ordinal = /^(?:(?:the|le|la|l) )?(?:first|second|third|fourth|fifth|last|former|latter|other|premiere?|deuxieme|seconde?|troisieme|quatrieme|cinquieme|derniere?|autre|\d+(?:st|nd|rd|th|er|ere|eme|e))(?: (?:one|option|contact|recipient|personne))?$/;
  const numbered = /^(?:option|number|numero|choix|n) (?:\d+|one|two|three|un|deux|trois)$/;
  const relative = /^(?:(?:this|that)(?: one| person| recipient)?|(?:celui|celle)(?: ci| la)?|yes|oui|ok|okay|they|them|she|her|he|him|it|lui|elle|eux|elles)$/;
  return ordinal.test(words) || numbered.test(words) || relative.test(words);
}

export function authorizedRecipient(entry: ListedRecipient): boolean {
  return Boolean(entry.name.trim() && entry.onChain?.allowed);
}

/** The model's suggestions never establish a payee's identity or vault authorization. */
export function initialRecipient(name: string, directory: ListedRecipient[], candidates: string[] = []): string {
  const key = nameKey(name);
  if (/^0x[0-9a-f]{40}$/.test(key)) {
    return directory.find(entry => authorizedRecipient(entry) && entry.address.toLowerCase() === key)?.address ?? "";
  }
  if (!key || ambiguousReference(key) || candidates.some(candidate => nameKey(candidate) !== key)) return "";
  const matches = directory.filter(entry => nameKey(entry.name) === key);
  return matches.length === 1 && authorizedRecipient(matches[0]) ? matches[0].address : "";
}

const command = /^(?:please\s+)?(?:pay|send|transfer|paie|paye|payer|envoie|envoyer|verse|vire)(?:\s+|$)/iu;
const menuRequest = /^(?:(?:prepare|make|start) (?:a )?payment|send money|faire un paiement)$/iu;
const fiat = new Set(Intl.supportedValuesOf("currency"));
const qualifier = /\b(?:and|or|if|unless|when|now|later|today|tomorrow|yesterday|next|instead|only|not|no|never|each|daily|weekly|monthly|monday|tuesday|wednesday|thursday|friday|saturday|sunday|et|ou|si|quand|demain|hier|après|seulement|non|pas|jamais|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/iu;
const coin = /^(?:btc|eth|bnb|sol|dai|busd|wbtc|weth|usde|usdd|usds|doge|avax|xrp|ada|matic|ton|trx|bitcoin|ether|euros?|dollars?|baht|pesos?|dong)$/iu;

/** Only a whole, simple clause can become fields. Keep other instructions intact for the chat router. */
export function draftFields(source: string[], directory: ListedRecipient[]): DraftFields | null {
  const result: DraftFields = { recipient: "", amount: "", token: "auto" };
  // Edit payment after a failed quote receives the exact message produced by paymentReviewMessage.
  const review = source.length === 1 && /^Pay (\d+(?:\.\d+)?)(?: (USDT|USDC))? to (0x[0-9a-fA-F]{40})$/.exec(source[0]);
  if (review) {
    const recipient = initialRecipient(review[3], directory);
    if (!recipient || canonicalAmount(review[1]) !== review[1]) return null;
    return { recipient, amount: review[1], token: review[2] as DraftToken ?? "auto" };
  }
  let currency = "";
  for (const [index, utterance] of source.entries()) {
    const line = utterance.trim().normalize("NFC");
    if (!index && menuRequest.test(line)) continue;
    if (!line || /[\r\n]|0x[\da-f]/iu.test(line) || qualifier.test(line)) return null;
    if (index && command.test(line)) return null;
    const body = line.replace(command, "").trim();
    if (!body) continue;
    if (ambiguousReference(body)) {
      result.recipient = "";
      continue;
    }
    // Consume the whole amount and optional token, so "-25", "1,50" and "1e5" never become 25, 50 or 5.
    const money = [...body.matchAll(/(?:^|\s)(?:(\d+(?:\.\d+)?|\.\d+)(?:\s*(USD[TC]?))?|(USD[TC]?)(?:\s+(\d+(?:\.\d+)?|\.\d+))?)(?=$|\s)/giu)];
    if (money.length > 1) return null;
    let target = body;
    if (money.length) {
      const match = money[0];
      const before = body.slice(0, match.index).trim();
      const after = body.slice(match.index + match[0].length).trim();
      if (before && after || directory.some(entry => nameKey(entry.name) === nameKey(body))) return null;
      target = before || after;
      const rawAmount = match[1] ?? match[4];
      if (rawAmount) {
        const amount = canonicalAmount(rawAmount);
        if (!amount || result.amount) return null;
        result.amount = amount;
      }
      const asset = (match[2] ?? match[3])?.toUpperCase();
      if (asset) {
        if (currency && currency !== asset) return null;
        currency = asset;
        result.token = asset === "USD" ? "auto" : asset as DraftToken;
      }
    }
    target = target.replace(/^(?:to|à)\s+/iu, "");
    if (target) {
      if (ambiguousReference(target)) {
        result.recipient = "";
        continue;
      }
      const known = directory.some(entry => nameKey(entry.name) === nameKey(target));
      if (fiat.has(target.toUpperCase()) || coin.test(target)) return null;
      if (!known && (!/^[\p{L}][\p{L}\p{M}'’-]*$/u.test(target) || /[A-Z]{2}/.test(target))) return null;
      if (result.recipient) return null;
      result.recipient = target;
    }
  }
  return result;
}

/** Re-check the current list on submit and send the selected address, even if two display names match. */
export function paymentReviewMessage(address: string, rawAmount: string, token: DraftToken, directory: ListedRecipient[]): string | null {
  const entry = directory.find(person => person.address.toLowerCase() === address.toLowerCase());
  const amount = canonicalAmount(rawAmount);
  if (!entry || !authorizedRecipient(entry) || !amount || !["auto", "USDT", "USDC"].includes(token)) return null;
  return "Pay " + amount + (token === "auto" ? "" : " " + token) + " to " + entry.address;
}
