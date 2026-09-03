export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RiskLevel = "read" | "reversible_write" | "external_side_effect" | "destructive";
export type CatalogChannel = "draft" | "staging" | "production";

export interface SdkVersionRange {
  minimum: string;
  maximum?: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

export class ContractValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(contractName: string, issues: ValidationIssue[]) {
    super(`${contractName} is invalid: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}
