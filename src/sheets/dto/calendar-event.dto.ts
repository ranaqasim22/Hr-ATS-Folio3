
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
