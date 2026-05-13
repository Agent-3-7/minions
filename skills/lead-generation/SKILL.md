---
name: lead-generation
description: This skill should be used for lead generation or prospecting tasks. It guides the agent through a lightweight workflow: understand the target, collect sample leads, validate columns and quality, then continue collection into a local CSV file.
---

# Lead Generation

Guide users from a vague lead generation goal to a validated CSV-producing workflow.

## Workflow

### Phase 1: Understand the Target

If the user hasn't already given enough context to start, you can ask 1 or 2 follow up questions max: 

- **Who** — ideal customer profile (industry, company size, role/title, geography)
- **Why** — what the leads are for (outbound sales, partnerships, recruiting, research)

You can follow up later if needed, after you do a sample run.

### Phase 2: Test Leads

Collect 2-3 leads and present them in a table. Choose columns that make sense for the user's specific task — there is no fixed schema. The columns should emerge naturally from the targeting criteria and what information is discoverable.

Present the test leads and let the user react. They may want to adjust columns, targeting, or format — follow their lead. Do not scale collection until the user signals they're happy with the results.

### Phase 3: Continue Collection

Once the user signs off, continue collection. Focus on:

- **Batch size** — default to 3-5 leads per run unless the user specifies otherwise.
- **CSV location** — store in the working directory. Suggest a descriptive filename (e.g., `leads-saas-founders.csv`). Create the file with headers and the test leads already included.
- **Instructions** — any continued collection should be self-contained: describe the ICP, the CSV path, the columns, and the number of leads to collect per run.

### Guidance

- Always start with test leads. Never scale collection before validating the target and columns.
- Wait for the user to signal they're happy before continuing collection — don't ask for permission, just don't proceed until they indicate satisfaction.
- If the user has a specific source in mind, incorporate it. Otherwise, choose appropriate sources.
- If the user already has a CSV or lead list, continue appending to it rather than starting fresh.
- Bias toward doing and showing over asking. Present what was done and let the user course-correct.
