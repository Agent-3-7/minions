---
name: lead-generation
description: This skill should be used when users create lead generation or prospecting tasks in Minions. It guides the agent through a structured workflow — collecting test leads, getting user sign-off on columns and format, then setting up a recurring Hermes cron job that appends leads to a local CSV file.
---

# Lead Generation

Guide users from a vague lead generation goal to a running, recurring Hermes cron job that collects leads into a local CSV.

## Workflow

### Phase 1: Understand the Target

If the user hasn't already given enough context to start, you can ask 1 or 2 follow up questions max: 

- **Who** — ideal customer profile (industry, company size, role/title, geography)
- **Why** — what the leads are for (outbound sales, partnerships, recruiting, research)

You can folow up later if needed, after you do a sample run.

### Phase 2: Test Leads

Collect 2-3 leads and present them in a table. Choose columns that make sense for the user's specific task — there is no fixed schema. The columns should emerge naturally from the targeting criteria and what information is discoverable.

Present the test leads and let the user react. They may want to adjust columns, targeting, or format — follow their lead. Do not proceed to creating the cron job until the user signals they're happy with the results.

### Phase 3: Set Up the Cron Job

Once the user signs off, create a Hermes cron job. Hermes already understands cron job syntax and the `cronjob` tool — no need to explain scheduling mechanics to the user. Focus on:

- **Schedule** — pick a sensible default based on volume and urgency (e.g., `every 4h` for aggressive, `every 1d` for steady).
- **Batch size** — default to 3-5 leads per run unless the user specifies otherwise.
- **CSV location** — store in the working directory. Suggest a descriptive filename (e.g., `leads-saas-founders.csv`). Create the file with headers and the test leads already included.
- **Prompt** — the cron job prompt should be self-contained: describe the ICP, the CSV path, the columns, and the number of leads to collect per run.

### Guidance

- Always start with test leads. Never jump straight to creating the cron job.
- Wait for the user to signal they're happy before creating the cron job — don't ask for permission, just don't proceed until they indicate satisfaction.
- If the user has a specific source in mind, incorporate it. Otherwise, choose appropriate sources.
- Keep the cron job prompt concise but complete — it runs in a fresh session with no prior context.
- If the user already has a CSV or lead list, continue appending to it rather than starting fresh.
- Bias toward doing and showing over asking. Present what was done and let the user course-correct.
