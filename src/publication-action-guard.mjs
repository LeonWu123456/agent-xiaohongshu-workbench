export function publicationSnapshotDecision({
  gate,
  expectedToken = null,
  currentContent = null,
  expectedContent = null,
} = {}) {
  if (!gate?.allowed) return { allowed: false, code: gate?.code || "PUBLICATION_BLOCKED" };
  if (expectedToken != null && gate.token !== expectedToken) {
    return { allowed: false, code: "PUBLICATION_AUTHORITY_CHANGED" };
  }
  if (expectedContent != null && currentContent !== expectedContent) {
    return { allowed: false, code: "PUBLICATION_CONTENT_CHANGED" };
  }
  return { allowed: true, code: "PUBLICATION_AUTHORITY_CURRENT" };
}

export async function runGuardedPublicationAction({ gate, action }) {
  const decision = publicationSnapshotDecision({ gate });
  if (!decision.allowed) return { ...decision, value: null };
  return { ...decision, value: await action() };
}
