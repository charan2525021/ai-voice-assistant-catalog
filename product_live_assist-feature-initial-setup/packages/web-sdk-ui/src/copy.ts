import type { ApprovalRequest } from "@sable/web-sdk";

export function approvalCopy(request: ApprovalRequest): { title: string; detail: string } {
  return {
    title: request.risk === "destructive" ? "Destructive action" : "Confirm action",
    detail: `${request.reason}\n\nJourney: ${request.journeyName}`,
  };
}
