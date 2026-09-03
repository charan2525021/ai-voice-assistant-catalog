# NirogGyan brochure mapping report

Verified: 2026-08-20 at a forced 1440×900 desktop viewport  
Application build: `brochure-main-847efae8`  
Origin: https://www.brochure.niroggyan.com

## Executive result

The brochure is public and needs no authentication. The current build defines 12 first-party routes. Eight are connected to the current navigation or page buttons; four older pages load directly but are orphaned from the current UI.

The strongest SDK-direct interactions are the ROI sliders, the local WhatsApp preview, the local booking-dialog open/close boundary, two unique React SPA route buttons, and testimonial scrolling. Main navigation, home expansion panels, and repeated Preview/View Smart Report buttons need stable markers before they can be approved.

## Capability boundary derived from code

- `dom.ts` reaches buttons, anchors, inputs, textareas, selects, summaries, roles, contenteditable nodes, non-negative tabindex nodes, and `data-sable-id` nodes.
- Semantic resolver tiers inspect only those meaningful elements. CSS fallback can technically query any element, but the brochure supplies only generated MUI/Emotion classes for the problematic nodes; those are intentionally rejected as unstable.
- The resolver refuses a tie when the two top candidates have the same score (`CONTROL_AMBIGUOUS`).
- The action driver allows local button clicks, fills, scrolling, and assertions. It refuses cross-origin anchors, target-blank/download links, full-page navigation, and native form submission. New-window button handlers still require compatibility classification and must never be called SDK-direct.
- Policy allows only `SDK_DIRECT` and reviewed registered tools. The guided-demo test catalog declares one read-only, route-allow-listed client router so an injected SDK can move between React pages without a document reload; the production v1 catalog declares no tools.

## Route inventory

| Route | Surface | Reachability |
|---|---|---|
| `/` | Intro/home | Desktop nav Intro |
| `/user-journey` | Five-step user journey | Desktop nav |
| `/smartReporting` | Smart Reporting overview | Smart Reporting nav label |
| `/smartReport` | New Smart Report page | Dropdown and repeated user-journey buttons |
| `/vizApp` | New Viz App page | Dropdown; `/vizapp` case alias from a page button |
| `/engagement` | Patient engagement | Desktop nav and two user-journey buttons |
| `/testimonials` | Customer evidence | Desktop nav |
| `/roi-calculator` | Live ROI calculator | Desktop nav |
| `/smartReports` | Legacy Smart Report page | Direct URL only; route literal appears only in App.js |
| `/vizappPage` | Legacy Viz App page | Direct URL only; route literal appears only in App.js |
| `/analytics` | Legacy report selector | Direct URL only; route literal appears only in App.js |
| `/healthTools` | Legacy health-tools page | Direct URL only; route literal appears only in App.js |

This corrects the earlier “at least eight / two button-only hidden routes” lead. In build 847efae8 there are 12 declarations, and the four extra legacy routes are not button-reachable at all.

## Open-question verdicts

### 1. Navigation

The previous negative finding is correct for the current markup, but the mechanism matters. Desktop nav items are plain `Box`/`Typography` nodes. They have click handlers but no role, tabindex, id, test ID, or Sable marker. Semantic locator kinds cannot see them. Generated CSS classes are the only unique selectors.

Smallest robust fix: add `data-sable-id` to the event-owning Box. Better accessibility fix: render an anchor/button with a distinct accessible name and keyboard behavior. A registered client-router tool is the alternative when markup cannot change.

### 2. Four home panels

They are working. Deployed source attaches the same state setter to `onMouseEnter` and `onClick` on the outer Box. A native pointer changed each selected panel from 60px to 400px. The SDK problem is targeting: the handler-owning Box is outside the semantic selector and has no stable marker. Add `data-sable-id` (or make it a real button) and the SDK click path becomes legitimate.

### 3. Smart Reporting dropdown

Native hover opens two items: Smart Report and Viz App. Both items are plain Boxes with generated classes and no role/marker, so they are not safely resolvable. They route to `/smartReport` and `/vizApp`.

### 4. Repeated labels

The user-journey page has two `View Smart Report` buttons; Smart Reporting has two `Preview` buttons; Smart Report has seven `Preview` buttons. Agent ID is absent, role/name and text tie, label ties, test ID is absent, relationship has no stable ancestor, and CSS would require generated or positional selectors. The resolver therefore refuses the top-score tie. Give each control a distinct `aria-label` or `data-sable-id`.

### 5. Zero statistics

Not a defect. `AnimatedCounter` uses `useInView({ once: true, amount: 0.5 })` and runs for 2.5 seconds. A clean load showed zeros; a native scroll produced 25+, 99.9%, 1M+, and 15. Store/quote them only as attributed site claims.

### 6. Scrolling

The page scrolls on `window`; all main pages have document heights above the 900px viewport. The SDK scroll action calls smooth `window.scrollBy`, defaulting to 80% of viewport height. A 950px testimonial scroll triggered the count-up successfully.

### 7. Coverage honesty

This brochure supports narrative walkthroughs, report-preview explanations, a local WhatsApp preview, booking-dialog opening, and ROI scenarios. It does not contain the full authenticated dashboards, configuration portal, consumer analysis workflow, or pricing shown in the founder's broader sales demo. The linked Viz App, corporate dashboard, and niro.health surfaces are separate origins and separate catalog scopes.

## Per-route control summary

- Home: Talk to Shweta; Personal/Total/Compact comparison buttons; two distinctly labelled founder LinkedIn buttons; Book Demo; unnamed social links.
- User journey: View Smart Report ×2; View Viz App; View Chat Bot; View Analytics; Contact Now; Book Demo.
- Smart Reporting: Learn More; Preview ×2; Book Demo.
- Smart Report: Preview ×7; Book Demo.
- Viz App: Try Now (external new tab); Book Demo.
- Engagement: Discover AI Tools (external); Preview (local WhatsApp overlay); Try Now (external corporate dashboard); Book Demo.
- Testimonials: unnamed carousel arrows; Book Demo.
- ROI: three uniquely aria-labelled range inputs; Book a Demo; footer Book Demo.
- Legacy Smart Reports: View Demo Report; Preview ×7; Book Demo.
- Legacy Viz App: Try Now; Book Demo.
- Legacy Analytics: Book Demo ×2 and four report-selector buttons.
- Legacy Health Tools: Book Now; Preview; Try Now; Book Demo.

## Third-party and privacy boundaries

The Google Translate widget injects a voting form, inputs, IDs, classes, and iframes on every route. The catalog excludes its forms, frames, IDs/classes, and gadget nodes from both observation and resolution. Screenshots are disabled, element values are disabled, visible text is capped at 25,000 characters, credential-shaped inputs are excluded, and the HubSpot iframe is excluded.

Opening the local booking dialog is SDK-direct. Selecting or submitting a time occurs inside a cross-origin HubSpot iframe and needs a frame bridge plus explicit external-side-effect handling; it is not approved here.

## Link and defect result

HTTP GET returned 200 for all 12 brochure routes and the Viz App demo, corporate dashboard login, niro.health, and HubSpot meeting destination. No broken link or broken control was found. The zero counters, home panels, and preview overlays were all resolved as working mechanisms rather than defects.
