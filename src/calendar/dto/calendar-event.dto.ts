export class CalendarEventDto {
  candidateName: string;
  position: string;
  interviewStage: string;
  type: string;

  date: string;
  time: string;
  location: string;

  interviewers: string[];
  recruiter: string;

  contactNumber: string;
  emailAddress: string;

  resumeLink: string;
  eventId: string;

  status: 'Active' | 'Cancelled';
}
