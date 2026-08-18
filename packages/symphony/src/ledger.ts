// SPDX-License-Identifier: Apache-2.0

export interface OwnerDirective {
  id: string;
  issueId: string;
  receivedAtMs: number;
  acknowledgedAtMs: number;
  verbatim: string;
  /** Present for directives ingested directly from the configured owner desk. */
  sourceSessionId?: string;
  /** Exact owner-authored message verified in the configured desk transcript. */
  sourceMessageId?: string;
  /** Immutable evidence for the compact acknowledgement projection. */
  acknowledgementId?: string;
}

function canonical(entry: OwnerDirective): string {
  return JSON.stringify(entry);
}

export class OwnerDirectiveLedger {
  readonly #entries: OwnerDirective[] = [];
  readonly #byId = new Map<string, OwnerDirective>();

  append(entry: OwnerDirective): Readonly<OwnerDirective> {
    if (!entry.id.trim() || !entry.issueId.trim() || !entry.verbatim.trim()) throw new Error("directive fields must not be blank");
    const directFields = [entry.sourceSessionId, entry.sourceMessageId, entry.acknowledgementId];
    if (directFields.some((value) => value !== undefined) && directFields.some((value) => value === undefined)) {
      throw new Error("direct owner directive requires source message and acknowledgement evidence together");
    }
    if (entry.sourceSessionId !== undefined && directFields.some((value) => !value!.trim())) {
      throw new Error("direct owner acknowledgement evidence must not be blank");
    }
    if (entry.acknowledgedAtMs < entry.receivedAtMs || entry.acknowledgedAtMs - entry.receivedAtMs > 60_000) {
      throw new Error("owner directive acknowledgement must be recorded within 60 seconds");
    }
    const immutable = Object.freeze({ ...entry });
    const existing = this.#byId.get(entry.id);
    if (existing) {
      if (canonical(existing) !== canonical(immutable)) throw new Error(`directive ${entry.id} is immutable`);
      return existing;
    }
    this.#entries.push(immutable);
    this.#byId.set(immutable.id, immutable);
    return immutable;
  }

  get(id: string): Readonly<OwnerDirective> | null {
    return this.#byId.get(id) ?? null;
  }

  entries(): readonly Readonly<OwnerDirective>[] {
    return Object.freeze([...this.#entries]);
  }
}

export type OwnerGateDecision =
  | { kind: "approve"; gateId: string }
  | { kind: "reject"; gateId: string; reason: string };

export function parseOwnerGateDecision(verbatim: string, expectedGateId: string): OwnerGateDecision {
  if (verbatim === `APPROVE ${expectedGateId}`) return { kind: "approve", gateId: expectedGateId };
  const prefix = `REJECT ${expectedGateId}: `;
  if (verbatim.startsWith(prefix) && verbatim.slice(prefix.length).trim()) {
    return { kind: "reject", gateId: expectedGateId, reason: verbatim.slice(prefix.length).trim() };
  }
  throw new Error(`owner decision does not exactly match gate ${expectedGateId}`);
}
