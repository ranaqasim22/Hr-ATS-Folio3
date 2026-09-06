/**
 * TEMPORARY ASSUMPTION
 * ---------------------
 * This is a local stand-in for Member 1's future `CalendarEventDto`.
 * It mirrors the field shape from the shared task spec so SheetsService
 * can be built and tested independently right now.
 *
 * REMOVE THIS FILE once Member 1 merges `feature/auth-calendar` into `main`
 * and their real CalendarEventDto exists. At that point:
 *   1. Delete this file.
 *   2. Update the import path in sheets.service.ts to point at the real DTO.
 *   3. Confirm field names match exactly — eventToRow() in sheets.service.ts
 *      is the ONLY place that needs to change if any field name differs.
 */
export interface CalendarEventDto {
  candidateName?: string;
  position?: string;
  interviewStage?: string;
  type?: string;
  date?: string | Date;
  time?: string;
  location?: string;
  interviewers?: string;
  recruiter?: string;
  contactNumber?: string;
  emailAddress?: string;
  resumeLink?: string;
  eventId: string; 
}