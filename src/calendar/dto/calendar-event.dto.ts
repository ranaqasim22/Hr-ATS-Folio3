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
  emails: string[];
  resumeLink: string;
  eventId: string;
  createdAt: string;
  updatedAt: string;
  status: 'Active' | 'Updated' | 'Cancelled';
}