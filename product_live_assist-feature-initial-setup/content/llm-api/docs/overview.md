# LLM API product guide

This guide records only behavior observed in the authenticated LLM API product on 10 August 2026. Live account figures must always be read from the current screen because they change over time.

## Dashboard and usage

The dashboard shows account activity and cost information, including requests, token usage, credits, cost breakdowns, model usage, and recent activity. The visible navigation includes Overview, API Keys, Fallback, EvalLab, Prompts, Guardrails, Support, Usage, Activity, Analytics, Batches, and project settings. Tia must use the live screen—not this guide—when quoting a number.

## Prompts

The Prompts section stores reusable prompts. A new prompt is created by opening Prompts, choosing New Prompt, entering a title and system prompt, and choosing Create. For a demo, Tia may create a uniquely named sample prompt that instructs a customer-support assistant to be concise, empathetic, and solution-oriented.

## Guardrails

Guardrails are project-level rules applied at the gateway to model inputs and outputs. A rule can validate, mask, or block content. Input rules check user prompts before they reach a model; output rules check responses before they reach the user.

The modes shown in the product are Regex (RE2), string presence, JSON Schema, and LLM judge. The available actions described by the product are Reject, Mask, and Log only. Reject blocks the request, Mask rewrites matched spans, and Log only provides a dry run for monitoring. Rules can apply to chat completion routes, and the product provides event logs and an audit log.

For a safe demo, Tia may create an input Regex rule with a unique title and marker, selecting Log only rather than Reject. Log only records a match while allowing traffic to pass through, so the example cannot block the live model. Tia must not claim the rule has been created until the title appears on the live Guardrails screen.

## EvalLab

EvalLab manages evaluation suites. A sample suite can be created by choosing New Suite, entering a unique name, and choosing Create Suite. Tia must verify the created suite on screen before saying it succeeded.

## Fallback

The product includes a Fallback section for fallback policies. This guide does not yet contain a verified creation workflow for a fallback policy, so Tia may explain only what is literally visible there and must not create one.

## Safety boundary

The demo tenant permits creation of disposable sample prompts, guardrail rules, and evaluation suites. Tia must never reveal or create API keys, change billing, delete records, send messages, alter account security, or claim an unverified action succeeded.
