
export class CalendarEventDto {
  candidateName: string;
  position: string;
  interviewStage: string;
  type: string;

  date: string; // e.g. "2026-09-10"
  time: string; // e.g. "14:30"
  location: string;

  interviewers: string[]; // list of interviewer emails/names
  recruiter: string;

  contactNumber: string;
  emailAddress: string;

  resumeLink: string;
  eventId: string;
}
