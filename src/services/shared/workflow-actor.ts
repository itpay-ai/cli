// This is an owner-projected transport actor, not evidence of user approval.
// Missing metadata retains the original human-only template.
export function workflowSubmissionActor(action: {submission_actor?: "agent" | "human"}): "agent" | "human" {
  return action.submission_actor === "agent" ? "agent" : "human";
}
