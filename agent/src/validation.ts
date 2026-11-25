import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

/** A 0x address in any letter case, returned checksummed (EIP-55) like every address the agent produces. */
export const AddressSchema = z
  .string()
  .trim()
  .refine((value) => isAddress(value, { strict: false }), "must be a 0x address")
  .transform((value) => getAddress(value) as Address);

// Characters that can break text onto a new line, or reorder or hide what a person reads:
// control and format characters (bidi overrides, zero-width marks) and line/paragraph separators.
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]+/gu;
const HAS_UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** Free text from people (names, countries): bounded, on one line, and read the way it looks. */
export const TextSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !HAS_UNSAFE.test(value), "must not contain line breaks or invisible characters");

/** Text from Claude or a person, made safe to show on one line. */
export const oneLine = (text: string, max = 80) => text.replace(UNSAFE, " ").trim().slice(0, max);
