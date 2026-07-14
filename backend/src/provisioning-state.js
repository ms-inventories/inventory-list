export const provisioningRoles = Object.freeze(["tenant_admin", "contributor", "viewer"]);
export const provisioningStates = Object.freeze(["active", "disabled"]);
export const provisioningSteps = Object.freeze(["identity", "groups", "enrollment", "complete"]);
export const provisioningStatuses = Object.freeze(["pending", "running", "retry_wait", "succeeded", "failed"]);

const safeFailures = Object.freeze({
  invalid_target: Object.freeze({
    message: "The requested account role or state is not supported.",
    retryable: false
  }),
  identity_ambiguous: Object.freeze({
    message: "More than one identity matched this email. An administrator must resolve the duplicate.",
    retryable: false
  }),
  identity_conflict: Object.freeze({
    message: "This Authentik identity is already linked to another app user.",
    retryable: false
  }),
  provider_not_configured: Object.freeze({
    message: "Permanent account provisioning is not configured yet.",
    retryable: false
  }),
  provider_not_authorized: Object.freeze({
    message: "The account service needs an administrator to update its permissions.",
    retryable: false
  }),
  provider_not_found: Object.freeze({
    message: "The required Authentik tenant group was not found.",
    retryable: false
  }),
  provider_rate_limited: Object.freeze({
    message: "The account service is busy. Provisioning will retry automatically.",
    retryable: true
  }),
  provider_unavailable: Object.freeze({
    message: "The account service is temporarily unavailable. Provisioning will retry automatically.",
    retryable: true
  }),
  unknown: Object.freeze({
    message: "Permanent account provisioning could not be completed.",
    retryable: false
  })
});

function requireValue(allowed, value, label) {
  if (!allowed.includes(value)) {
    const error = new Error(`Unsupported ${label}`);
    error.code = "invalid_target";
    throw error;
  }
  return value;
}

export function normalizeProvisioningTarget({ role, state }) {
  return Object.freeze({
    desiredRole: requireValue(provisioningRoles, role, "provisioning role"),
    desiredState: requireValue(provisioningStates, state, "provisioning state")
  });
}

export function provisioningPlan({
  desiredState,
  enrollmentRequired = true,
  enrollmentSentAt = null
}) {
  requireValue(provisioningStates, desiredState, "provisioning state");
  const steps = ["identity", "groups"];
  if (desiredState === "active" && enrollmentRequired !== false && !enrollmentSentAt) {
    steps.push("enrollment");
  }
  steps.push("complete");
  return Object.freeze(steps);
}

export function nextProvisioningStep({
  completedStep,
  desiredState,
  enrollmentRequired = true,
  enrollmentSentAt = null
}) {
  requireValue(provisioningSteps, completedStep, "provisioning step");
  const plan = provisioningPlan({ desiredState, enrollmentRequired, enrollmentSentAt });
  const index = plan.indexOf(completedStep);
  if (index === -1) {
    // Enrollment is deliberately skipped for disabled or already-enrolled users.
    if (completedStep === "enrollment") return "complete";
    const error = new Error("Provisioning step is not part of the desired-state plan");
    error.code = "invalid_target";
    throw error;
  }
  return plan[Math.min(index + 1, plan.length - 1)];
}

export function retryDelayMs(attemptCount, {
  baseDelayMs = 5_000,
  maximumDelayMs = 15 * 60_000
} = {}) {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new TypeError("attemptCount must be a positive integer");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
    throw new TypeError("baseDelayMs must be positive");
  }
  if (!Number.isFinite(maximumDelayMs) || maximumDelayMs < baseDelayMs) {
    throw new TypeError("maximumDelayMs must be at least baseDelayMs");
  }
  return Math.min(maximumDelayMs, baseDelayMs * (2 ** Math.min(attemptCount - 1, 20)));
}

export function safeProvisioningFailure(error = {}) {
  const providerCodeMap = {
    authentik_config_invalid: "provider_not_configured",
    authentik_user_ambiguous: "identity_ambiguous",
    authentik_group_ambiguous: "provider_not_found",
    authentik_timeout: "provider_unavailable",
    authentik_unavailable: "provider_unavailable",
    authentik_response_too_large: "provider_unavailable",
    authentik_invalid_response: "provider_unavailable"
  };
  const candidateCode = providerCodeMap[error.code] || error.code;
  const explicitCode = typeof candidateCode === "string" && safeFailures[candidateCode]
    ? candidateCode
    : null;
  let code = explicitCode;

  if (!code) {
    const status = Number(error.statusCode ?? error.status);
    if (status === 401 || status === 403) code = "provider_not_authorized";
    else if (status === 404) code = "provider_not_found";
    else if (status === 409) code = "identity_conflict";
    else if (status === 429) code = "provider_rate_limited";
    else if (status >= 500 && status <= 599) code = "provider_unavailable";
    else code = "unknown";
  }

  const failure = safeFailures[code];
  return Object.freeze({ code, message: failure.message, retryable: failure.retryable });
}
