import {
  SDK_CATALOG_SCHEMA_VERSION,
  type ToolDefinition,
} from "@sable/sdk-contracts";

/**
 * The deployed brochure uses React client-side routing, but its header items
 * are not stable semantic links. This reviewed tool gives guided-demo
 * journeys narrow authority to move only among known first-party routes
 * without reloading the document (which would remove an injected SDK).
 */
export const NIROGGYAN_BROCHURE_ROUTE_MARKERS = {
  "/": "The Challenges",
  "/user-journey": "Smart Health Journey",
  "/smartReporting": "Next-Generation Smart Reporting",
  "/vizapp": "Lab Report Analysis",
  "/engagement": "AI-Powered Engagement Tools That Patients Actually Use",
  "/roi-calculator": "Calculate Your True Patient Retention ROI",
  "/testimonials": "Real Stories, Real Impact",
} as const;

export type NirogGyanBrochureRoute = keyof typeof NIROGGYAN_BROCHURE_ROUTE_MARKERS;

export const NIROGGYAN_CLIENT_ROUTER_TOOL_NAME = "client_router.navigate";

export const NIROGGYAN_CLIENT_ROUTER_TOOL_DEFINITION: ToolDefinition = {
  kind: "sable.catalog.tool",
  schemaVersion: SDK_CATALOG_SCHEMA_VERSION,
  name: NIROGGYAN_CLIENT_ROUTER_TOOL_NAME,
  description: "Navigate only among reviewed first-party NirogGyan brochure SPA routes without reloading the document.",
  inputSchema: {
    kind: "sable.journey_input_schema",
    properties: {
      route: {
        type: "enum",
        enum: Object.keys(NIROGGYAN_BROCHURE_ROUTE_MARKERS),
      },
    },
    required: ["route"],
    additionalProperties: false,
  },
  risk: "read",
  confirmation: "never",
  availability: "required",
  timeoutMs: 8_000,
};
