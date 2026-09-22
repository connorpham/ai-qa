# Acceptance checklists — project-specific UAT criteria

This document is the **Single Source of Truth** for acceptance criteria and UAT verification in this project.
When adding new verification criteria, append them to the table below.

## Rules for AI Agents
1. **Audit before testing:** Read this table and identify all applicable items for the feature/surface under test.
2. **Auto-sync & expand:** If this file contains criteria not yet covered in existing test cases, you MUST expand the verification plan to include them.
3. **No silent skips:** Every applicable item must result in executable verification with evidence, or an explicit waiver with justification. Never silently ignore a checklist item.
4. **Standardize & update:** After executing the verification, update the status and evidence path for each evaluated item in this document or the case manifest.

## Criteria Matrix

| ID | Category | Scope | Criteria | Expected Fact | Status | Evidence |
|:---:|:---|:---:|:---|:---|:---:|:---|
| 01 | General | all | Clean navigation without 404 or unhandled runtime errors | HTTP 200, valid layout and title | PENDING | |
| 02 | Form | reg | Form validation prevents empty submission of required fields | Explicit error message in working language | PENDING | |
| 03 | Table | list | Table columns support sorting without breaking layout | Ascending/descending order maintained | PENDING | |
| 04 | Navigation | all | Breadcrumb and Back button navigate to previous state without loops | Valid history state, filters retained | PENDING | |
